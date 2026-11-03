/**
 * dsh-hippocampus — 海马体（三方公共共享的记忆巩固层）
 *
 * 【vendor 副本 · 自动生成】本文件由 scripts/sync-vendor.mjs 从
 * ../dsh-hippocampus/index.js 同步，请勿手改；发布包自包含依赖此副本。
 * 真源在 dsh-hippocampus/index.js，改动后必须重跑同步并过全量测试。
 * 校验：node scripts/sync-vendor.mjs --check
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/* ── 布局常量 ─────────────────────────────────────────────── */
export const WARM = "warm.md";
export const COLD = "cold.md";
export const EPISODIC_DIR = "episodic";
export const JOURNAL_DIR = "journal";
/** 结构化条目三型：event / fact / rule；legacy=旧叙述条目（无 kind 标记）。 */
export const KINDS = ["event", "fact", "rule"];

const CONF_WEIGHT = { high: 2, medium: 1, low: 0, wrong: -1 };

/* ── 主体名归一（共享原语：暖态条目 @subject / 单元 subjects 复用）──── */
export function normalizeSubject(subject) {
  const s = String(subject ?? "").trim();
  const clean = s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "");
  return clean || "unknown";
}

/* ── 暖态解析/渲染 ────────────────────────────────────────── */

/** 从条目标题行提取 kind：`## <stamp> [<kind>] <confidence>`；旧类别收敛：decision/preference→rule、experience→event、identity→fact。 */
export function kindOfBlock(block) {
  const m = String(block ?? "").match(/^## .*?\[([a-z_]+)\]/m);
  const k = m ? m[1].toLowerCase() : "legacy";
  if (KINDS.includes(k)) return k;
  if (k === "decision" || k === "preference") return "rule";
  if (k === "experience") return "event";
  if (k === "identity") return "fact";
  return "legacy";
}

/** 助手自述条目（如「助手 | 采取 | 澄清式处理」）：warm 只存用户信息，这类条目解析期丢弃。
 *  否则模型会把自己的历史动作当成用户说过的话（10-30 实证：会向用户报内部调度时间戳）。 */
function isAssistantSelfBlock(block) {
  const body = String(block ?? "")
    .replace(/^## .*$/m, "")
    .replace(/<!-- last_access: [^>]+ -->/g, "")
    .trim();
  return /^(助手|assistant)\s*[|｜]/i.test(body);
}

/** 解析 warm.md 为条目数组；每条提取 last_access / confidence / subject / kind / idx（文件序索引）。
 *  标题行：`## <stamp> [<kind>] <confidence> [@<subject>]`。 */
export function parseWarm(text) {
  const blocks = String(text ?? "")
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks
    .map((block, idx) => {
      const m = block.match(/<!-- last_access: ([^>]+) -->/);
      const cm = block.match(/^## .*?\[[a-z_]+\]\s+(high|medium|low|wrong)\s*(?:@([^\s]+))?\s*$/m);
      return {
        block,
        idx,
        lastAccess: m ? m[1].trim() : null,
        confidence: cm ? cm[1] : "medium",
        subject: cm ? (cm[2] ? cm[2].trim() : null) : null,
        kind: kindOfBlock(block),
      };
    })
    // idx 保留原文件序，过滤后编号不错位（update/read 的 [n] 仍指向原条目）
    .filter((e) => !isAssistantSelfBlock(e.block));
}

/** 渲染条目为纯内容（剥 last_access）；wrong 默认跳过；markLow/ numbered / kinds / subject 过滤。 */
export function renderWarmEntries(entries, opts = {}) {
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => opts.includeWrong === true || e.confidence !== "wrong")
    .filter(({ e }) => (Array.isArray(opts.kinds) ? opts.kinds.includes(e.kind) : true))
    .filter(({ e }) => (typeof opts.subject === "string" && opts.subject ? e.subject === opts.subject : true))
    .map(({ e, i }) => {
      const body = e.block.replace(/\n?<!-- last_access: [^>]+ -->/, "");
      const num = opts.numbered ? `[${(typeof e.idx === "number" ? e.idx : i) + 1}] ` : "";
      const tag =
        e.confidence === "wrong"
          ? "【已翻转·勿引用】 "
          : opts.markLow === false
            ? ""
            : e.confidence === "low"
              ? "【低置信·需验证】 "
              : "";
      return `${num}${tag}${body}`;
    })
    .join("\n\n");
}

/* ── 匹配/查重/排序 ────────────────────────────────────────── */

/** 匹配前剥 markdown 标记（**、*、`）。 */
export function normalizeForMatch(text) {
  return text.replace(/[*`]+/g, "");
}

/** 归一化文本用于查重：剥标题行/访问时间/markdown 标记/空白，统一小写。 */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/^## .*$/gm, "")
    .replace(/<!-- last_access: [^>]+ -->/g, "")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

/** ref 匹配：ref 按空白拆多词，任一词命中（归一后包含匹配）即真；空词表不匹配。 */
export function matchRef(text, ref) {
  const words = String(ref ?? "")
    .split(/\s+/)
    .map((w) => normalizeForMatch(w).trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return false;
  const hay = normalizeForMatch(String(text ?? "")).toLowerCase();
  return words.some((w) => hay.includes(w));
}

/** ref 过滤暖态条目：只保留命中 ref 的条目（多词任一命中）。 */
export function filterWarmByRef(entries, ref) {
  const list = Array.isArray(entries) ? entries : [];
  if (!String(ref ?? "").trim()) return list;
  return list.filter((e) => matchRef(e.block, ref));
}

/** ref 过滤文本（本体档案/规则文件/索引行）：## 块结构按块过滤保留完整块；非 ## 结构按行过滤。 */
export function filterTextByRef(raw, ref) {
  const text = String(raw ?? "");
  if (!text.trim() || !String(ref ?? "").trim()) return text;
  const parts = text.split(/\n(?=## )/);
  if (parts.length > 1) {
    return parts.filter((b) => b.trim() && matchRef(b, ref)).join("");
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && matchRef(line, ref))
    .join("\n");
}

/** 暖态最新优先：写入序倒序（大暖态截断砍最旧、保最新）。 */
export function sortWarmNewestFirst(entries) {
  return [...(Array.isArray(entries) ? entries : [])].reverse();
}

/** 按 last_access 降序（最近调用的在前；缺失视为最旧沉底）。 */
export function sortWarmByAccess(entries) {
  return [...entries].sort((a, b) => {
    const ta = a.lastAccess ?? "";
    const tb = b.lastAccess ?? "";
    return tb.localeCompare(ta, "en");
  });
}

/** 注入排序：先按置信度（高>中>低>wrong）；high 不衰减保持写入序；medium/low 按 last_access 衰减。 */
export function sortWarmForInject(entries) {
  return [...entries].sort((a, b) => {
    const wa = CONF_WEIGHT[a.confidence ?? "medium"] ?? 1;
    const wb = CONF_WEIGHT[b.confidence ?? "medium"] ?? 1;
    if (wa !== wb) return wb - wa;
    if (a.confidence === "high" && b.confidence === "high") return 0;
    const ta = a.lastAccess ?? "";
    const tb = b.lastAccess ?? "";
    return tb.localeCompare(ta, "en");
  });
}

/* ── MMR / BM25 检索原语 ──────────────────────────────────── */

const STOPWORDS = new Set(
  ("a an and are as at be but by for if in into is it no not of on or such that the their then there these this to was will with i you your we our he she they them me my mine yours ours the a an of to in for on with about").split(" "),
);
const TOKEN_SIM_RE = /[a-z0-9][a-z0-9_'\-]*|[\u4e00-\u9fff]+/g;

/** 相似度用 token 化：小写英数 token（去停用词）+ 中文连续串按字符 bigram 切分。 */
export function tokenizeForSim(text) {
  const out = [];
  for (const m of String(text ?? "").toLowerCase().matchAll(TOKEN_SIM_RE)) {
    const t = m[0];
    if (/^[a-z0-9]/.test(t)) {
      if (STOPWORDS.has(t)) continue;
      out.push(t);
    } else if (t.length >= 2) {
      for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
    } else {
      out.push(t);
    }
  }
  return out;
}

/** token 集合 Jaccard 相似度。 */
export function jaccardSim(a, b) {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (!sa.size || !sb.size) return 0.0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0.0;
}

/** 贪心 MMR：相对阈值截断 → 种子取最高分 → 逐条 λ·rel − (1−λ)·max_sim 选最大边际。保底全低于阈值也取最高分。 */
export function mmrSelect(scored, k, lam = 0.85, topCutoff = 0.2) {
  const items = Array.isArray(scored) ? scored : [];
  if (!items.length) return [];
  const top = Math.max(...items.map((s) => s[0])) || 1.0;
  let pool = items
    .map(([rel, idx, toks]) => [rel / top, idx, toks])
    .filter(([rel]) => rel >= topCutoff);
  if (!pool.length) {
    const [rel, idx, toks] = items[0];
    pool = [[rel / top, idx, toks]];
  }
  const selected = [];
  const popMax = () => {
    let bi = 0;
    for (let i = 1; i < pool.length; i++) if (pool[i][0] > pool[bi][0]) bi = i;
    return pool.splice(bi, 1)[0];
  };
  selected.push(popMax());
  while (selected.length < k && pool.length) {
    const margin = (x) => {
      const rel = x[0];
      let ms = 0.0;
      for (const s of selected) ms = Math.max(ms, jaccardSim(x[2], s[2]));
      return lam * rel - (1 - lam) * ms;
    };
    let bi = 0;
    for (let i = 1; i < pool.length; i++) if (margin(pool[i]) > margin(pool[bi])) bi = i;
    if (margin(pool[bi]) <= 0.0) break;
    selected.push(pool.splice(bi, 1)[0]);
  }
  return selected.map((s) => s[1]);
}

const K1 = 1.5;
const B = 0.75;

/** 基于语料构建 BM25 统计（df/avgdl）。 */
export function buildBm25Stats(docToksList) {
  const docFreq = new Map();
  let sum = 0;
  for (const toks of docToksList) {
    sum += toks.length;
    for (const w of new Set(toks)) docFreq.set(w, (docFreq.get(w) || 0) + 1);
  }
  const n = docToksList.length;
  return { totalDocs: n, docFreq, avgdl: n ? sum / n : 1 };
}

/** BM25 打分：K1=1.5, B=0.75；idf 用 Robertson-Sparck Jones 经典变体；stats 不传退化为词频打分。 */
export function bm25Score(qToks, docToks, stats) {
  const dl = docToks.length || 1;
  const tf = new Map();
  for (const w of docToks) tf.set(w, (tf.get(w) || 0) + 1);
  const N = stats?.totalDocs ?? 1;
  const avgdl = stats?.avgdl ?? 1;
  const df = stats?.docFreq;
  let s = 0;
  for (const w of new Set(qToks)) {
    const f = tf.get(w) || 0;
    if (!f) continue;
    const d = df?.get(w) || 0;
    const idf = df ? Math.log(1 + (N - d + 0.5) / (d + 0.5)) : 1;
    s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * dl) / avgdl)));
  }
  return s;
}

/** BM25 检索：候选条目 → BM25 分数（过滤 0 分）→ 贪心 MMR 排重；返回 [{ idx, score }]。 */
export function bm25Retrieve(entries, query, stats, opts = {}) {
  const k = Number(opts.topk ?? 10) || 10;
  const qToks = tokenizeForSim(query);
  const docText = (e) => e.block ?? e.text ?? "";
  const scores = entries.map((e) => bm25Score(qToks, tokenizeForSim(docText(e)), stats));
  const scored = entries
    .map((e, i) => [scores[i], i, tokenizeForSim(docText(e))])
    .filter(([rel]) => rel > 0);
  const lam = Number(opts.lambda ?? 0.85) || 0.85;
  const idxs = mmrSelect(scored, k, lam, 0.2);
  return idxs.map((i) => ({ idx: i, score: scores[i] }));
}

/* ── 暖态定位/改写/触达 ────────────────────────────────────── */

/** 按 ref 定位 warm 条目：支持 `[n]` 编号（1-based）或内容片段。返回 { index, entry } 或 null。 */
export function findWarmEntryRef(warm, ref) {
  const entries = parseWarm(warm);
  if (!entries.length) return null;
  const key = normalizeForMatch(String(ref ?? "")).trim();
  if (!key) return null;
  const num = key.match(/^\[(\d+)\]$/);
  if (num) {
    const idx = Number(num[1]) - 1;
    if (idx >= 0 && idx < entries.length) return { index: idx, entry: entries[idx] };
    return null;
  }
  const idx = entries.findIndex((e) => normalizeForMatch(e.block).includes(key));
  if (idx < 0) return null;
  return { index: idx, entry: entries[idx] };
}

/** 用 nextBlock 替换 ref 命中的条目（保留原位置）。无匹配返回 null。 */
export function replaceWarmEntryText(warm, ref, nextBlock) {
  const found = findWarmEntryRef(warm, ref);
  if (!found) return null;
  const entries = parseWarm(warm);
  entries[found.index] = { ...entries[found.index], block: nextBlock.trim() };
  return `${entries.map((e) => e.block).join("\n\n")}\n`;
}

/** 把 ref 命中的条目标记为 wrong（被翻转）：标题 confidence 改 wrong，内容保留。无匹配返回 null。 */
export function markWrongWarmEntryText(warm, ref) {
  const found = findWarmEntryRef(warm, ref);
  if (!found) return null;
  const entries = parseWarm(warm);
  const next = entries[found.index].block.replace(
    /^## (.+?)(?:\s+\[[a-z_]+\])?(?:\s+(?:high|medium|low|wrong))?\s*$/m,
    (_m, stamp) => `${stamp} [fact] wrong`,
  );
  entries[found.index] = { ...entries[found.index], block: next, confidence: "wrong" };
  return `${entries.map((e) => e.block).join("\n\n")}\n`;
}

/** 查近似重复：新内容与已有条目归一化后完全相等或短者是长者的子串且长度差 < 1.8 倍。 */
export function findNearDuplicateWarm(warm, content) {
  const entries = parseWarm(warm);
  if (!entries.length) return null;
  const key = normalizeText(content);
  if (!key) return null;
  for (let i = 0; i < entries.length; i++) {
    const body = normalizeText(entries[i].block);
    if (!body) continue;
    if (body === key) return { index: i, entry: entries[i], reason: "equal" };
    const [short, long] = body.length <= key.length ? [body, key] : [key, body];
    if (short.length > 0 && long.includes(short) && long.length <= short.length * 1.8) {
      return { index: i, entry: entries[i], reason: "contains" };
    }
  }
  return null;
}

/** 标记 warm 中「被用到」的条目（block 包含 ref 片段）刷新 last_access。返回 { text, touched }；无变化 text=null。 */
export function touchWarmAccessText(warm, ref, stamp) {
  const entries = parseWarm(warm);
  const key = ref ? normalizeForMatch(ref).trim() : "";
  if (!entries.length || !key) return { text: null, touched: 0 };
  let changed = false;
  let touched = 0;
  const blocks = entries.map((e) => {
    if (!normalizeForMatch(e.block).includes(key)) return e.block;
    touched += 1;
    if (!/<!-- last_access: [^>]+ -->/.test(e.block)) {
      changed = true;
      return `${e.block}\n<!-- last_access: ${stamp} -->`;
    }
    const next = e.block.replace(
      /<!-- last_access: [^>]+ -->/,
      `<!-- last_access: ${stamp} -->`,
    );
    if (next !== e.block) changed = true;
    return next;
  });
  return { text: changed ? `${blocks.join("\n\n")}\n` : null, touched };
}

/* ── 冷储 ──────────────────────────────────────────────────── */

/** 冷储摘要：把暖态原文压成「每条一行」的锚点（cold 只放摘要，不倾倒原文）。wrong 跳过。 */
export function summarizeWarmForCold(warmText) {
  const entries = parseWarm(String(warmText ?? "")).filter((e) => e.confidence !== "wrong");
  return entries.map((e) => {
    const body = e.block.replace(/\n?<!-- last_access: [^>]+ -->/, "").trim();
    const bodyLines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const contentLine = bodyLines.find((l) => !l.startsWith("##")) ?? bodyLines[0] ?? "";
    const brief = contentLine.replace(/\s+/g, " ").slice(0, 60);
    const tag = e.confidence === "high" ? "[high] " : e.confidence === "low" ? "[low] " : "";
    const k = e.kind !== "legacy" ? `[${e.kind}] ` : "";
    return `- ${k}${tag}${brief}`;
  });
}

/** 从前往后按条目边界截断（\n\n 分块），不切在字符中间；单块本身超限才字符截断。 */
export function truncateKeepHead(text, cap) {
  if (cap <= 0) return "";
  if (text.length <= cap) return text;
  const blocks = String(text).split(/\n\n/);
  const out = [];
  let used = 0;
  for (const b of blocks) {
    if (used + b.length > cap) {
      if (!out.length) return `${b.slice(0, cap)}\n…(截断)…`;
      break;
    }
    out.push(b);
    used += b.length + 2;
  }
  return out.join("\n\n");
}

/* ── 情景单元（episodic 原文一 session 一文件）──────────────── */

/** 主题 slug：非字母数字（中英文保留）压缩为下划线，截断防超长。 */
export function slugifyTheme(theme, maxLen = 40) {
  const t = String(theme ?? "").trim();
  const slug = t
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
  return slug || "untitled";
}

/** 单元文件名：`<时间戳>_session_<主题slug>.md`；seq>1 追加 `-<seq>` 防同日同主题冲突。 */
export function unitFileName(stamp, theme, seq = 0) {
  const s = String(stamp ?? "").replace(/[^\d-]/g, "").replace(/^(\d{4}-\d{2}-\d{2}).*$/, "$1");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : String(stamp ?? "unknown").slice(0, 10);
  const base = `${date}_session_${slugifyTheme(theme)}`;
  return seq > 1 ? `${base}-${seq}.md` : `${base}.md`;
}

/** 渲染单元 md（原文不动）。 */
export function renderEpisodicUnit({ stamp, theme, subjects = [], content }) {
  const subjLine = Array.isArray(subjects) && subjects.length ? `- subjects: ${subjects.join(", ")}` : "- subjects:";
  const body = String(content ?? "").trim();
  return [
    "# 记忆单元",
    `- stamp: ${stamp ?? ""}`,
    `- theme: ${theme ?? ""}`,
    subjLine,
    "",
    body,
    "",
  ].join("\n");
}

/** 解析单元 md → {stamp, theme, subjects, content}；容错：无 frontmatter 时全部归 content。 */
export function parseEpisodicUnit(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  const meta = {};
  const contentLines = [];
  let inMeta = false;
  let metaDone = false;
  for (const line of lines) {
    if (!metaDone) {
      if (line.startsWith("# ")) { inMeta = true; continue; }
      const m = line.match(/^-\s*(\w+)\s*:\s*(.*)$/);
      if (inMeta && m) { meta[m[1]] = m[2].trim(); continue; }
      if (inMeta && !m && !line.trim()) { metaDone = true; continue; }
      if (inMeta && !m && line.trim()) { metaDone = true; }
    }
    if (metaDone || !inMeta) contentLines.push(line);
  }
  const subjects = String(meta.subjects ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    stamp: meta.stamp ?? "",
    theme: meta.theme ?? "",
    subjects,
    content: contentLines.join("\n").trim(),
  };
}

/** 暖态条目：标题行复用 event 粒度 + 内容为原文复制 + src 溯源（与 parseWarm 完全兼容）。 */
export function renderWarmUnitBlock({ stamp, theme, subject, unitFile, content, conf = "high" }) {
  const subjTag = subject ? ` @${normalizeSubject(subject)}` : "";
  const srcLine = unitFile ? `> 原文单元：episodic/${unitFile}` : "";
  const body = String(content ?? "").trim();
  return `\n## ${stamp} [event] ${conf}${subjTag} src=${unitFile ?? ""}\n\n${srcLine}\n\n${body}\n<!-- last_access: ${stamp} -->\n`;
}

/** 暖态=当前条目：把原文单元复制到暖态（工作记忆）。幂等：同单元文件已存在则只刷新 last_access。 */
export function activateWarmUnit(warm, { stamp, theme, subject, unitFile, content, conf = "high" }) {
  const raw = String(warm ?? "");
  const existing = raw.match(new RegExp(`(## .*?\\[event\\][^\\n]* src=${escapeRe(unitFile)}[^\\n]*\\n[\\s\\S]*?)(?:\\n<!-- last_access: [^>]+ -->)`));
  if (existing) {
    const head = existing[1];
    const newStamp = stamp ?? new Date().toISOString().slice(0, 19).replace("T", " ");
    return raw.replace(existing[0], `${head}\n<!-- last_access: ${newStamp} -->`);
  }
  return `${raw.trimEnd()}\n${renderWarmUnitBlock({ stamp, theme, subject, unitFile, content, conf })}\n`;
}

/** 转义正则特殊字符。 */
function escapeRe(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 冷储单元索引速览（注入用）：列出时间/主题/主体。 */
export function renderEpisodicIndex(units, opts = {}) {
  const cap = Math.max(0, Math.floor(opts?.maxChars ?? 600));
  if (!Array.isArray(units) || !units.length) return "";
  const rows = units
    .map((u) => `- ${u.stamp ?? ""} ${u.theme ? `— ${u.theme}` : ""}${u.subjects?.length ? `  @${u.subjects.join("/")}` : ""}`)
    .join("\n");
  const out = `## 原文单元索引 / Episodic\n${rows}`;
  return out.length > cap ? truncateKeepHead(out, cap) : out;
}

/* ── 海马体布局（三方共享的同一根目录读写）────────────────── */

/**
 * createHippocampus(root, readText) — 共享单例工厂。
 *
 * @param root     记忆根目录（函数或字符串）：$DSH_HOME/linghun/memory
 * @param readText 读取函数（文件→文本，缺失返回 null，可带 mtime 缓存）
 *
 * 三方约定：linghun / memory / assembler 全部经 createHippocampus 访问
 * warm.md / cold.md / episodic/ / journal/ ——同一根目录、同一套读写，
 * 杜绝各带一份导致的竞态（写串行、读并发）。
 */
export function createHippocampus(root, readText) {
  const memoryRoot = () => (typeof root === "function" ? root() : root);

  const warmFile = () => join(memoryRoot(), WARM);
  const coldFile = () => join(memoryRoot(), COLD);
  const episodicDir = () => join(memoryRoot(), EPISODIC_DIR);
  const journalDir = () => join(memoryRoot(), JOURNAL_DIR);

  const readFile = (file) => {
    const text = readText(file);
    return text === null ? "" : text;
  };

  /** 序时账：把一轮原始对话 append 到当天 journal（YYYY-MM-DD.md），每条带 HH:MM:SS；全量记录不筛选。 */
  const appendJournal = (stampSec, text) => {
    const day = String(stampSec).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !text?.trim()) return false;
    const file = join(journalDir(), `${day}.md`);
    try {
      mkdirSync(journalDir(), { recursive: true });
      appendFileSync(file, `\n${stampSec}\n${text.trim()}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  };

  const listJournal = () => {
    try {
      return readdirSync(journalDir(), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name, "en"))
        .map((entry) => {
          const file = join(journalDir(), entry.name);
          const text = readText(file);
          const nBlocks = (text ?? "").split(/\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/).filter((b) => b.trim()).length;
          return { file, name: basename(entry.name, ".md"), entries: nBlocks };
        });
    } catch {
      return [];
    }
  };

  const listEpisodic = () => {
    try {
      return readdirSync(episodicDir(), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name, "en"))
        .map((entry) => {
          const file = join(episodicDir(), entry.name);
          const text = readText(file);
          const parsed = parseEpisodicUnit(text);
          const lines = (text ?? "").split(/\r?\n/);
          const firstContent = lines.find((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-"));
          return {
            file,
            name: basename(entry.name, ".md"),
            title: firstContent ? firstContent.trim().slice(0, 120) : "",
            stamp: parsed.stamp ?? "",
            theme: parsed.theme ?? "",
            subjects: parsed.subjects ?? [],
          };
        });
    } catch {
      return [];
    }
  };

  /** 写冷储原文单元（一 session 一文件）。幂等：同文件名已存在不覆盖（原文不动档案）；同日同主题自动加 -2/-3 序号。 */
  const appendEpisodicUnit = (unit) => {
    try {
      let name = unitFileName(unit.stamp ?? "", unit.theme ?? "");
      let seq = 1;
      while (existsSync(join(episodicDir(), name))) {
        seq++;
        name = unitFileName(unit.stamp ?? "", unit.theme ?? "", seq);
      }
      const file = join(episodicDir(), name);
      mkdirSync(episodicDir(), { recursive: true });
      writeFileSync(file, renderEpisodicUnit(unit), "utf8");
      return { file, name, created: true };
    } catch {
      return null;
    }
  };

  /** 读冷储单元全文（不存在返回 ""）。 */
  const readEpisodicUnit = (name) => {
    const base = String(name ?? "").replace(/\.md$/, "");
    const file = join(episodicDir(), `${base}.md`);
    return readFile(file);
  };

  /** 读指定日期 journal（支持 start/end 时间窗过滤）。 */
  const readJournal = (day, opts = {}) => {
    const file = join(journalDir(), `${day}.md`);
    const text = readFile(file);
    if (!text.trim()) return "";
    const start = typeof opts?.start === "string" ? opts.start.trim() : "";
    const end = typeof opts?.end === "string" ? opts.end.trim() : "";
    if (!start && !end) return text;
    const stampRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const blocks = text.split(/\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    const kept = blocks.filter((b) => {
      const firstLine = b.trimStart().split(/\r?\n/, 1)[0]?.trim();
      if (!firstLine || !stampRe.test(firstLine)) return false;
      if (start && firstLine < start) return false;
      if (end && firstLine > end) return false;
      return true;
    });
    return kept.join("\n");
  };

  return {
    memoryRoot,
    warmFile,
    coldFile,
    episodicDir,
    journalDir,
    readWarm: () => readFile(warmFile()),
    readCold: () => readFile(coldFile()),
    appendJournal,
    listJournal,
    readJournal,
    listEpisodic,
    appendEpisodicUnit,
    readEpisodicUnit,
    /** 暖态触达（读≠用：实际派上用场才 touch）。 */
    touchWarm(ref, stamp = new Date().toISOString().slice(0, 19).replace("T", " ")) {
      const warm = readFile(warmFile());
      const { text, touched } = touchWarmAccessText(warm, ref, stamp);
      if (text !== null) {
        try {
          writeFileSync(warmFile(), text, "utf8");
        } catch {
          return { touched: 0 };
        }
      }
      return { touched };
    },
  };
}
