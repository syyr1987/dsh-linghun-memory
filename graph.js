/**
 * graph.js — 记忆图谱（v0.3.0 新增）
 *
 * 把「记忆单元（冷储原文 md）」与「人物画像要素」连起来表示关系：
 *   - 节点（node）：
 *       U:episodic/<file>           单元节点（冷储原文文件）
 *       S:<subject>                主体节点（中间枢纽）
 *       P:<subject>:<slot>:<id>    画像要素节点（指向 profiles 槽位条目）
 *   - 边（edge）：
 *       U --mentions--> S           单元涉及某主体
 *       S --has_profile--> P        主体拥有该画像要素
 *       U --supports--> P           单元支撑画像要素（印证细节）
 *       U --contradicts--> P        单元反驳/更新画像要素（冲突细节）
 *
 * 图谱由工具自动维护（linghun_graph_build 幂等全量重建），模型不手工改。
 * 双格式：graph.md（人读）+ graph.json（机器读）。
 */

export const GRAPH_FILE = "graph.md";
export const GRAPH_JSON = "graph.json";

/** 边类型全集 */
export const EDGE_TYPES = ["mentions", "has_profile", "supports", "contradicts"];

/** 归一化主体（与 memory.js normalizeSubject 一致，独立实现避免耦合） */
export function normalizeSubject(name) {
  return String(name ?? "").trim().replace(/\s+/g, "_");
}

/** 单元节点 id：U:episodic/<file> */
export function unitNodeId(file) {
  return `U:episodic/${file}`;
}

/** 主体节点 id：S:<subject> */
export function subjectNodeId(subject) {
  return `S:${normalizeSubject(subject)}`;
}

/** 画像要素节点 id：P:<subject>:<slot>:<id> */
export function profileNodeId(subject, slot, id) {
  return `P:${normalizeSubject(subject)}:${String(slot).toLowerCase()}:${id}`;
}

/** 从 profile 节点 id 反解 subject/slot/id */
export function parseProfileNodeId(nodeId) {
  const m = String(nodeId).match(/^P:([^:]+):([a-z_]+):(\d+)$/);
  if (!m) return null;
  return { subject: m[1], slot: m[2], id: Number(m[3]) };
}

/** 空图谱 */
export function emptyGraph() {
  return { version: "0.3.0", nodes: [], edges: [] };
}

/**
 * 解析 graph.md 人读格式：
 *   ## 节点
 *   - U:episodic/2023-05-03_session_A.md  @Caroline 主题=...
 *   - S:Caroline
 *   - P:Caroline:fact:1  "职业为金融分析师"
 *   ## 边
 *   - U:... --mentions--> S:Caroline
 *   容忍格式漂移：无 ## 标题、多余空白、顺序任意。
 */
export function parseGraph(text) {
  const g = emptyGraph();
  const raw = String(text ?? "");
  if (!raw.trim()) return g;
  let section = null;
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^##\s*节点/i.test(t)) { section = "nodes"; continue; }
    if (/^##\s*边/i.test(t)) { section = "edges"; continue; }
    if (/^#/.test(t)) continue; // 其他标题跳过
    if (section === "nodes") {
      const body = t.replace(/^-\s*/, "");
      // 单元节点：U:episodic/<file> 开头
      let m = body.match(/^U:episodic\/(\S+)/);
      if (m) {
        const id = `U:episodic/${m[1]}`;
        if (!seen.has(id)) { g.nodes.push({ id, type: "unit", file: m[1] }); seen.add(id); }
        continue;
      }
      // 主体节点：S:<subject>
      m = body.match(/^S:([^\s]+)/);
      if (m) {
        const id = `S:${m[1]}`;
        if (!seen.has(id)) { g.nodes.push({ id, type: "subject", subject: m[1] }); seen.add(id); }
        continue;
      }
      // 画像要素节点：P:<subject>:<slot>:<id>  "text"
      m = body.match(/^P:([^:\s]+):([a-z_]+):(\d+)/);
      if (m) {
        const id = `P:${m[1]}:${m[2]}:${m[3]}`;
        const textM = body.match(/"([^"]*)"/);
        if (!seen.has(id)) {
          g.nodes.push({ id, type: "profile", subject: m[1], slot: m[2], idNum: Number(m[3]), text: textM ? textM[1] : "" });
          seen.add(id);
        }
        continue;
      }
      // 未识别节点行：尽力保留为 subject（宽松）
      if (/^[A-Za-z0-9_一-龥]+/.test(body) && !seen.has(body)) {
        g.nodes.push({ id: body, type: "subject", subject: body });
        seen.add(body);
      }
    } else if (section === "edges") {
      const body = t.replace(/^-\s*/, "");
      const m = body.match(/^(\S+)\s*--(\w+)-->\s*(\S+)/);
      if (m && EDGE_TYPES.includes(m[2])) {
        g.edges.push({ from: m[1], to: m[3], rel: m[2] });
      }
    }
  }
  return g;
}

/** 渲染 graph.md 人读格式 */
export function renderGraph(g) {
  const nodes = (g?.nodes ?? []).filter(Boolean);
  const edges = (g?.edges ?? []).filter(Boolean);
  const parts = ["# 记忆图谱 / Memory Graph", ""];
  parts.push("## 节点");
  for (const n of nodes) {
    if (n.type === "unit") parts.push(`- ${n.id}  @${extractSubjects(n.id)}`);
    else if (n.type === "profile") parts.push(`- ${n.id}  "${n.text ?? ""}"`);
    else parts.push(`- ${n.id}`);
  }
  parts.push("");
  parts.push("## 边");
  for (const e of edges) parts.push(`- ${e.from} --${e.rel}--> ${e.to}`);
  parts.push("");
  return parts.join("\n");
}

/** 从单元 id 提取可能主体（宽松：文件名里 @ 后或主题段） */
function extractSubjects(id) {
  const m = String(id).match(/@([A-Za-z0-9_]+)/);
  return m ? m[1] : "";
}

/** 序列化为 graph.json */
export function graphToJson(g) {
  return JSON.stringify(g, null, 1);
}

/** 从 graph.json 读回（容错：非 JSON 时回退 parseGraph 格式识别） */
export function graphFromJson(text) {
  try {
    const obj = JSON.parse(String(text ?? ""));
    if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return obj;
  } catch { /* fallthrough */ }
  return parseGraph(text);
}

/** 幂等合并节点（按 id 去重） */
export function upsertNode(g, node) {
  if (!node?.id) return false;
  const idx = g.nodes.findIndex((n) => n?.id === node.id);
  if (idx >= 0) {
    g.nodes[idx] = { ...g.nodes[idx], ...node };
    return false;
  }
  g.nodes.push(node);
  return true;
}

/** 幂等合并边（按 from+rel+to 去重） */
export function upsertEdge(g, from, rel, to) {
  if (!from || !rel || !to) return false;
  if (g.edges.some((e) => e?.from === from && e?.rel === rel && e?.to === to)) return false;
  g.edges.push({ from, rel, to });
  return true;
}

/**
 * 全量重建图谱（幂等）：从单元索引 + 画像文件重建。
 * @param units  [{file, stamp, subjects: string[], text, theme}] 冷储单元清单
 * @param profiles [{subject, slots:{slot:[{text}]}}] 画像清单（parseProfiles 输出结构）
 * @param hintEdges [{from,rel,to}] 额外线索边（如 supports/contradicts 由上层判断传入）
 */
export function buildGraph({ units = [], profiles = [], hintEdges = [] } = {}) {
  const g = emptyGraph();
  // 1. 单元节点 + U--mentions-->S
  for (const u of units) {
    const uId = unitNodeId(u.file);
    upsertNode(g, { id: uId, type: "unit", file: u.file, stamp: u.stamp ?? "", theme: u.theme ?? "" });
    const subjects = Array.isArray(u.subjects) ? u.subjects : [];
    for (const s of subjects) {
      const sId = subjectNodeId(s);
      upsertNode(g, { id: sId, type: "subject", subject: normalizeSubject(s) });
      upsertEdge(g, uId, "mentions", sId);
    }
  }
  // 2. 主体节点 + S--has_profile-->P
  for (const p of profiles) {
    const sId = subjectNodeId(p.subject);
    upsertNode(g, { id: sId, type: "subject", subject: normalizeSubject(p.subject) });
    const slots = p.slots ?? {};
    for (const slot of Object.keys(slots)) {
      const items = slots[slot] ?? [];
      items.forEach((it, i) => {
        const pId = profileNodeId(p.subject, slot, i);
        upsertNode(g, { id: pId, type: "profile", subject: normalizeSubject(p.subject), slot, idNum: i, text: it?.text ?? "" });
        upsertEdge(g, sId, "has_profile", pId);
      });
    }
  }
  // 3. 线索边（supports/contradicts 等）
  for (const e of hintEdges ?? []) {
    upsertEdge(g, e.from, e.rel, e.to);
  }
  return g;
}

/**
 * 图谱查询：输入主体/画像要素/关键词，返回相关单元节点。
 * @param g 图谱对象
 * @param query 主体名或关键词
 * @param opts {limit}
 * @returns [{unitId, file, rels:[{rel,via}]}] 按相关度排序
 */
export function queryGraph(g, query, opts = {}) {
  const q = normalizeSubject(String(query ?? "").trim());
  const limit = opts?.limit ?? 20;
  if (!q || !g?.nodes?.length) return [];
  const qLower = q.toLowerCase();
  // 定位匹配节点：主体节点（S）、画像要素节点（P）、单元节点文本
  const matched = new Map(); // unitId -> {file, rels:Set}
  const unitById = new Map(g.nodes.filter((n) => n?.type === "unit").map((n) => [n.id, n]));
  const subjectNodes = g.nodes.filter((n) => n?.type === "subject" || n?.type === "profile");
  // 找 query 命中的主体/画像节点
  const hitNodes = subjectNodes.filter((n) => {
    const label = n.type === "profile" ? n.subject : n.subject;
    return label && (label.toLowerCase().includes(qLower) || (n.text && String(n.text).toLowerCase().includes(qLower)));
  });
  const hitIds = new Set(hitNodes.map((n) => n.id));
  // 附属回卷：命中画像要素节点（P）时，向上聚合其所属主体（S）的所有单元。
  // 第三方附属化后（附属条目不独立成主体节点），查附属名 → 回卷到说话人主体 → 返回该主体关联的原文单元，
  // 保证「附属人物」仍可通过图谱定位到原文，细节由 linghun_memory_read 精读。
  const parentSubjectIds = new Set();
  const sNodeById = new Map(g.nodes.filter((n) => n?.type === "subject").map((n) => [n.id, n]));
  const pToSubject = new Map(); // P 节点 id -> 所属 S 节点 id
  for (const e of g.edges ?? []) {
    if (e.rel === "has_profile" && e.from.startsWith("S:") && e.to.startsWith("P:")) {
      pToSubject.set(e.to, e.from);
    }
  }
  for (const n of hitNodes) {
    if (n.type === "profile" && pToSubject.has(n.id)) {
      parentSubjectIds.add(pToSubject.get(n.id));
    }
  }
  // 遍历边：从命中节点出发收集关联单元
  for (const e of g.edges ?? []) {
    let unitId = null;
    let via = null;
    if (hitIds.has(e.from) && e.to.startsWith("U:")) { unitId = e.to; via = e.from; }
    else if (hitIds.has(e.to) && e.from.startsWith("U:")) { unitId = e.from; via = e.to; }
    // 附属回卷：画像要素命中时，其所属主体 S 的 mentions 单元也纳入
    if (!unitId && parentSubjectIds.size) {
      if (parentSubjectIds.has(e.from) && e.to.startsWith("U:")) { unitId = e.to; via = `${e.from} (附属回卷)`; }
      else if (parentSubjectIds.has(e.to) && e.from.startsWith("U:")) { unitId = e.from; via = `${e.to} (附属回卷)`; }
    }
    if (unitId) {
      const rec = matched.get(unitId) ?? { file: "", rels: new Set() };
      rec.rels.add(`${e.rel} via ${via}`);
      matched.set(unitId, rec);
    }
  }
  // 没有画像命中时，退化为单元文件名/主题关键词匹配
  if (!matched.size) {
    for (const [id, u] of unitById) {
      const hay = `${id} ${u.theme ?? ""} ${u.stamp ?? ""}`.toLowerCase();
      if (hay.includes(qLower)) {
        const rec = matched.get(id) ?? { file: u.file ?? "", rels: new Set() };
        rec.rels.add("keyword");
        matched.set(id, rec);
      }
    }
  }
  const out = [...matched.entries()]
    .map(([unitId, rec]) => ({ unitId, file: unitById.get(unitId)?.file ?? rec.file, rels: [...rec.rels] }))
    .sort((a, b) => b.rels.length - a.rels.length)
    .slice(0, limit);
  return out;
}

/** 图谱速览（注入用，控制预算） */
export function renderGraphIndex(g, opts = {}) {
  const cap = Math.max(0, Math.floor(opts?.maxChars ?? 400));
  const nodes = g?.nodes ?? [];
  const edges = g?.edges ?? [];
  if (!nodes.length) return "";
  const uCount = nodes.filter((n) => n?.type === "unit").length;
  const sCount = nodes.filter((n) => n?.type === "subject").length;
  const pCount = nodes.filter((n) => n?.type === "profile").length;
  const rels = [...new Set(edges.map((e) => e?.rel))].filter(Boolean);
  let out = `## 记忆图谱\n单元=${uCount} 主体=${sCount} 画像要素=${pCount} 边=${edges.length}（${rels.join("/")}）`;
  // 每主体一行：主体 → 画像要素数 → 关联单元数
  const sMap = new Map();
  for (const e of edges ?? []) {
    if (e?.from?.startsWith("S:") && e?.to?.startsWith("U:")) {
      const s = e.from.slice(2);
      sMap.set(s, (sMap.get(s) ?? 0) + 1);
    }
  }
  const rows = [...sMap.entries()].slice(0, 12).map(([s, c]) => `- ${s}: 关联 ${c} 单元`);
  if (rows.length) out += "\n" + rows.join("\n");
  if (out.length > cap) return truncateKeepHead(out, cap);
  return out;
}

/** 保头截断（与 memory.js 一致的简单实现） */
function truncateKeepHead(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
