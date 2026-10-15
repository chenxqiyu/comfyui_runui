import sys
import os
import random

COMFYUI_ROOT = r"F:\ai\fastai"
if COMFYUI_ROOT not in sys.path:
    sys.path.insert(0, COMFYUI_ROOT)

import comfy.sd


# ================================================================ 加载
def load_clip_tokenizer(ckpt_path: str):
    """加载 checkpoint，返回它的 CLIP tokenizer（只加载一次，供下面两个功能复用）。"""
    print(f"[INFO] 正在加载模型: {ckpt_path}")

    checkpoint = comfy.sd.load_checkpoint_guess_config(
        ckpt_path,
        output_vae=False,
        output_clip=True,
        embedding_directory=None,
    )
    if checkpoint is None or len(checkpoint) < 2:
        raise ValueError(f"无法加载模型: {ckpt_path}")

    clip = checkpoint[1]
    return clip.tokenizer


def _inner_tokenizer(tokenizer):
    """SD1Tokenizer / SDXLTokenizer -> 底层的 SDTokenizer 实例。"""
    return getattr(tokenizer, tokenizer.clip)


# ============================================== 功能一：prompt -> token id
def dump_prompt_tokens(tokenizer, prompt: str):
    # 返回结构：{ "l": [ batch_0, batch_1, ... ] }，每个 batch = [(token_id, weight), ...]
    batches = tokenizer.tokenize_with_weights(prompt)[tokenizer.clip_name]

    print(f"\n{'=' * 60}")
    print(f"Prompt: '{prompt}'")
    print(f"Tokenizer: {type(tokenizer).__name__} | Key: '{tokenizer.clip_name}'")
    print(f"批次数(batch): {len(batches)} | 各批长度: {[len(b) for b in batches]}")
    print(f"{'=' * 60}")
    print(f"{'ID':>8} | {'Weight':>6} | Token")
    print(f"{'-' * 45}")

    valid = 0
    for bi, batch in enumerate(batches):
        if len(batches) > 1:
            print(f"--- batch {bi} ({len(batch)} tokens) ---")
        for pair in batch:
            tid = pair[0]
            weight = pair[1] if len(pair) > 1 else 1.0

            if not isinstance(tid, int):
                print(f"{'<emb>':>8} | {float(weight):>6.2f} | <embedding vector {tuple(tid.shape)}>")
                continue

            if tid in (49406, 49407):  # <|startoftext|> / <|endoftext|>
                continue

            valid += 1
            print(f"{tid:>8} | {weight:>6.2f} | {repr(_raw_token(tokenizer, tid))}")

    print(f"{'=' * 60}")
    print(f"有效 Token 数: {valid}")
    return batches


# ================================ 功能二：随机抽 N 个 id 并转回单词
def _raw_token(tokenizer, tid: int) -> str:
    """词表里的原始 BPE 片段（含 </w> 之类的标记）。"""
    try:
        return _inner_tokenizer(tokenizer).inv_vocab.get(tid, "<unknown>")
    except Exception:
        return "<unknown>"


def random_token_sample(tokenizer, n: int = 20, seed=None):
    """从 CLIP 词表里随机抽 n 个 token id，再解码成可读单词。"""
    inner = _inner_tokenizer(tokenizer)
    vocab_size = len(inner.inv_vocab)

    specials = {t for t in (inner.start_token, inner.end_token, inner.pad_token) if t is not None}
    pool = [i for i in range(vocab_size) if i not in specials]

    if seed is None:
        seed = random.randrange(2 ** 31)
    rng = random.Random(seed)
    ids = rng.sample(pool, min(n, len(pool)))

    print(f"\n{'=' * 60}")
    print(f"随机抽取 {len(ids)} 个 Token ID  (seed={seed}，同 seed 可复现)")
    print(f"词表大小: {vocab_size} | 已排除特殊 token: {sorted(specials)}")
    print(f"{'=' * 60}")
    print(f"{'ID':>8} | {'BPE token':<22} | Decoded")
    print(f"{'-' * 60}")

    for tid in ids:
        raw = _raw_token(tokenizer, tid)
        try:
            dec = tokenizer.decode([tid], skip_special_tokens=True)
        except Exception as e:
            dec = f"<decode error: {e}>"
        print(f"{tid:>8} | {repr(raw):<22} | {repr(dec)}")

    return ids


if __name__ == "__main__":
    CKPT_NAME = r"F:\aidraw\models\Stable-diffusion\chilloutmix_NiPrunedFp32Fix.safetensors"
    PROMPT = "1girl, blue eyes, outdoor, masterpiece"

    tokenizer = load_clip_tokenizer(CKPT_NAME)
    dump_prompt_tokens(tokenizer, PROMPT)
    random_token_sample(tokenizer, n=20)
