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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "5199"))
MODEL_NAME = os.environ.get("CLIP_MODEL", "openai/clip-vit-large-patch14")
DEVICE = os.environ.get("CLIP_DEVICE", "cpu")

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

_lock = threading.Lock()
_state = {"model": None, "tokenizer": None, "torch": None, "ready": False, "error": None}
_baseline_cache: dict = {}


# --------------------------------------------------------------------- 模型
def load_model() -> None:
    """懒加载 + 启动时预热。CPU 上加载 CLIP-L 文本塔约 10~30 秒。"""
    with _lock:
        if _state["ready"] or _state["error"]:
            return
        try:
            import torch
            from transformers import CLIPModel, CLIPTokenizer

            torch.set_grad_enabled(False)
            model = CLIPModel.from_pretrained(MODEL_NAME).eval()
            if DEVICE == "cuda" and torch.cuda.is_available():
                model = model.to("cuda")
            _state["model"] = model
            _state["tokenizer"] = CLIPTokenizer.from_pretrained(MODEL_NAME)
            _state["torch"] = torch
            _state["ready"] = True
            print(f"[ok] CLIP 文本塔已加载: {MODEL_NAME}  device={DEVICE}")
        except Exception as exc:  # noqa: BLE001
            _state["error"] = f"{type(exc).__name__}: {exc}"
            print(f"[x] 模型加载失败: {_state['error']}")


def encode_features(words):
    """归一化后的文本特征向量（等价于 F.normalize(model.get_text_features(...), dim=-1)）"""
    tok = _state["tokenizer"]
    model = _state["model"]
    torch = _state["torch"]
    batch = tok(list(words), padding=True, truncation=True, return_tensors="pt")
    if DEVICE == "cuda" and torch.cuda.is_available():
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
            })
            return
        self._static(path)

    def do_POST(self):  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path != "/api/similarity":
            self._json({"error": "not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            reference = str(payload.get("reference") or "").strip()
            words = payload.get("words") or []

            if not reference:
                self._json({"error": "缺少参照词 reference"}, 400)
                return
            if not _state["ready"]:
                self._json(
                    {"error": _state["error"] or "模型仍在加载中，请稍候重试", "loading": not _state["error"]},
                    503,
                )
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
    print(f"模型 {MODEL_NAME} 正在后台加载，就绪后可查词义相似度（Ctrl+C 退出）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
