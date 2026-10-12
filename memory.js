/**
 * 灵魂（Linghun）— 海马体记忆布局。
 *
 * 暖态工位 + 冷储归档 + 序时账（journal），机制先行：
 *
 *   $DSH_HOME/linghun/memory/
 *   ├── warm.md          # 暖态工位：近期记忆（linghun_memory_append 写这里，遗忘梯度）
 *   ├── cold.md          # 冷储摘要：沉淀后的知识/规则（注入时优先读）
 *   ├── episodic/        # 冷储归档：YYYY-MM-DD.md（linghun_memory_consolidate 时移入）
 *   └── journal/         # 序时账：YYYY-MM-DD.md 原始流水（每次对话全量 append，不筛选）
 */
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export const WARM = "warm.md";
export const COLD = "cold.md";
export const EPISODIC_DIR = "episodic";
export const JOURNAL_DIR = "journal";
/** 三本体档案（warm 移出后的固化层，结构化条目追加）：
 *  记忆本体 = 事件时间线档案；知识本体 = 精确值档案。规则本体沿用 rules.md（ontology.js）。 */
export const MEMORY_ONTOLOGY = "memory_ontology.md";
export const KNOWLEDGE_ONTOLOGY = "knowledge_ontology.md";

/** 结构化条目三型：event（事件=记忆本体）/ fact（事实=知识本体）/ rule（规则=规则本体）。
 *  legacy 表示旧叙述条目（无 kind 标记，兼容渲染）。 */
export const KINDS = ["event", "fact", "rule"];

/** 从条目标题行提取 kind：`## <stamp> [<kind>] <confidence>`；无 kind 视为 legacy（旧叙述条目）。
 *  三型归一化贯穿解析层：旧类别（decision/preference→rule、experience→event、identity→fact）在此收敛。 */
export function kindOfBlock(block) {
  const m = String(block ?? "").match(/^## .*?\[([a-z_]+)\]/m);
  const k = m ? m[1].toLowerCase() : "legacy";
  if (KINDS.includes(k)) return k;
  if (k === "decision" || k === "preference") return "rule";
  if (k === "experience") return "event";
  if (k === "identity") return "fact";
  return "legacy";
}

/** 解析 warm.md 为条目数组；每条提取 last_access、confidence 与 kind。
 *  标题行格式：`## <stamp> [<kind>] <confidence>`；confidence 缺省视为 medium（老条目兼容）；
 *  kind 缺省视为 legacy（旧叙述条目，兼容渲染）。
 *  confidence：high / medium / low / wrong（wrong=被翻转的事实，已废弃，注入时排除）。 */
export function parseWarm(text) {
  const blocks = String(text ?? "")
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const m = block.match(/<!-- last_access: ([^>]+) -->/);
    const cm = block.match(/^## .*?\[[a-z_]+\]\s+(high|medium|low|wrong)\s*$/m);
    return {
      block,
      lastAccess: m ? m[1].trim() : null,
      confidence: cm ? cm[1] : "medium",
      kind: kindOfBlock(block),
    };
  });
}

const CONF_WEIGHT = { high: 2, medium: 1, low: 0, wrong: -1 };

/** 渲染条目为纯内容（剥掉 last_access 元数据），按原顺序 join。
 *  opts.markLow !== false：低置信条目加【低置信·需验证】前缀（提醒模型声明存疑）。
 *  opts.includeWrong !== true：wrong（被翻转）条目默认跳过——注入绝不引用已废弃事实。
 *  opts.numbered：每条加 [n] 编号前缀（基于原始索引，供 linghun_memory_append update 引用）。
 *  opts.kinds：数组过滤（只渲染指定 kind，如 ["fact"]）；不传渲染全部。 */
export function renderWarmEntries(entries, opts = {}) {
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => opts.includeWrong === true || e.confidence !== "wrong")
    .filter(({ e }) => (Array.isArray(opts.kinds) ? opts.kinds.includes(e.kind) : true))
    .map(({ e, i }) => {
      const body = e.block.replace(/\n?<!-- last_access: [^>]+ -->/, "");
      const num = opts.numbered ? `[${i + 1}] ` : "";
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

/** 按 last_access 降序排序（最近调用的在前）；缺失视为最旧沉底。 */
export function sortWarmByAccess(entries) {
  return [...entries].sort((a, b) => {
    const ta = a.lastAccess ?? "";
    const tb = b.lastAccess ?? "";
    return tb.localeCompare(ta, "en");
  });
}

/** 注入排序：先按置信度（高>中>低>wrong）。
 *  high（验证过的知识）不参与时间衰减——保持写入顺序，时间管不着（几个月没用也不沉底）；
 *  medium/low 按 last_access 衰减（新在前），吃灰沉底被挤出注入——遗忘梯度只管未验证/存疑的情景。
 *  wrong 沉底且渲染时排除。 */
export function sortWarmForInject(entries) {
  return [...entries].sort((a, b) => {
    const wa = CONF_WEIGHT[a.confidence ?? "medium"] ?? 1;
    const wb = CONF_WEIGHT[b.confidence ?? "medium"] ?? 1;
    if (wa !== wb) return wb - wa;
    if ((a.confidence === "high" && b.confidence === "high")) return 0; // 稳定排序=保持写入序
    const ta = a.lastAccess ?? "";
    const tb = b.lastAccess ?? "";
    return tb.localeCompare(ta, "en");
  });
}

/** 匹配前剥掉 markdown 格式标记（**、*、`），避免模型选的 ref 跨标记匹配失败。 */
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

/**
 * v0.1.0：MMR 排重（BEAM 情境树 v2.6 机制回灌）。
 * token 口径对齐 v2.6：英数 token（[A-Za-z0-9][A-Za-z0-9_'-]*，去英文停用词）；
 * 扩展中文连续串（[\u4e00-\u9fff]+），保证中英内容都能算相似度。
 */
const STOPWORDS = new Set(
  ("a an and are as at be but by for if in into is it no not of on or such that the their then there these this to was will with i you your we our he she they them me my mine yours ours the a an of to in for on with about").split(" "),
);
const TOKEN_SIM_RE = /[a-z0-9][a-z0-9_'\-]*|[\u4e00-\u9fff]+/g;

/** 相似度用 token 化：小写英数 token（去停用词）+ 中文连续串按字符 bigram 切分。
 *  中文整串粒度太粗（3-4 块），jaccard 会被稀释到相似句不相似；bigram 让中英都能敏感算相似。 */
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

/** token 集合 Jaccard 相似度（v2.6 mmr 的 jaccard 移植）。 */
export function jaccardSim(a, b) {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (!sa.size || !sb.size) return 0.0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0.0;
}

/**
 * 贪心 MMR：相对阈值截断 → 种子取最高分 → 逐条 λ·rel − (1−λ)·max_sim 选最大边际。
 * scored: [[rel, idx, toks], ...]，rel 归一化到池顶；返回保留下来的 idx 数组。
 * 保底：全低于阈值也取最高分（防情境恢复空手）。λ=0.85 相关优先、阈值 0.2 保守。
 */
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

/** 按 ref 定位 warm 条目：支持 `[n]` 编号（linghun_memory_read 展示顺序，1-based）或内容片段。
 *  匹配双方先剥 markdown 标记。返回 { index, entry } 或 null。 */
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

/** 用 nextBlock 替换 ref 命中的条目（保留原位置，其他条目不变）。无匹配返回 null。 */
export function replaceWarmEntryText(warm, ref, nextBlock) {
  const found = findWarmEntryRef(warm, ref);
  if (!found) return null;
  const entries = parseWarm(warm);
  entries[found.index] = { ...entries[found.index], block: nextBlock.trim() };
  return `${entries.map((e) => e.block).join("\n\n")}\n`;
}

/** 把 ref 命中的条目标记为 wrong（被翻转）：标题 confidence 改 wrong，内容保留（追溯）。无匹配返回 null。 */
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

/** 查近似重复：新内容与已有条目归一化后完全相等（equal）或短者是长者的子串且长度差 < 1.8 倍（contains）。
 *  命中返回 { index, entry, reason }，否则 null。只合并"几乎一样"的，不误伤不同事实。 */
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

/** 标记 warm 中「被用到」的条目（block 包含 ref 片段）刷新 last_access。
 *  读≠用：只有显式 touch 才算被调用=活跃。返回 { text, touched }；无变化 text=null。
 *  匹配时双方先剥 markdown 标记（normalizeForMatch），写盘保留原文。 */
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

/**
 * @param root     记忆根目录（函数或字符串）
 * @param readText 读取函数，缺失时返回 null（可带 mtime 缓存）
 */
/** 冷储摘要：把暖态原文压成「每条一行」的锚点（F4：cold 只放摘要，不倾倒原文）。
 *  返回行数组；wrong（被翻转）条目跳过。行首带 kind 标记（event/fact/rule/legacy），冷储可读。 */
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

/** 从前往后按条目边界截断（\n\n 分块），不切在字符中间；单块本身超限才字符截断。
 *  返回保留下来的头段；cap<=0 或放不下任何块时返回空串（调用方据此停止）。 */
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

export function createMemoryLayout(root, readText) {
  const memoryRoot = () => (typeof root === "function" ? root() : root);

  const warmFile = () => join(memoryRoot(), WARM);
  const coldFile = () => join(memoryRoot(), COLD);
  const episodicDir = () => join(memoryRoot(), EPISODIC_DIR);
  const journalDir = () => join(memoryRoot(), JOURNAL_DIR);
  /** 三本体档案文件：记忆本体（事件时间线）/ 知识本体（精确值）。规则本体在 ontology.js（rules.md）。 */
  const memoryOntologyFile = () => join(memoryRoot(), MEMORY_ONTOLOGY);
  const knowledgeOntologyFile = () => join(memoryRoot(), KNOWLEDGE_ONTOLOGY);

  const readFile = (file) => {
    const text = readText(file);
    return text === null ? "" : text;
  };

  /** 序时账：把一轮原始对话 append 到当天 journal（YYYY-MM-DD.md），每条带 HH:MM:SS。
   *  append 顺序 = 天内先后；全量记录不筛选不评估。 */
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
          const lines = (text ?? "").split(/\r?\n/);
          const firstContent = lines.find((line) => line.trim() && !line.startsWith("#"));
          return {
            file,
            name: basename(entry.name, ".md"),
            title: firstContent ? firstContent.trim().slice(0, 120) : "",
          };
        });
    } catch {
      return [];
    }
  };

  return {
    warmFile,
    coldFile,
    episodicDir,
    journalDir,
    memoryOntologyFile,
    knowledgeOntologyFile,
    readWarm: () => readFile(warmFile()),
    readCold: () => readFile(coldFile()),
    readMemoryOntology: () => readFile(memoryOntologyFile()),
    readKnowledgeOntology: () => readFile(knowledgeOntologyFile()),
    listEpisodic,
    appendJournal,
    listJournal,
    readJournal: (day, opts = {}) => {
      const file = join(journalDir(), `${day}.md`);
      const text = readFile(file);
      if (!text.trim()) return "";
      const start = typeof opts?.start === "string" ? opts.start.trim() : "";
      const end = typeof opts?.end === "string" ? opts.end.trim() : "";
      // 无时间范围：保持整天全量（向后兼容）
      if (!start && !end) return text;
      const stampRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
      const blocks = text.split(/\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const kept = blocks.filter((b) => {
        const firstLine = b.trimStart().split(/\r?\n/, 1)[0]?.trim();
        if (!firstLine || !stampRe.test(firstLine)) return false;
        // ISO 秒级时间戳字符串可直接字典序比较
        if (start && firstLine < start) return false;
        if (end && firstLine > end) return false;
        return true;
      });
      return kept.join("\n");
    },

    /** 注入用渲染：三本体档案（知识/规则/记忆）+ 冷储摘要 + 归档/序时账索引，截断到 maxChars。
     *  写侧协议 v1：本体档案（结构化可查视图）优先注入——知识本体（精确值）→ 规则本体（纪律）→
     *  事件时间线（时序）→ 冷储摘要（高抽象经验）；暖态近期记忆（warm）默认不进注入段
     *  （近期记忆由 linghun_memory_read 按需读取），仅当 opts.injectWarm === true 时追加。
     *  opts.timeWeight !== false 时，暖态按 sortWarmForInject 排序：
     *  high（验证过的知识）不衰减、保持写入序常驻；medium/low 按 last_access 衰减（吃灰沉底）；
     *  超限从尾部裁剪——低置信/吃灰的记忆自然被挤出注入，high 知识永不因久未使用被挤出。
     *  低置信条目带【低置信·需验证】标记；存在低置信条目时附声明纪律：引用存疑记忆必须先声明不确定，不编造不硬选。 */
    renderForInject(maxChars, opts = {}) {
      const cold = readFile(coldFile());
      const warmRaw = readFile(warmFile());
      const episodes = listEpisodic();
      const journals = listJournal();
      const parts = [];
      // 本体档案优先：知识本体（精确值，回答"是什么/多少"）
      const ontK = readFile(knowledgeOntologyFile());
      if (ontK.trim()) parts.push(`## 知识本体 / Facts\n${ontK.trim()}`);
      // 规则本体（该怎么做，行为纪律）
      const rulesFile = join(memoryRoot(), "rules.md");
      const rulesText = readFile(rulesFile);
      if (rulesText.trim()) parts.push(`## 规则本体 / Rules\n${rulesText.trim()}`);
      // 记忆本体（事件时间线，回答"什么时候/顺序"）
      const ontM = readFile(memoryOntologyFile());
      if (ontM.trim()) parts.push(`## 事件时间线 / Timeline\n${ontM.trim()}`);
      // 近期记忆默认不进注入段（高频高抽象优先；近期由 linghun_memory_read 按需读）
      if (opts.injectWarm === true && warmRaw.trim()) {
        let warm = warmRaw;
        if (opts.timeWeight !== false) {
          const entries = sortWarmForInject(parseWarm(warmRaw));
          // v0.1.0：MMR 排重（BEAM v2.6 机制回灌）——排序后候选按「位置新鲜度」打分，
          // 贪心 λ·rel − (1−λ)·max_sim 去重（token Jaccard），同类冗余条目被砍，保留多样性。
          // 置信度不参与打分：低置信条目按注入纪律须带【低置信·需验证】标记注入，不得被 MMR 挤掉；
          // 排重只针对「同类冗余」（相似度惩罚）；wrong 沉底后新鲜度自然低于阈值被过滤。
          const mmr = opts.mmr && typeof opts.mmr === "object" ? opts.mmr : {};
          if (mmr.enabled !== false) {
            const k = Number(mmr.k ?? 6) || 6;
            const n = entries.length;
            const relOf = (e, i) => {
              // 新鲜度：位置越靠前越新；high（验证过）不参与时间衰减，恒 1.0
              return e.confidence === "high" ? 1.0 : 1 - 0.6 * (n > 1 ? i / (n - 1) : 0);
            };
            const scored = entries.map((e, i) => [relOf(e, i), i, tokenizeForSim(e.block)]);
            const idxs = mmrSelect(
              scored,
              k,
              Number(mmr.lambda ?? 0.85) || 0.85,
              Number(mmr.topCutoff ?? 0.2) || 0.2,
            );
            warm = renderWarmEntries(idxs.map((i) => entries[i]));
          } else {
            warm = renderWarmEntries(entries);
          }
        }
        const lowExists = /【低置信·需验证】/.test(warm);
        const note = lowExists
          ? "\n> 记忆带置信度：无标记=中置信；【低置信·需验证】=存疑。引用存疑记忆必须先声明不确定，不得当确定事实输出；与高置信/新记忆冲突时明说矛盾，不硬选。\n"
          : "";
        parts.push(`## 近期记忆 / Recent\n${note}\n${warm.trim()}`);
      }
      if (cold.trim()) parts.push(cold.trim());
      if (episodes.length) {
        const rows = episodes
          .map((e) => `- ${e.name}${e.title ? ` — ${e.title}` : ""}`)
          .join("\n");
        parts.push(`## 归档索引 / Archive\n${rows}`);
      }
      if (journals.length) {
        const rows = journals.map((j) => `- ${j.name}（${j.entries} 条流水）`).join("\n");
        parts.push(`## 序时账索引 / Journal\n${rows}`);
      }
      const rendered = parts.join("\n\n");
      if (!rendered) return "";
      const cap = Math.max(0, Math.floor(maxChars ?? 6000));
      if (rendered.length <= cap) return rendered;
      // 段边界 + 条目边界截断：从前往后保留完整段落/条目，超限处停并提示，不切在字符中间
      const kept = [];
      let used = 0;
      for (const part of parts) {
        const remain = cap - used;
        if (remain <= 0) break;
        const head = truncateKeepHead(part, remain);
        if (!head) break;
        kept.push(head);
        used += head.length + 2;
        if (head.length < part.length) break;
      }
      return `${kept.join("\n\n")}\n\n> 记忆超出注入上限，可用 linghun_memory_read 读取全文。`;
    },
  };
}
