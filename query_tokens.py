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
    tokens_dict = tokenizer.tokenize_with_weights(prompt)
    
    first_key = next(iter(tokens_dict))
    token_sequence = tokens_dict[first_key]
    
    # ✅ 安全探测：打印第一个元素的真实结构和长度
    sample = token_sequence[0]
    print(f"[DEBUG] item类型: {type(sample).__name__}, 长度: {len(sample)}, 内容: {sample}")
    
    print(f"\n{'='*60}")
    print(f"Prompt: '{prompt}'")
    print(f"Tokenizer: {type(tokenizer).__name__} | Key: '{first_key}'")
    print(f"{'='*60}")
    print(f"{'ID':>8} | {'Weight':>6} | Token")
    print(f"{'-'*45}")
    
    valid_count = 0
    for item in token_sequence:
        # ✅ 核心修复：永远使用索引访问，绝不假设元组长度
        tid = item[0]
        weight = item[1] if len(item) > 1 else 1.0
        
        # 过滤特殊Token
        if tid in (49406, 49407):
            continue
            
        valid_count += 1
        token_str = tokenizer.untokenize([tid])
        print(f"{tid:>8} | {weight:>6.2f} | {repr(token_str)}")
    
    print(f"{'='*60}")
    print(f"有效 Token 数: {valid_count} (总序列长度: {len(token_sequence)})")
    
    return token_sequence


if __name__ == "__main__":
    CKPT_NAME = r"F:\aidraw\models\Stable-diffusion\chilloutmix_NiPrunedFp32Fix.safetensors"
    PROMPT = "1girl, blue eyes, outdoor, masterpiece"
    
    result = query_token_ids(CKPT_NAME, PROMPT)