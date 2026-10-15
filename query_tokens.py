import sys
import os

COMFYUI_ROOT = r"F:\ai\fastai"
if COMFYUI_ROOT not in sys.path:
    sys.path.insert(0, COMFYUI_ROOT)

import comfy.sd


def query_token_ids(ckpt_path: str, prompt: str):
    print(f"[INFO] 正在加载模型: {ckpt_path}")

    checkpoint = comfy.sd.load_checkpoint_guess_config(
        ckpt_path,
        output_vae=False,
        output_clip=True,
        embedding_directory=None
    )

    if checkpoint is None or len(checkpoint) < 2:
        raise ValueError(f"无法加载模型: {ckpt_path}")

    clip = checkpoint[1]
    tokenizer = clip.tokenizer

    # 真实返回结构（见 comfy/sd1_clip.py: tokenize_with_weights）：
    #   { "l": [ batch_0, batch_1, ... ] }
    #   其中每个 batch = [ (token_id, weight), ... ]，长度最多为 CLIP 的 77
    tokens_dict = tokenizer.tokenize_with_weights(prompt)
    first_key = next(iter(tokens_dict))
    batches = tokens_dict[first_key]

    print(f"\n{'='*60}")
    print(f"Prompt: '{prompt}'")
    print(f"Tokenizer: {type(tokenizer).__name__} | Key: '{first_key}'")
    print(f"批次数(batch): {len(batches)} | 各批长度: {[len(b) for b in batches]}")
    print(f"{'='*60}")
    print(f"{'ID':>8} | {'Weight':>6} | Token")
    print(f"{'-'*45}")

    valid_count = 0
    for bi, batch in enumerate(batches):
        if len(batches) > 1:
            print(f"--- batch {bi} ({len(batch)} tokens) ---")

        for pair in batch:
            # 每个元素是 (token_id, weight)；token_id 可能是 int，也可能是 embedding 向量(tensor)
            tid = pair[0]
            weight = pair[1] if len(pair) > 1 else 1.0

            if not isinstance(tid, int):
                print(f"{'<emb>':>8} | {float(weight):>6.2f} | <embedding vector {tuple(tid.shape)}>")
                continue

            # 过滤特殊 Token (start / end / pad)
            if tid in (49406, 49407):
                continue

            valid_count += 1
            try:
                # untokenize 接受 [(token_id, weight), ...]，返回 [(token_id, str), ...]
                out = tokenizer.untokenize([(tid, weight)])
                token_str = out[0][1] if out else ""
            except Exception:
                token_str = "<unknown>"
            print(f"{tid:>8} | {weight:>6.2f} | {repr(token_str)}")

    print(f"{'='*60}")
    print(f"有效 Token 数: {valid_count} (已排除 49406/49407 特殊 token)")
    return batches


if __name__ == "__main__":
    CKPT_NAME = r"F:\aidraw\models\Stable-diffusion\chilloutmix_NiPrunedFp32Fix.safetensors"
    PROMPT = "1girl, blue eyes, outdoor, masterpiece"

    result = query_token_ids(CKPT_NAME, PROMPT)
