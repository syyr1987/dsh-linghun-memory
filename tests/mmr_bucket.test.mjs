import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tokenizeForSim,
  jaccardSim,
  mmrSelect,
  createMemoryLayout,
  parseWarm,
  renderWarmEntries,
} from "../memory.js";
import {
  parseRulesBuckets,
  isSignatureTopic,
  bucketHeaderForTopic,
  appendRulesSafe,
} from "../ontology.js";

// ── MMR：token 化 ───────────────────────────────────────────────────────
test("mmr: tokenizeForSim 英文去停用词、中文按字符 bigram", () => {
  const en = tokenizeForSim("The agent must check facts before conclusions");
  assert.ok(en.includes("agent"));
  assert.ok(en.includes("check"));
  assert.ok(!en.includes("the"));
  assert.ok(!en.includes("must") === false); // must 非停用词，应保留
  assert.ok(!en.includes("facts") === false);
  const zh = tokenizeForSim("矛盾不硬裁，先查证再下结论");
  assert.ok(zh.length > 0, "中文应切出 bigram");
  assert.ok(zh.includes("矛盾"), "中文 bigram 命中");
  assert.ok(zh.includes("查证"), "中文 bigram 命中");
  assert.ok(!zh.includes("矛盾不硬裁"), "bigram 化后不再保留整串");
});

test("mmr: jaccardSim 全同=1、无交集=0、半同=交集/并集", () => {
  assert.equal(jaccardSim(["a", "b"], ["a", "b"]), 1);
  assert.equal(jaccardSim(["a", "b"], ["c", "d"]), 0);
  assert.equal(jaccardSim(["a", "b"], ["b", "c"]), 1 / 3);
  assert.equal(jaccardSim([], ["a"]), 0);
});

test("mmr: mmrSelect λ=0.85 相关优先——种子/相似高相关保留，低相关被阈值砍，多样保留", () => {
  // v2.6 口径：λ=0.85 相关优先，排重靠 topCutoff 相对阈值砍低相关冗余 + 边际重排
  const scored = [
    [1.0, 0, tokenizeForSim("agent must check the facts before concluding anything at all")],
    [0.95, 1, tokenizeForSim("agent should check the facts before concluding anything at all")],
    [0.15, 2, tokenizeForSim("agent will check the facts before concluding anything at all")],
    [0.5, 3, tokenizeForSim("different topic about memory consolidation workflow")],
  ];
  const idxs = mmrSelect(scored, 4, 0.85, 0.2);
  assert.ok(idxs.includes(0), "最高分种子必留");
  assert.ok(idxs.includes(1), "相似高相关保留（相关优先，不误伤）");
  assert.ok(!idxs.includes(2), "相似低相关 0.15 < 阈值 0.2×1.0 被砍");
  assert.ok(idxs.includes(3), "不同主题多样条目保留");
});

test("mmr: mmrSelect 相对阈值 topCutoff 砍低相关冗余", () => {
  const scored = [
    [0.5, 0, tokenizeForSim("low score one alpha")],
    [0.05, 1, tokenizeForSim("low score one alpha")],
    [0.3, 2, tokenizeForSim("medium score two beta")],
  ];
  const idxs = mmrSelect(scored, 5, 0.85, 0.2);
  assert.deepEqual(idxs, [0, 2], "0.05 < 0.5×0.2=0.1 被阈值过滤，0/2 保留");
});

test("mmr: mmrSelect k 大于候选数时全保留", () => {
  const scored = [
    [1.0, 0, tokenizeForSim("alpha beta gamma")],
    [0.5, 1, tokenizeForSim("delta epsilon zeta")],
  ];
  const idxs = mmrSelect(scored, 10, 0.85, 0.2);
  assert.deepEqual(new Set(idxs), new Set([0, 1]));
});

// ── MMR：renderForInject 暖态注入排重 ──────────────────────────────────
test("mmr: 暖态注入 MMR 排重——相似条目只留一条，保留条数 ≤k", () => {
  const dir = mkdtempSync(join(tmpdir(), "linghun-mmr-"));
  const warmFile = join(dir, "warm.md");
  const warmText = [
    "## 2026-10-11 10:00 [event] high\n跨情境推理要带完整 LLM 摘要，防信息富集丢失",
    "## 2026-10-11 10:05 [event] high\n跨情境推理需要完整 LLM 摘要来防止信息富集丢失",
    "## 2026-10-11 10:10 [event] high\n跨情境推理用完整 LLM 摘要避免信息富集丢失",
    "## 2026-10-11 11:00 [fact] high\nBEAM sit26 加权 84.4 是系列最优判分",
    "## 2026-10-11 11:05 [fact] medium\n相位实验 topk12 会诱导弃答编造",
  ].join("\n\n");
  writeFileSync(warmFile, warmText + "\n", "utf8");
  const layout = createMemoryLayout(dir, (f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  });
  // 默认 λ=0.85 相关优先（不误伤相似高相关，见 mmrSelect 测试）；这里验证机制可调：
  // λ 调低后 MMR 的相似度惩罚生效——三句高度相似的跨情境只留代表条，多样性事实保留。
  const rendered = layout.renderForInject(6000, {
    timeWeight: true,
    injectWarm: true,
    mmr: { enabled: true, k: 5, lambda: 0.35, topCutoff: 0.2 },
  });
  const warmSection = rendered.split("## 近期记忆 / Recent\n")[1] ?? "";
  // 三条“跨情境推理”相似条目被砍到少于 3 条（保留多样性）
  const crossHits = (warmSection.match(/跨情境推理/g) ?? []).length;
  assert.ok(crossHits < 3, `相似冗余应被 MMR 砍掉，实际 ${crossHits} 条跨情境`);
  // 高相关高分条目（sit26 84.4）应保留
  assert.ok(warmSection.includes("84.4"), "高分事实条目保留");
  // 保留条数 ≤ 注入块数上限（不含冷储/索引）
  const recentLines = warmSection.split("\n\n").filter((l) => l.trim().startsWith("## ") || l.trim().startsWith("【")).length;
  assert.ok(recentLines <= 5, "注入段条目数受控");
});

test("mmr: MMR 关闭时暖态注入回到纯排序截断（相似条目不砍）", () => {
  const dir = mkdtempSync(join(tmpdir(), "linghun-mmroff-"));
  const warmFile = join(dir, "warm.md");
  writeFileSync(
    warmFile,
    [
      "## 2026-10-11 10:00 [event] high\n跨情境推理要带完整 LLM 摘要防信息富集丢失",
      "## 2026-10-11 10:05 [event] high\n跨情境推理需要完整 LLM 摘要防止信息富集丢失",
      "## 2026-10-11 10:10 [event] high\n跨情境推理用完整 LLM 摘要避免信息富集丢失",
    ].join("\n\n") + "\n",
    "utf8",
  );
  const layout = createMemoryLayout(dir, (f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  });
  const rendered = layout.renderForInject(6000, {
    timeWeight: true,
    injectWarm: true,
    mmr: { enabled: false },
  });
  const warmSection = rendered.split("## 近期记忆 / Recent\n")[1] ?? "";
  assert.ok((warmSection.match(/跨情境推理/g) ?? []).length >= 2, "关闭 MMR 不去重");
});

// ── 签名分桶：写侧 ─────────────────────────────────────────────────────
test("bucket: 签名 topic 写入 ### 桶 块，同签名自动聚合", () => {
  const dir = mkdtempSync(join(tmpdir(), "linghun-bucket-"));
  const rulesPath = join(dir, "rules.md");
  const r1 = appendRulesSafe(rulesPath, "[推理题|矛盾辨析|无|无] 矛盾处置", "悖论场景承认无一致解，不强行自洽", "2026-10-11");
  assert.ok(r1.ok);
  const r2 = appendRulesSafe(rulesPath, "[推理题|矛盾辨析|无|无] 矛盾处置", "先查证再下结论，不武断精确化模糊概念", "2026-10-11");
  assert.ok(r2.ok);
  const text = readFileSync(rulesPath, "utf8");
  assert.ok(text.includes("### 桶 [推理题|矛盾辨析|无|无]（矛盾处置）"), "签名桶头正确");
  assert.ok(text.includes("悖论场景承认无一致解"), "桶内规则 1");
  assert.ok(text.includes("先查证再下结论"), "桶内规则 2 同桶聚合");
  const bucketCount = (text.match(/^### 桶 /gm) ?? []).length;
  assert.equal(bucketCount, 1, "同签名只建一个桶");
});

test("bucket: 普通 topic 维持旧 ## 主题 节点，两者可共存", () => {
  const dir = mkdtempSync(join(tmpdir(), "linghun-bucketmix-"));
  const rulesPath = join(dir, "rules.md");
  appendRulesSafe(rulesPath, "[推理题|矛盾辨析|无|无] 矛盾处置", "悖论承认无一致解", "2026-10-11");
  appendRulesSafe(rulesPath, "判断纪律", "先查证再下结论", "2026-10-11");
  const text = readFileSync(rulesPath, "utf8");
  assert.ok(text.includes("### 桶 [推理题|矛盾辨析|无|无]"), "签名桶在");
  assert.ok(text.includes("## 判断纪律"), "旧主题节点在");
});

test("bucket: isSignatureTopic / bucketHeaderForTopic", () => {
  assert.ok(isSignatureTopic("[推理题|矛盾辨析|无|无] 矛盾处置"));
  assert.ok(isSignatureTopic("推理题|矛盾辨析|无|无"));
  assert.ok(!isSignatureTopic("判断纪律"));
  assert.ok(!isSignatureTopic("[单括号无管道]"));
  assert.equal(bucketHeaderForTopic("[推理题|矛盾辨析|无|无] 矛盾处置"), "### 桶 [推理题|矛盾辨析|无|无]（矛盾处置）");
  assert.equal(bucketHeaderForTopic("推理题|矛盾辨析|无|无"), "### 桶 推理题|矛盾辨析|无|无");
});

test("bucket: parseRulesBuckets 解析桶/主题兼容", () => {
  const text = [
    "### 桶 [推理题|矛盾辨析|无|无]（矛盾处置）",
    "- 悖论承认无一致解",
    "- 先查证再下结论",
    "",
    "## 判断纪律",
    "- 口径一致",
    "",
  ].join("\n");
  const blocks = parseRulesBuckets(text);
  assert.equal(blocks.length, 2);
  const b = blocks[0];
  assert.equal(b.kind, "bucket");
  assert.ok(b.name.includes("[推理题|矛盾辨析|无|无]"));
  assert.ok(b.body.includes("悖论承认无一致解"));
  const t = blocks[1];
  assert.equal(t.kind, "theme");
  assert.equal(t.name, "判断纪律");
  assert.ok(t.body.includes("口径一致"));
});
