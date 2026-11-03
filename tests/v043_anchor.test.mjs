/**
 * v0.4.3 写侧相对时间锚定验证。
 * 锚点 = 写入时刻日期；相对表达就地标成 [=YYYY-MM-DD]，原文不改写；已标注的不重复标注。
 * 「相隔多少天」不在此处理（相对量，读侧现算）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../index.js";

function makeCtx() {
  const tools = new Map();
  const ctx = {
    systemPrompt: { section: () => () => {} },
    effect: (cb) => cb(),
    inject: () => {},
    tools: { register: (def) => tools.set(def.name, def) },
    on: () => {},
  };
  return { ctx, tools };
}

const iso = (d) => d.toISOString().slice(0, 10);

function findWarm(root) {
  const direct = join(root, "linghun", "memory", "warm.md");
  return direct;
}

test("v0.4.3 写侧相对时间锚定", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-anchor-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, Config({}));
    const append = tools.get("linghun_memory_append");
    assert.ok(append, "linghun_memory_append 已注册");

    const today = iso(new Date());
    const tomorrow = iso(new Date(Date.now() + 86400000));

    await append.execute(
      {
        kind: "event",
        confidence: "high",
        content: "Team | post snapshot | by EOD today | Compliance | deadline tomorrow",
      },
      {},
    );

    const warmPath = findWarm(home);
    assert.ok(existsSync(warmPath), `warm.md 已写入（查找路径 ${warmPath}）`);
    const text = readFileSync(warmPath, "utf8");
    assert.ok(text.includes(`EOD today [=${today}]`), `today 应锚定为 ${today}，实际：\n${text}`);
    assert.ok(text.includes(`tomorrow [=${tomorrow}]`), `tomorrow 应锚定为 ${tomorrow}，实际：\n${text}`);
    // 原文不得被改写
    assert.ok(text.includes("by EOD today"), "原文保留");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("v0.4.3 已标注的不重复锚定", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-anchor2-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, Config({}));
    const append = tools.get("linghun_memory_append");
    await append.execute(
      { kind: "fact", confidence: "high", content: "Review | date | tomorrow [=2099-01-01] | note#1" },
      {},
    );
    const text = readFileSync(findWarm(home), "utf8");
    assert.ok(text.includes("tomorrow [=2099-01-01]"), "原有标注保留");
    assert.equal((text.match(/\[=\d{4}-\d{2}-\d{2}\]/g) || []).length, 1, "不重复标注");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
