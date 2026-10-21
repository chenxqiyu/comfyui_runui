# -*- coding: utf-8 -*-
"""
runtest.py —— 打印「运行中的 ComfyUI 进程里真正已加载的模型对象」

不是重新加载。COM 进程里的 Python 对象外部脚本读不到，所以真正的读取发生在
ComfyUI 进程内部：custom_nodes/ComfyUI-LiveModels 那个只读节点把
comfy.model_management.current_loaded_models 采出来，开了两个端点：

    GET /livemodels/now      JSON（同时落一份到节点目录的 loaded_models.json）
    GET /livemodels/text     纯文本报告

本脚本就是这两个端点的薄客户端，顺带把对象地址（id）一起打出来 —— 那个地址就是
内存里真实对象的身份，重新加载出来的对象不可能有同样的地址。

用法：
    python runtest.py            # 打印文本报告
    python runtest.py --json     # 打印原始 JSON
    python runtest.py --watch 2  # 每 2 秒刷新一次

前提：custom_nodes/ComfyUI-LiveModels 已被 ComfyUI 加载（装好后需重启一次 ComfyUI）。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_API = os.environ.get("COMFYUI_API", "http://127.0.0.1:8189").rstrip("/")
NODE_DIR = r"F:\ai\fastai\custom_nodes\ComfyUI-LiveModels"
FALLBACK_TEXT = os.path.join(NODE_DIR, "loaded_models.txt")
FALLBACK_JSON = os.path.join(NODE_DIR, "loaded_models.json")


def http_get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch(api, as_json=False):
    """返回 (内容, 来源说明, 状态)。端点不存在时退回到上次落盘的快照。"""
    path = "/livemodels/now" if as_json else "/livemodels/text"
    url = api + path
    try:
        body = http_get(url)
        return body, url, None
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise RuntimeError(f"HTTP {exc.code}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"连不上 ComfyUI（{api}）：{exc.reason}") from exc
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"请求失败：{type(exc).__name__}: {exc}") from exc

    # 端点 404 -> 节点还没被加载
    fallback = FALLBACK_JSON if as_json else FALLBACK_TEXT
    if os.path.isfile(fallback):
        with open(fallback, "r", encoding="utf-8") as f:
            body = f.read()
        if as_json:
            try:
                body = json.dumps(json.loads(body), ensure_ascii=False, indent=2)
            except Exception:  # noqa: BLE001
                pass
        return body, fallback + "（上次落盘的快照）", "MISSING"
    return "", "", "MISSING"


def main():
    parser = argparse.ArgumentParser(description="打印运行中 ComfyUI 进程里已加载的模型对象")
    parser.add_argument("--api", default=DEFAULT_API, help="ComfyUI 地址")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON")
    parser.add_argument("--watch", type=float, default=0, help="每隔 N 秒刷新一次")
    args = parser.parse_args()
    api = args.api.rstrip("/")

    while True:
        try:
            body, source, state = fetch(api, args.json)
        except RuntimeError as exc:
            print(f"[失败] {exc}")
            print("       用 --api 指定地址，例如 --api http://127.0.0.1:8188")
            return 1

        if state == "MISSING":
            print("=" * 70)
            print(" [未生效] ComfyUI 里没有 /livemodels/now 这个端点")
            print("=" * 70)
            print("  节点文件 : " + os.path.join(NODE_DIR, "__init__.py"))
            print(f"  文件存在 : {'是' if os.path.isfile(os.path.join(NODE_DIR, '__init__.py')) else '否'}")
            print("")
            print("  模型对象只活在 ComfyUI 进程里，外部脚本读不到，所以必须先让这个")
            print("  只读节点被加载：重启一次 ComfyUI 即可（之后就不用再管）。")
            print("")
            if body:
                print(f"  想先看上次落盘的快照（{source}）：")
                print("-" * 70)
                print(body)
            return 2

        if args.watch and not args.json:
            os.system("cls" if os.name == "nt" else "clear")
        print(f"[{source}]")
        print(body)
        if not args.watch:
            return 0
        time.sleep(args.watch)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
