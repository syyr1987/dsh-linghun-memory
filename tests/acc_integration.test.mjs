/**
 * v0.2.0 ACC 集成测试：mock DSH harness ctx + 临时 DSH_HOME，跑真实 apply。
 * 1) 工具注册（retrieval_probe / memory_status / math_analyze）；
 * 2) ACC 模式注入收窄（enabled=true 时 memory section 只含导航层纪律，不含本体素材）；
 * 3) retrieval_probe execute：真实候选检索（warm/cold 混合候选池）；
 * 4) memory_status execute：状态结构齐全。
 * 领域层（linghun_domain_load）已随改版移除：领域指导归三本体，由 memory_read 主动读取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../index.js";

const W = (stamp, kind, conf, body, access) =>
  `## ${stamp} [${kind}] ${conf}\n\n${body}\n<!-- last_access: ${access ?? stamp} -->`;

function makeCtx() {
  const sections = [];
  const toolNames = [];
  const tools = new Map();
  return {
    sections,
    toolNames,
    tools,
    ctx: {
      systemPrompt: {
        section: (s) => {
          sections.push(s);
          return () => {
            const i = sections.indexOf(s);
            if (i >= 0) sections.splice(i, 1);
          };
        },
      },
      effect: (cb) => cb(),
      inject: () => {},
      tools: {
        register: (def) => {
          toolNames.push(def.name);
          tools.set(def.name, def);
        },
      },
      on: () => {},
    },
  };
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "dsh-acc-int-"));
  const memDir = join(home, "linghun", "memory");
  mkdirSync(memDir, { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return fn({ home, memDir });
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("acc-int: 工具注册（retrieval_probe / memory_status / math_analyze）", () => {
  const { ctx, toolNames } = makeCtx();
  apply(ctx, Config({}));
  assert.ok(toolNames.includes("linghun_retrieval_probe"));
  assert.ok(toolNames.includes("linghun_memory_status"));
  assert.ok(toolNames.includes("linghun_math_analyze"));
  assert.ok(!toolNames.includes("linghun_domain_load"), "领域加载工具应已移除");
});

test("acc-int: ACC 模式注入收窄——memory section 含导航纪律、不含本体素材", () => {
  const { ctx, sections } = makeCtx();
  apply(ctx, Config({ memory: { acc: { enabled: true } } }));
  const mem = sections.find((s) => s.name === "soul:linghun-memory");
  assert.ok(mem, "应注册 soul:linghun-memory section");
  const text = mem.text();
  assert.ok(text.includes("主动认知控制"), "ACC 纪律应注入");
  assert.ok(text.includes("linghun_retrieval_probe"), "工具引导应注入");
  assert.ok(text.includes("linghun_math_analyze"), "计算工具引导应注入");
  // 空记忆下不应出现本体素材段（知识本体 / 事件时间线）
  assert.ok(!text.includes("知识本体 / Facts"), "ACC 模式不自动注入本体素材");
});

test("acc-int: 非 ACC 模式保持 0.1.8 自动注入（默认关）", () => {
  const { ctx, sections } = makeCtx();
  apply(ctx, Config({}));
  const mem = sections.find((s) => s.name === "soul:linghun-memory");
  const text = mem.text();
  assert.ok(!text.includes("主动认知控制"), "默认模式不应注入 ACC 纪律");
});

test("acc-int: retrieval_probe execute 真实候选检索（warm/cold 混合）", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, Config({}));
  const probe = tools.get("linghun_retrieval_probe");
  assert.ok(probe);
  const out = await withHome(async ({ memDir }) => {
    writeFileSync(
      join(memDir, "warm.md"),
      [
        W("t1", "event", "high", "Caroline 参加 LGBTQ 互助小组 被接纳", "t1"),
        W("t2", "event", "high", "Melanie 参加慈善跑 完成半马", "t2"),
        W("t3", "fact", "medium", "Caroline 表达咨询事业意向 转型三年", "t3"),
      ].join("\n\n") + "\n",
      "utf8",
    );
    writeFileSync(join(memDir, "cold.md"), "## 冷储摘要\n用户偏好直接沟通 反对堆参数。\n", "utf8");
    return probe.execute({ query: "心理咨询 事业", top_k: 10 });
  });
  assert.equal(out.ok, true);
  assert.ok(out.results.length >= 1, "应返回至少 1 条候选");
  const warmHit = out.results.find((r) => r.source === "warm");
  assert.ok(warmHit, "应命中 warm 候选");
  assert.match(warmHit.title, /Caroline|咨询|事业|LGBTQ|Melanie/);
  assert.equal(typeof warmHit.score, "number");
  assert.ok(warmHit.read_hint.startsWith("linghun_memory_read"), "候选应带精读提示");
  // ref 定向过滤：ref=Melanie 后不应再出现 Caroline 相关候选
  const filtered = await probe.execute({ query: "事业", ref: "Melanie", top_k: 5 });
  assert.ok(filtered.results.every((r) => !r.title.includes("Caroline")), "ref 过滤后不应包含 Caroline 条目");
  const hitMelanie = filtered.results.find((r) => r.source === "warm");
  assert.ok(!hitMelanie || hitMelanie.title.includes("Melanie"), "warm 候选应只剩 Melanie 条目");
});

test("acc-int: math_analyze execute 六 op（calc/date/aggregate/compare/text）", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, Config({}));
  const math = tools.get("linghun_math_analyze");
  assert.ok(math);
  const calc = await math.execute({ op: "calc", expr: "3 + 4 * 2" });
  assert.equal(calc.ok, true);
  assert.equal(calc.result.value, 11);
  const date = await math.execute({ op: "date", expr: "2024-03-01 到 2024-05-15" });
  assert.equal(date.ok, true);
  assert.equal(date.result.days, 75);
  const agg = await math.execute({ op: "aggregate", values: [1, 2, 3, 4] });
  assert.equal(agg.ok, true);
  assert.equal(agg.result.sum, 10);
  assert.equal(agg.result.avg, 2.5);
  const cmp = await math.execute({ op: "compare", values: [{ label: "a", value: 5 }, { label: "b", value: 3 }, { label: "c", value: 9 }] });
  assert.equal(cmp.ok, true);
  assert.equal(cmp.result.max, "c=9");
  assert.equal(cmp.result.min, "b=3");
  const txtEn = await math.execute({ op: "text", text: "hello world" });
  assert.equal(txtEn.ok, true);
  assert.equal(txtEn.result.characters, 11);
  assert.equal(txtEn.result.words, 2);
  assert.equal(txtEn.result.cjkCharacters, 0);
  const txtCn = await math.execute({ op: "text", text: "你好 world\n第二行" });
  assert.equal(txtCn.ok, true);
  assert.equal(txtCn.result.characters, 12);
  assert.equal(txtCn.result.cjkCharacters, 5);
  assert.equal(txtCn.result.whitespace, 2);
  assert.equal(txtCn.result.lines, 2);
  assert.equal(txtCn.result.words, 3);
});

test("acc-int: memory_status execute 状态结构齐全", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, Config({ memory: { acc: { enabled: true } } }));
  const ms = tools.get("linghun_memory_status");
  assert.ok(ms);
  const out = await withHome(async ({ memDir }) => {
    writeFileSync(
      join(memDir, "warm.md"),
      W("t1", "event", "high", "第一条记忆", "t1") + "\n",
      "utf8",
    );
    writeFileSync(join(memDir, "cold.md"), "## 冷储摘要\n抽象经验。\n", "utf8");
    return ms.execute({});
  });
  assert.equal(out.ok, true);
  assert.equal(out.acc.enabled, true);
  assert.equal(out.memory.warm_entries, 1);
  assert.equal(out.memory.cold_blocks, 1);
  assert.ok(Array.isArray(out.goals.active_list));
  assert.ok(!("domains" in out), "memory_status 不应再返回 domains 字段");
  assert.ok(out.tools.includes("linghun_retrieval_probe"));
  assert.ok(out.tools.includes("linghun_math_analyze"));
  assert.ok(!out.tools.includes("linghun_domain_load"), "工具清单不应含 domain_load");
});
