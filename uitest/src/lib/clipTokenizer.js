/**
 * 纯前端复刻的 CLIP (SD1.x) 分词器。
 *
 * 逐行对齐下面两处实现，保证和 ComfyUI 里实际跑出来的 token 完全一致：
 *   - transformers/models/clip/tokenization_clip.py :: CLIPTokenizer
 *       bytes_to_unicode / get_pairs / bpe / _tokenize / convert_tokens_to_string
 *   - comfy/sd1_clip.py :: SDTokenizer
 *       escape_important / unescape_important / token_weights
 *   - ftfy.fix_text 的常用修复步骤（弯引号、全角、连字、HTML 实体、NFC…）
 *
 * 词表与映射表由 tools/gen_data.py 从本机 ComfyUI / ftfy 直接导出。
 */

export const START_TOKEN = 49406
export const END_TOKEN = 49407
export const PAD_TOKEN = 49407
export const MAX_LENGTH = 77
export const UNK_TOKEN = '<|endoftext|>'

/* ==========================================================================
 * bytes_to_unicode —— 与 Python 版完全一致
 * ========================================================================== */
function buildByteEncoder() {
  const bs = []
  for (let i = 0x21; i <= 0x7e; i++) bs.push(i)
  for (let i = 0xa1; i <= 0xac; i++) bs.push(i)
  for (let i = 0xae; i <= 0xff; i++) bs.push(i)

  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n++
    }
  }

  const encoder = new Map()
  const decoder = new Map()
  for (let i = 0; i < bs.length; i++) {
    const ch = String.fromCodePoint(cs[i])
    encoder.set(bs[i], ch)
    decoder.set(ch, bs[i])
  }
  return { encoder, decoder }
}

/* ==========================================================================
 * ftfy.fix_text —— 复刻需要的几个 fixer
 * ========================================================================== */
const ANSI_RE = /\u001b\[((?:\d|;)*)([a-zA-Z])/g
const HTML_ENTITY_RE = /&#?[0-9A-Za-z]{1,24};/g
const SINGLE_QUOTE_RE = /[\u02bc\u2018-\u201b]/g
const DOUBLE_QUOTE_RE = /[\u201c-\u201f]/g

function isRemovableControl(cp) {
  return (
    cp <= 0x08 ||
    cp === 0x0b ||
    (cp >= 0x0e && cp <= 0x1f) ||
    cp === 0x7f ||
    (cp >= 0x206a && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffc)
  )
}

export class TextFixer {
  constructor({ entities, ligatures, widthMap, c1Map }) {
    this.entities = entities || {}
    // 码点 -> 替换字符串
    this.ligatures = new Map(
      Object.entries(ligatures || {}).map(([cp, v]) => [Number(cp), v])
    )
    this.widthMap = new Map(
      Object.entries(widthMap || {}).map(([cp, v]) => [Number(cp), v])
    )
    this.c1Map = new Map(
      Object.entries(c1Map || {}).map(([cp, v]) => [Number(cp), v])
    )
  }

  /** 复刻 ftfy.fix_text（跳过 fix_encoding 的 mojibake 猜测，正常 prompt 不会触发） */
  fixText(text) {
    let t = text
    // Python 侧是 while True 直到稳定，这里给个上限防止病态输入
    for (let iter = 0; iter < 8; iter++) {
      const before = t
      // unescape_html='auto'：文本里出现 '<' 就认为不是被转义的 HTML，跳过
      if (!t.includes('<')) t = this.unescapeHtml(t)
      t = this.fixC1Controls(t)
      t = this.fixLatinLigatures(t)
      t = this.fixCharacterWidth(t)
      t = this.uncurlQuotes(t)
      t = this.fixLineBreaks(t)
      t = this.fixSurrogates(t)
      t = t.replace(ANSI_RE, '')
      t = this.removeControlChars(t)
      t = t.normalize('NFC')
      if (t === before) break
    }
    return t
  }

  unescapeHtml(text) {
    return text.replace(HTML_ENTITY_RE, (ent) => {
      if (Object.prototype.hasOwnProperty.call(this.entities, ent)) {
        return this.entities[ent]
      }
      if (ent.startsWith('&#')) {
        let cp = NaN
        if (/^&#[0-9]+;$/.test(ent)) cp = parseInt(ent.slice(2, -1), 10)
        else if (/^&#[xX][0-9a-fA-F]+;$/.test(ent)) cp = parseInt(ent.slice(3, -1), 16)
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ent
        try {
          return String.fromCodePoint(cp)
        } catch {
          return ent
        }
      }
      return ent
    })
  }

  fixC1Controls(text) {
    let out = ''
    for (const ch of text) {
      const rep = this.c1Map.get(ch.codePointAt(0))
      out += rep !== undefined ? rep : ch
    }
    return out
  }

  fixLatinLigatures(text) {
    let out = ''
    for (const ch of text) {
      const rep = this.ligatures.get(ch.codePointAt(0))
      out += rep !== undefined ? rep : ch
    }
    return out
  }

  fixCharacterWidth(text) {
    let out = ''
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cp === 0x3000) {
        out += ' '
        continue
      }
      const rep = this.widthMap.get(cp)
      out += rep !== undefined ? rep : ch
    }
    return out
  }

  uncurlQuotes(text) {
    return text.replace(SINGLE_QUOTE_RE, "'").replace(DOUBLE_QUOTE_RE, '"')
  }

  fixLineBreaks(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u2028/g, '\n')
      .replace(/\u2029/g, '\n')
      .replace(/\u0085/g, '\n')
  }

  /** 未配对的代理项替换为 U+FFFD（Python 的 fix_surrogates 同理） */
  fixSurrogates(text) {
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += text[i] + text[i + 1]
          i++
        } else {
          out += '\ufffd'
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        out += '\ufffd'
      } else {
        out += text[i]
      }
    }
    return out
  }

  removeControlChars(text) {
    let out = ''
    for (const ch of text) {
      if (!isRemovableControl(ch.codePointAt(0))) out += ch
    }
    return out
  }
}

/* ==========================================================================
 * comfy/sd1_clip.py 的括号 / 权重解析
 * ========================================================================== */
const IMPORTANT_RIGHT = '\u0000\u0001'
const IMPORTANT_LEFT = '\u0000\u0002'

export function escapeImportant(text) {
  return text.split('\\)').join(IMPORTANT_RIGHT).split('\\(').join(IMPORTANT_LEFT)
}

export function unescapeImportant(text) {
  return text.split(IMPORTANT_RIGHT).join(')').split(IMPORTANT_LEFT).join('(')
}

/** 复刻 parse_parentheses(string) */
export function parseParentheses(string) {
  const result = []
  let currentItem = ''
  let nestingLevel = 0

  for (const char of string) {
    if (char === '(') {
      if (nestingLevel === 0) {
        if (currentItem) {
          result.push(currentItem)
          currentItem = '('
        } else {
          currentItem = '('
        }
      } else {
        currentItem += char
      }
      nestingLevel += 1
    } else if (char === ')') {
      nestingLevel -= 1
      if (nestingLevel === 0) {
        result.push(currentItem + ')')
        currentItem = ''
      } else {
        currentItem += char
      }
    } else {
      currentItem += char
    }
  }
  if (currentItem) result.push(currentItem)
  return result
}

/** 复刻 token_weights(string, current_weight)，返回 [[segment, weight], ...] */
export function tokenWeights(string, currentWeight) {
  const out = []
  for (const x0 of parseParentheses(string)) {
    let x = x0
    let weight = currentWeight
    if (x.length >= 2 && x[x.length - 1] === ')' && x[0] === '(') {
      x = x.slice(1, -1)
      const xx = x.lastIndexOf(':')
      weight *= 1.1
      if (xx > 0) {
        const parsed = Number.parseFloat(x.slice(xx + 1))
        if (Number.isFinite(parsed) && /^[\s]*[-+]?[\d.eE+-]+[\s]*$/.test(x.slice(xx + 1))) {
          weight = parsed
          x = x.slice(0, xx)
        }
      }
      out.push(...tokenWeights(x, weight))
    } else {
      out.push([x, currentWeight])
    }
  }
  return out
}

/* ==========================================================================
 * CLIPTokenizer
 * ========================================================================== */
export class ClipTokenizer {
  constructor({ vocab, mergesText, entities, ligatures, widthMap, c1Map }) {
    this.encoder = vocab
    this.decoder = new Map()
    for (const [token, id] of Object.entries(vocab)) this.decoder.set(id, token)

    const { encoder: byteEncoder, decoder: byteDecoder } = buildByteEncoder()
    this.byteEncoder = byteEncoder
    this.byteDecoder = byteDecoder

    // bpe_merges = read().strip().split("\n")[1 : 49152 - 256 - 2 + 1]
    const lines = String(mergesText).replace(/^\ufeff/, '').trim().split('\n')
    const merges = lines.slice(1, 49152 - 256 - 2 + 1)
    this.bpeRanks = new Map()
    merges.forEach((line, i) => {
      const parts = line.split(/\s+/).filter(Boolean)
      if (parts.length === 2) this.bpeRanks.set(parts[0] + '\u0000' + parts[1], i)
    })

    this.bpeCache = new Map()

    // pat（Python 侧用的是 regex 模块的 \p{L} / \p{N}，JS 用 u 标志等价实现）
    this.pat = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu

    this.fixer = new TextFixer({ entities, ligatures, widthMap, c1Map })
  }

  /* ---------------------------------------------------------------- BPE */
  getPairs(word) {
    const pairs = new Set()
    for (let i = 0; i < word.length - 1; i++) {
      pairs.add(word[i] + '\u0000' + word[i + 1])
    }
    return pairs
  }

  bpe(token) {
    const cached = this.bpeCache.get(token)
    if (cached !== undefined) return cached

    const chars = Array.from(token)
    let word = chars.slice(0, -1)
    word.push(chars[chars.length - 1] + '</w>')

    if (word.length === 1) {
      const single = word.join(' ')
      this.bpeCache.set(token, single)
      return single
    }

    while (true) {
      let bigram = null
      let bestRank = Infinity
      for (const pair of this.getPairs(word)) {
        const rank = this.bpeRanks.get(pair)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          bigram = pair
        }
      }
      if (bigram === null) break

      const [first, second] = bigram.split('\u0000')
      const newWord = []
      let i = 0
      while (i < word.length) {
        const j = word.indexOf(first, i)
        if (j === -1) {
          newWord.push(...word.slice(i))
          break
        }
        newWord.push(...word.slice(i, j))
        i = j
        if (word[i] === first && i < word.length - 1 && word[i + 1] === second) {
          newWord.push(first + second)
          i += 2
        } else {
          newWord.push(word[i])
          i += 1
        }
      }
      word = newWord
      if (word.length === 1) break
    }

    const result = word.join(' ')
    this.bpeCache.set(token, result)
    return result
  }

  /* ------------------------------------------------------- _tokenize */
  /** 返回 BPE 片段数组（对应 CLIPTokenizer._tokenize） */
  tokenize(text) {
    const cleaned = this.fixer.fixText(text).replace(/\s+/g, ' ').trim().toLowerCase()
    const out = []
    for (const match of cleaned.matchAll(this.pat)) {
      const token = match[0]
      let mapped = ''
      for (const byte of new TextEncoder().encode(token)) {
        mapped += this.byteEncoder.get(byte)
      }
      const bpe = this.bpe(mapped)
      if (bpe) out.push(...bpe.split(' '))
    }
    return out
  }

  /** token 字符串 -> id（找不到时用 unk，与 HF 行为一致） */
  tokenToId(token) {
    const id = this.encoder[token]
    return id === undefined ? this.encoder[UNK_TOKEN] : id
  }

  convertTokensToIds(tokens) {
    return tokens.map((t) => this.tokenToId(t))
  }

  idToToken(id) {
    return this.decoder.get(id)
  }

  /* ------------------------------------------------------------ 权重 */
  /**
   * 对应 SDTokenizer.tokenize_with_weights。
   * 返回 [{ id, weight, segmentIndex }]，不含 start/end/pad。
   */
  encodeWithWeights(text, { disableWeights = false } = {}) {
    const escaped = escapeImportant(text)
    const parsed = disableWeights ? [[escaped, 1.0]] : tokenWeights(escaped, 1.0)

    const out = []
    parsed.forEach(([segment, weight], segIndex) => {
      const unescaped = unescapeImportant(segment)
      const ids = this.convertTokensToIds(this.tokenize(unescaped))
      for (const id of ids) out.push({ id, weight, segmentIndex: segIndex + 1 })
    })
    return out
  }

  /* ------------------------------------------------------------ 解码 */
  /** 复刻 convert_tokens_to_string */
  decode(ids) {
    let text = ''
    for (const id of ids) {
      const tok = this.decoder.get(id)
      if (typeof tok === 'string') text += tok
    }
    const bytes = []
    for (const ch of text) {
      const b = this.byteDecoder.get(ch)
      if (b !== undefined) bytes.push(b)
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
    return decoded.replace(/<\/w>/g, ' ').trim()
  }

  /**
   * 单个 BPE 片段的“字面文本”。
   *
   * 注意：CLIP 是 byte-level BPE，一个汉字（3 字节 UTF-8）会被拆成 3 个字节级 token，
   * 单个 token 往往是「半个字符」，硬解 UTF-8 只会得到 �。这种情况改用十六进制
   * 展示字节本身（如 \xE5），信息量更大；完整文本请看「分词还原」那一栏。
   */
  tokenToText(rawToken) {
    if (typeof rawToken !== 'string') return ''
    const body = rawToken.endsWith('</w>') ? rawToken.slice(0, -4) : rawToken
    const bytes = []
    for (const ch of body) {
      const b = this.byteDecoder.get(ch)
      if (b !== undefined) bytes.push(b)
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
    if (decoded.includes('\ufffd')) {
      return bytes.map((b) => '\\x' + b.toString(16).toUpperCase().padStart(2, '0')).join('')
    }
    return decoded
  }

  /* --------------------------------------------------------- 词表检索 */
  get vocabSize() {
    return this.decoder.size
  }

  /** 按关键字模糊搜索词表，keyword 为空时随机返回 */
  search(keyword, limit = 30) {
    const key = this.fixer.fixText(String(keyword || '')).toLowerCase()
    const hits = []
    if (!key) return hits
    for (const [token, id] of Object.entries(this.encoder)) {
      if (id >= 49406 && id <= 49407) continue
      if (token.toLowerCase().includes(key)) {
        hits.push({ id, token, text: this.tokenToText(token) })
        if (hits.length >= limit) break
      }
    }
    return hits
  }
}

/** 按需加载数据文件并构造分词器 */
export async function createClipTokenizer(baseUrl = './data/') {
  const join = (name) => `${baseUrl.replace(/\/?$/, '/')}${name}`
  const [vocab, mergesText, entities, ligatures, widthMap, c1Map] = await Promise.all([
    fetch(join('vocab.json')).then((r) => r.json()),
    fetch(join('merges.txt')).then((r) => r.text()),
    fetch(join('html_entities.json')).then((r) => r.json()),
    fetch(join('ligatures.json')).then((r) => r.json()),
    fetch(join('width_map.json')).then((r) => r.json()),
    fetch(join('c1_map.json')).then((r) => r.json()),
  ])
  return new ClipTokenizer({ vocab, mergesText, entities, ligatures, widthMap, c1Map })
}
