/**
 * 灵魂（Linghun）— 记忆本体投影（BEAM 第二轮验证机制回灌）。
 *
 * 背景：BEAM 1M/10M 双档实验中，把 warm 记忆按主题桶聚合成本体投影
 * （build_ontology_v1/v2），再让组装侧「本体主题索引优先 + BM25 兜底」，
 * 是隔离基线 60 → 记忆本体 70 → 双管齐下 85/90 的关键一环。
 *
 * 本模块把该机制沉淀为海马体布局的一等公民：
 *   $DSH_HOME/linghun/memory/ontology.md  # 记忆本体投影（主题节点）
 *
 * 与 linghun-assembler 联动：assembler 检索时优先读 ontology.md 主题节点
 * （TAG_ALIAS 主题命中 → 节点优先），再 BM25 兜底；无本体时退回纯 BM25。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const ONTOLOGY = "ontology.md";
export const RULES = "rules.md";

/**
 * 解析 ontology.md 为主题节点数组。
 *
 * 格式（与 BEAM build_ontology 输出对齐）：
 *   ## <主题名>
 *   <主题要点正文>（可含 - 要点 / 时间锚点 / 关键数字）
 *   <!-- theme: <主题名> -->
 *
 * 返回 [{ theme, body, stamp }]；stamp 取正文首行日期（若有），供时间维使用。
 */
export function parseOntology(text) {
  const blocks = String(text ?? "")
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const firstLine = block.split("\n")[0] ?? "";
    const theme = firstLine.replace(/^##\s+/, "").trim();
    const body = block.replace(/^##\s+.*\n/, "").trim();
    const dm = body.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    return { theme, body, stamp: dm ? dm[1] : null };
  });
}

/** 渲染本体节点（正文，剥主题行），用于注入/检索。 */
export function renderOntologyNodes(nodes) {
  return nodes
    .map((n) => (n.body ? `## ${n.theme}\n${n.body}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** 主题别名表：检索 query 命中别名 → 返回该主题节点优先命中。
 *  与 BEAM TAG_ALIAS 同构；这里做通用层，具体别名由 assembler 侧维护。 */
export function hitThemeByAlias(question, nodes, aliases = {}) {
  const q = String(question ?? "").toLowerCase();
  if (!q || !nodes?.length) return [];
  const hits = [];
  for (const [alias, theme] of Object.entries(aliases)) {
    if (q.includes(String(alias).toLowerCase())) {
      const node = nodes.find((n) => n.theme === theme);
      if (node) hits.push(node);
    }
  }
  // 去重（同主题多个别名只取一次），保持本体顺序
  const seen = new Set();
  return hits.filter((n) => (seen.has(n.theme) ? false : (seen.add(n.theme), true)));
}

/** 写本体投影文件（原子替换）——由 memory_project 工具 / assembler 周期性调用。
 *  幂等：内容不变不写盘（mtime 缓存友好）。返回是否发生了写盘。 */
export function writeOntologySafe(path, text) {
  const content = String(text ?? "").trim();
  if (!content) return false;
  try {
    let prev = "";
    try {
      prev = readFileSync(path, "utf8").trim();
    } catch {
      /* 文件不存在 */
    }
    if (prev === content) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${content}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 规则本体追加（BEAM 三本体方案·规则本体）：把一条总结经验追加进 rules.md。
 *  格式与 ontology 同构（## 主题节点），命中同主题节点 → 追加一行；否则新建节点。
 *  规则是稳定的长期经验（矛盾不硬裁/查证纪律等），不是一次性事实。
 *  返回 { ok, changed, path, theme }；失败返回 { ok:false, reason }。 */
export function appendRulesSafe(path, topic, rule, stamp) {
  const theme = String(topic ?? "").trim() || "经验规则";
  const content = String(rule ?? "").trim();
  if (!content) return { ok: false, reason: "rule 为空" };
  const line = `- ${content}${stamp ? `（${stamp}）` : ""}`;
  try {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      /* 文件不存在 */
    }
    const blocks = text.trim()
      ? String(text).split(/\n(?=## )/).map((b) => b.trim()).filter(Boolean)
      : [];
    const idx = blocks.findIndex((b) => b.startsWith(`## ${theme}`));
    if (idx >= 0) {
      blocks[idx] = `${blocks[idx].trimEnd()}\n${line}`;
    } else {
      blocks.push(`## ${theme}\n${line}`);
    }
    const next = `${blocks.join("\n\n")}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, "utf8");
    return { ok: true, changed: true, path, theme };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

export default {
  ONTOLOGY,
  RULES,
  parseOntology,
  renderOntologyNodes,
  hitThemeByAlias,
  writeOntologySafe,
  appendRulesSafe,
};
