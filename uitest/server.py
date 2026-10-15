# -*- coding: utf-8 -*-
"""
CLIP Token 查询器 —— 本地后端服务

  · 静态托管 dist/（前端页面）
  · GET  /api/status      模型加载状态
  · POST /api/similarity  词义相似度：参照词 vs 待测词列表（含乱码基线校准）

运行：
  python server.py [port]

环境变量：
  CLIP_MODEL   默认 openai/clip-vit-large-patch14（SD1.5 用的同一条 CLIP 文本塔，词表 49408）
  CLIP_DEVICE  默认 cpu；设为 cuda 可用显卡（会占用显存）
"""
from __future__ import annotations

import gc
import hashlib
import json
import os
import random
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "5199"))
MODEL_NAME = os.environ.get("CLIP_MODEL", "openai/clip-vit-large-patch14")
COMFY_ROOT = os.environ.get("COMFYUI_ROOT", r"F:\ai\fastai")
# ComfyUI 服务地址 + 模型根目录（用于「从 ComfyUI 读取」可用 CLIP 列表）
COMFY_API = os.environ.get("COMFYUI_API", "http://127.0.0.1:8189")
COMFY_MODELS_ROOT = os.environ.get("COMFYUI_MODELS", os.path.join(COMFY_ROOT, "models"))
# SD1.x/SDXL ckpt 里 CLIP 文本塔的 key 前缀（按顺序尝试；空串 = 裸 text_model.*，如 clip_l.safetensors）
SD_TEXT_PREFIXES = ("cond_stage_model.transformer.", "cond_stage_model.", "transformer.", "")
# cuda / cpu / auto（默认 auto：有可用显卡就走显卡）
DEVICE = os.environ.get("CLIP_DEVICE", "auto").strip().lower()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

CACHE_DIR = ROOT / ".cache"
DEFAULT_LIMIT = 10000  # 默认预计算前 1 万个 token（等于「只搜前 1 万词」）

_lock = threading.Lock()
_matrix_lock = threading.Lock()
_state = {
    "model": None,
    "tokenizer": None,
    "torch": None,
    "ready": False,
    "error": None,
    # 词表嵌入矩阵（Top-K 相似词检索用）
    "matrix": None,
    "matrix_ready": False,
    "matrix_progress": 0,
    "matrix_total": 0,
    "matrix_limit": 0,  # 已就绪的范围（词表前 N 个 token）
    "matrix_error": None,
    "matrix_source": None,  # 'cache' | 'cuda' | 'cpu'
    "matrix_building": False,
    # 模型来源
    "model_label": "（未加载）",
    "model_source": None,  # 'builtin' | 'clip-path' | 'sd-ckpt' | 'sd-ckpt-g' | 'comfy'
    "model_key": "builtin",
    "comfy_clip": None,  # ComfyUI 直接加载的 CLIP 对象（Qwen 系等）
}
_baseline_cache: dict = {}


# --------------------------------------------------------------------- 模型
def _resolve_device(torch) -> str:
    """按 DEVICE 设置解析实际计算设备。"""
    global DEVICE
    if DEVICE == "auto":
        DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    elif DEVICE == "cuda" and not torch.cuda.is_available():
        print("[!] 未检测到可用 CUDA，自动回退到 CPU")
        DEVICE = "cpu"
    return DEVICE


class _TextTower:
    """
    把 HF CLIPTextModel（+ 可选投影层）封装成与 CLIPModel.get_text_features 等价的接口，
    这样 SD1.x / SDXL 的 CLIP-L / SDXL 的 OpenCLIP bigG 都能走同一套下游代码。
    """

    def __init__(self, text_model, projection=None):
        self.text_model = text_model
        self.projection = projection

    def eval(self):
        self.text_model.eval()
        if self.projection is not None:
            self.projection.eval()
        return self

    def to(self, device):
        self.text_model.to(device)
        if self.projection is not None:
            self.projection.to(device)
        return self

    def get_text_features(self, input_ids=None, attention_mask=None, **kwargs):
        out = self.text_model(input_ids=input_ids, attention_mask=attention_mask)
        pooled = out.pooler_output
        if self.projection is not None:
            pooled = self.projection(pooled)
        return pooled


def _bigG_from_openclip(state: dict):
    """
    OpenCLIP(bigG) 的权重命名 -> HF CLIPTextModel 的命名。

      token_embedding / positional_embedding -> embeddings.*
      transformer.resblocks.N.attn.in_proj_*  -> self_attn.{q,k,v}_proj.*（按 3 等分拆开）
      resblocks.N.ln_1 / ln_2                -> encoder.layers.N.layer_norm1 / layer_norm2
      resblocks.N.mlp.c_fc / c_proj          -> mlp.fc1 / fc2
      ln_final                               -> final_layer_norm
    """
    from transformers import CLIPTextConfig, CLIPTextModel

    vocab_size, width = state["token_embedding.weight"].shape
    pos = state["positional_embedding"]
    n_layers = 1 + max(
        int(k.split(".")[2]) for k in state if k.startswith("transformer.resblocks.")
    )
    intermediate = state["transformer.resblocks.0.mlp.c_fc.weight"].shape[0]

    cfg = CLIPTextConfig(
        vocab_size=int(vocab_size),
        hidden_size=int(width),
        intermediate_size=int(intermediate),
        num_hidden_layers=int(n_layers),
        num_attention_heads=int(width) // 64,
        max_position_embeddings=int(pos.shape[0]),
        hidden_act="gelu",  # OpenCLIP 系用 GELU（不是 OpenAI CLIP 的 quick_gelu）
        layer_norm_eps=1e-5,
        attention_dropout=0.0,
        bos_token_id=49406,
        eos_token_id=49407,
        pad_token_id=49407,
    )

    out = {
        "embeddings.token_embedding.weight": state["token_embedding.weight"],
        "embeddings.position_embedding.weight": pos,
        "final_layer_norm.weight": state["ln_final.weight"],
        "final_layer_norm.bias": state["ln_final.bias"],
    }

    for i in range(int(n_layers)):
        b = f"transformer.resblocks.{i}."
        q, k, v = state[b + "attn.in_proj_weight"].chunk(3, dim=0)
        out[f"encoder.layers.{i}.self_attn.q_proj.weight"] = q
        out[f"encoder.layers.{i}.self_attn.k_proj.weight"] = k
        out[f"encoder.layers.{i}.self_attn.v_proj.weight"] = v
        qb, kb, vb = state[b + "attn.in_proj_bias"].chunk(3, dim=0)
        out[f"encoder.layers.{i}.self_attn.q_proj.bias"] = qb
        out[f"encoder.layers.{i}.self_attn.k_proj.bias"] = kb
        out[f"encoder.layers.{i}.self_attn.v_proj.bias"] = vb
        out[f"encoder.layers.{i}.self_attn.out_proj.weight"] = state[b + "attn.out_proj.weight"]
        out[f"encoder.layers.{i}.self_attn.out_proj.bias"] = state[b + "attn.out_proj.bias"]
        out[f"encoder.layers.{i}.layer_norm1.weight"] = state[b + "ln_1.weight"]
        out[f"encoder.layers.{i}.layer_norm1.bias"] = state[b + "ln_1.bias"]
        out[f"encoder.layers.{i}.layer_norm2.weight"] = state[b + "ln_2.weight"]
        out[f"encoder.layers.{i}.layer_norm2.bias"] = state[b + "ln_2.bias"]
        out[f"encoder.layers.{i}.mlp.fc1.weight"] = state[b + "mlp.c_fc.weight"]
        out[f"encoder.layers.{i}.mlp.fc1.bias"] = state[b + "mlp.c_fc.bias"]
        out[f"encoder.layers.{i}.mlp.fc2.weight"] = state[b + "mlp.c_proj.weight"]
        out[f"encoder.layers.{i}.mlp.fc2.bias"] = state[b + "mlp.c_proj.bias"]

    text_model = CLIPTextModel(cfg)
    # CLIPTextModel 内部是 self.text_model = CLIPTextTransformer(...)，state_dict 自带
    # "text_model." 前缀，所以要补上（SD1.x/SDXL-CLIP-L 那条路径走的是 model.text_model，
    # 反而不带前缀，别搞混）
    missing, _unexpected = text_model.load_state_dict(
        {f"text_model.{k}": v for k, v in out.items()}, strict=False
    )
    if missing:
        raise ValueError(f"bigG 权重对不上，缺少 {len(missing)} 项，例如 {list(missing)[:3]}")

    projection = None
    proj = state.get("text_projection")
    if proj is not None:
        import torch.nn as nn

        lin = nn.Linear(int(width), int(width))
        # OpenCLIP 的用法是 x @ text_projection；HF nn.Linear 是 x @ weight.T，故存转置
        lin.weight.data = proj.t().contiguous().float()
        lin.bias.data.zero_()
        projection = lin

    print(f"[ok] bigG: {n_layers} 层 / hidden {width} / vocab {vocab_size}")
    return text_model, projection


def _load_sd_text_encoder(sd_path: str, which: str = "auto"):
    """
    从 SD 单文件 ckpt 里取 CLIP 文本塔，返回 (model, label, source)。

      SD1.x : cond_stage_model.transformer.text_model.*             -> CLIPModel（768）
      SDXL  : conditioner.embedders.0.transformer.text_model.*      -> CLIPModel（CLIP-L，768）
              conditioner.embedders.1.model.*                       -> OpenCLIP bigG（CLIP-G，1280）

    which: 'auto'（默认优先 CLIP-L）/ 'l' / 'g'
    """
    from safetensors import safe_open
    from transformers import CLIPModel

    if not os.path.isfile(sd_path):
        raise FileNotFoundError(f"文件不存在: {sd_path}")

    base = os.path.basename(sd_path)
    prefixes = SD_TEXT_PREFIXES + ("conditioner.embedders.0.transformer.",)

    with safe_open(sd_path, framework="pt", device="cpu") as f:
        all_keys = list(f.keys())

        prefix = None
        for p in prefixes:
            if any(k.startswith(p + "text_model.") for k in all_keys):
                prefix = p
                break

        has_bigg = any(k.startswith("conditioner.embedders.1.model.") for k in all_keys)

        if which == "g" and not has_bigg:
            raise ValueError("该 ckpt 里没有 OpenCLIP bigG 文本塔（conditioner.embedders.1）")

        use_g = which == "g" or (which == "auto" and prefix is None and has_bigg)

        if use_g:
            gp = "conditioner.embedders.1.model."
            gkeys = [k for k in all_keys if k.startswith(gp)]
            gstate = {k[len(gp):]: f.get_tensor(k).float() for k in gkeys}

        if not use_g:
            if prefix is None:
                raise ValueError("该文件里找不到 CLIP text_model 权重（既不是 SD1.x 也不是 SDXL？）")
            inner = prefix + "text_model."
            tm_keys = [k for k in all_keys if k.startswith(inner)]
            # 目标是 model.text_model（CLIPTextModel），所以 "…text_model." 整段都要剥掉
            lstate = {k[len(inner):]: f.get_tensor(k).float() for k in tm_keys}

    if use_g:
        text_model, projection = _bigG_from_openclip(gstate)
        print(f"[ok] 已从 {base} 载入 CLIP-G（OpenCLIP bigG，{len(gkeys)} 个张量）")
        return _TextTower(text_model, projection), f"SDXL CLIP-G · {base}", "sd-ckpt-g"

    # transformers 里 position_ids 是 non-persistent buffer，不在 state_dict 里
    lstate.pop("embeddings.position_ids", None)

    model = CLIPModel.from_pretrained(MODEL_NAME)
    missing, _unexpected = model.text_model.load_state_dict(lstate, strict=False)
    if missing:
        raise ValueError(f"权重对不上，缺少 {len(missing)} 项，例如 {list(missing)[:3]}")

    suffix = "CLIP-L" if prefix.startswith("conditioner.embedders.0") else "text encoder"
    print(f"[ok] 已从 {base} 载入 {suffix}（{len(tm_keys)} 个张量）")
    return model, f"SD ckpt {suffix} · {base}", "sd-ckpt"


def build_model(
    clip_path: str | None = None, sd_path: str | None = None, sd_which: str = "auto"
):
    """按优先级构建模型：SD ckpt > 自定义 CLIP 路径 > 内置。"""
    from transformers import CLIPModel, CLIPTokenizer

    if sd_path:
        model, label, source = _load_sd_text_encoder(sd_path, sd_which)
        tokenizer = CLIPTokenizer.from_pretrained(MODEL_NAME)  # SD 系的词表与 CLIP 相同
        return model, tokenizer, label, source, sd_path

    if clip_path:
        model = CLIPModel.from_pretrained(clip_path)
        tokenizer = CLIPTokenizer.from_pretrained(clip_path)
        return model, tokenizer, clip_path, "clip-path", clip_path

    model = CLIPModel.from_pretrained(MODEL_NAME)
    tokenizer = CLIPTokenizer.from_pretrained(MODEL_NAME)
    return model, tokenizer, MODEL_NAME, "builtin", "builtin"


# ------------------------------------------- 文件格式嗅探（决定走哪条路）
def sniff_model_file(path: str) -> dict:
    """
    只读 safetensors 头部（毫秒级），判断这个文件该走哪条加载路径：

      comfy -> ComfyUI 私有量化格式（convrot_w4a4 / fp8_scaled 等）或 LLM 文本塔，
               只能用 ComfyUI 自己的加载栈；
      hf    -> 标准 SD1.x / SDXL / CLIP 权重，可被 transformers 解析。
    """
    if os.path.isdir(path):
        return {"route": "hf", "kind": "dir", "reason": "本地目录（HF 模型）"}

    if not path.lower().endswith(".safetensors"):
        return {"route": "hf", "kind": "other", "reason": "非 safetensors，交给 transformers 处理"}

    import struct

    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))

    meta = header.pop("__metadata__", None) or {}
    keys = list(header)

    quant = None
    raw_quant = meta.get("_quantization_metadata")
    if raw_quant:
        try:
            quant = json.loads(raw_quant)
        except Exception:  # noqa: BLE001
            quant = {"format_version": "unparsed"}

    if quant or any(k.endswith(".weight_scale") for k in keys[:3000]):
        fmt = (quant or {}).get("format_version") or "unknown"
        return {
            "route": "comfy",
            "kind": "quantized",
            "reason": f"ComfyUI 量化格式（format_version={fmt}）",
            "tensors": len(keys),
        }

    if any(k.startswith("conditioner.embedders.") for k in keys):
        return {"route": "hf", "kind": "sdxl", "reason": "SDXL 单文件 ckpt"}

    if any(k.startswith("cond_stage_model.transformer.text_model.") for k in keys):
        return {"route": "hf", "kind": "sd1", "reason": "SD1.x 单文件 ckpt"}

    if any(k.startswith("text_model.encoder.layers.") for k in keys):
        return {"route": "hf", "kind": "clip", "reason": "独立的 CLIP text encoder"}

    if any(k.startswith("model.language_model.") or k.startswith("model.layers.") for k in keys):
        return {
            "route": "comfy",
            "kind": "llm",
            "reason": "LLM 系文本塔（需要 ComfyUI 的 tokenizer / chat 模板）",
            "tensors": len(keys),
        }

    return {"route": "hf", "kind": "unknown", "reason": "未识别的 safetensors，先按 transformers 尝试"}


# ------------------------------------- 「从 ComfyUI 读取」可用 CLIP 列表
def _comfy_get(path: str, timeout: int = 30):
    url = COMFY_API.rstrip("/") + path
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.load(resp)


def _resolve_comfy_clip_path(name: str):
    """把 ComfyUI 的 clip_name 还原成本机真实文件路径。"""
    rel = str(name).replace("/", os.sep).replace("\\", os.sep)
    for root in (
        os.path.join(COMFY_MODELS_ROOT, "text_encoders"),
        os.path.join(COMFY_MODELS_ROOT, "clip"),
    ):
        cand = os.path.join(root, rel)
        if os.path.isfile(cand):
            return cand
    return None


def comfy_current_clip() -> dict:
    """
    读出「ComfyUI 当前在用的 CLIP」：从 /api/jobs + /history 里找最近一次实际执行的
    CLIPLoader 节点，取它的 clip_name / type，再还原成本机真实路径。

    ComfyUI 没有暴露"内存里加载了哪个模型对象"的接口，但最近执行过的工作流定义
    就写在 history 里，而用过的模型一般都还在显存/内存里 —— 这是最接近的答案。
    """
    ids: list[str] = []
    try:
        jobs = _comfy_get("/api/jobs")
        ids = [j.get("id") for j in (jobs.get("jobs") or []) if j.get("id")]
    except Exception:  # noqa: BLE001
        pass

    history = _comfy_get("/history?max_items=10")
    if not ids:
        ids = list(history)

    for pid in ids:
        entry = history.get(pid)
        if not entry:
            continue
        prompt = entry.get("prompt") or []
        nodes = prompt[2] if len(prompt) > 2 else {}
        for nid, node in nodes.items():
            if str((node or {}).get("class_type")) != "CLIPLoader":
                continue
            ins = node.get("inputs") or {}
            name = ins.get("clip_name")
            if not name:
                continue
            resolved = _resolve_comfy_clip_path(name)
            return {
                "name": name,
                "type": ins.get("type"),
                "device": ins.get("device"),
                "nodeId": nid,
                "promptId": pid,
                "path": resolved,
                "exists": resolved is not None,
                "api": COMFY_API,
            }

    raise RuntimeError(
        "ComfyUI 的执行记录里还没有 CLIPLoader —— 先在 ComfyUI 里跑一次工作流（或历史被清空了）"
    )


def comfy_clip_list() -> dict:
    """
    问 ComfyUI 要 CLIPLoader 的可选项（clip_name / type），
    再把 clip_name 还原成这台机器上的真实文件路径，供前端直接选用。
    """
    url = COMFY_API.rstrip("/") + "/object_info/CLIPLoader"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"连不上 ComfyUI（{COMFY_API}）：{type(exc).__name__}: {exc}。"
            "可用环境变量 COMFYUI_API 指定地址，例如 http://127.0.0.1:8188"
        ) from exc

    info = data.get("CLIPLoader") or {}
    required = (info.get("input") or {}).get("required") or {}

    def options(key):
        v = required.get(key)
        if isinstance(v, list) and v and isinstance(v[0], list):
            return list(v[0])
        return []

    names = options("clip_name")
    types = options("type")

    items = []
    for name in names:
        resolved = _resolve_comfy_clip_path(name)
        items.append({"name": name, "path": resolved, "exists": resolved is not None})

    return {
        "api": COMFY_API,
        "modelsRoot": COMFY_MODELS_ROOT,
        "clipNames": names,
        "types": types,
        "items": items,
        "found": sum(1 for i in items if i["exists"]),
    }


# --------------------------------------------- ComfyUI 原生加载（Qwen 系等）
def _ensure_comfy():
    if COMFY_ROOT not in sys.path:
        sys.path.insert(0, COMFY_ROOT)
    import comfy.sd as comfy_sd  # noqa: PLC0415

    return comfy_sd


def _load_comfy_clip(sd_path: str, type_name: str):
    """
    用 ComfyUI 自己的加载栈加载文本编码器 —— 与 ComfyUI 里「加载CLIP」节点同一条路。
    这是唯一能吃下 ComfyUI 私有量化格式（如 convrot_w4a4）的方式。

    type_name 取 ComfyUI 里「类型」下拉的值，例如 krea2 / qwen_image / flux …
    """
    comfy_sd = _ensure_comfy()

    if not os.path.isfile(sd_path):
        raise FileNotFoundError(f"文件不存在: {sd_path}")

    name = str(type_name or "").strip()
    if name.lower() in ("", "auto"):
        # 中性类型：comfy 自己会按权重 detect_te_model，LLM 文本塔一般落到通用分支
        ct = comfy_sd.CLIPType.STABLE_DIFFUSION
    else:
        ct = getattr(comfy_sd.CLIPType, name.upper(), None)
        if ct is None:
            raise ValueError(f"ComfyUI 里没有这个 CLIP 类型: {name}")

    return comfy_sd.load_clip([sd_path], embedding_directory=None, clip_type=ct)


def _comfy_encode_features(words):
    """
    用 ComfyUI 的 CLIP 对象给文本算特征。

    机制提醒：Qwen 系的文本塔是完整 LLM（会套 chat 模板），输出是
    [B, seq, layers*hidden] 的序列表示，没有 CLIP 那种 pooled 语义向量。
    这里取「最后一个位置」的向量（因果注意力下它聚合了整段）再归一化。
    """
    import torch

    clip = _state["comfy_clip"]
    vecs = []
    for w in words:
        tokens = clip.tokenize(w)
        out = clip.encode_from_tokens(tokens, return_pooled=True)
        cond = out[0] if isinstance(out, (tuple, list)) else out
        if cond.dim() != 3:
            raise ValueError(f"意外的编码输出形状: {tuple(cond.shape)}")
        vecs.append(cond[0, -1, :].detach().float().cpu())

    mat = torch.stack(vecs, dim=0)
    return mat / mat.norm(dim=-1, keepdim=True)


def _current_hf_tokenizer():
    """拿到当前模型底层的 HF tokenizer（用于分词展示）。"""
    if _state.get("comfy_clip") is not None:
        tk = _state["comfy_clip"].tokenizer
        inner = getattr(tk, getattr(tk, "clip_name", ""), None) or tk
        return getattr(inner, "tokenizer", None)
    return _state.get("tokenizer")


def _raw_piece_to_text(tok, raw: str) -> str:
    """byte-level BPE 片段 -> 可读文本（CLIP 与 Qwen 都用 byte_decoder 映射）。"""
    body = raw[:-4] if raw.endswith("</w>") else raw
    bd = getattr(tok, "byte_decoder", None)
    if not bd:
        return body
    try:
        data = bytes(bd[c] for c in body if c in bd)
    except Exception:  # noqa: BLE001
        return body
    return data.decode("utf-8", errors="replace")


def tokenize_with_current(text: str) -> dict:
    """
    用「当前加载的模型」的分词器切分文本，仅供展示 —— 不带 chat 模板，
    这样切到 krea2/Qwen 时就能直接看到它的词表怎么切（例如 张三丰 -> 3 个 token）。
    """
    tok = _current_hf_tokenizer()
    if tok is None:
        raise ValueError("当前模型没有可用的 tokenizer")

    ids = list(tok.encode(text, add_special_tokens=False))
    pieces = tok.convert_ids_to_tokens(ids)

    items = [
        {"id": int(t), "token": raw, "text": _raw_piece_to_text(tok, raw)}
        for t, raw in zip(ids, pieces)
    ]

    try:
        decoded = tok.decode(ids, skip_special_tokens=True)
    except Exception:  # noqa: BLE001
        decoded = ""

    return {
        "text": text,
        "tokenizer": type(tok).__name__,
        "vocabSize": getattr(tok, "vocab_size", None),
        "items": items,
        "decoded": decoded,
        "model": _state.get("model_label"),
        "source": _state.get("model_source"),
    }


def _require_hf_tower(feature: str):
    """整表检索类功能只支持 CLIP 系文本塔。"""
    if _state.get("comfy_clip") is not None:
        raise ValueError(
            f"当前用的是从 ComfyUI 加载的 LLM 文本塔（逐词套 chat 模板），不支持{feature}。"
            "请切回 CLIP 系模型（内置 / SD ckpt / 自定义 CLIP 路径）。"
        )


def _release_model() -> None:
    """释放当前模型，并清掉依赖它的缓存（词表矩阵 / 相似度基线）。"""
    old = _state.get("model")
    _state["model"] = None
    _state["tokenizer"] = None
    _state["comfy_clip"] = None
    if old is not None:
        del old
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass

    _state.update(
        matrix=None,
        matrix_ready=False,
        matrix_progress=0,
        matrix_total=0,
        matrix_limit=0,
        matrix_error=None,
        matrix_source=None,
    )
    _baseline_cache.clear()


def apply_model(
    clip_path: str | None = None,
    sd_path: str | None = None,
    sd_which: str = "auto",
    comfy_type: str | None = None,
) -> dict:
    """
    切换模型：先在 CPU 上把新模型构建好，成功后才释放旧模型并挂载。
    这样即使新路径有问题、加载失败，旧的仍然可用。
    """
    import torch

    with _lock:
        if (
            _state["ready"]
            and not clip_path
            and not sd_path
            and _state["model_source"] == "builtin"
        ):
            return {"changed": False, "reason": "当前已经是内置模型"}

        torch.set_grad_enabled(False)
        _state["torch"] = torch
        device = _resolve_device(torch)

        # ---- 自动嗅探文件格式，决定走哪条路
        sniff = None
        if sd_path and not comfy_type:
            try:
                sniff = sniff_model_file(sd_path)
                print(f"[·] 嗅探 {os.path.basename(sd_path)}: {sniff['reason']} => {sniff['route']}")
                if sniff["route"] == "comfy":
                    comfy_type = "auto"
            except Exception as exc:  # noqa: BLE001
                print(f"[!] 嗅探失败，按 transformers 尝试: {exc}")

        # ---- ComfyUI 原生加载（Qwen 系等 ComfyUI 私有量化格式）
        if comfy_type:
            if not sd_path:
                raise ValueError("用 ComfyUI 类型加载时，必须同时给出文件路径")
            clip = _load_comfy_clip(sd_path, comfy_type)
            _release_model()
            _state["comfy_clip"] = clip
            _state["model_label"] = f"ComfyUI[{comfy_type}] · {os.path.basename(sd_path)}"
            _state["model_source"] = "comfy"
            _state["model_key"] = f"{comfy_type}:{sd_path}"
            _state["ready"] = True
            _state["error"] = None
            print(f"[ok] 模型已就绪: {_state['model_label']}  source=comfy")
            return {
                "changed": True,
                "label": _state["model_label"],
                "source": "comfy",
                "device": "由 ComfyUI 管理",
                "detected": sniff,
            }

        model, tokenizer, label, source, key = build_model(clip_path, sd_path, sd_which)
        model.eval()

        actual_device = "cpu"
        if device == "cuda":
            try:
                model = model.to("cuda")
                actual_device = "cuda"
            except Exception as exc:  # noqa: BLE001
                print(f"[!] 新模型放不上显卡（{exc}），改用 CPU")
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

        _release_model()
        _state["model"] = model
        _state["tokenizer"] = tokenizer
        _state["model_label"] = label
        _state["model_source"] = source
        _state["model_key"] = key
        _state["ready"] = True
        _state["error"] = None

        print(f"[ok] 模型已就绪: {label}  source={source}  device={actual_device}")
        result = {"changed": True, "label": label, "source": source, "device": actual_device}
        if sniff is not None:
            result["detected"] = sniff
        return result


def load_model() -> None:
    """启动时预热：加载内置模型（不预计算词表矩阵）。"""
    with _lock:
        if _state["ready"] or _state["error"]:
            return

    try:
        import torch

        torch.set_grad_enabled(False)
        apply_model()
    except Exception as exc:  # noqa: BLE001
        _state["error"] = f"{type(exc).__name__}: {exc}"
        print(f"[x] 模型加载失败: {_state['error']}")


def encode_features(words):
    """归一化后的文本特征向量（等价于 F.normalize(model.get_text_features(...), dim=-1)）"""
    if _state.get("comfy_clip") is not None:
        return _comfy_encode_features(list(words))

    tok = _state["tokenizer"]
    model = _state["model"]
    torch = _state["torch"]
    batch = tok(list(words), padding=True, truncation=True, return_tensors="pt")
    if DEVICE == "cuda":
        batch = {k: v.to("cuda") for k, v in batch.items()}
    feats = model.get_text_features(**batch)
    return feats / feats.norm(dim=-1, keepdim=True)


def baseline_for(reference: str, n: int = 24):
    """
    乱码基线：CLIP 的文本嵌入存在“各向异性”，任意短文本之间的余弦相似度普遍偏高
    （0.7~0.95），乱码词甚至可能比语义相关的词还高。所以必须给出相对基线。
    """
    if reference in _baseline_cache:
        return _baseline_cache[reference]

    rng = random.Random(20240515)
    words = [
        "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(rng.randint(5, 10)))
        for _ in range(n)
    ]
    feats = encode_features([reference] + words)
    sims = (feats[1:] @ feats[0]).tolist()
    value = sum(sims) / len(sims)
    _baseline_cache[reference] = (value, words)
    return value, words


def compute_similarity(reference: str, words) -> dict:
    uniq: list[str] = []
    for raw in words:
        w = str(raw).strip()
        if w and w not in uniq:
            uniq.append(w)

    if not uniq:
        return {
            "reference": reference,
            "baseline": None,
            "items": [],
            "model": MODEL_NAME,
            "device": DEVICE,
        }

    feats = encode_features([reference] + uniq)
    sims = (feats[1:] @ feats[0]).tolist()
    base, base_words = baseline_for(reference)

    items = [{"word": w, "sim": round(float(s), 6)} for w, s in zip(uniq, sims)]
    items.sort(key=lambda x: -x["sim"])

    return {
        "reference": reference,
        "baseline": round(float(base), 6),
        "baselineWords": base_words,
        "items": items,
        "model": MODEL_NAME,
        "device": DEVICE,
    }


# ------------------------------------------- 词表嵌入矩阵 / Top-K 相似词
def _model_tag() -> str:
    """缓存标签：不同模型算出的词表矩阵不能混用。"""
    source = _state.get("model_source") or "builtin"
    if source == "builtin":
        return "builtin"
    key = _state.get("model_key") or ""
    return f"{source}-{hashlib.md5(key.encode('utf-8')).hexdigest()[:8]}"


def _matrix_cache_path(limit: int):
    tag = _model_tag()
    # 内置模型沿用早期命名，避免历史缓存作废
    if tag == "builtin":
        return CACHE_DIR / f"vocab_emb_{limit}_fp16.npy"
    return CACHE_DIR / f"vocab_emb_{tag}_{limit}_fp16.npy"


def _compute_matrix(limit: int, start: int, end: int, batch_size: int, use_cuda: bool):
    """按 batch 逐段计算前 limit 个 token 的特征并归一化。"""
    torch = _state["torch"]
    model = _state["model"]
    rows = []
    for i in range(0, limit, batch_size):
        ids = torch.tensor([[start, j, end] for j in range(i, min(i + batch_size, limit))])
        if use_cuda:
            ids = ids.to("cuda")
        feats = model.get_text_features(input_ids=ids)
        feats = feats / feats.norm(dim=-1, keepdim=True)
        rows.append(feats.detach().float().cpu())
        _state["matrix_progress"] = min(i + batch_size, limit)
    return torch.cat(rows, dim=0)


def build_vocab_matrix(limit: int | None = None, force: bool = False) -> None:
    """
    预计算词表**前 limit 个** token 的文本特征（limit 可自定义，默认 10000）。

    每个 token 的输入形如 [<|startoftext|>, id, <|endoftext|>]，所以当某个单词恰好是
    单个 token 时，它的向量与 tokenizer("word") 得到的结果完全一致。

    计算设备优先用显卡；显存不足或 OOM 时自动降级到 CPU 重算。
    """
    if _state.get("comfy_clip") is not None:
        _state["matrix_error"] = "当前是 ComfyUI 的 LLM 文本塔，不支持整表预计算（请切回 CLIP 系模型）"
        print(f"[!] {_state['matrix_error']}")
        return

    if not _matrix_lock.acquire(blocking=False):
        print("[!] 已有预计算任务在进行，忽略本次请求")
        return

    try:
        # 等模型加载完
        while not _state["ready"] and not _state["error"]:
            time.sleep(0.3)
        if not _state["ready"]:
            return

        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415

        tok = _state["tokenizer"]
        model = _state["model"]
        vocab_size = len(tok)
        limit = max(100, min(int(limit or DEFAULT_LIMIT), vocab_size))

        _state.update(
            matrix_total=limit,
            matrix_progress=0,
            matrix_error=None,
            matrix_ready=False,
            matrix_building=True,
        )

        # 1) 复用磁盘缓存
        cache = _matrix_cache_path(limit)
        if cache.exists() and not force:
            mat = torch.from_numpy(np.load(cache).astype("float32"))
            _state.update(
                matrix=mat,
                matrix_ready=True,
                matrix_progress=limit,
                matrix_limit=limit,
                matrix_source="cache",
            )
            print(f"[ok] 复用词表嵌入缓存: {cache.name} {tuple(mat.shape)}")
            return

        start = tok.bos_token_id if tok.bos_token_id is not None else 49406
        end = tok.eos_token_id if tok.eos_token_id is not None else 49407

        # 2) 决定尝试序列：显存够就用显卡，否则直接 CPU
        attempts: list[tuple[str, int]] = []
        if DEVICE == "cuda":
            free, _total = torch.cuda.mem_get_info()
            if free > 2 * 1024**3:
                attempts.append(("cuda", 2048))
                attempts.append(("cuda", 256))
            else:
                print(f"[!] 显存仅剩 {free / 1024**3:.2f} GiB，词表矩阵改用 CPU 计算")
        attempts.append(("cpu", 512))

        last_err: Exception | None = None
        for target, batch_size in attempts:
            moved_to_cpu = False
            try:
                if target == "cpu" and DEVICE == "cuda":
                    model.to("cpu")  # 临时挪到内存，避免占用显存
                    torch.cuda.empty_cache()
                    moved_to_cpu = True

                _state["matrix_progress"] = 0
                mat = _compute_matrix(limit, start, end, batch_size, target == "cuda")
                _state.update(
                    matrix=mat,
                    matrix_ready=True,
                    matrix_limit=limit,
                    matrix_source=target,
                )

                try:
                    CACHE_DIR.mkdir(parents=True, exist_ok=True)
                    np.save(cache, mat.numpy().astype("float16"))
                    saved = f" -> {cache.name}"
                except Exception as exc:  # noqa: BLE001
                    saved = f"（缓存写入失败: {exc}）"
                print(f"[ok] 词表嵌入矩阵 {tuple(mat.shape)} 由 {target} 算完{saved}")
                return
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if "out of memory" not in str(exc).lower():
                    raise
                print(f"[!] {target} 计算 OOM，尝试下一档…")
            finally:
                if moved_to_cpu:
                    model.to("cuda")
                    torch.cuda.empty_cache()

        raise RuntimeError(f"所有计算设备均失败: {last_err}")
    except Exception as exc:  # noqa: BLE001
        _state["matrix_error"] = f"{type(exc).__name__}: {exc}"
        _state["matrix_ready"] = False
        print(f"[x] 词表嵌入矩阵构建失败: {_state['matrix_error']}")
    finally:
        _state["matrix_building"] = False
        _matrix_lock.release()


def nearest_words(word: str, top_k: int = 20) -> dict:
    """在整张词表里找与 word 最接近的 top_k 个 token。"""
    _require_hf_tower("整表 Top-K 检索")
    torch = _state["torch"]
    tok = _state["tokenizer"]
    model = _state["model"]

    enc = tok([word], padding=True, truncation=True, return_tensors="pt")
    source_ids = enc["input_ids"][0].tolist()
    if DEVICE == "cuda":
        enc = {k: v.to("cuda") for k, v in enc.items()}

    q = model.get_text_features(**enc)
    q = (q / q.norm(dim=-1, keepdim=True))[0].float().cpu()

    sims = _state["matrix"] @ q

    # 屏蔽 begin / end / pad 等特殊 token
    for sid in {tok.bos_token_id, tok.eos_token_id, tok.pad_token_id}:
        if sid is not None and 0 <= sid < sims.numel():
            sims[sid] = -1.0

    k = max(1, min(int(top_k), 200))
    values, indices = torch.topk(sims, k)

    items = []
    for score, idx in zip(values.tolist(), indices.tolist()):
        items.append({"id": idx, "token": tok.decoder.get(idx, ""), "sim": round(float(score), 6)})

    return {
        "word": word,
        "sourceIds": source_ids,
        "scanned": int(_state["matrix"].shape[0]),
        "items": items,
        "model": MODEL_NAME,
        "device": DEVICE,
    }


# ------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "ClipTokenLookup/1.0"

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("  %s\n" % (fmt % args))

    # -- helpers
    def _json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        file_path = (DIST / rel).resolve()
        if not str(file_path).startswith(str(DIST.resolve())):
            self.send_error(403)
            return
        if file_path.is_dir():
            file_path = file_path / "index.html"
        if not file_path.exists():
            file_path = DIST / "index.html"  # SPA 回退
        if not file_path.exists():
            self.send_error(404, "dist/index.html 不存在，请先执行 npm run build")
            return

        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(file_path.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- routes
    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path == "/api/status":
            self._json({
                "ready": _state["ready"],
                "error": _state["error"],
                "model": _state["model_label"],
                "modelBuiltin": MODEL_NAME,
                "modelSource": _state["model_source"],
                "device": DEVICE if _state["ready"] else None,
                "matrix": {
                    "ready": _state["matrix_ready"],
                    "building": _state["matrix_building"],
                    "progress": _state["matrix_progress"],
                    "total": _state["matrix_total"],
                    "limit": _state["matrix_limit"],
                    "vocabSize": len(_state["tokenizer"]) if _state["tokenizer"] is not None else 49408,
                    "error": _state["matrix_error"],
                    "source": _state["matrix_source"],
                },
            })
            return
        if path == "/api/comfy/current":
            try:
                self._json(comfy_current_clip())
            except Exception as exc:  # noqa: BLE001
                self._json({"error": str(exc)}, 404)
            return
        if path == "/api/comfy/list":
            try:
                self._json(comfy_clip_list())
            except Exception as exc:  # noqa: BLE001
                self._json({"error": str(exc)}, 500)
            return
        self._static(path)

    def do_POST(self):  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path not in ("/api/similarity", "/api/nearest", "/api/matrix/build", "/api/model/reload", "/api/tokenize"):
            self._json({"error": "not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")

            # ---- 切换 / 重载模型（两个路径都留空 = 回到内置模型）
            if path == "/api/model/reload":
                clip_path = str(payload.get("clipPath") or "").strip() or None
                sd_path = str(payload.get("sdPath") or "").strip() or None
                sd_which = str(payload.get("sdWhich") or "auto").strip().lower()
                if sd_which not in ("auto", "l", "g"):
                    sd_which = "auto"
                comfy_type = str(payload.get("comfyType") or "").strip() or None
                try:
                    self._json(apply_model(clip_path, sd_path, sd_which, comfy_type))
                except Exception as exc:  # noqa: BLE001
                    self._json({"error": f"重载失败: {type(exc).__name__}: {exc}"}, 500)
                return

            if not _state["ready"]:
                self._json(
                    {
                        "error": _state["error"]
                        or "还没有加载任何模型 —— 请在界面顶部「自定义模型路径」里选择后点「重载」",
                        "loading": False,
                    },
                    503,
                )
                return

            # ---- 用当前模型的分词器切分（仅供展示，不带 chat 模板）
            if path == "/api/tokenize":
                text = str(payload.get("text") or "")
                try:
                    self._json(tokenize_with_current(text))
                except Exception as exc:  # noqa: BLE001
                    self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
                return

            # ---- 触发/重建词表嵌入矩阵（自定义预计算的 token 数）
            if path == "/api/matrix/build":
                if _state["matrix_building"]:
                    self._json({"started": False, "reason": "已有预计算任务正在进行"}, 409)
                    return
                limit = int(payload.get("limit") or DEFAULT_LIMIT)
                force = bool(payload.get("force"))
                threading.Thread(
                    target=build_vocab_matrix, args=(limit, force), daemon=True
                ).start()
                self._json({"started": True, "limit": limit, "force": force})
                return

            # ---- Top-K 相似词
            if path == "/api/nearest":
                word = str(payload.get("word") or "").strip()
                if not word:
                    self._json({"error": "缺少待查词 word"}, 400)
                    return
                if not _state["matrix_ready"]:
                    self._json(
                        {
                            "error": _state["matrix_error"] or "词表嵌入矩阵仍在构建中，请稍候",
                            "building": not _state["matrix_error"],
                        },
                        503,
                    )
                    return
                self._json(nearest_words(word, payload.get("topK") or 20))
                return

            # ---- 参照词相似度
            reference = str(payload.get("reference") or "").strip()
            words = payload.get("words") or []
            if not reference:
                self._json({"error": "缺少参照词 reference"}, 400)
                return
            self._json(compute_similarity(reference, words))
        except Exception as exc:  # noqa: BLE001
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)


def main() -> None:
    if not (DIST / "index.html").exists():
        print(f"[!] 未找到 {DIST / 'index.html'}，界面无法打开（可在项目目录执行 npm run build）")

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"CLIP Token 查询器 -> http://127.0.0.1:{PORT}")
    print("启动时不加载任何模型（内置 CLIP 也改为按需）")
    print("请在界面「自定义模型路径」里选择后点「重载」；词表矩阵同样需在「相似词 Top-K」页手动预计算")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
