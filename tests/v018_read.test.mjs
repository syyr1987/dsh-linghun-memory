/**
 * v0.1.8 memory_read 修复测试：
 * 1) 暖态最新优先（写入序倒序渲染），大暖态截断砍最旧、保最新；
 * 2) 编号 [n] 与渲染顺序解耦——倒序渲染时编号仍为文件序，findWarmEntryRef 的 [n] 解析语义不变；
 * 3) ref 过滤：warm 条目级、本体档案块级（保块头）、rules 行级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWarm,
  renderWarmEntries,
  sortWarmNewestFirst,
  filterWarmByRef,
  filterTextByRef,
  matchRef,
  findWarmEntryRef,
} from "../memory.js";

const W = (stamp, kind, conf, body, access) =>
  `## ${stamp} [${kind}] ${conf}\n\n${body}\n<!-- last_access: ${access ?? stamp} -->`;

test("v018: parseWarm 携带文件序 idx", () => {
  const warm = [W("t1", "event", "high", "甲", "t1"), W("t2", "event", "high", "乙", "t2"), W("t3", "event", "high", "丙", "t3")].join("\n\n");
  const entries = parseWarm(warm);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.idx), [0, 1, 2]);
  assert.match(entries[2].block, /乙|丙|甲/);
  assert.match(entries[2].block, /丙/);
});

test("v018: sortWarmNewestFirst 倒序（文件尾=最新在前）", () => {
  const warm = [W("t1", "event", "high", "旧条目"), W("t2", "event", "high", "中条目"), W("t3", "event", "high", "新条目")].join("\n\n");
  const sorted = sortWarmNewestFirst(parseWarm(warm));
  assert.match(sorted[0].block, /新条目/);
  assert.match(sorted[2].block, /旧条目/);
});

test("v018: 倒序渲染时编号仍为文件序（update 引用不错位）", () => {
  const warm = [W("t1", "event", "high", "最早条目-alpha"), W("t2", "event", "high", "中间条目-beta"), W("t3", "event", "high", "最新条目-gamma")].join("\n\n");
  const rendered = renderWarmEntries(sortWarmNewestFirst(parseWarm(warm)), { numbered: true, includeWrong: true });
  // 渲染条目带 ## 块头（现有格式）：断言编号出现顺序=最新在前，编号值=文件序
  assert.ok(rendered.indexOf("[3]") >= 0 && rendered.indexOf("[2]") > rendered.indexOf("[3]") && rendered.indexOf("[1]") > rendered.indexOf("[2]"));
  assert.match(rendered, /\[3\] ## t3 \[event\] high/);
  assert.match(rendered, /\[1\] ## t1 \[event\] high/);
});

test("v018: 倒序渲染的编号反查原 warm 仍命中同一条目", () => {
  const warm = [W("t1", "event", "high", "最早条目"), W("t2", "event", "high", "中间条目"), W("t3", "event", "high", "最新条目")].join("\n\n");
  const rendered = renderWarmEntries(sortWarmNewestFirst(parseWarm(warm)), { numbered: true, includeWrong: true });
  // 渲染出的 [1] 指向文件序第 1 条（最早条目），尽管它显示在渲染末尾
  const found = findWarmEntryRef(warm, "[1]");
  assert.ok(found, "编号 [1] 应命中");
  assert.match(found.entry.block, /最早条目/);
  const found3 = findWarmEntryRef(warm, "[3]");
  assert.ok(found3, "编号 [3] 应命中");
  assert.match(found3.entry.block, /最新条目/);
  assert.ok(rendered.includes("[1] ## t1") && rendered.includes("最早条目"));
});

test("v018: filterWarmByRef 多词 OR / 无命中为空 / markdown 归一", () => {
  const warm = [W("t1", "event", "high", "Caroline 参加 LGBTQ 小组"), W("t2", "event", "high", "Melanie 参加慈善跑"), W("t3", "event", "high", "**Caroline** 表达职业意向")].join("\n\n");
  const entries = parseWarm(warm);
  assert.equal(filterWarmByRef(entries, "Caroline").length, 2);
  assert.equal(filterWarmByRef(entries, "Melanie 慈善").length, 1); // 多词 OR：同一词命中即留
  assert.equal(filterWarmByRef(entries, "查无此人").length, 0);
  assert.equal(filterWarmByRef(entries, "caroline").length, 2); // 大小写归一
  assert.equal(filterWarmByRef(entries, "").length, entries.length); // 空 ref 放行
});

test("v018: matchRef 空 ref 恒为 false（防空放行误用）", () => {
  assert.equal(matchRef("任意内容", ""), false);
  assert.equal(matchRef("任意内容", "   "), false);
  assert.equal(matchRef("任意内容", "内容"), true);
});

test("v018: filterTextByRef 块结构过滤保块头（本体档案）", () => {
  const onto = [
    W("2026-10-12 04:46", "event", "medium", "用户 | 发送测试指令 | 回复 ok | 无 | 仅回 ok"),
    W("2026-10-12 04:57", "event", "high", "Caroline | 转型三年 | 心理背景 | 无 | 追求咨询事业"),
    W("2026-10-12 04:59", "event", "medium", "Caroline | 参加小组 | 昨日 | 无 | 被接纳"),
  ].join("\n\n") + "\n";
  const out = filterTextByRef(onto, "Caroline");
  assert.equal(out.split(/\n(?=## )/).filter((b) => b.trim()).length, 2); // 只剩 2 块
  assert.ok(out.includes("## 2026-10-12 04:57 [event] high")); // 块头保留
  assert.ok(out.includes("last_access")); // 元数据保留
  assert.ok(!out.includes("发送测试指令"));
});

test("v018: filterTextByRef 行结构过滤（rules.md）", () => {
  const rules = "# 记忆沉淀\n- 收到连通测试时仅回复 ok。（2026-10-12）\n- 文件修改仅在 /tmp 工作区。（2026-10-12）\n- 悖论不硬裁，承认无一致解。（2026-10-12）\n";
  const out = filterTextByRef(rules, "悖论");
  assert.ok(out.includes("悖论不硬裁"));
  assert.ok(!out.includes("仅回复 ok"));
  assert.equal(out.split("\n").length, 1); // 只剩命中行
});

test("v018: filterTextByRef 无命中返回空串（execute 判定无命中提示）", () => {
  const onto = W("t1", "fact", "high", "实体 | 属性 | 值") + "\n";
  assert.equal(filterTextByRef(onto, "查无此词").trim(), "");
});

test("v018: 截断场景机制对比——大暖态下旧行为丢最新、新行为保最新（冒烟 bug 最小复现）", () => {
  // 合成 40 条 × 约 2KB 的 warm（模拟冒烟时 59KB 暖态）
  const pad = "背景细节.".repeat(460); // ≈2300 字符/条，40 条 ≈ 92K，必超 50000 上限
  const blocks = [];
  for (let i = 1; i <= 40; i++) {
    blocks.push(W(`t${String(i).padStart(2, "0")}`, "event", "medium", `条目-${i}-LATEST标记 ${pad}`));
  }
  const warm = blocks.join("\n\n");
  const cold = "## 冷储摘要\n高频高抽象经验摘要。";
  const LIMIT = 50000;
  const view = (entriesArr) => {
    const w = renderWarmEntries(entriesArr, { numbered: true, includeWrong: true });
    return [cold, "## 近期记忆 / Recent\n\n" + w].join("\n\n");
  };
  const entries = parseWarm(warm);
  assert.equal(entries.length, 40);
  const needle = "条目-40-LATEST标记"; // 文件序最后一条 = 最新
  // 旧行为：写入序渲染（旧→新），slice(0, LIMIT) 从头截断 → 最新条目（尾部）被砍
  const oldFull = view(entries);
  assert.ok(oldFull.length > LIMIT, "合成数据应超过截断上限");
  assert.ok(!oldFull.slice(0, LIMIT).includes(needle), "旧行为：最新条目应被截断丢失");
  // 新行为：最新优先渲染 → 截断砍最旧、保最新
  const newFull = view(sortWarmNewestFirst(entries));
  assert.ok(newFull.slice(0, LIMIT).includes(needle), "新行为：最新条目应在截断窗口内");
  // 编号语义：新渲染里 [40]（文件序最后一条）出现且反查命中同一条
  const rendered = newFull.slice(0, LIMIT);
  assert.ok(rendered.includes("[40] "), "文件序编号 40 应出现在渲染中");
  const back = findWarmEntryRef(warm, "[40]");
  assert.ok(back && back.entry.block.includes(needle), "编号 [40] 反查仍命中文件序最后一条");
});
