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
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  WARM, COLD, EPISODIC_DIR, JOURNAL_DIR, KINDS,
  kindOfBlock, parseWarm, renderWarmEntries,
  normalizeForMatch, normalizeText, matchRef, filterWarmByRef, filterTextByRef,
  sortWarmNewestFirst, sortWarmByAccess, sortWarmForInject,
  tokenizeForSim, jaccardSim, mmrSelect, buildBm25Stats, bm25Score, bm25Retrieve,
  findWarmEntryRef, replaceWarmEntryText, markWrongWarmEntryText,
  findNearDuplicateWarm, touchWarmAccessText,
  summarizeWarmForCold, truncateKeepHead,
  slugifyTheme, unitFileName, renderEpisodicUnit, parseEpisodicUnit,
  renderWarmUnitBlock, activateWarmUnit, renderEpisodicIndex,
} from "./vendor/hippocampus.js";
import { parseRulesBuckets } from "./ontology.js";

/* 转发导出：抽离后保持对外签名不变（抽道留术——调用方 import memory.js 的行为不变） */
export {
  WARM, COLD, EPISODIC_DIR, JOURNAL_DIR, KINDS,
  kindOfBlock, parseWarm, renderWarmEntries,
  normalizeForMatch, normalizeText, matchRef, filterWarmByRef, filterTextByRef,
  sortWarmNewestFirst, sortWarmByAccess, sortWarmForInject,
  tokenizeForSim, jaccardSim, mmrSelect, buildBm25Stats, bm25Score, bm25Retrieve,
  findWarmEntryRef, replaceWarmEntryText, markWrongWarmEntryText,
  findNearDuplicateWarm, touchWarmAccessText,
  summarizeWarmForCold, truncateKeepHead,
  slugifyTheme, unitFileName, renderEpisodicUnit, parseEpisodicUnit,
  renderWarmUnitBlock, activateWarmUnit, renderEpisodicIndex,
};

/** 人物画像目录（主体轴挂载点）：$DSH_HOME/linghun/profiles/<subject>.md，六槽画像。 */
export const PROFILES_DIR = "profiles";
/** 画像六槽（fact/state/goal/value/causal/preference）——画像 = 记忆的第一索引键。 */
export const PROFILE_SLOTS = ["fact", "state", "goal", "value", "causal", "preference"];
/** 本体档案与记忆文件（warm 移出后的固化层，结构化条目追加）：
 *  记忆 = 事件时间线文件；知识本体 = 精确值档案。规则本体沿用 rules.md（ontology.js）。 */
export const MEMORY_TIMELINE = "memory_timeline.md";
/** 旧文件名（记忆本体时代遗留），只读兼容：memory_timeline.md 不存在时回退读它。 */
export const MEMORY_TIMELINE_LEGACY = "memory_ontology.md";
/** @deprecated 旧常量名，仅为外部引用兼容保留。 */
export const MEMORY_ONTOLOGY = MEMORY_TIMELINE;
export const KNOWLEDGE_ONTOLOGY = "knowledge_ontology.md";

/** 解析画像文件（$DSH_HOME/linghun/profiles/<subject>.md）。
 *  格式：`# 画像：<subject>（<备注>）` → 摘要行 `> 摘要：…` → 六槽分组 `## <slot>`，槽内 `- 条目`。
 *  返回 { subject, summary, slots: { [slot]: [{ text, confidence }] } }；未识别槽并入 "other"。
 *  解析失败/空文件返回 null（调用方据此跳过画像段）。 */
export function parseProfiles(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  const subjectMatch = raw.match(/^#\s*画像[:：]\s*([^\s（(]+)/m);
  if (!subjectMatch) return null;
  const subject = subjectMatch[1].trim();
  const summaryMatch = raw.match(/^>\s*摘要[:：]\s*(.+)$/m);
  const slots = {};
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const slotMatch = trimmed.match(/^##\s*([a-z_]+)\s*$/);
    if (slotMatch) {
      current = slotMatch[1];
      if (!slots[current]) slots[current] = [];
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
    if (current && /^-/.test(trimmed)) {
      const body = trimmed.replace(/^-+\s*/, "").trim();
      if (body) slots[current].push({ text: body, confidence: null });
    }
  }
  return { subject, summary: summaryMatch ? summaryMatch[1].trim() : "", slots };
}

/** 画像速览（注入用，默认 300 字预算）：每主体一行——主体名 + 摘要 + 有内容的槽位计数。
 *  只做索引密度导航，不倾倒画像全文；细节由 linghun_profile_get 按需读。 */
export function renderProfileIndex(profiles, opts = {}) {
  const list = (Array.isArray(profiles) ? profiles : [profiles]).filter(Boolean);
  if (!list.length) return "";
  const cap = Math.max(0, Math.floor(opts.maxChars ?? 300));
  const rows = list.map((p) => {
    const filled = PROFILE_SLOTS.filter((s) => (p.slots?.[s] ?? []).length > 0);
    const count = filled.length
      ? `（槽：${filled.map((s) => `${s}${p.slots[s].length}`).join("/")}）`
      : "";
    const sum = p.summary ? `—— ${p.summary}` : "";
    return `- ${p.subject}${sum}${count}`;
  });
  let out = `## 人物画像 / Profiles\n${rows.join("\n")}`;
  if (out.length <= cap) return out;
  // 超出预算：只保留主体名 + 摘要，砍掉槽位计数
  out = `## 人物画像 / Profiles\n${list.map((p) => `- ${p.subject}${p.summary ? `—— ${p.summary}` : ""}`).join("\n")}`;
  if (out.length <= cap) return out;
  return truncateKeepHead(out, cap);
}

/** 画像全文渲染（linghun_profile_get 用）：摘要 + 六槽完整条目。 */
export function renderProfileFull(profile, opts = {}) {
  if (!profile) return "";
  const parts = [];
  parts.push(`# 画像：${profile.subject}`);
  if (profile.summary) parts.push(`> 摘要：${profile.summary}`);
  const slotFilter = Array.isArray(opts?.slots) ? opts.slots : PROFILE_SLOTS;
  for (const slot of PROFILE_SLOTS) {
    if (slotFilter.includes(slot)) {
      const entries = profile.slots?.[slot] ?? [];
      if (!entries.length) continue;
      parts.push(`## ${slot}\n${entries.map((e) => `- ${e.text}`).join("\n")}`);
    }
  }
  const rendered = parts.join("\n\n");
  if (!rendered) return `# 画像：${profile.subject}\n> 暂无画像内容，可用 linghun_profile_update 沉淀。`;
  const cap = Math.max(0, Math.floor(opts?.maxChars ?? 4000));
  return rendered.length <= cap ? rendered : truncateKeepHead(rendered, cap);
}

/** 主体名归一为文件名安全形式（画像文件主键）。空/非法输入回退 "unknown"。 */
export function normalizeSubject(subject) {
  const s = String(subject ?? "").trim();
  const clean = s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "");
  return clean || "unknown";
}

/** 画像槽位追加/更新（upsert）：返回新画像文本。
 *  语义对齐 warm 的 update：update 命中（前缀/包含匹配，剥时间戳）时旧条目标注 ⚠️ 已更新；
 *  新条目插入目标槽段末尾（同槽相邻）；无目标槽段时新建 `## <slot>` 段；update 未命中则直接追加新条目。
 *  slot 不在六槽内归入 "other"；空 entry 返回 null（调用方报错）。 */
export function upsertProfileSlotText(text, slot, entry, update, stamp) {
  const entryText = String(entry ?? "").trim();
  if (!entryText) return null;
  const marker = stamp ? `（${stamp}）` : "";
  const line = `- ${entryText}${marker}`;
  if (!PROFILE_SLOTS.includes(slot)) slot = "other";
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return `# 画像：未知\n\n## ${slot}\n${line}\n`;
  }
  const lines = raw.split(/\r?\n/);
  // 1) 找 update 目标（任意槽位条目）
  let hitIdx = -1;
  if (update) {
    const un = normalizeForMatch(String(update));
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith("-")) continue;
      let body = t.replace(/^-+\s*/, "").trim();
      body = body.replace(/\s*（\d{4}-\d{2}-\d{2}.*?）\s*$/, "").trim();
      if (!body) continue;
      const bn = normalizeForMatch(body);
      if (bn === un || bn.startsWith(un) || bn.includes(un)) {
        hitIdx = i;
        break;
      }
    }
  }
  // 2) 定位目标槽段（## slot 头 到 下一段头 之间）
  let slotStart = -1;
  let slotEnd = lines.length;
  let inTarget = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^##\s*([a-z_]+)\s*$/);
    if (m) {
      if (inTarget) {
        slotEnd = i;
        break;
      }
      if (m[1] === slot) {
        inTarget = true;
        slotStart = i;
      }
    }
  }
  if (!inTarget) {
    return `${raw.trimEnd()}\n\n## ${slot}\n${line}\n`;
  }
  // 3) 命中 update：旧条目标注 ⚠️ 已更新（保留现场，供追溯）
  const out = [...lines];
  if (hitIdx >= 0) {
    const oldBody = out[hitIdx].replace(/^-+\s*/, "").trim();
    out[hitIdx] = oldBody ? `- ~~${oldBody}~~ ⚠️ 已更新` : out[hitIdx];
  }
  // 4) 新条目插入：命中且同槽 → 紧跟旧条目；否则目标槽段末尾
  let pos = Math.min(slotEnd, out.length);
  if (hitIdx >= 0 && hitIdx >= slotStart && hitIdx < slotEnd) pos = hitIdx + 1;
  out.splice(pos, 0, line);
  return out.join("\n");
}

export function createMemoryLayout(root, readText) {
  const memoryRoot = () => (typeof root === "function" ? root() : root);

  const warmFile = () => join(memoryRoot(), WARM);
  const coldFile = () => join(memoryRoot(), COLD);
  const episodicDir = () => join(memoryRoot(), EPISODIC_DIR);
  const journalDir = () => join(memoryRoot(), JOURNAL_DIR);
  /** 本体档案与记忆文件：记忆（事件时间线）/ 知识本体（精确值）。规则本体在 ontology.js（rules.md）。 */
  const memoryOntologyFile = () => {
    const next = join(memoryRoot(), MEMORY_TIMELINE);
    if (existsSync(next)) return next;
    const legacy = join(memoryRoot(), MEMORY_TIMELINE_LEGACY);
    return existsSync(legacy) ? legacy : next;
  };
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

  /** v0.3.0：写冷储原文单元（一 session 一文件）。幂等：同文件名已存在不覆盖（原文不动档案）；
   *  同日同主题冲突时自动加 -2/-3 序号（同一天多个 session 同名主题时保证都落盘）。
   *  返回 {file, name, created}；created=false 表示已存在（保留旧档案）。 */
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

  /** v0.3.0：读冷储单元全文（不存在返回 ""） */
  const readEpisodicUnit = (name) => {
    const base = String(name ?? "").replace(/\.md$/, "");
    const file = join(episodicDir(), `${base}.md`);
    return readFile(file);
  };

  return {
    warmFile,
    coldFile,
    episodicDir,
    journalDir,
    memoryOntologyFile,
    knowledgeOntologyFile,
    appendEpisodicUnit,
    readEpisodicUnit,
    profilesDir: () => join(memoryRoot(), PROFILES_DIR),
    /** 读指定主体画像文件（不存在返回 ""）。 */
    readProfile: (subject) => readFile(join(memoryRoot(), PROFILES_DIR, `${normalizeSubject(subject)}.md`)),
    /** 列全部画像（解析为 { subject, summary, slots } 数组，供速览注入/状态展示）。 */
    listProfiles: () => {
      try {
        const dir = join(memoryRoot(), PROFILES_DIR);
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
          .sort((a, b) => a.name.localeCompare(b.name, "en"))
          .map((entry) => parseProfiles(readFile(join(dir, entry.name))))
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    readWarm: () => readFile(warmFile()),
    readCold: () => readFile(coldFile()),
    readMemoryOntology: () => readFile(memoryOntologyFile()),
    readKnowledgeOntology: () => readFile(knowledgeOntologyFile()),
    /** 本体资源池（DSH 本体分工定案：知识+规则存储合并、使用归 linghun 收口者）：
     *  统一只读视图 = 知识本体（精确值）+ 规则本体（纪律）合并；物理文件保持
     *  knowledge_ontology.md / rules.md 不动，逻辑上是一个本体资源池，
     *  供 linghun 收口侧按需装配读取（收口者的上下文工程）。 */
    readOntologyPool() {
      const ontK = readFile(knowledgeOntologyFile());
      const rulesFile = join(memoryRoot(), "rules.md");
      const rulesText = readFile(rulesFile);
      const parts = [];
      if (ontK.trim()) parts.push(`## 知识本体 / Knowledge\n${ontK.trim()}`);
      if (rulesText.trim()) parts.push(`## 规则本体 / Rules\n${rulesText.trim()}`);
      return parts.join("\n\n");
    },
    /** 本体资源池只读索引：分区 + 主题/桶 + 条目数，供 linghun 装配时快速定位命中。 */
    listOntologyPool() {
      const ontK = readFile(knowledgeOntologyFile());
      const rulesFile = join(memoryRoot(), "rules.md");
      const rulesText = readFile(rulesFile);
      const kThemes = [...ontK.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
      const kEntries = (ontK.match(/^[-*]\s+/gm) ?? []).length;
      const rBuckets = parseRulesBuckets(rulesText);
      return {
        knowledge: { file: KNOWLEDGE_ONTOLOGY, themes: kThemes, entries: kEntries },
        rules: { file: "rules.md", themes: rBuckets.map((b) => b.name), entries: rBuckets.length },
      };
    },
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

    /** 注入用渲染：本体档案与记忆（知识/规则/记忆）+ 冷储摘要 + 归档/序时账索引，截断到 maxChars。
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
      // 记忆（事件时间线，回答"什么时候/顺序"）
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

/* ================= v0.3.0 原文单元 + 暖态=当前条目 =================
 * 记忆单元=冷储原文 md 文件（一 session 一文件）；暖态=当前条目（工作记忆）：
 * 冷储不动，检索命中把原文复制到暖态激活。图谱（graph.js）连接单元与画像要素。
 * 单元文件格式（episodic/<时间戳>_session_<主题slug>.md）：
 *   # 记忆单元
 *   - stamp: <ISO时间戳>
 *   - theme: <主题>
 *   - subjects: <s1>, <s2>
 *
 *   <原文全文……>
 */

