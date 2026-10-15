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

import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "5199"))
MODEL_NAME = os.environ.get("CLIP_MODEL", "openai/clip-vit-large-patch14")
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
}
_baseline_cache: dict = {}


# --------------------------------------------------------------------- 模型
def load_model() -> None:
    """懒加载 + 启动时预热。"""
    global DEVICE

    with _lock:
        if _state["ready"] or _state["error"]:
            return
        try:
            import torch
            from transformers import CLIPModel, CLIPTokenizer

            torch.set_grad_enabled(False)

            # 解析目标设备
            if DEVICE == "auto":
                DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
            elif DEVICE == "cuda" and not torch.cuda.is_available():
                print("[!] 未检测到可用 CUDA，自动回退到 CPU")
                DEVICE = "cpu"

            model = CLIPModel.from_pretrained(MODEL_NAME).eval()
            if DEVICE == "cuda":
                model = model.to("cuda")

            _state["model"] = model
            _state["tokenizer"] = CLIPTokenizer.from_pretrained(MODEL_NAME)
            _state["torch"] = torch
            _state["ready"] = True

            if DEVICE == "cuda":
                name = torch.cuda.get_device_name(0)
                alloc = torch.cuda.memory_allocated(0) / 1024**2
                print(f"[ok] CLIP 文本塔已加载: {MODEL_NAME}  device=cuda ({name})  {alloc:.0f} MB")
            else:
                print(f"[ok] CLIP 文本塔已加载: {MODEL_NAME}  device=cpu")
        except Exception as exc:  # noqa: BLE001
            _state["error"] = f"{type(exc).__name__}: {exc}"
            print(f"[x] 模型加载失败: {_state['error']}")


def encode_features(words):
    """归一化后的文本特征向量（等价于 F.normalize(model.get_text_features(...), dim=-1)）"""
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
def _matrix_cache_path(limit: int):
    return CACHE_DIR / f"vocab_emb_{limit}_fp16.npy"


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
                "model": MODEL_NAME,
                "device": DEVICE,
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
        self._static(path)

    def do_POST(self):  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path not in ("/api/similarity", "/api/nearest", "/api/matrix/build"):
            self._json({"error": "not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")

            if not _state["ready"]:
                self._json(
                    {"error": _state["error"] or "模型仍在加载中，请稍候重试", "loading": not _state["error"]},
                    503,
                )
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

    threading.Thread(target=load_model, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"CLIP Token 查询器 -> http://127.0.0.1:{PORT}")
    print(f"模型 {MODEL_NAME} 后台加载中")
    print("词表嵌入矩阵不会自动预计算，请在界面「相似词 Top-K」页设置范围后手动触发")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
