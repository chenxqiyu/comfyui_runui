# -*- coding: utf-8 -*-
"""
now.py —— 打印 ComfyUI 当前“已加载并激活”的工作流

只走 ComfyUI 自己的 HTTP API，不加载任何模型、不占显存，几秒出结果：
    /system_stats    版本 / 设备 / 显存
    /queue           正在运行 + 排队等待的 prompt（“激活”最直接的证据）
    /api/jobs        最近作业列表（带 workflow_id / 状态 / 耗时）
    /history/{id}    作业完整快照，含前端工作流定义(extra_pnginfo.workflow)与提交的节点图
    user/default/workflows/**/*.json
                     工作流文件里带着 uuid，用 workflow_id 就能把文件名字反查出来

判定顺序：正在执行 -> 排队中 -> 最近一次执行。三者都没有才说“空闲”。
"""

import glob
import json
import os
import sys
import urllib.request
from datetime import datetime

# ================================================================ 配置
COMFY_ROOT = r"F:\ai\fastai"
COMFY_API = os.environ.get("COMFYUI_API", "http://127.0.0.1:8189").rstrip("/")
WORKFLOW_DIR = os.environ.get(
    "COMFYUI_WORKFLOWS", os.path.join(COMFY_ROOT, "user", "default", "workflows")
)
RECENT_FILES = 6          # 末尾“前端最近打开/保存”列几个
LINE = "=" * 68
SUB = "-" * 68


# ================================================================ HTTP
def api_get(path: str, timeout: int = 15):
    """打一个 ComfyUI 的 GET 接口，返回解析后的 json。"""
    with urllib.request.urlopen(COMFY_API + path, timeout=timeout) as resp:
        return json.load(resp)


# ================================================================ 数据解析
def parse_prompt_tuple(p):
    """
    ComfyUI 的 prompt 五元组 -> dict
    (number, prompt_id, nodes, extra_data, outputs_to_execute)
    节点图在 p[2]，前端工作流定义在 p[3]['extra_pnginfo']['workflow']。
    """
    if not isinstance(p, (list, tuple)) or len(p) < 3:
        return None
    nodes = p[2] if isinstance(p[2], dict) else {}
    extra = p[3] if len(p) > 3 and isinstance(p[3], dict) else {}
    wf = (extra.get("extra_pnginfo") or {}).get("workflow") or {}
    return {"prompt_id": p[1], "nodes": nodes, "workflow": wf}


def parse_queue_item(item):
    """queue_running / queue_pending 里的一项 -> 同样的 dict。"""
    # 标准结构: [number, prompt_id, prompt, extra_data, outputs_to_execute]
    if isinstance(item, (list, tuple)) and len(item) >= 3:
        return parse_prompt_tuple(item[2])
    return None


def scan_workflow_files(root: str):
    """扫一遍工作流目录，拿到每个文件的 uuid / 节点数 / 修改时间。"""
    items = []
    for path in glob.glob(os.path.join(root, "**", "*.json"), recursive=True):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if not isinstance(data, dict) or "nodes" not in data:
            continue  # 不是工作流文件（模板、配置之类）
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        items.append(
            {
                "path": path,
                "rel": os.path.relpath(path, root),
                "id": data.get("id"),
                "nodes": len(data.get("nodes") or []),
                "mtime": mtime,
            }
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def guess_name(workflow_id, node_count, files):
    """
    用 workflow_id 反查文件名。
    id 是前端生成后写进文件里的，复制工作流会让多个文件共用同一个 id，
    所以先用节点数筛一遍；id 对不上就退化成“节点数一致”的猜测。
    """
    if workflow_id:
        exact = [f for f in files if f["id"] == workflow_id]
        if exact:
            exact.sort(key=lambda f: (f["nodes"] != node_count, -f["mtime"]))
            return exact[0]["rel"], "workflow_id 完全匹配", exact
    same = [f for f in files if f["nodes"] == node_count]
    if same:
        return same[0]["rel"] + " (推测)", "节点数一致，id 未匹配到", same
    return None, "工作流文件里没找到（可能没保存过）", []


def collect_models(nodes):
    """从提交的节点图里挑出所有模型文件引用。"""
    rows = []
    for nid, node in (nodes or {}).items():
        if not isinstance(node, dict):
            continue
        ctype = str(node.get("class_type") or "")
        if "Load" not in ctype:
            continue
        for key, val in (node.get("inputs") or {}).items():
            if not isinstance(val, str):
                continue
            # ckpt_name / unet_name / clip_name1 / lora_name ...
            if not (key.endswith("_name") or (key[:-1].endswith("_name") and key[-1].isdigit())):
                continue
            rows.append((ctype, str(nid), key, val))
            break
    return rows


def collect_samplers(nodes):
    """采样器的关键参数，用来一眼认出跑的是哪个工作流。"""
    rows = []
    for nid, node in (nodes or {}).items():
        if not isinstance(node, dict):
            continue
        ctype = str(node.get("class_type") or "")
        if "Sampler" not in ctype or "Select" in ctype:
            continue
        ins = node.get("inputs") or {}
        picked = {
            k: ins[k]
            for k in ("steps", "cfg", "sampler_name", "scheduler", "denoise", "seed", "noise_seed")
            if k in ins and not isinstance(ins[k], (list, dict))
        }
        if picked:
            rows.append((ctype, str(nid), picked))
    return rows


# ================================================================ 打印
def _fmt_ms(ms):
    if not ms:
        return "-"
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, ValueError):
        return "-"


def _fmt_mtime(ts):
    try:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
    except (OSError, ValueError):
        return "-"


def print_workflow(tag, parsed, job, files):
    """打印一个工作流：名称 / 身份 / 节点 / 执行信息 / 模型 / 采样参数。"""
    wf = parsed.get("workflow") or {}
    nodes = parsed.get("nodes") or {}
    wf_id = wf.get("id")
    wf_nodes = len(wf.get("nodes") or [])
    name, why, _ = guess_name(wf_id, wf_nodes, files)

    print(f"\n{SUB}")
    print(f"[{tag}] {name or '(未命名工作流)'}")
    print(SUB)
    print(f"  名称判定   : {why}")
    print(f"  workflow id: {wf_id or '-'}")
    print(f"  prompt id  : {parsed.get('prompt_id') or '-'}")
    print(f"  节点数量   : 前端 {wf_nodes} 个 / 提交执行 {len(nodes)} 个")
    if wf.get("revision"):
        print(f"  版本号     : revision {wf.get('revision')}")
    if job:
        duration = ""
        if job.get("execution_start_time") and job.get("execution_end_time"):
            sec = (job["execution_end_time"] - job["execution_start_time"]) / 1000
            duration = f"  耗时 {sec:.1f}s"
        print(
            f"  执行状态   : {job.get('status', '-')}  提交于 {_fmt_ms(job.get('create_time'))}{duration}"
        )
        if job.get("outputs_count") is not None:
            print(f"  输出数量   : {job.get('outputs_count')} 个")

    models = collect_models(nodes)
    if models:
        print(f"\n  已加载的模型 ({len(models)})")
        width = max(len(m[0]) for m in models)
        for ctype, nid, key, val in models:
            print(f"    {ctype:<{width}} #{nid:<4} {val}")

    samplers = collect_samplers(nodes)
    if samplers:
        print(f"\n  采样参数 ({len(samplers)})")
        for ctype, nid, kv in samplers:
            body = "  ".join(f"{k}={v}" for k, v in kv.items())
            print(f"    {ctype} #{nid}: {body}")


def print_header(stats, queue):
    sysinfo = (stats or {}).get("system") or {}
    devices = (stats or {}).get("devices") or []
    running = queue.get("queue_running") or []
    pending = queue.get("queue_pending") or []

    print(LINE)
    print(" ComfyUI 当前已加载并激活的工作流")
    print(LINE)
    print(f"  服务地址 : {COMFY_API}")
    print(f"  版本     : ComfyUI {sysinfo.get('comfyui_version', '?')}")
    if devices:
        d = devices[0]
        total = d.get("vram_total") or 0
        free = d.get("vram_free") or 0
        print(
            f"  设备     : {d.get('name', '?')}  "
            f"VRAM {(total - free) / 1024 ** 3:.1f} / {total / 1024 ** 3:.1f} GB 已用"
        )
    print(f"  队列     : 运行中 {len(running)} / 排队 {len(pending)}")


def print_recent_files(files, active_id):
    if not files:
        print(f"\n  (工作流目录为空或不存在: {WORKFLOW_DIR})")
        return
    print(f"\n{SUB}")
    print(f" 前端最近打开/保存的工作流 (Top {min(RECENT_FILES, len(files))})")
    print(SUB)
    for f in files[:RECENT_FILES]:
        mark = "  <- 当前激活" if active_id and f["id"] == active_id else ""
        print(f"  {_fmt_mtime(f['mtime'])}  {f['nodes']:>3} 节点  {f['rel']}{mark}")


# ================================================================ 主流程
def main():
    files = scan_workflow_files(WORKFLOW_DIR)

    try:
        stats = api_get("/system_stats")
        queue = api_get("/queue")
    except Exception as exc:  # noqa: BLE001
        print(LINE)
        print(" ComfyUI 当前已加载并激活的工作流")
        print(LINE)
        print(f"  [失败] 连不上 ComfyUI ({COMFY_API})")
        print(f"         {type(exc).__name__}: {exc}")
        print("         可用环境变量 COMFYUI_API 指定地址，例如 http://127.0.0.1:8188")
        print("\n  退化成文件视图（只能看本地有哪些工作流）：")
        print_recent_files(files, None)
        return 1

    print_header(stats, queue)

    try:
        jobs = api_get("/api/jobs?limit=30").get("jobs") or []
    except Exception:  # noqa: BLE001
        jobs = []
    jobs_by_id = {j.get("id"): j for j in jobs if j.get("id")}

    running = queue.get("queue_running") or []
    pending = queue.get("queue_pending") or []
    active_id = None

    if running:
        for item in running:
            parsed = parse_queue_item(item)
            if not parsed:
                continue
            parsed["prompt_id"] = parsed.get("prompt_id") or (item[1] if len(item) > 1 else None)
            job = jobs_by_id.get(parsed["prompt_id"]) or {"status": "in_progress"}
            print_workflow("激活中 · 正在执行", parsed, job, files)
            active_id = (parsed.get("workflow") or {}).get("id")
    elif pending:
        for idx, item in enumerate(pending[:3], 1):
            parsed = parse_queue_item(item)
            if not parsed:
                continue
            parsed["prompt_id"] = parsed.get("prompt_id") or (item[1] if len(item) > 1 else None)
            job = jobs_by_id.get(parsed["prompt_id"]) or {"status": "pending"}
            print_workflow(f"排队中 · 第 {idx} 位", parsed, job, files)
            if active_id is None:
                active_id = (parsed.get("workflow") or {}).get("id")
        if len(pending) > 3:
            print(f"\n  ... 另有 {len(pending) - 3} 个 prompt 在队列里")
    else:
        # 队列是空的 -> 用最近一次真正执行过的作业作为“当前激活”的答案
        target = None
        for job in jobs:
            if job.get("status") in ("completed", "failed", "success", "error"):
                target = job
                break
        if target:
            try:
                history = api_get(f"/history/{target['id']}")
                entry = history.get(target["id"]) or {}
                parsed = parse_prompt_tuple(entry.get("prompt"))
                if parsed:
                    print_workflow("最近一次执行（队列当前空闲）", parsed, target, files)
                    active_id = (parsed.get("workflow") or {}).get("id")
                else:
                    print("\n  [提示] 该作业的历史快照已被清空，只有元数据：")
                    print_workflow_meta_only(target, files)
                    active_id = target.get("workflow_id")
            except Exception as exc:  # noqa: BLE001
                print(f"\n  [警告] 读取历史失败: {type(exc).__name__}: {exc}")
        else:
            print("\n  队列空闲，执行记录里也没有可用作业 —— 现在确实没在工作流在跑。")

    print_recent_files(files, active_id)
    print(f"\n{LINE}")
    return 0


def print_workflow_meta_only(job, files):
    name, why, _ = guess_name(job.get("workflow_id"), -1, files)
    print(f"  workflow id: {job.get('workflow_id') or '-'}")
    print(f"  名称判定   : {why}  {name or ''}")
    print(f"  状态       : {job.get('status')}  提交于 {_fmt_ms(job.get('create_time'))}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
