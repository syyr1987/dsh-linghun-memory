import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILE_DISCIPLINE } from "../identity.js";
import {
  parseWarm,
  renderWarmEntries,
  parseProfiles,
  renderProfileIndex,
  renderProfileFull,
  upsertProfileSlotText,
  normalizeSubject,
  PROFILE_SLOTS,
} from "../memory.js";

// ── normalizeSubject（画像文件主键）───────────────────────────────────────
test("profile: normalizeSubject 归一为文件名安全形式", () => {
  assert.equal(normalizeSubject("owner"), "owner");
  assert.equal(normalizeSubject(" 张三 "), "张三");
  assert.equal(normalizeSubject("山野/越野人!"), "山野越野人");
  assert.equal(normalizeSubject(""), "unknown");
  assert.equal(normalizeSubject(undefined), "unknown");
  assert.equal(normalizeSubject("a-b_c 中1"), "a-b_c中1");
});

// ── parseWarm 主体标签 ───────────────────────────────────────────────────
test("profile: parseWarm 解析 @subject 主体标签", () => {
  const text = `## 20261021T100000Z [fact] high @owner

山野 | 职业 | 开发者 | 对话
<!-- last_access: 20261021T100000Z -->

## 20261021T100100Z [fact] medium

无主体标签条目
<!-- last_access: 20261021T100100Z -->

## 20261021T100200Z [rule] low @assistant

先查证再下结论
<!-- last_access: 20261021T100200Z -->`;
  const entries = parseWarm(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].subject, "owner");
  assert.equal(entries[1].subject, null);
  assert.equal(entries[2].subject, "assistant");
});

test("profile: renderWarmEntries 支持按主体过滤", () => {
  const text = `## 20261021T100000Z [fact] high @owner

山野 | 职业 | 开发者 | 对话
<!-- last_access: 20261021T100000Z -->

## 20261021T100100Z [fact] medium @assistant

岚客 | 定位 | 记忆体 | 对话
<!-- last_access: 20261021T100100Z -->`;
  const entries = parseWarm(text);
  const all = renderWarmEntries(entries);
  assert.ok(all.includes("山野 | 职业"));
  assert.ok(all.includes("岚客 | 定位"));
  const ownerOnly = renderWarmEntries(entries, { subject: "owner" });
  assert.ok(ownerOnly.includes("山野 | 职业"));
  assert.ok(!ownerOnly.includes("岚客 | 定位"));
  const none = renderWarmEntries(entries, { subject: "nobody" });
  assert.equal(none.trim(), "");
});

// ── parseProfiles（画像文件解析）──────────────────────────────────────────
test("profile: parseProfiles 解析摘要与六槽", () => {
  const text = `# 画像：owner（山野）

> 摘要：开发者，正在探索 AI 认知边界

## fact
- [high] 职业是开发者（20261021T100000Z）
- [medium] 有数据库基础（20261021T100100Z）

## goal
- [high] 尽快变现认知成果（20261021T100200Z）

## other
- [low] 不在标准槽的条目（20261021T100300Z）`;
  const p = parseProfiles(text);
  assert.ok(p);
  assert.equal(p.subject, "owner");
  assert.ok(p.summary.includes("开发者"));
  assert.equal(p.slots.fact.length, 2);
  assert.equal(p.slots.goal.length, 1);
  assert.ok(p.slots.other.length === 1, "非标准槽保留在 other");
});

test("profile: parseProfiles 空/无画像头返回 null", () => {
  assert.equal(parseProfiles(""), null);
  assert.equal(parseProfiles("随便一段文字\n没有画像头"), null);
});

// ── renderProfileIndex（速览注入）────────────────────────────────────────
test("profile: renderProfileIndex 生成主体导航速览", () => {
  const profiles = [
    { subject: "owner", summary: "开发者，正在探索 AI 认知边界", slots: { fact: [1], goal: [1, 2] } },
    { subject: "assistant", summary: "记忆体助手", slots: {} },
  ];
  const out = renderProfileIndex(profiles, { maxChars: 300 });
  assert.ok(out.includes("人物画像"));
  assert.ok(out.includes("owner"));
  assert.ok(out.includes("assistant"));
  assert.ok(out.includes("槽"));
  // 空画像数组返回空
  assert.equal(renderProfileIndex([], { maxChars: 300 }), "");
});

test("profile: renderProfileIndex 超预算砍槽位计数", () => {
  const profiles = [
    { subject: "owner", summary: "开发者，正在探索 AI 认知边界，喜欢短句直接沟通，讨厌重复解释", slots: { fact: [1, 2, 3], goal: [1] } },
  ];
  const tight = renderProfileIndex(profiles, { maxChars: 70 });
  // 砍掉槽位计数（预算不足时不再展示 槽：fact3/goal1）
  assert.ok(!tight.includes("槽："), "超预算时砍掉槽位计数");
  assert.ok(tight.includes("owner"));
  assert.ok(tight.length < renderProfileIndex(profiles, { maxChars: 300 }).length);
});

// ── renderProfileFull（画像全文）─────────────────────────────────────────
test("profile: renderProfileFull 渲染六槽全文", () => {
  const profile = {
    subject: "owner",
    summary: "开发者",
    slots: {
      fact: [{ text: "[high] 职业是开发者（20261021T100000Z）" }],
      goal: [{ text: "[high] 变现认知成果（20261021T100200Z）" }],
    },
  };
  const out = renderProfileFull(profile);
  assert.ok(out.includes("画像：owner"));
  assert.ok(out.includes("摘要：开发者"));
  assert.ok(out.includes("## fact"));
  assert.ok(out.includes("## goal"));
  // 指定槽位子集
  const onlyGoal = renderProfileFull(profile, { slots: ["goal"] });
  assert.ok(onlyGoal.includes("## goal"));
  assert.ok(!onlyGoal.includes("## fact"));
});

// ── upsertProfileSlotText（槽位写入/更新）────────────────────────────────
test("profile: upsertProfileSlotText 空文件新建画像与槽段", () => {
  const next = upsertProfileSlotText("", "fact", "[high] 职业是开发者", undefined, "20261021T100000Z");
  assert.ok(next.includes("# 画像：未知"));
  assert.ok(next.includes("## fact"));
  assert.ok(next.includes("- [high] 职业是开发者（20261021T100000Z）"));
});

test("profile: upsertProfileSlotText 无目标槽段时新建段", () => {
  const text = `# 画像：owner

> 摘要：开发者

## fact
- [high] 职业是开发者（20261021T100000Z）`;
  const next = upsertProfileSlotText(text, "goal", "[high] 变现认知成果", undefined, "20261021T100200Z");
  assert.ok(next.includes("## goal"));
  assert.ok(next.includes("- [high] 变现认知成果（20261021T100200Z）"));
  // fact 槽不受影响
  const factIdx = next.indexOf("## fact");
  const goalIdx = next.indexOf("## goal");
  assert.ok(factIdx < goalIdx, "fact 段在 goal 段之前");
});

test("profile: upsertProfileSlotText 无 update 追加到目标槽段末尾", () => {
  const text = `# 画像：owner

## fact
- [high] 职业是开发者（20261021T100000Z）
- [medium] 有数据库基础（20261021T100100Z）

## goal
- [high] 变现认知成果（20261021T100200Z）`;
  const next = upsertProfileSlotText(text, "fact", "[high] 职业是开发者，兼做产品", undefined, "20261021T100500Z");
  const factBlock = next.slice(next.indexOf("## fact"), next.indexOf("## goal"));
  const lines = factBlock.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 3);
  assert.ok(lines[2].includes("兼做产品"), "无 update 时新条目追加到 fact 槽段末尾");
  // goal 段不被破坏
  const goalBlock = next.slice(next.indexOf("## goal"));
  assert.ok(goalBlock.includes("变现认知成果"));
});

test("profile: upsertProfileSlotText update 命中旧条目标注已更新", () => {
  const text = `# 画像：owner

## fact
- [high] 职业是开发者（20261021T100000Z）

## goal
- [high] 变现认知成果（20261021T100200Z）`;
  const next = upsertProfileSlotText(text, "goal", "[high] 变现认知成果已达成，转向沉淀方法论", "变现认知成果", "20261021T100600Z");
  assert.ok(next.includes("⚠️ 已更新"));
  assert.ok(next.includes("转向沉淀方法论"));
  // 更新命中旧条目后，新条目紧跟其后（仍在 goal 槽内）
  const goalBlock = next.slice(next.indexOf("## goal"));
  const goalLines = goalBlock.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(goalLines.length, 2);
  assert.ok(goalLines[0].includes("⚠️ 已更新"));
  assert.ok(goalLines[1].includes("转向沉淀方法论"));
});

test("profile: upsertProfileSlotText 非标准槽回退 other", () => {
  const next = upsertProfileSlotText("", "random_slot", "[high] 测试", undefined, "20261021T100000Z");
  assert.ok(next.includes("## other"));
  assert.ok(!next.includes("## random_slot"));
});

// ── PROFILE_DISCIPLINE（画像纪律注入）────────────────────────────────────
test("profile: PROFILE_DISCIPLINE 含检索路径与先画像后下钻", () => {
  assert.ok(PROFILE_DISCIPLINE.includes("第一索引键"));
  assert.ok(PROFILE_DISCIPLINE.includes("linghun_profile_get"));
  assert.ok(PROFILE_DISCIPLINE.includes("linghun_memory_read"));
  assert.ok(PROFILE_DISCIPLINE.includes("视角"));
  assert.ok(PROFILE_DISCIPLINE.includes("画像"));
  assert.ok(PROFILE_DISCIPLINE.includes("情境"));
  assert.ok(PROFILE_DISCIPLINE.includes("细节"));
  assert.ok(PROFILE_DISCIPLINE.includes("linghun_profile_update"));
  assert.equal(PROFILE_SLOTS.length, 6);
  assert.deepEqual(PROFILE_SLOTS, ["fact", "state", "goal", "value", "causal", "preference"]);
});
