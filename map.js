/**
 * 记忆地图（Memory Map）— 写侧机制导航图，读侧按图回溯
 *
 * 方法论对齐（写侧=机制化组织层 / 读侧=认知主体层）：
 *   写侧只建图：把沉淀产物组织成四轴导航（情境轴 / 目标轴 / 档案轴 + 证据层），
 *   不预判问题、不替读侧做排序与候选选择。
 *   读侧按图回溯：看图定位（题目线索落在哪个轴/哪个主题域）→ 沿轴翻到候选 →
 *   用 linghun_memory_read / linghun_memory_journal 下钻证据 → 引用作答；能解决就停。
 *
 * 与 v018 白板按图回溯评测的关系：白板版把全量档案渲染成地图注入（无下钻工具，
 * 只能全量给）；本模块是 DSH 认知架构版——地图只放「轴+指针」（索引密度），
 * 细节由读侧用已有工具下钻，记忆预算不被地图吃光。
 *
 * 四轴 + 证据层：
 *   情境轴 Situations —— 近期在谈什么（暖态条目主题索引 + [n] 编号指针）
 *   目标轴 Goals      —— 要达成什么（目标速览：domain/state/priority/statement）
 *   档案轴 Archive    —— 长期沉淀了什么（本体节点索引：知识/规则/事件时间线/冷储）
 *   证据层 Evidence   —— 原文在哪（序时账索引 + 归档索引，可时间窗口下钻）
 */
import { basename, join } from "node:path";

/** 按图回溯纪律（读侧协议）：地图是导航不是答案——定位靠轴、细节靠下钻。 */
export const MAP_DISCIPLINE = `> 记忆地图使用纪律（读侧·按图回溯）：当前消息先看图定位——线索落在哪个轴（情境/目标/档案）的哪个主题域？选轴后沿轴翻到候选，需要细节时用 linghun_memory_read（[n] 编号或本体直读）或 linghun_memory_journal（时间窗口）下钻到原文，引用作答；读到且派上用场后用 linghun_memory_touch 标记。地图是导航不是答案：定位靠轴，细节靠下钻；能解决就停，不翻全量。`;

/** 暖态排序权重（与 memory.js sortWarmForInject 对齐）：high 不衰减常驻，medium/low 按 last_access 衰减。 */
const CONF_WEIGHT = { high: 2, medium: 1, low: 0, wrong: -1 };

const DEFAULT_MAX_CHARS = 2000;
const MAX_SITUATION_ROWS = 8; // 情境轴最多列出的暖态条目（导航索引，不倾倒）
const MAX_GOAL_ROWS = 6; // 目标轴最多列出的目标（速览）
const MAX_ARCHIVE_ROWS = 10; // 档案轴最多列出的本体/冷储节点
const MAX_EVIDENCE_ROWS = 8; // 证据层最多列出的流水/归档索引

/** 暖态条目排序：高置信常驻在前（保持写入序），中/低置信按 last_access 新在前；wrong 沉底。 */
function rankWarmForMap(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.confidence !== "wrong")
    .sort((a, b) => {
      const wa = CONF_WEIGHT[a.e.confidence ?? "medium"] ?? 1;
      const wb = CONF_WEIGHT[b.e.confidence ?? "medium"] ?? 1;
      if (wa !== wb) return wb - wa;
      if (a.e.confidence === "high" && b.e.confidence === "high") return 0;
      const ta = a.e.lastAccess ?? "";
      const tb = b.e.lastAccess ?? "";
      return tb.localeCompare(ta, "en");
    });
}

/** 提取 markdown 主题节点（## / ### 开头行）作为档案轴索引；不存在的文件返回空数组。 */
function listTopicNodes(text) {
  if (!text || !text.trim()) return [];
  return String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^#{2,3}\s+/.test(l))
    .map((l) => l.replace(/^#{2,3}\s+/, "").trim())
    .filter(Boolean);
}

/**
 * 渲染记忆地图（导航图）。所有输入可选——缺失的轴自动跳过，保证空记忆库也能安全渲染。
 * @param {object} src 素材源（各字段可选）：
 *   warmEntries  [{block, lastAccess, confidence, kind}] 暖态条目（已按 access 排序则优先取前段）
 *   coldSummary  string 冷储摘要（每条一行的锚点）
 *   knowledgeOnt string  知识本体原文
 *   memoryOnt    string  事件时间线原文
 *   rules        string  规则本体原文
 *   journals     [{name, entries}]  序时账索引
 *   episodes     [{name, title}]    归档索引
 *   goals        [{domain,state,priority,statement,detail,time}] 目标清单
 * @param {object} opts { maxChars=2000 }
 */
export function renderMemoryMap(src = {}, opts = {}) {
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const parts = [];

  // ── 情境轴：近期在谈什么（暖态条目主题索引 + [n] 编号指针）───────────────
  // 编号 = 原始 parseWarm 索引（与 linghun_memory_read 的 [n] 对齐）；排序只决定展示顺序。
  const warm = Array.isArray(src.warmEntries) ? src.warmEntries : [];
  const situationRows = rankWarmForMap(warm)
    .slice(0, MAX_SITUATION_ROWS)
    .map(({ e, i }) => {
      const lines = String(e.block ?? "")
        .split("\n")
        .map((l) => l.trim());
      const title = lines.find((l) => l.startsWith("## ")) ?? "## 未命名";
      const body = lines.find((l) => l.trim() && !l.startsWith("## ") && !l.startsWith("<!--"));
      const brief = body ? ` — ${body.replace(/\s+/g, " ").slice(0, 48)}` : "";
      return `- [${i + 1}] ${title}${brief}`;
    });
  if (situationRows.length) {
    parts.push(`## 情境轴 / Situations —— 近期在谈什么（[n] 可 linghun_memory_read 取全文）\n${situationRows.join("\n")}`);
  }

  // ── 目标轴：要达成什么（速览，细节在目标档案/目标主线段）────────────
  const goals = Array.isArray(src.goals) ? src.goals : [];
  const goalRows = goals
    .filter((g) => g.state !== "abandoned" && g.state !== "achieved")
    .slice(0, MAX_GOAL_ROWS)
    .map((g) => {
      const stateTag = g.state === "paused" ? "·暂停" : "";
      const prioTag = g.priority ? `·${g.priority}` : "";
      const when = g.time ? `（${g.time}）` : "";
      return `- [${g.domain ?? "goal"}${stateTag}${prioTag}] ${g.statement}${when}`;
    });
  if (goalRows.length) {
    parts.push(`## 目标轴 / Goals —— 要达成什么（目标主线段含触发排序详情）\n${goalRows.join("\n")}`);
  }

  // ── 档案轴：长期沉淀了什么（本体节点索引；内容在注入素材层或本体直读）──
  const archiveRows = [];
  const pushArchive = (label, text) => {
    const nodes = listTopicNodes(text);
    if (!nodes.length) return;
    const head = nodes.slice(0, MAX_ARCHIVE_ROWS).join(" / ");
    const more = nodes.length > MAX_ARCHIVE_ROWS ? ` …共 ${nodes.length} 节点` : "";
    archiveRows.push(`- ${label}：${head}${more}`);
  };
  pushArchive("知识本体", src.knowledgeOnt);
  pushArchive("规则本体", src.rules);
  pushArchive("事件时间线", src.memoryOnt);
  if (src.coldSummary && src.coldSummary.trim()) {
    const coldRows = src.coldSummary
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .slice(0, MAX_ARCHIVE_ROWS)
      .map((l) => l.slice(2).trim());
    if (coldRows.length) {
      const more = coldRows.length > MAX_ARCHIVE_ROWS ? ` …共 ${coldRows.length} 条` : "";
      archiveRows.push(`- 冷储摘要：${coldRows.join(" / ")}${more}`);
    }
  }
  if (archiveRows.length) {
    parts.push(`## 档案轴 / Archive —— 长期沉淀了什么（细节 linghun_memory_read 直读本体）\n${archiveRows.join("\n")}`);
  }

  // ── 证据层：原文在哪（序时账/归档，可时间窗口下钻）─────────────────
  const evidenceRows = [];
  const journals = Array.isArray(src.journals) ? src.journals : [];
  if (journals.length) {
    const recent = journals.slice(-MAX_EVIDENCE_ROWS).reverse();
    evidenceRows.push(`- journal 流水：${recent.map((j) => `${j.name}（${j.entries} 条）`).join(" / ")}`);
  }
  const episodes = Array.isArray(src.episodes) ? src.episodes : [];
  if (episodes.length) {
    const recent = episodes.slice(-MAX_EVIDENCE_ROWS).reverse();
    evidenceRows.push(`- episodic 归档：${recent.map((e) => (e.title ? `${e.name} — ${e.title}` : e.name)).join(" / ")}`);
  }
  if (evidenceRows.length) {
    parts.push(`## 证据层 / Evidence —— 原文在哪（linghun_memory_journal 时间窗口下钻）\n${evidenceRows.join("\n")}`);
  }

  const rendered = parts.join("\n\n");
  if (!rendered) return "";
  if (rendered.length <= maxChars) return rendered;
  // 段边界截断：从前往后保留完整段落，超限处停
  const kept = [];
  let used = 0;
  for (const part of parts) {
    const remain = maxChars - used;
    if (remain <= 0) break;
    if (part.length > remain) {
      kept.push(`${part.slice(0, Math.max(0, remain))}\n…(地图截断，下钻取细节)…`);
      break;
    }
    kept.push(part);
    used += part.length + 2;
  }
  return kept.join("\n\n");
}
