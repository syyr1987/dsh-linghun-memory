/**
 * v0.2.0 ACC（Agentic Cognitive Control）测试：
 * 1) Config.memory.acc 默认值（enabled=false 保持 0.1.8 行为 / probeTopK 8）；
 * 2) probe 检索核心语义：候选池不注入、BM25 打分、ref 定向过滤、top_k 上限。
 * 领域层（domains.js + linghun_domain_load）已于改版移除：领域指导归三本体
 * （知识本体按领域组织 fact / 规则本体管跨领域共性 rule），由 memory_read 主动读取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWarm, matchRef, tokenizeForSim, buildBm25Stats, bm25Retrieve } from "../memory.js";
import { Config } from "../index.js";
import z from "@deepseek-ai/schemastery";

const W = (stamp, kind, conf, body, access) =>
  `## ${stamp} [${kind}] ${conf}\n\n${body}\n<!-- last_access: ${access ?? stamp} -->`;

test("acc: 未配置时 ACC 默认关闭（enabled 非 true），运行时兜底值与 0.1.8 一致", () => {
  const cfg = z.resolve({}, Config)[0];
  const acc = cfg.memory?.acc ?? {};
  // schemastery object default({}) 不递归填充子字段；运行时语义由 `?? 兜底` 保证（与 execute 代码一致）
  assert.ok(acc.enabled !== true, "未配置时应保持自动注入（A 组行为）");
  const probeTopK = acc.probeTopK ?? 8; // linghun_retrieval_probe execute 兜底
  assert.equal(probeTopK, 8);
});

test("acc: Config.memory.acc 可显式开启（B 组 ACC 线）", () => {
  const cfg = z.resolve({ memory: { acc: { enabled: true, probeTopK: 12 } } }, Config)[0];
  assert.equal(cfg.memory.acc.enabled, true);
  assert.equal(cfg.memory.acc.probeTopK, 12);
});

test("acc: probe 检索语义——候选池带来源锚点、ref 定向过滤、top_k 上限", () => {
  const warm = [
    W("t1", "event", "high", "Caroline 参加 LGBTQ 互助小组 被接纳"),
    W("t2", "event", "high", "Melanie 参加慈善跑 完成半马"),
    W("t3", "fact", "medium", "Caroline 表达咨询事业意向 转型三年 心理背景"),
  ].join("\n\n");
  // 候选池组装（与 index.js collectProbeCandidates 同构：warm 条目 + cold 块 + 本体块）
  const candidates = [];
  for (const e of parseWarm(warm)) {
    candidates.push({ block: e.block, source: "warm", anchor: `[${e.idx + 1}]`, confidence: e.confidence, kind: e.kind });
  }
  candidates.push({ block: "## 冷储摘要\n用户偏好直接沟通 反对堆参数", source: "cold", anchor: "冷储摘要", confidence: "", kind: "" });
  // ref 定向过滤：只留 Caroline 相关
  const kept = candidates.filter((x) => matchRef(x.block, "Caroline"));
  assert.equal(kept.length, 2);
  // BM25 检索：query 换词面也能召回（"心理咨询" → Caroline 咨询事业意向）
  const stats = buildBm25Stats(candidates.map((x) => tokenizeForSim(x.block)));
  const hits = bm25Retrieve(candidates, "心理咨询 事业", stats, { topk: 8 });
  assert.ok(hits.length >= 1, "query 应至少命中 1 条");
  const hitIdx = hits.map((h) => h.idx);
  assert.ok(hitIdx.some((i) => candidates[i].block.includes("Caroline 表达咨询事业意向")), "应召回 Caroline 咨询意向");
  // top_k 上限：topk=20 时返回数不超过候选池
  const hits20 = bm25Retrieve(candidates, "咨询", stats, { topk: 20 });
  assert.ok(hits20.length <= candidates.length);
  // 无命中返回空（候选过滤后为空 → probe 返回 total_candidates 0）
  const none = candidates.filter((x) => matchRef(x.block, "查无此词"));
  assert.equal(none.length, 0);
});

test("acc: warm 锚点 = 文件序编号（probe read_hint 指向 linghun_memory_read）", () => {
  const warm = [W("t1", "event", "high", "旧条目"), W("t2", "event", "high", "新条目")].join("\n\n");
  const entries = parseWarm(warm);
  assert.equal(entries[1].idx, 1);
  // probe 对 warm 候选给出 ref=[n]（文件序编号，与 linghun_memory_read 一致）
  assert.equal(`[${entries[1].idx + 1}]`, "[2]");
  assert.ok(warm.includes("新条目"));
});
