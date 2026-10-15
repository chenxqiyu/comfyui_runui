# -*- coding: utf-8 -*-
"""
对比「内置原始 CLIP」与「SD ckpt 里的 text encoder（被微调过）」在同一批词上的表现。

  python tools/check_models.py
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5199"
SD = r"F:\aidraw\models\Stable-diffusion\chilloutmix_NiPrunedFp32Fix.safetensors"
REF = "girl"
WORDS = ["woman", "1girl", "dog", "cat", "masterpiece", "asdkjhqwezxc"]


def get(path, timeout=60):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.load(r)


def post(path, payload, timeout=900):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)


def wait_ready(tries=180):
    for _ in range(tries):
        try:
            s = get("/api/status")
            if s.get("ready"):
                return s
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit("service not ready")


def snapshot(tag):
    sim = post("/api/similarity", {"reference": REF, "words": WORDS})
    print(f"\n--- {tag} ---")
    print("  baseline = {:.4f}".format(sim["baseline"]))
    for it in sim["items"]:
        print("   {:16s} {:.4f}".format(it["word"], it["sim"]))
    return sim


def main():
    s = wait_ready()
    print("初始模型:", s["model"], "| source:", s.get("modelSource"), "| device:", s["device"])

    a = snapshot("内置 CLIP（原始 openai/clip-vit-large-patch14）")

    print("\n>>> 切换到 SD ckpt 的 text encoder")
    r = post("/api/model/reload", {"sdPath": SD})
    print("    reload ->", r)
    if "error" in r:
        sys.exit(1)
    wait_ready()
    b = snapshot("SD ckpt text encoder（chilloutmix）")

    print("\n=== 对比 ===")
    ma = {i["word"]: i["sim"] for i in a["items"]}
    mb = {i["word"]: i["sim"] for i in b["items"]}
    print("  {:16s} {:>10s} {:>10s} {:>10s}".format("word", "builtin", "sd-ckpt", "delta"))
    for w in WORDS:
        print("  {:16s} {:10.4f} {:10.4f} {:+10.4f}".format(w, ma[w], mb[w], mb[w] - ma[w]))
    print(
        "  {:16s} {:10.4f} {:10.4f} {:+10.4f}".format(
            "baseline", a["baseline"], b["baseline"], b["baseline"] - a["baseline"]
        )
    )

    print("\n>>> 恢复内置模型")
    print("    reload ->", post("/api/model/reload", {}))


if __name__ == "__main__":
    main()
