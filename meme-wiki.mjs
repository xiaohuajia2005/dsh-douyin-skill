// 2026-11-21：把「梗百科」接进私信回复链路。
// 只读 dsh-memewiki 的词库（不写、不改），用对方这句话里出现的梗名做匹配，
// 命中后把「含义/用法/来源」摘要交给模型理解语境，避免模型硬猜或答非所问。
//
// 2026-11-22：匹配从 includes() 子串改成「长度 + 边界」判定。
// 子串匹配会把「绝了」命中在「拒绝了解」里，把「emo」命中在「emoji」里；
// 现在要求命中词 ≥3 个字符，且两边按字符类别卡边界（中文不与汉字相邻、英文数字按词边界）。
//
// 实测（真实词库 6434 条可匹配词条、130 个随机 3–4 字中文词）：
//   两侧是标点/空白 → 命中 100%；两侧紧邻汉字 → 命中 0%。
// 也就是说中文词只有在「被标点、空格、数字、英文隔开」时才算命中，
// 「这个显眼包真的很离谱」这类自然连写不会命中。这是本轮刻意选的口径（精确优先），
// 若之后要换回「中文只要有 3 个字就命中、只保留英文/数字边界」，只需要改 memeTermPattern 里
// CJK 的两个 lookaround 分支，其余逻辑不用动。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// 词库不属于本仓库——由同级的 dsh-memewiki 包提供，各机器安装位置不同。
// 这里**不允许**写死绝对路径（开源仓库里出现本机目录等于把用户名和目录结构公开），
// 改为三级解析，全部失败就返回空串：open() 时 existsSync 为假 → 优雅降级为"无梗库"，
// 私信回复照常，不会因为这个可选能力缺失而报错。
function resolveMemeDb() {
  const fromEnv = String(process.env.DSH_MEMEWIKI_DB || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [];
  try {
    const entry = require.resolve('dsh-memewiki');
    candidates.push(join(dirname(entry), 'data', 'memes.db'), join(dirname(entry), '..', 'data', 'memes.db'));
  } catch { /* 未安装：走下面的同级目录推断 */ }
  // 本插件与 dsh-memewiki 通常并列安装在同一个 node_modules 下。
  candidates.push(fileURLToPath(new URL('../dsh-memewiki/data/memes.db', import.meta.url)));
  return candidates.find(path => existsSync(path)) || '';
}

const DEFAULT_DB = resolveMemeDb();

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();

// 命中词最短长度。低于这个长度的词（「绝了」「栓Q」）在子串匹配下误命中率太高，
// 代价是它们不再参与匹配——宁可少一条梗，也不要把「拒绝了解」读成「绝了」。
export const MIN_MEME_TERM_LENGTH = 3;

// 汉字及常见东亚文字：紧邻出现即视为同一个词，不算命中。
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/u;
const ALNUM = /[0-9A-Za-z]/;
const CJK_GUARD = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 按命中词首尾字符的类别决定两侧边界：
// - 汉字首尾 → 两侧不能紧邻汉字（「显眼包」不命中「显眼包子」）；
// - 英数首尾 → 两侧不能紧邻英数（等价 \b，但对 yyds、666 这类词同样成立）；
// - 标点首尾 → 这一侧不加限制（词尾是标点时，边界交给另一侧）。
export function memeTermPattern(term) {
  const chars = [...clean(term)];
  if (chars.length < MIN_MEME_TERM_LENGTH) return null;
  const cjk = chars.some(char => CJK.test(char));
  const left = CJK.test(chars[0]) ? `(?<![${CJK_GUARD}])` : ALNUM.test(chars[0]) ? '(?<![0-9A-Za-z])' : '';
  const right = CJK.test(chars.at(-1)) ? `(?![${CJK_GUARD}])` : ALNUM.test(chars.at(-1)) ? '(?![0-9A-Za-z])' : '';
  try { return new RegExp(`${left}${escapeRegex(chars.join(''))}${right}`, cjk ? 'u' : 'iu'); } catch { return null; }
}

// 词库行的别名可能是 JSON 数组，也可能是「逗号、顿号、竖线」分隔的字符串。
export function parseAliases(raw) {
  if (Array.isArray(raw)) return raw.map(clean).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(clean).filter(Boolean);
  } catch { /* 不是 JSON 就按分隔符拆。 */ }
  return String(raw).split(/[,，、|]/).map(clean).filter(Boolean);
}

// 一条词条 = 标题 + 别名，各自编译成正则。编译失败的词直接跳过，不静默退化成子串匹配。
export function buildMemeIndex(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const title = clean(row?.title), seen = new Set(), matchers = [];
    for (const term of [title, ...parseAliases(row?.aliases)]) {
      if (!term || seen.has(term)) continue;
      seen.add(term);
      const regex = memeTermPattern(term);
      if (regex) matchers.push({ term, regex });
    }
    return { title, matchers };
  }).filter(item => item.title.length >= 2 && item.matchers.length);
}

// 命中后按词长排序：越长的词越具体，优先交给模型。
export function matchMeme(index, text, limit = 3) {
  const source = clean(text);
  if (source.length < MIN_MEME_TERM_LENGTH) return [];
  const hits = [];
  for (const item of Array.isArray(index) ? index : []) {
    const hit = item.matchers.find(matcher => matcher.regex.test(source));
    if (hit) hits.push({ title: item.title, matched: hit.term, weight: [...hit.term].length });
  }
  if (!hits.length) return [];
  hits.sort((left, right) => right.weight - left.weight || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0));
  return hits.slice(0, Math.max(1, limit));
}

export class MemeWiki {
  constructor({ dbPath = DEFAULT_DB, maxHits = 3 } = {}) {
    this.dbPath = dbPath;
    this.maxHits = maxHits;
    this.db = null;
    this.index = null;
    this.failed = false;
  }

  open() {
    if (this.db) return this.db;
    if (this.failed) return null;
    try {
      if (!existsSync(this.dbPath)) { this.failed = true; return null; }
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this.db;
    } catch { this.failed = true; return null; }
  }

  // 一次性把标题和别名读进内存并编译成正则，之后每条消息只做正则匹配（<1ms）。
  loadIndex() {
    if (this.index) return this.index;
    if (this.failed) return null;
    try {
      const db = this.open();
      if (!db) return null;
      this.index = buildMemeIndex(db.prepare('SELECT title, aliases FROM memes').all());
      return this.index;
    } catch { this.failed = true; return null; }
  }

  lookup(text, { limit = this.maxHits } = {}) {
    const source = clean(text);
    if (!source || source.length < MIN_MEME_TERM_LENGTH) return [];
    const index = this.loadIndex();
    if (!index) return [];
    const selected = matchMeme(index, source, limit);
    if (!selected.length) return [];
    const db = this.open();
    if (!db) return [];
    let statement = null;
    try { statement = db.prepare('SELECT title, tags, usage, origin FROM memes WHERE title = ?'); } catch { return []; }
    return selected.map((hit) => {
      let row = null;
      try { row = statement.get(hit.title); } catch { row = null; }
      return {
        title: hit.title,
        tags: clean(row?.tags).slice(0, 80),
        usage: clean(row?.usage).slice(0, 220),
        origin: clean(row?.origin).slice(0, 120),
      };
    }).filter(item => item.usage || item.origin);
  }
}

export function createMemeWiki(options = {}) { return new MemeWiki(options); }
