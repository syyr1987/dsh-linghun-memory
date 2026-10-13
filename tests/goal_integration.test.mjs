// goal.js 集成回归：index.js 完整链路（注册 → execute 落盘/触发/状态 → 注入段渲染）
// 背景：曾发生「index.js 缺 import goal.js + renderMemory 缺目标主线」的静默缺失——
// apply 不执行 helper 时测试不报错，真机 execute 才崩。此测试锁定完整链路。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../index.js";

function mockCtx() {
  const tools = [];
  const sections = [];
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    effect: (cb) => cb(),
    inject: () => {},
    tools: { register: (def) => tools.push(def) },
    on: () => {},
  };
  apply(ctx, Config({}));
  return { ctx, tools, sections };
}

test("index.js 集成：goal 三工具注册 + execute 写入/合并/触发/状态 + 注入段渲染", async () => {
  const home = mkdtempSync(join(tmpdir(), "goal-int-"));
  process.env.DSH_HOME = home;
  try {
    const { tools, sections } = mockCtx();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.ok(byName.linghun_goal_update, "linghun_goal_update 注册");
    assert.ok(byName.linghun_goal_get, "linghun_goal_get 注册");
    assert.ok(byName.linghun_goal_state, "linghun_goal_state 注册");

    // 写侧：new
    const r1 = await byName.linghun_goal_update.execute({
      action: "new",
      statement: "攒钱买戒指向 Sarah 求婚",
      domain: "family",
      priority: "high",
      speaker: "self",
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.mode, "new");
    const gf = join(home, "linghun", "goals", "goals.json");
    assert.ok(existsSync(gf), "goals.json 落盘");
    const saved = JSON.parse(readFileSync(gf, "utf8"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].state, "active");

    // 写侧：progress 同主题应合并（推进同一目标，mode=progress、id 不变、detail 追加）
    const r1b = await byName.linghun_goal_update.execute({
      action: "progress",
      statement: "戒指已经挑好了",
      domain: "family",
      speaker: "self",
      detail: "本周六求婚",
    });
    assert.equal(r1b.ok, true);
    assert.equal(r1b.mode, "progress", "同 speaker 同 domain 合并为推进");
    assert.equal(r1b.goal.id, r1.goal.id, "progress 沿用同一目标 id，不重复建档");
    assert.ok(r1b.goal.detail.includes("本周六求婚"), "detail 追加");

    // 读侧：残差触发
    const r2 = await byName.linghun_goal_get.execute({ query: "下周要向 Sarah 求婚了", top: 3 });
    assert.ok(r2.ok, "get ok");
    assert.equal(r2.goals.length, 1);
    assert.ok(r2.goals[0].statement.includes("求婚"), "触发排序命中求婚目标");
    assert.ok(r2.scores.length === 1 && typeof r2.scores[0].score === "number", "scores 带触发分");

    // 状态机
    const r3 = await byName.linghun_goal_state.execute({});
    assert.equal(r3.total, 1);
    assert.equal(r3.byState.active, 1);

    // 读侧注入段：记忆为空时目标主线仍渲染（独立于记忆本体）
    const memSec = sections.find((s) => s.name.includes("memory"));
    const text = memSec?.text?.() ?? "";
    assert.ok(text.includes("目标激活纪律"), "注入段含 GOAL_DISCIPLINE");
    assert.ok(text.includes("求婚"), "注入段含目标主线内容");
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.DSH_HOME;
  }
});

test("index.js 集成：achieved 目标激活分为 0，不再进触发", async () => {
  const home = mkdtempSync(join(tmpdir(), "goal-int-"));
  process.env.DSH_HOME = home;
  try {
    const { tools } = mockCtx();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await byName.linghun_goal_update.execute({
      action: "new",
      statement: "攒钱买戒指向 Sarah 求婚",
      domain: "family",
      priority: "high",
      speaker: "self",
    });
    await byName.linghun_goal_update.execute({
      action: "achieve",
      statement: "攒钱买戒指向 Sarah 求婚",
      domain: "family",
      speaker: "self",
      detail: "求婚成功",
    });
    const r2 = await byName.linghun_goal_get.execute({ query: "下周要向 Sarah 求婚了", top: 3 });
    assert.ok(r2.ok);
    assert.equal(r2.goals.length, 0, "已达成目标不进触发结果");
    const r3 = await byName.linghun_goal_state.execute({});
    assert.equal(r3.byState.achieved, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.DSH_HOME;
  }
});
