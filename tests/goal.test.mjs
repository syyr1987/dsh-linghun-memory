import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_STATE_WEIGHT,
  DOMAIN_LEXICON,
  parseGoals,
  serializeGoals,
  sortGoals,
  findMergeCandidate,
  mergeGoalSignal,
  goalActivateScore,
  rankGoalsByTrigger,
  renderGoalsForInject,
  GOAL_DISCIPLINE,
} from "../goal.js";

// ── 解析 / 序列化 ───────────────────────────────────────────────────────
test("goal: parseGoals 空/坏 JSON 返回空数组", () => {
  assert.deepEqual(parseGoals(""), []);
  assert.deepEqual(parseGoals(null), []);
  assert.deepEqual(parseGoals("not json"), []);
  assert.deepEqual(parseGoals("[]"), []);
});

test("goal: parseGoals 解析合法数组", () => {
  const goals = parseGoals('[{"id":"g1","statement":"攒钱买戒指"}]');
  assert.equal(goals.length, 1);
  assert.equal(goals[0].statement, "攒钱买戒指");
});

test("goal: serializeGoals 可往返", () => {
  const goals = [{ id: "g1", statement: "攒钱买戒指", state: "active", domain: "family" }];
  assert.deepEqual(parseGoals(serializeGoals(goals)), goals);
});

// ── 状态机排序 ──────────────────────────────────────────────────────────
test("goal: sortGoals active 在前、priority 高在前、新在前", () => {
  const goals = [
    { id: "a", state: "achieved", priority: "high", time: "2026-10-10" },
    { id: "b", state: "active", priority: "low", time: "2026-10-12" },
    { id: "c", state: "active", priority: "high", time: "2026-10-11" },
    { id: "d", state: "paused", priority: "medium", time: "2026-10-13" },
  ];
  const sorted = sortGoals(goals).map((g) => g.id);
  assert.deepEqual(sorted, ["c", "b", "d", "a"]);
});

// ── 写侧信号合并 ─────────────────────────────────────────────────────────
test("goal: new 建档", () => {
  const { goals, mode, goal } = mergeGoalSignal([], {
    action: "new",
    speaker: "Sarah",
    statement: "攒钱买戒指向我求婚",
    domain: "family",
    priority: "high",
  }, "2026-10-13");
  assert.equal(mode, "new");
  assert.equal(goals.length, 1);
  assert.equal(goal.state, "active");
  assert.equal(goal.speaker, "Sarah");
  assert.equal(goals[0].domain, "family");
});

test("goal: 同主题自动合并（同 domain 不重复建档）", () => {
  const first = mergeGoalSignal([], { action: "new", statement: "攒钱买戒指", domain: "family" }, "2026-10-13").goals;
  const { goals, mode } = mergeGoalSignal(first, { action: "new", statement: "攒钱买戒指", domain: "family" }, "2026-10-14");
  assert.equal(mode, "merge");
  assert.equal(goals.length, 1);
});

test("goal: progress 追加 detail 不新建", () => {
  const first = mergeGoalSignal([], { action: "new", statement: "攒钱买戒指", domain: "family" }, "2026-10-13").goals;
  const { goals, mode, goal } = mergeGoalSignal(first, {
    action: "progress",
    statement: "攒钱买戒指",
    detail: "已存 3 万",
  }, "2026-10-15");
  assert.equal(mode, "progress");
  assert.equal(goals.length, 1);
  assert.ok(goal.detail.includes("已存 3 万"));
});

test("goal: achieve 更新状态机", () => {
  const first = mergeGoalSignal([], { action: "new", statement: "攒钱买戒指", domain: "family" }, "2026-10-13").goals;
  const { goals, mode, goal } = mergeGoalSignal(first, {
    action: "achieve",
    statement: "攒钱买戒指",
    detail: "求婚成功",
  }, "2026-10-20");
  assert.equal(mode, "achieve");
  assert.equal(goal.state, "achieved");
  assert.equal(goals.length, 1);
});

test("goal: abandon 后不再参与合并", () => {
  let state = mergeGoalSignal([], { action: "new", statement: "学吉他", domain: "belief" }, "2026-10-13");
  state = mergeGoalSignal(state.goals, { action: "abandon", statement: "学吉他" }, "2026-10-15");
  assert.equal(state.goal.state, "abandoned");
  const again = mergeGoalSignal(state.goals, { action: "progress", statement: "学吉他" }, "2026-10-16");
  // 已放弃目标不合并，新建一个 active
  assert.equal(again.goals.length, 2);
  assert.equal(again.goal.state, "active");
});

// ── 读侧残差触发 ─────────────────────────────────────────────────────────
test("goal: achieved/abandoned 目标激活分为 0", () => {
  const active = { statement: "攒钱买戒指", domain: "family", state: "active" };
  const done = { statement: "攒钱买戒指", domain: "family", state: "achieved" };
  const q = "车钥匙这么贵，攒钱好难";
  assert.ok(goalActivateScore(active, q) > 0);
  assert.equal(goalActivateScore(done, q), 0);
});

test("goal: 处境命中 domain 词典时激活分更高（goal/value 盲区补位）", () => {
  const goal = { statement: "升职加薪", domain: "career", state: "active" };
  const hit = goalActivateScore(goal, "今天加班到很晚，老板说项目要赶进度");
  const miss = goalActivateScore(goal, "今天天气不错，去公园散步吧");
  assert.ok(hit > miss, `hit=${hit} miss=${miss}`);
});

test("goal: 残差触发排序——目标激活分抬升目标类联想", () => {
  const goals = [
    { id: "g1", statement: "攒钱买戒指向 Sarah 求婚", domain: "family", state: "active", priority: "high", time: "2026-10-13" },
    { id: "g2", statement: "发布 dsh-linghun-memory 0.2.0", domain: "career", state: "active", priority: "high", time: "2026-10-13" },
    { id: "g3", statement: "去日本看樱花", domain: "travel", state: "paused", priority: "low", time: "2026-10-01" },
  ];
  const q = "戒指好贵，还得继续攒钱，今年想求婚";
  const ranked = rankGoalsByTrigger(goals, q);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].goal.id, "g1");
  assert.ok(ranked[0].activate > 0);
});

test("goal: 无处境渲染按 active+priority 取前 N", () => {
  const goals = [
    { id: "a", statement: "低优目标", domain: "career", state: "active", priority: "low", time: "2026-10-13" },
    { id: "b", statement: "高优目标", domain: "family", state: "active", priority: "high", time: "2026-10-13" },
  ];
  const text = renderGoalsForInject(goals, "", { maxGoals: 5 });
  assert.ok(text.includes("高优目标"));
  const hiIdx = text.indexOf("高优目标");
  const loIdx = text.indexOf("低优目标");
  assert.ok(hiIdx < loIdx, "高优目标应排前面");
});

test("goal: 有处境渲染按触发分排序", () => {
  const goals = [
    { id: "a", statement: "攒钱买戒指", domain: "family", state: "active", priority: "high", time: "2026-10-13" },
    { id: "b", statement: "发论文", domain: "career", state: "active", priority: "high", time: "2026-10-13" },
  ];
  const text = renderGoalsForInject(goals, "戒指太贵了，要攒钱");
  assert.ok(text.includes("攒钱买戒指"));
  assert.ok(text.indexOf("攒钱买戒指") < text.indexOf("发论文"));
});

// ── Bridge 触发词（v0.1.5）─────────────────────────────────────────────
test("goal: new 建档可携带 triggers（Bridge 触发词）", () => {
  const { goals, mode, goal } = mergeGoalSignal([], {
    action: "new",
    speaker: "Caroline",
    statement: "keep saving for the kid's college fund",
    domain: "money",
    priority: "high",
    triggers: ["reconsidering long-term financial plans after a family trip", "postponing the saving approach and rethinking priorities"],
  }, "2026-10-13");
  assert.equal(mode, "new");
  assert.equal(goal.triggers.length, 2);
  assert.equal(goals[0].triggers[0].includes("family trip"), true);
});

test("goal: triggers 去重且最多 2 条", () => {
  const { goals } = mergeGoalSignal([], {
    action: "new",
    statement: "A 目标",
    domain: "family",
    triggers: ["t1 same", "t1 same", "t2 same", "t3 same", "t4 same"],
  }, "2026-10-13");
  assert.equal(goals[0].triggers.length, 2);
  assert.deepEqual(goals[0].triggers, ["t1 same", "t2 same"]);
});

test("goal: merge 时补充 triggers 不覆盖已有", () => {
  const first = mergeGoalSignal([], { action: "new", statement: "A 目标", domain: "family", triggers: ["t1"] }, "2026-10-13").goals;
  const { goals, mode } = mergeGoalSignal(first, { action: "new", statement: "A 目标", domain: "family", triggers: ["t2"] }, "2026-10-14");
  assert.equal(mode, "merge");
  assert.deepEqual(goals[0].triggers, ["t1", "t2"]);
});

test("goal: Bridge 命中抬升远距处境的激活分（词面零线索）", () => {
  const goal = {
    statement: "keep saving for the kid's college fund",
    domain: "money",
    state: "active",
    triggers: ["reconsidering long-term financial plans after a family trip"],
  };
  const far = "Six months later, we postponed that approach and took a family trip, which made me rethink how we use our time";
  const near = goalActivateScore(goal, far);
  const base = { statement: "keep saving for the kid's college fund", domain: "money", state: "active" };
  const farNoBridge = goalActivateScore(base, far);
  assert.ok(near > farNoBridge, `bridge=${near} noBridge=${farNoBridge}`);
});

test("goal: 题12 场景——college fund 目标在远距 trigger 下进前 5", () => {
  const goals = [
    { id: "g1", statement: "keep saving for the kid's college fund", domain: "money", state: "active", priority: "high", triggers: ["reconsidering long-term financial plans after a family trip"] },
    { id: "g2", statement: "adopt a child to become a mother", domain: "family", state: "active", priority: "high", time: "2026-10-01" },
    { id: "g3", statement: "become a licensed counselor by studying psychology", domain: "career", state: "active", priority: "high", time: "2026-10-02" },
    { id: "g4", statement: "spend more quality time with family", domain: "family", state: "active", priority: "medium", time: "2026-10-03" },
  ];
  const q = "Six months later, we postponed that approach and took a family trip, which made me rethink how we use our time";
  const ranked = rankGoalsByTrigger(goals, q);
  const idx = ranked.findIndex((r) => r.goal.id === "g1");
  assert.ok(idx >= 0 && idx < 5, `college fund 排名 ${idx}（前 5 应有）`);
});

test("goal: belief 词表覆盖谣言/隐私/声誉场景（题13）", () => {
  const q = "I refused to spread a rumor about a colleague out of respect for everyone's privacy and reputation";
  const goal = { statement: "never spread rumors; respect everyone's privacy and reputation", domain: "belief", state: "active" };
  const hit = goalActivateScore(goal, q);
  const missGoal = { statement: "learn to play the piano", domain: "art", state: "active" };
  const miss = goalActivateScore(missGoal, q);
  assert.ok(hit > miss, `hit=${hit} miss=${miss}`);
  assert.ok(hit > 0.3, `belief 激活分应明显 >0（当前 ${hit}）`);
});

// ── 注入纪律 ────────────────────────────────────────────────────────────
test("goal: GOAL_DISCIPLINE 含激活纪律要点", () => {
  assert.ok(GOAL_DISCIPLINE.includes("目标激活"));
  assert.ok(GOAL_DISCIPLINE.includes("温和注入"));
  assert.ok(GOAL_DISCIPLINE.includes("active"));
  assert.ok(GOAL_DISCIPLINE.includes("achieved"));
});

test("goal: 状态机权重表完整", () => {
  assert.equal(GOAL_STATE_WEIGHT.active, 1);
  assert.equal(GOAL_STATE_WEIGHT.paused, 0.5);
  assert.equal(GOAL_STATE_WEIGHT.achieved, 0);
  assert.equal(GOAL_STATE_WEIGHT.abandoned, 0);
  assert.ok(DOMAIN_LEXICON.money.length > 0);
});
