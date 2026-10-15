# -*- coding: utf-8 -*-
"""
用 ComfyUI 自己的加载栈（与 ComfyUI 里 CLIPLoader 节点同一条路）加载 Qwen3-VL 文本编码器，
并试探出如何从里面取到「词向量」。

  python tools/probe_comfy_clip.py
"""
import sys
import time

sys.path.insert(0, r"F:\ai\fastai")

CKPT = r"I:\夸克网盘\ComfyUI官方版\千问图像模型\qwtext_encoders\qwen3_vl_4b_abliterated-int4_convrot.safetensors"


def log(*a):
    print(*a, flush=True)


t0 = time.time()
import comfy.sd  # noqa: E402

log(f"[1] import comfy.sd  {time.time() - t0:.1f}s")

t0 = time.time()
log(f"[2] loading clip_type=KREA2 ...")
clip = comfy.sd.load_clip([CKPT], embedding_directory=None, clip_type=comfy.sd.CLIPType.KREA2)
log(f"    load_clip OK  {time.time() - t0:.1f}s  ->  {type(clip).__name__}")
log(f"    patcher model: {type(clip.patcher.model).__name__}")
try:
    log(f"    load_device  : {clip.patcher.load_device}")
except Exception as e:
    log(f"    load_device  : ? {e}")

log(f"[3] tokenizer: {type(clip.tokenizer).__name__}")
tokens = clip.tokenize("girl")
log(f"    tokenize('girl') -> {type(tokens).__name__} keys={list(tokens.keys()) if hasattr(tokens, 'keys') else '-'}")
try:
    for k, v in tokens.items():
        if isinstance(v, list) and v and isinstance(v[0], list):
            log(f"      {k}: {len(v)} batch, first batch len={len(v[0])}, head={v[0][:6]}")
        else:
            log(f"      {k}: {type(v).__name__}")
except Exception as e:
    log(f"    (inspect tokens failed: {e})")

log("[4] try encode_from_tokens ...")
try:
    res = clip.encode_from_tokens(tokens, return_pooled=True)
    log(f"    -> {type(res).__name__}")
    if isinstance(res, (tuple, list)):
        for i, o in enumerate(res):
            log(f"      [{i}] {type(o).__name__} shape={getattr(o, 'shape', None)} dtype={getattr(o, 'dtype', None)}")
            if hasattr(o, "shape") and o.dim() == 3:
                log(f"          (B,S,H) = {tuple(o.shape)}")
    else:
        log(f"      value: {type(res).__name__} {getattr(res, 'shape', None)}")
except Exception as e:
    log(f"    encode_from_tokens FAILED: {type(e).__name__}: {e}")

log("[done]")
