/**
 * 本体资源池测试（DSH 本体分工定案：知识+规则合并存管、使用归 linghun 收口者）：
 *  - readOntologyPool：知识本体 + 规则本体合并只读视图
 *  - listOntologyPool：分区 + 主题/桶 + 条目数只读索引
 *  - linghun_ontology_assemble 装配三态逻辑（both / knowledge / none）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryLayout } from "../memory.js";
import { parseRulesBuckets } from "../ontology.js";

function setupMemory() {
  const dir = mkdtempSync(join(tmpdir(), "ont-pool-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "knowledge_ontology.md"), `## 悖论处置\n- 说谎者悖论：承认无一致解，不武断判定真假\n\n## 评测纪律\n- m401 全量 401 题，acc=92.52%（v4）\n`, "utf8");
  writeFileSync(join(dir, "rules.md"), `## 判断纪律\n- 矛盾不硬裁：悖论场景承认无一致解，不强行自洽\n\n## 记忆纪律\n- 记忆注入是素材，不替代判定\n`, "utf8");
  const readText = (f) => {
    try { return readFileSync(f, "utf8"); } catch { return null; }
  };
  return { dir, layout: createMemoryLayout(dir, readText) };
}

test("本体资源池：合并视图包含知识+规则两个分区", () => {
  const { layout } = setupMemory();
  const pool = layout.readOntologyPool();
  assert.ok(pool.includes("## 知识本体 / Knowledge"));
  assert.ok(pool.includes("## 规则本体 / Rules"));
  assert.ok(pool.includes("m401 全量 401 题"));
  assert.ok(pool.includes("矛盾不硬裁"));
});

test("本体资源池：只读索引分区/主题/条目数正确", () => {
  const { layout } = setupMemory();
  const idx = layout.listOntologyPool();
  assert.deepEqual(idx.knowledge.themes, ["悖论处置", "评测纪律"]);
  assert.equal(idx.knowledge.entries, 2);
  assert.deepEqual(idx.rules.themes, ["判断纪律", "记忆纪律"]);
  assert.equal(idx.rules.entries, 2);
});

test("本体装配三态：双命中 / 知识单命中 / 无命中", () => {
  const { dir, layout } = setupMemory();
  const readText = (f) => {
    try { return readFileSync(f, "utf8"); } catch { return null; }
  };
  const assemble = (q, maxHits = 3) => {
    const words = q.split(/[\s,，。;；:：、|/]+/).filter((w) => w.length >= 2);
    const hitWords = (text) => words.some((w) => text.includes(w));
    const parts = [];
    const hits = [];
    const ontK = layout.readKnowledgeOntology();
    const kBlocks = String(ontK ?? "").split(/^(?=##\s)/m).filter((b) => b.trim());
    const kHit = kBlocks.filter((b) => hitWords((b.split("\n", 1)[0] ?? "") + "\n" + b)).slice(0, maxHits);
    if (kHit.length) {
      hits.push(...kHit.map((b) => `knowledge:${(b.split("\n", 1)[0] ?? "").trim()}`));
      parts.push(`## 知识本体命中 / Knowledge\n${kHit.join("\n\n").trim()}`);
    }
    const rulesText = readText(join(dir, "rules.md"));
    let rHit = [];
    if (rulesText) {
      const rBuckets = parseRulesBuckets(rulesText);
      rHit = rBuckets.filter((b) => hitWords(`${b.name} ${b.header} ${b.body}`)).slice(0, maxHits);
      if (rHit.length) {
        hits.push(...rHit.map((b) => `rules:${b.name}`));
        parts.push(`## 规则本体命中 / Rules\n${rHit.map((b) => `${b.header}\n${b.body}`.trim()).join("\n\n")}`);
      }
    }
    const section = kHit.length && rHit.length ? "both" : kHit.length ? "knowledge" : rHit.length ? "rules" : "none";
    return { section, hits, text: parts.join("\n\n") };
  };

  const both = assemble("悖论处置 判断纪律");
  assert.equal(both.section, "both");
  assert.ok(both.text.includes("说谎者悖论"));
  assert.ok(both.text.includes("矛盾不硬裁"));

  const kOnly = assemble("m401 评测");
  assert.equal(kOnly.section, "knowledge");
  assert.ok(kOnly.text.includes("评测纪律"));
  assert.ok(!kOnly.text.includes("规则本体命中"));

  const none = assemble("量子计算");
  assert.equal(none.section, "none");
  assert.equal(none.hits.length, 0);
  assert.equal(none.text, "");
});
