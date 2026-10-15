# -*- coding: utf-8 -*-
"""
从本机 ComfyUI / ftfy 生成前端所需的静态数据文件 + Python 对照数据集。

数据来源：
  vocab.json / merges.txt  <- F:\\ai\\fastai\\comfy\\sd1_tokenizer（ComfyUI 自带的 CLIP 词表）
  html_entities / ligatures / width_map / c1_map <- ftfy（保证 JS 侧复刻 ftfy.fix_text 的映射与原版一致）

输出：
  F:\\ai\\onetest\\uitest\\public\\data\\*.json   前端运行时加载
  F:\\ai\\onetest\\uitest\\tests\\expected.json   JS 实现与 Python 的对照基准
"""
import html.entities
import json
import os
import shutil
import sys

sys.path.insert(0, r"F:\ai\fastai")

import ftfy.fixes as FF  # noqa: E402
from ftfy.chardata import HTML_ENTITIES, LIGATURES, WIDTH_MAP  # noqa: E402

from comfy.sd1_clip import SDTokenizer  # noqa: E402

SRC = r"F:\ai\fastai\comfy\sd1_tokenizer"
ROOT = r"F:\ai\onetest\uitest"
DATA = os.path.join(ROOT, "public", "data")
TESTS = os.path.join(ROOT, "tests")

START, END = 49406, 49407


def dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    print("  {} : {:.1f} KB".format(os.path.relpath(path, ROOT), os.path.getsize(path) / 1024))


def main():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(TESTS, exist_ok=True)

    print("[1] 拷贝词表")
    shutil.copy(os.path.join(SRC, "vocab.json"), os.path.join(DATA, "vocab.json"))
    shutil.copy(os.path.join(SRC, "merges.txt"), os.path.join(DATA, "merges.txt"))
    print("  vocab.json / merges.txt")

    print("[2] ftfy 映射表")
    # 直接取 ftfy 内部表，避免大小写变体等细节与之不一致
    dump(os.path.join(DATA, "html_entities.json"), dict(HTML_ENTITIES))
    dump(os.path.join(DATA, "ligatures.json"), {str(cp): r for cp, r in LIGATURES.items()})
    dump(os.path.join(DATA, "width_map.json"), {str(cp): r for cp, r in WIDTH_MAP.items()})

    c1 = {}
    for i in range(0x80, 0xA0):
        ch = chr(i)
        out = FF.fix_c1_controls(ch)
        if out != ch:
            c1[str(i)] = out
    dump(os.path.join(DATA, "c1_map.json"), c1)

    print("[3] Python 对照数据集")
    tok = SDTokenizer()

    texts = [
        # 常规 prompt
        "1girl, blue eyes, outdoor, masterpiece",
        "masterpiece, best quality, ultra detailed, 8k wallpaper, cinematic lighting",
        "1girl, solo, long hair, looking at viewer, smile, sitting, outdoors, day, sky, clouds, sun, shadow, grass, tree, flowers, detailed background, depth of field, bokeh, warm lighting, soft light, vibrant colors, high resolution, very detailed, illustration, anime style, cel shading, intricate details, glowing, atmospheric, dramatic pose, dynamic angle, foreshortening, motion blur, particles, sparkles, lens flare, chromatic aberration, film grain",
        # 单词
        "girl", "blue", "eyes", "masterpiece", "a", "the", "cyberpunk", "photorealistic",
        "tokenizer", "unbelievable", "abcdefghijklmnop",
        # 数字与标点
        "42", "1234", "1girl", "2b", "-", "--", "...", "!?", "()", "[]",
        # 大小写
        "GIRL Girl girl", "iPhone iPad",
        # 缩写与撇号
        "it's a don't test", "you're we've I'll he'd",
        # 空白
        "   multi   space   here  ", "tab\there", "line1\nline2", "line1\r\nline2",
        # 权重语法（ComfyUI 支持）
        "(masterpiece:1.3) girl", "((detailed:1.2):1.1) face", "[cat]",
        "(a:1.4) ((b:1.2):0.8) [c]", "(word)", "(word:1.5)", "a (b) c",
        "plain \\(escaped\\) paren", "(1girl:1.2), (blue eyes:0.9)",
        # 非 ASCII
        "café latte", "naïve", "Müller", "Ünicode combining",
        "中文提示词", "日本語テスト", "한국어 테스트",
        "emoji 😀 test 🌸", "✨ sparkle ✨",
        # ftfy 会被改变的输入
        "“smart quotes” and ‘apostrophes’",
        "ＡＢＣ１２３", "ｈｅｌｌｏ", "Ｈｅｌｌｏ，Ｗｏｒｌｄ！",
        "ﬁne ﬂow", "&amp; &#39; entity", "&hellip; &mdash;",
        "<div>html</div>",
        # 边界
        "", " ", "a", ",", "／／／",
    ]

    out = []
    for t in texts:
        res = tok.tokenize_with_weights(t)
        # SDTokenizer 会把超长文本切成多个 batch，每批都带 start/end，这里全部合并
        pairs = []
        for batch in res:
            pairs.extend([(tid, w) for tid, w in batch if tid not in (START, END)])
        out.append({
            "text": t,
            "ids": [tid for tid, _ in pairs],
            "tokens": [tok.inv_vocab.get(tid, "") for tid, _ in pairs],
            "weights": [round(w, 6) for _, w in pairs],
        })

    dump(os.path.join(TESTS, "expected.json"), out)
    print("done -> {}".format(ROOT))


if __name__ == "__main__":
    main()
