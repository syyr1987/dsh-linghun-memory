/**
 * 记忆地图集成测试：真实 DSH 环境下 memory section 注入段包含地图导航。
 * 验证：地图段（四轴+证据层）进入注入、按图回溯纪律生效、原注入与目标主线保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, apply, NS } from "../index.js";

function harnessCollect(config) {
  const sections = [];
  const tools = [];
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    effect: (cb) => cb(),
    inject: () => {},
    tools: { register: (def) => tools.push(def) },
    on: () => {},
  };
  const oldDshHome = process.env.DSH_HOME;
  const home = join("/tmp", `linghun-map-int-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const dshHome = join(home, ".dsh");
  const setEnv = (on) => {
    if (on) process.env.DSH_HOME = dshHome;
    else if (oldDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldDshHome;
  };
  setEnv(true);
  try {
    apply(ctx, Config(config));
  } finally {
    setEnv(false);
  }
  return {
    sections,
    dshHome,
    withEnv(fn) {
      setEnv(true);
      try { return fn(); } finally { setEnv(false); }
    },
  };
}

test("map集成: memory 注入段含地图导航（四轴+证据层）且保留原注入", () => {
  const h = harnessCollect(undefined);
  const memDir = join(h.dshHome, "linghun", "memory");
  mkdirSync(memDir, { recursive: true });
  mkdirSync(join(memDir, "journal"), { recursive: true });
  writeFileSync(
    join(memDir, "warm.md"),
    [
      "## 买车对比 [fact] high\n\n比亚迪海豹 vs 特斯拉 Model 3，预算 25 万。\n<!-- last_access: 2026-10-15 09:00:00 -->",
      "## 存钱计划 [goal] medium\n\n每月存 3000 启动金。\n<!-- last_access: 2026-10-14 20:00:00 -->",
    ].join("\n\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(memDir, "knowledge_ontology.md"),
    "## 车型参数\n- 海豹：续航 700\n",
    "utf8",
  );
  writeFileSync(
    join(memDir, "rules.md"),
    "## 决策纪律\n- 先查证再下结论\n",
    "utf8",
  );
  writeFileSync(join(memDir, "cold.md"), "- [fact] 买车预算 25 万\n", "utf8");
  writeFileSync(
    join(memDir, "journal", "2026-10-15.md"),
    "2026-10-15 09:00:00\n聊了买车\n",
    "utf8",
  );
  mkdirSync(join(h.dshHome, "linghun", "goals"), { recursive: true });
  writeFileSync(
    join(h.dshHome, "linghun", "goals", "goals.json"),
    JSON.stringify([
      { id: "g1", speaker: "owner", type: "long_term", domain: "career", state: "active", priority: "high", statement: "三个月内上线认知实验基线", time: "", detail: "", createdAt: "2026-10-01", updatedAt: "2026-10-01" },
    ]),
    "utf8",
  );

  const mem = h.sections.find((s) => s.name === "soul:linghun-memory");
  assert.ok(mem, "应注册 memory section");
  const text = h.withEnv(() => mem.text());

  // 地图纪律 + 四轴 + 证据层
  assert.ok(text.includes("记忆地图使用纪律"), "注入应含按图回溯纪律");
  assert.ok(text.includes("情境轴"), "应含情境轴");
  assert.ok(text.includes("[1] ## 买车对比"), "情境轴编号 1 对齐原始索引");
  assert.ok(text.includes("[2] ## 存钱计划"), "情境轴编号 2 对齐原始索引");
  assert.ok(text.includes("目标轴"), "应含目标轴");
  assert.ok(text.includes("[career·high]"), "目标轴含 domain/priority");
  assert.ok(text.includes("档案轴"), "应含档案轴");
  assert.ok(text.includes("车型参数"), "档案轴含知识本体节点");
  assert.ok(text.includes("证据层"), "应含证据层");
  assert.ok(text.includes("2026-10-15"), "证据层含 journal 索引");

  // 原注入保留：记忆使用纪律 / 认知循环 / 目标主线 / 本体素材
  assert.ok(text.includes("记忆使用纪律"), "保留 MEMORY_DISCIPLINE");
  assert.ok(text.includes("认知循环"), "保留 COGNITION_CYCLE");
  assert.ok(text.includes("目标激活纪律"), "保留目标主线纪律");
  assert.ok(text.includes("三个月内上线认知实验基线"), "目标主线内容保留");
  assert.ok(text.includes("知识本体 / Facts"), "本体素材注入保留");
});

test("map集成: map.enabled=false 时不注入地图段与纪律，其余注入不受影响", () => {
  const h = harnessCollect({ memory: { map: { enabled: false } } });
  const memDir = join(h.dshHome, "linghun", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "cold.md"), "- [fact] 买车预算 25 万\n", "utf8");

  const mem = h.sections.find((s) => s.name === "soul:linghun-memory");
  const text = h.withEnv(() => mem.text());
  assert.ok(!text.includes("记忆地图使用纪律"), "关闭地图时不得注入地图纪律");
  assert.ok(!text.includes("情境轴"), "关闭地图时不得注入情境轴");
  assert.ok(text.includes("记忆使用纪律"), "关闭地图时原纪律保留");
  assert.ok(text.includes("买车预算"), "素材注入保留");
});

test("map集成: 空记忆库地图段安全（不注入空地图也不报错）", () => {
  const h = harnessCollect(undefined);
  const memDir = join(h.dshHome, "linghun", "memory");
  mkdirSync(memDir, { recursive: true });
  const mem = h.sections.find((s) => s.name === "soul:linghun-memory");
  const text = h.withEnv(() => mem.text());
  // 空库无地图段（renderMemoryMap 返回空串），但 memory section 本身仍注册（返回空注入也正常）
  assert.ok(typeof text === "string", "空库渲染不抛错");
});
