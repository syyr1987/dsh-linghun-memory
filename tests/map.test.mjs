/**
 * 记忆地图（map.js）单元测试：四轴渲染 / 编号对齐 / 预算截断 / 空库安全。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMemoryMap, MAP_DISCIPLINE } from "../map.js";

const warmBlocks = [
  {
    block: "## 买车对比 [fact] high\n比亚迪海豹 vs 特斯拉 Model 3，预算 25 万\n<!-- last_access: 2026-10-15 09:00:00 -->",
    lastAccess: "2026-10-15 09:00:00",
    confidence: "high",
    kind: "fact",
  },
  {
    block: "## 存钱计划 [goal] medium\n每月存 3000 启动金，明年三月前\n<!-- last_access: 2026-10-14 20:00:00 -->",
    lastAccess: "2026-10-14 20:00:00",
    confidence: "medium",
    kind: "goal",
  },
  {
    block: "## 旧决策 [event] wrong\n已被推翻的事实\n<!-- last_access: 2026-10-10 12:00:00 -->",
    lastAccess: "2026-10-10 12:00:00",
    confidence: "wrong",
    kind: "event",
  },
];

test("map: 空库安全（无任何素材返回空串）", () => {
  assert.equal(renderMemoryMap({}), "");
  assert.equal(renderMemoryMap({ warmEntries: [] }), "");
});

test("map: 四轴全量渲染含标题与指针", () => {
  const out = renderMemoryMap({
    warmEntries: warmBlocks,
    coldSummary: "- 冷储：买车预算已定 25 万\n- 冷储：存钱节奏每月 3000",
    knowledgeOnt: "## 车型参数\n- 海豹：续航 700",
    rules: "## 决策纪律\n- 先查证再下结论",
    memoryOnt: "## 时间线\n- 10-14 定预算",
    journals: [{ name: "2026-10-15", entries: 23 }],
    episodes: [{ name: "买车复盘", title: "预算 25 万定版" }],
    goals: [{ domain: "career", state: "active", priority: "high", statement: "三个月内上线认知实验基线" }],
  });
  assert.ok(out.includes("情境轴"), "应含情境轴");
  assert.ok(out.includes("目标轴"), "应含目标轴");
  assert.ok(out.includes("档案轴"), "应含档案轴");
  assert.ok(out.includes("证据层"), "应含证据层");
  // 编号 = 原始 parseWarm 索引（1-based），wrong 条目不出现
  assert.ok(out.includes("[1] ## 买车对比"), "编号 1 对齐原始索引");
  assert.ok(out.includes("[2] ## 存钱计划"), "编号 2 对齐原始索引");
  assert.ok(!out.includes("旧决策"), "wrong 条目不得进入地图");
  assert.ok(out.includes("[career·high]"), "目标轴含 domain/priority");
  assert.ok(out.includes("2026-10-15（23 条）"), "证据层含 journal 索引");
});

test("map: 高置信常驻优先、编号仍为原始索引", () => {
  // 故意让 medium 条目 last_access 更新（排前面），high 应仍优先展示但编号不变
  const out = renderMemoryMap({
    warmEntries: [
      { block: "## 新近话题 [event] medium\n聊了电影\n<!-- last_access: 2026-10-15 10:00:00 -->", lastAccess: "2026-10-15 10:00:00", confidence: "medium", kind: "event" },
      { block: "## 买车对比 [fact] high\n海豹 vs Model 3\n<!-- last_access: 2026-10-10 08:00:00 -->", lastAccess: "2026-10-10 08:00:00", confidence: "high", kind: "fact" },
    ],
  });
  assert.ok(out.includes("[2] ## 买车对比"), "high 条目编号保持原始索引 2");
  assert.ok(out.indexOf("买车对比") < out.indexOf("新近话题"), "high 条目展示在 medium 之前");
});

test("map: 预算截断保留完整段落并提示下钻", () => {
  const src = {
    warmEntries: warmBlocks,
    journals: [{ name: "2026-10-15", entries: 23 }],
    episodes: [{ name: "买车复盘", title: "预算 25 万定版" }],
  };
  const out = renderMemoryMap(src, { maxChars: 200 });
  assert.ok(out.length <= 200 + 30, "截断后不超预算太多");
  assert.ok(out.includes("地图截断"), "超限处提示下钻");
});

test("map: 纪律常量含按图回溯协议要点", () => {
  assert.ok(MAP_DISCIPLINE.includes("按图回溯"));
  assert.ok(MAP_DISCIPLINE.includes("linghun_memory_read"));
  assert.ok(MAP_DISCIPLINE.includes("linghun_memory_journal"));
  assert.ok(MAP_DISCIPLINE.includes("定位靠轴，细节靠下钻"));
});
