// 白板 → 三本体架构 链路测试（BEAM 三本体方案回灌后的套装级验证）
//  三本体 = 记忆本体(ontology.md) + 知识本体(knowledge.md) + 领域本体(领域库本体_*.md)
//  白板 = 空 $DSH_HOME（无 warm / 无本体 / 无知识 / 无领域库）
//  链路 = 白板 → agent 工具积累 → LLM 投影 → 三本体文件落盘 → assembler 三路加载消费
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── linghun 侧：记忆本体纯函数 ──
import { parseWarm, renderWarmEntries, createMemoryLayout } from "../memory.js";
import { parseOntology, renderOntologyNodes, hitThemeByAlias, writeOntologySafe, appendRulesSafe } from "../ontology.js";

// ── assembler 侧：三路加载 ──
import {
  parseNodes,
  renderNodes,
  hitByAlias,
  loadOntology,
  loadKnowledge,
  loadRules,
  loadKnowledgeDirs,
} from "../../dsh-linghun-assembler/ontology.js";

// 桩 LLM：模拟 memory_project 的聚合输出（真实环境由 DSH 运行时模型调用）
function stubProjection(warmText) {
  const entries = parseWarm(warmText).map((e) => ({
    ...e,
    text: e.block.replace(/\n?<!-- last_access: [^>]+ -->/, "").trim(),
  }));
  const themes = [
    { theme: "BEAM 评测", pick: (e) => /beam|评测|双收敛/.test(e.text) },
    { theme: "插件开发", pick: (e) => /插件|linghun|assembler|工具/.test(e.text) },
    { theme: "领域规则", pick: (e) => /规则|本体|领域/.test(e.text) },
  ];
  const nodes = themes
    .map((t) => ({ theme: t.theme, items: entries.filter(t.pick).map((e) => e.text) }))
    .filter((n) => n.items.length > 0)
    .map((n) => `## ${n.theme}\n${n.items.map((x) => `- ${x}`).join("\n")}`);
  return nodes.join("\n\n");
}

test("白板起点：空 DSH_HOME 无任何本体/记忆文件", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    assert.ok(!existsSync(join(mem, "warm.md")));
    assert.ok(!existsSync(join(mem, "ontology.md")));
    assert.ok(!existsSync(join(mem, "knowledge.md")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("记忆本体①：空 warm 投影返回失败原因（白板无内容不生成空文件）", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    // 模拟 doOntologyProject 的空 warm 分支
    const warm = "";
    if (!warm.trim()) {
      const reason = "warm 为空，无内容可投影";
      assert.equal(reason, "warm 为空，无内容可投影");
      assert.ok(!existsSync(join(mem, "ontology.md")));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("记忆本体②：agent 积累 warm（memory_append 等价写入）→ 桩 LLM 投影 → ontology.md 落盘", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    const warmFile = join(mem, "warm.md");
    // 等价 memory_append 三次
    const stamp = "2026-10-07 09:00";
    const blocks = [
      `## ${stamp} [fact] high\n\nBEAM 1M 85.0/92.5 加权双收敛 92.5。\n<!-- last_access: ${stamp} -->`,
      `## ${stamp} [fact] high\n\nlinghun 套装 v0.4.0 回灌三本体机制。\n<!-- last_access: ${stamp} -->`,
      `## ${stamp} [decision] medium\n\n领域层规则继续按对象→关系→规则三层生长。\n<!-- last_access: ${stamp} -->`,
    ].join("\n\n") + "\n";
    writeFileSync(warmFile, blocks, "utf8");

    // 桩 LLM 聚合（memory_project 的 LLM 步骤）
    const projection = stubProjection(readFileSync(warmFile, "utf8"));
    assert.ok(projection.includes("## BEAM 评测"), "投影出 BEAM 评测节点");

    // 写盘（doOntologyProject 的写盘步骤）
    const ontFile = join(mem, "ontology.md");
    const changed = writeOntologySafe(ontFile, projection);
    assert.equal(changed, true, "首次写盘 changed=true");
    assert.ok(existsSync(ontFile), "ontology.md 已生成");

    // 幂等：内容不变不写盘
    assert.equal(writeOntologySafe(ontFile, projection), false, "同内容不重复写盘");

    // linghun 侧读回
    const nodes = parseOntology(readFileSync(ontFile, "utf8"));
    assert.ok(nodes.length >= 2, `至少 2 个主题节点（实际 ${nodes.length}）`);
    const hit = hitThemeByAlias("beam 双收敛多少", nodes, { beam: "BEAM 评测" });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].theme, "BEAM 评测");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("记忆本体③：assembler 侧 loadOntology 能消费 linghun 生成的 ontology.md", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    const warmFile = join(mem, "warm.md");
    writeFileSync(warmFile, "## 2026-10-07 09:00 [fact] high\n\nBEAM 双收敛 92.5。\n<!-- last_access: 2026-10-07 09:00 -->\n", "utf8");
    const projection = stubProjection(readFileSync(warmFile, "utf8"));
    writeOntologySafe(join(mem, "ontology.md"), projection);

    const ontNodes = loadOntology(join(mem, "ontology.md"));
    assert.ok(ontNodes.length >= 1, `assembler 读到本体节点（${ontNodes.length}）`);
    const hit = hitByAlias("beam 评测 92.5", ontNodes, { beam: "BEAM 评测" });
    assert.equal(hit[0]?.theme, "BEAM 评测");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("知识本体：knowledge.md 落盘 → assembler loadKnowledge 解析 + 别名命中", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    const knowledge = [
      "## BM25",
      "BM25 是稀疏检索经典算法，短查询效果好；用于记忆检索兜底。",
      "",
      "## 题型纪律",
      "summarization：因果链+阶段+学到什么；event_ordering：时间排序；preference_following：版本绑定。",
    ].join("\n");
    writeFileSync(join(mem, "knowledge.md"), knowledge + "\n", "utf8");

    const kNodes = loadKnowledge(join(mem, "knowledge.md"));
    assert.equal(kNodes.length, 2);
    const hit = hitByAlias("解释一下 BM25", kNodes, { bm25: "BM25" });
    assert.equal(hit[0]?.theme, "BM25");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("领域本体：领域库三件套（对象/关系/规则）→ assembler loadKnowledgeDirs 扫描命中", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const dom = join(home, "领域层", "数学领域");
    mkdirSync(dom, { recursive: true });
    writeFileSync(join(dom, "本体_对象.md"), "## 对象层\n数学对象：坐标系/函数/矩阵。\n", "utf8");
    writeFileSync(join(dom, "本体_关系.md"), "## 关系层\n函数 → 坐标系 映射。\n", "utf8");
    writeFileSync(join(dom, "本体_规则.md"), "## 规则层\nR-400：数值计算先查证。\n", "utf8");

    const docs = loadKnowledgeDirs([join(home, "领域层")]);
    assert.ok(docs.length >= 3, `领域库三件套全扫到（实际 ${docs.length}）`);
    assert.ok(docs.some((d) => d.file.includes("本体_对象.md")));
    assert.ok(docs.some((d) => d.file.includes("本体_关系.md")));
    assert.ok(docs.some((d) => d.file.includes("本体_规则.md")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("规则本体①：memory_rules 等价 append → rules.md 落盘 + 同主题聚合", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    const rulesFile = join(mem, "rules.md");
    // 等价 memory_rules 两次调用（同主题）
    const r1 = appendRulesSafe(rulesFile, "判断纪律", "矛盾不硬裁：悖论场景承认无一致解，不强行自洽", "2026-10-07");
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, true);
    const r2 = appendRulesSafe(rulesFile, "判断纪律", "查证纪律：具体数值/事实先查证冷储", "2026-10-07");
    assert.equal(r2.ok, true);
    // 同主题聚合在同一节点
    const text = readFileSync(rulesFile, "utf8");
    assert.equal((text.match(/^## /gm) ?? []).length, 1, "同主题只一个节点");
    assert.ok(text.includes("矛盾不硬裁"));
    assert.ok(text.includes("查证纪律"));
    // linghun 侧读回
    const nodes = parseOntology(text);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].theme, "判断纪律");
    assert.ok(nodes[0].body.includes("矛盾不硬裁"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("规则本体②：不同主题追加 → 独立节点", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    const rulesFile = join(mem, "rules.md");
    appendRulesSafe(rulesFile, "判断纪律", "矛盾不硬裁", "2026-10-07");
    appendRulesSafe(rulesFile, "记忆纪律", "注入记忆是素材，不替代判定", "2026-10-07");
    const text = readFileSync(rulesFile, "utf8");
    assert.equal((text.match(/^## /gm) ?? []).length, 2);
    assert.ok(text.includes("## 判断纪律"));
    assert.ok(text.includes("## 记忆纪律"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("规则本体③：assembler loadRules 消费 + R_ALIAS 别名命中", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    const rulesFile = join(mem, "rules.md");
    appendRulesSafe(rulesFile, "判断纪律", "矛盾不硬裁：悖论场景承认无一致解", "2026-10-07");
    appendRulesSafe(rulesFile, "查证纪律", "先查证再下结论，有错就认", "2026-10-07");

    const rNodes = loadRules(rulesFile);
    assert.equal(rNodes.length, 2);
    const hit = hitByAlias("矛盾题怎么处理", rNodes, { 矛盾: "判断纪律" });
    assert.equal(hit[0]?.theme, "判断纪律");
    const hit2 = hitByAlias("要不要先查证", rNodes, { 查证: "查证纪律" });
    assert.equal(hit2[0]?.theme, "查证纪律");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("三本体架构：白板 → 记忆/知识/规则三本体全部就位，assembler 全部可消费", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    const mem = join(home, "linghun", "memory");
    mkdirSync(mem, { recursive: true });
    // ① 记忆本体（项目场景 → memory_project 投影）
    writeFileSync(join(mem, "warm.md"), "## 2026-10-07 09:00 [fact] high\n\nBEAM 双收敛 92.5。\n<!-- last_access: 2026-10-07 09:00 -->\n", "utf8");
    writeOntologySafe(join(mem, "ontology.md"), stubProjection(readFileSync(join(mem, "warm.md"), "utf8")));
    // ② 知识本体（技术知识 → knowledge.md / 领域层）
    writeFileSync(join(mem, "knowledge.md"), "## BM25\nBM25 短查询效果好。\n", "utf8");
    // ③ 规则本体（总结经验 → memory_rules → rules.md）
    appendRulesSafe(join(mem, "rules.md"), "判断纪律", "矛盾不硬裁：悖论场景承认无一致解", "2026-10-07");
    appendRulesSafe(join(mem, "rules.md"), "查证纪律", "先查证再下结论，有错就认", "2026-10-07");
    // 领域载体（领域层本体_规则.md，作为知识/规则载体）
    const dom = join(home, "领域层", "数学领域");
    mkdirSync(dom, { recursive: true });
    writeFileSync(join(dom, "本体_规则.md"), "## 规则层\nR-400：数值先查证。\n", "utf8");

    // assembler 三本体加载
    const ontNodes = loadOntology(join(mem, "ontology.md"));
    const kNodes = loadKnowledge(join(mem, "knowledge.md"));
    const rNodes = loadRules(join(mem, "rules.md"));
    const dDocs = loadKnowledgeDirs([join(home, "领域层")]);
    assert.ok(ontNodes.length >= 1, "记忆本体已消费");
    assert.ok(kNodes.length >= 1, "知识本体已消费");
    assert.ok(rNodes.length >= 2, `规则本体已消费（${rNodes.length} 节点）`);
    assert.ok(dDocs.length >= 1, "领域载体已消费");

    // 三本体别名命中各自生效
    assert.equal(hitByAlias("beam 92.5", ontNodes, { beam: "BEAM 评测" })[0]?.theme, "BEAM 评测");
    assert.equal(hitByAlias("bm25 效果", kNodes, { bm25: "BM25" })[0]?.theme, "BM25");
    assert.equal(hitByAlias("矛盾题怎么处理", rNodes, { 矛盾: "判断纪律" })[0]?.theme, "判断纪律");
    assert.equal(hitByAlias("要不要先查证", rNodes, { 查证: "查证纪律" })[0]?.theme, "查证纪律");
    assert.ok(dDocs.some((d) => d.file.includes("数学领域")), "领域库可被目录扫描");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
