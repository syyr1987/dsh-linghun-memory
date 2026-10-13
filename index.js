/**
 * 灵魂（Linghun）— 认知主体插件 for DeepSeek Harness
 *
 * 不是记忆/人设插件：给 agent 一套「收口者身份 + 边界判断纪律 + 海马体沉淀循环」，
 * 让 agent 成为有判断力、有纪律、会自我改进的认知主体。
 *
 * prompt sections:
 *   soul:identity  — 灵魂卡（身份锚点：收口者架构）
 *   soul:judgment  — 判断纪律（边界扫描）
 *   soul:memory    — 海马体记忆注入（冷储摘要·高频高抽象经验 + 归档/序时账索引；暖态近期由 linghun_memory_read 按需读）
 *
 * tools:
 *   linghun_soul_read / linghun_soul_update      — 灵魂自进化（读/更新自己的灵魂卡）
 *   linghun_memory_append / linghun_memory_read / linghun_memory_consolidate — 海马体（记/读/沉淀）
 */
import { readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_IDENTITY, DEFAULT_JUDGMENT, DEFAULT_USER_CARD, MEMORY_DISCIPLINE, COGNITION_CYCLE, resolveIdentity } from "./identity.js";
import { createMemoryLayout, parseWarm, renderWarmEntries, summarizeWarmForCold, touchWarmAccessText, findWarmEntryRef, replaceWarmEntryText, markWrongWarmEntryText, findNearDuplicateWarm } from "./memory.js";
import { writeOntologySafe, appendRulesSafe } from "./ontology.js";
import { parseGoals, serializeGoals, sortGoals, mergeGoalSignal, rankGoalsByTrigger, renderGoalsForInject, GOAL_DISCIPLINE } from "./goal.js";

const name = "linghun";
const inject = ["systemPrompt", "tools"];
const NS = "linghun";

const SECTION_IDENTITY = "soul:identity";
const SECTION_JUDGMENT = "soul:judgment";
// 记忆体线 section 命名空间独立：与旧线 dsh-linghun 的 soul:memory 隔离，
// 两条线并存时 prompt section 不冲突。
const SECTION_MEMORY = "soul:linghun-memory";

const MEMORY_DIR = join("linghun", "memory");
/** 用户人设文件：$DSH_HOME/linghun/identity.md —— 用户自己写人设的地方，文件优先。 */
const IDENTITY_FILE = join("linghun", "identity.md");

/** 从灵魂卡文件文本解析「名字：xxx」；找不到返回 null。 */
function parseName(text) {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*名字[:：]\s*(.+?)\s*$/);
    if (m && m[1] && m[1] !== "（你的名字或称呼）") return m[1];
  }
  return null;
}

const Config = z.object({
  identity: z.object({
    /** 灵魂名字：留空则只用默认卡片内容；填写后追加为「我的名字」。 */
    name: z.string().default(""),
    /** 灵魂卡内容（身份锚点）。 */
    content: z.string().default(""),
    /** 灵魂卡总开关：false 则完全不注入身份段落。 */
    enabled: z.boolean().default(true),
    /** 段落顺序：数字越小越靠前（多 section 模式下控制先后）。 */
    order: z.number().default(0),
    /** linghun_soul_update 拒绝超过此大小（字节）。 */
    maxBytes: z.number().default(64 * 1024),
    /** 灵魂卡覆盖模式：complete=true 时 soul:identity 注册为 dsh-system-prompt 的
     *  complete section（装配后唯一保留），覆盖 DSH 底座默认身份指涉；
     *  judgment/memory 合并进同一 section，避免被 complete 抑制机制丢弃。
     *  默认 false 保持三 section 现状。 */
    complete: z.boolean().default(false),
  }),
  judgment: z.object({
    /** 判断纪律开关：false 则不注入「边界扫描」判断纪律段落。 */
    enabled: z.boolean().default(true),
    /** 段落顺序：默认排在身份段之后、记忆段之前。 */
    order: z.number().default(0.2),
  }),
  memory: z.object({
    /** 海马体总开关：false 则记忆完全停用（不读不写不注入）。 */
    enabled: z.boolean().default(true),
    /** 是否注入记忆：true=记+注入；false=只记不注入（模型看不到记忆）。 */
    inject: z.boolean().default(true),
    /** 注入预算上限（字符）：每次注入的记忆总长度不超过此值。 */
    injectMaxChars: z.number().default(6000),
    /** 段落顺序：默认排在判断纪律段之后。 */
    order: z.number().default(0.5),
    /** 时间权重：暖态注入按 last_access（最后一次被调用）新→旧排序，吃灰的沉底被裁出注入。 */
    timeWeight: z.boolean().default(true),
    /** 暖态注入开关：默认 false——注入段只承载高频高抽象经验（冷储摘要/归档索引），
     *  暖态近期记忆由 linghun_memory_read 按需读取；true 时追加「近期记忆」注入段（特殊场景）。 */
    injectWarm: z.boolean().default(false),
    /** 暖态记忆体积上限：与注入预算（injectMaxChars 默认 6000 字）同量级对齐，
     *  避免 warm 可合法涨到 1MB 而 98% 结构性进不了注入（F5：autoConsolidate 死代码）。 */
    maxBytes: z.number().default(64 * 1024),
    /** 收尾评估：每轮对话结束由工程强制触发一次「有没有值得沉淀」的 LLM 评估，不依赖模型自觉。 */
    assessment: z.object({
      enabled: z.boolean().default(true),
      /** 送入评估的对话文本上限（字符）。 */
      maxChars: z.number().default(4000),
      /** 评估输出上限（token）：全量记录协议下每轮可多条，默认放宽到 800。 */
      maxTokens: z.number().default(800),
      /** 评估采样温度：低温度更稳定，不容易误判该沉淀/不该沉淀。 */
      temperature: z.number().default(0.2),
    }).default({}),
    /** 阈值自动沉淀：暖态达到 maxBytes*triggerRatio 时自动 consolidate 再写入，模型无感知。 */
    autoConsolidate: z.object({
      /** 自动沉淀开关：暖态到阈值自动 consolidate，模型无感知。 */
      enabled: z.boolean().default(true),
      /** 触发比例：warm 体积达到 maxBytes 的 80% 即自动沉淀。 */
      triggerRatio: z.number().default(0.8),
    }).default({}),
    /** 组装模式（提取侧子智能体）：从指定路径注入「预组装素材包」，替代 warm 原文注入。
     *  素材包由 linghun-assembler 生成；配置此路径后优先于环境变量 LINGHUN_MEMORY_OVERRIDE。 */
    assembler: z.object({
      injectPath: z.string().default(""),
      label: z.string().default("以下记忆素材由提取子智能体按当前问题从记忆库组装（仅保留相关条目，细节原样）"),
    }).default({}),
    /** 记忆本体投影（BEAM 机制回灌）：linghun_memory_project 把 warm 按主题桶 LLM 聚合 → ontology.md，
     *  供 linghun-assembler 检索「本体主题索引优先 + BM25 兜底」。 */
    ontology: z.object({
      /** 主题桶：LLM 聚合时的分组提示。空=由 LLM 自主聚类；给桶名则按桶聚合。 */
      buckets: z.array(z.string()).default([]),
      /** 每次投影最多主题节点数。 */
      maxNodes: z.number().default(12),
      /** 送入聚合的 warm 原文上限（字符）。 */
      maxChars: z.number().default(12000),
      /** 投影文件路径：默认 $DSH_HOME/linghun/memory/ontology.md。 */
      path: z.string().default(""),
    }).default({}),
    /** 规则本体（BEAM 三本体方案·规则本体）：linghun_memory_rules 把总结经验追加进 rules.md，
     *  供 linghun-assembler 检索「R_ALIAS 规则别名命中注入」。规则是长期经验（矛盾不硬裁/查证纪律等）。
     *  v0.1.0：支持签名分桶——topic 传 `[题型域|子题型|工具|错误码] 中文名` 写入 ### 桶 块。 */
    rules: z.object({
      /** 规则本体文件路径：默认 $DSH_HOME/linghun/memory/rules.md。 */
      path: z.string().default(""),
    }).default({}),
    /** MMR 排重（BEAM v2.6 机制回灌）：暖态近期记忆注入前做多样性重排——
     *  候选按「置信×新鲜度」打分，贪心 λ·rel − (1−λ)·max_sim（token Jaccard）砍同类冗余。
     *  默认开，λ=0.85 相关优先、阈值 0.2 保守（只砍明显冗余/低相关），保底取最高分。 */
    mmr: z.object({
      /** MMR 排重开关：false 则暖态注入回到纯排序截断。 */
      enabled: z.boolean().default(true),
      /** 保留条数上限（对标 v2.6 情境内 ≤6）。 */
      k: z.number().default(6),
      /** 相关优先权重：λ 越大越看重相关度，越小越看重多样性。 */
      lambda: z.number().default(0.85),
      /** 相对阈值截断：低于池顶 score×topCutoff 的候选不参与（防低相关混入）。 */
      topCutoff: z.number().default(0.2),
    }).default({}),
  }),
  goals: z.object({
    /** 目标系统总开关：false 则目标工具停用（get/update/state 返回 disabled）。 */
    enabled: z.boolean().default(true),
    /** 是否把目标主线注入读侧：true=读侧注入段追加「目标激活纪律+按触发分排序的目标主线」。 */
    inject: z.boolean().default(true),
    /** 目标档案路径：默认 $DSH_HOME/linghun/goals/goals.json。 */
    path: z.string().default(""),
    /** 注入预算上限（字符）：目标主线注入段不超过此值。 */
    injectMaxChars: z.number().default(1200),
    /** 段落顺序：默认排在记忆段之后。 */
    order: z.number().default(0.6),
    /** 残差触发公式权重：触发分 = simWeight·sim + activateWeight·goalActivate。 */
    simWeight: z.number().default(1),
    /** 目标激活权重：v1 建议 0.3 起步（MADELEINE 借鉴，β 从 0.3 起步）。 */
    activateWeight: z.number().default(0.3),
    /** 目标主线注入条数上限。 */
    maxGoals: z.number().default(5),
  }).default({}),
});

/** 记忆本体投影系统提示（BEAM build_ontology 机制回灌）：把暖态按主题桶聚合成主题节点。
 *  与 assembler 侧 TAG_ALIAS 主题索引配合：主题节点优先、BM25 兜底。 */
const ONTOLOGY_SYSTEM =
  "你是记忆本体投影器：把一批带时间戳的记忆条目按主题聚类，输出「主题节点」式的结构化本体，供检索优先命中。\n" +
  "要求：\n" +
  "1. 主题用 `## 主题名` 起行；同主题条目合并成一个节点，不拆分、不遗漏；\n" +
  "2. 每个节点正文保留关键事实：时间锚点（YYYY-MM-DD）、数字、版本号、结论——不得概括省略；\n" +
  "3. 节点按主题重要度排序（与当前主线相关的放前），最多不超过 {maxNodes} 个主题；\n" +
  "4. 条目间存在冲突（日期/数字/结论不一致）时，在节点内用「⚠️ 冲突：」标注两个口径，不擅自裁决；\n" +
  "5. 只聚合已有条目，不新增、不编造、不补对话外知识；\n" +
  "6. 输出紧凑，直接输出节点文本，不要解释。\n" +
  "{bucketsHint}";

const PROJECTION_PROMPT =
  "请把以下记忆条目投影成本体（主题节点）：\n\n{entries}";

/** 收尾评估系统提示（写侧协议 v1）：评估输出三类结构化条目（event/fact/rule），不写叙述段。
 *  历史 bug：此字符串曾缺失 const 声明成为死代码，导致 ASSESS_SYSTEM 未定义、收尾评估被 catch 静默吞掉。 */
const ASSESS_SYSTEM =
  "你是海马体记忆管家。你的任务：阅读一段刚结束的对话，把对话中**发生的、用户表达的**内容全量沉淀为记忆条目（记忆本体=时间线，发生过就记，不判断价值）；" +
  "同时识别对话中用到了哪些已有记忆。\n\n" +
  "全量记的：明确的事件（发生了什么）、用户表达的状态/约束/偏好/目标/价值观/因果（哪怕一句话带过、哪怕看似一次性）、精确事实（是什么/多少，含数字日期版本）、可执行规则（该怎么做）。\n" +
  "只跳过：纯寒暄（你好/再见/天气/客套）、无任何信息量的语气词。\n\n" +
  "输出格式（严格遵守）：\n" +
  "- 全是纯寒暄、无任何可记内容 → 只输出 SKIP\n" +
  "- 否则输出全部条目，每条一行：类别：内容（不要限条数，宁可多记）\n" +
  "  类别 ∈ event（事件）/ fact（事实，含精确值）/ rule（规则/决策/偏好，一句话可执行）\n" +
  "  event 内容写结构行：主语 | 动作 | 宾语 | 关联实体 | 细节\n" +
  "  fact 内容写结构行：实体 | 属性 | 值 | 来源#（值必须精确：数字/日期/版本）\n" +
  "  rule 内容写一句可执行纪律，不依赖原对话上下文也能读懂。\n" +
  "- 对话中实际用到了【已有记忆】里的条目 → 另起一行输出：TOUCH: 片段1 | 片段2\n" +
  "  片段取该条记忆中的一段原文（越独特越好）；没用到任何已有记忆则省略此行。";

/** 解析收尾评估输出：{ entries, touches }。entries 为全部沉淀条目（全量记录协议 v2：每轮可多条）；
 *  touches 为用到的已有记忆片段列表。
 *  kind 三型（event/fact/rule）；兼容旧类别（decision/preference→rule，experience→event，identity→fact）。 */
function parseAssessment(text) {
  const t = (text ?? "").trim();
  if (!t) return { entries: [], touches: [] };
  const skip = t.toUpperCase().includes("SKIP");
  const lines = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^[-*•]?\s*(类别|输出|对话|已有)/.test(l));
  const entries = [];
  const touches = [];
  for (const line of lines) {
    const touchM = line.match(/^TOUCH[：:]\s*(.+)$/i);
    if (touchM) {
      touches.push(
        ...touchM[1]
          .split(/[|｜]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (skip) continue;
    const m = line.match(/^(event|fact|rule|decision|preference|experience|identity)[：:]\s*(.+)$/i);
    if (m) {
      const raw = m[1].toLowerCase();
      const kind =
        raw === "decision" || raw === "preference"
          ? "rule"
          : raw === "experience"
            ? "event"
            : raw === "identity"
              ? "fact"
              : raw;
      entries.push({ kind, content: m[2].trim() });
    } else if (line.length > 4) {
      entries.push({ kind: "fact", content: line });
    }
  }
  return { entries, touches };
}

function apply(ctx, config) {
  let sourceGetter = null;
  /** mtime-keyed text cache：稳定段落保持 byte-identical（KV-cache 友好）。 */
  const fileCache = new Map();

  const cfg = () => (sourceGetter ? sourceGetter() : config);

  /** 同步 mtime 缓存读取；缺失/不可读返回 null。 */
  const readCached = (file) => {
    try {
      const st = statSync(file);
      const hit = fileCache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
      const text = readFileSync(file, "utf8");
      fileCache.set(file, { mtimeMs: st.mtimeMs, text });
      return text;
    } catch {
      return null;
    }
  };

  const memoryDir = () => join(resolveDshHome(), MEMORY_DIR);
  const identityFile = () => join(resolveDshHome(), IDENTITY_FILE);
  const layout = createMemoryLayout(memoryDir, readCached);

  // ── 目标系统（goal.js）：目标档案 CRUD + 读侧残差触发 ────────────────
  const goalsFile = () =>
    (cfg().goals?.path ?? "").trim() || join(resolveDshHome(), "linghun", "goals", "goals.json");
  const readGoals = () => parseGoals(readCached(goalsFile()));
  const writeGoals = async (goals) => {
    const file = goalsFile();
    await ensureParent(file);
    await writeFile(file, serializeGoals(goals), "utf8");
    fileCache.delete(file);
  };

  // 团队认知台账（assembler 认知循环团队共享；缺失/损坏跳过，只读）。
  // 子智能体的领域工作区 = $DSH_HOME/linghun/memory/team/，主智能体经此共享认知产物。
  const readTeamLedger = () => {
    const tdir = join(memoryDir(), "team");
    const cycRaw = readCached(join(tdir, "cycle.json"));
    const gapsRaw = readCached(join(tdir, "gaps.md"));
    const tlRaw = readCached(join(tdir, "archivist", "timelines", "index.json"));
    const judgeRaw = readCached(join(tdir, "judge", "history.jsonl"));
    const bundlesRaw = readCached(join(tdir, "editor", "bundles.jsonl"));
    const rows = [];
    if (cycRaw) {
      try {
        const cyc = JSON.parse(cycRaw);
        if (cyc && typeof cyc === "object") {
          const s = cyc.judgeStats ?? {};
          const f = cyc.feedback ?? {};
          rows.push(
            `- 回合 ${cyc.turnCount ?? 0} · 判官：light ${s.light ?? 0} / medium ${s.medium ?? 0} / deep ${s.deep ?? 0}`,
          );
          rows.push(`- 反馈：命中 ${f.hits ?? 0} / 未命中 ${f.misses ?? 0}`);
          const gaps = Array.isArray(cyc.gaps) ? cyc.gaps : [];
          if (gaps.length) {
            const head = gaps.slice(-3).map((g) => `「${g.query ?? ""}」`).join("、");
            rows.push(`- 缺口 ${gaps.length} 条，最近：${head}`);
          }
        }
      } catch {
        /* cycle.json 损坏跳过 */
      }
    }
    if (gapsRaw) {
      const lines = String(gapsRaw).split("\n").map((l) => l.trim()).filter(Boolean).slice(-3);
      if (lines.length && !rows.some((r) => r.startsWith("- 缺口"))) {
        rows.push(`- gaps.md 尾部：${lines.join("；")}`);
      }
    }
    if (tlRaw) {
      try {
        const tl = JSON.parse(tlRaw);
        if (Array.isArray(tl) && tl.length) {
          const topics = tl.slice(-5).map((e) => `${e.topic ?? "?"}（${e.stamp ?? ""}）`).join("、");
          rows.push(`- 史官已梳理：${topics}`);
        }
      } catch {
        /* 缓存损坏跳过 */
      }
    }
    if (judgeRaw) {
      const recs = [];
      for (const l of String(judgeRaw).split("\n").map((x) => x.trim()).filter(Boolean).slice(-5)) {
        try {
          recs.push(JSON.parse(l));
        } catch {
          /* 坏行跳过 */
        }
      }
      if (recs.length) {
        const head = recs
          .slice(-3)
          .map((r) => `${r.level ?? "?"}(${r.strategy ?? "general"})「${String(r.query ?? "").slice(0, 18)}」`)
          .join("、");
        rows.push(`- 判官履历 ${recs.length} 条，最近：${head}`);
      }
    }
    if (bundlesRaw) {
      const recs = [];
      for (const l of String(bundlesRaw).split("\n").map((x) => x.trim()).filter(Boolean).slice(-3)) {
        try {
          recs.push(JSON.parse(l));
        } catch {
          /* 坏行跳过 */
        }
      }
      if (recs.length) {
        const head = recs
          .map((r) => `${r.entryCount ?? 0} 条${r.timeline ? "+时序" : ""}「${String(r.query ?? "").slice(0, 14)}」`)
          .join("、");
        rows.push(`- 编辑已交付 ${recs.length} 次，最近：${head}`);
      }
    }
    return rows.length ? `## 团队认知台账 / Team\n${rows.join("\n")}` : "";
  };

  // ── prompt sections（function text：按 assembly 动态解析）──────────────
  const renderIdentity = () => {
    const c = cfg();
    if (c.identity?.enabled === false) return "";
    const content = resolveIdentity({
      fileText: readCached(identityFile()),
      configContent: c.identity?.content,
    });
    const soulName = (c.identity?.name ?? "").trim();
    return soulName ? `${content}\n\n> 我的名字：${soulName}` : content;
  };
  const renderJudgment = () =>
    cfg().judgment?.enabled === false ? "" : DEFAULT_JUDGMENT;
  const renderMemory = () => {
    const c = cfg();
    if (c.memory?.enabled === false || c.memory?.inject === false) return "";
    // 组装模式（提取侧子智能体）：配置 injectPath / 环境变量 / 默认约定路径（与 assembler 侧零配置联动）
    const asmPath =
      (c.memory?.assembler?.injectPath ?? "").trim() ||
      process.env.LINGHUN_MEMORY_OVERRIDE ||
      join(resolveDshHome(), "linghun", "memory", "assembled.md");
    if (asmPath) {
      try {
        const text = readFileSync(asmPath, "utf8").trim();
        if (text) return `> ${c.memory?.assembler?.label}\n\n${text}`;
      } catch {
        /* 文件不可读则回退默认注入 */
      }
    }
    const rendered = layout.renderForInject(c.memory?.injectMaxChars, {
      timeWeight: c.memory?.timeWeight,
      injectWarm: c.memory?.injectWarm,
      mmr: c.memory?.mmr,
    });
    // 目标系统：读侧注入目标主线（GOAL_DISCIPLINE + 按触发分排序的目标清单）
    const goalsCfg = c.goals;
    let goalSection = "";
    if (goalsCfg?.enabled !== false && goalsCfg?.inject !== false) {
      try {
        const gs = readGoals();
        if (gs.length) {
          goalSection = `${GOAL_DISCIPLINE}\n\n${renderGoalsForInject(gs, "", { maxGoals: goalsCfg?.maxGoals ?? 5 })}`;
        }
      } catch {
        /* 目标档案不可读则跳过目标主线 */
      }
    }
    const parts = [];
    if (rendered) parts.push(rendered);
    if (goalSection) parts.push(goalSection);
    if (!parts.length) return "";
    return `${MEMORY_DISCIPLINE}\n\n${COGNITION_CYCLE}\n\n${parts.join("\n\n")}`;
  };

  const sectionDisposers = { identity: null, judgment: null, memory: null };
  function registerSections() {
    for (const key of Object.keys(sectionDisposers)) {
      if (sectionDisposers[key]) {
        sectionDisposers[key]();
        sectionDisposers[key] = null;
      }
    }
    if (cfg().identity?.complete) {
      // 灵魂卡覆盖模式：只注册一个 complete section（身份+判断+记忆合并渲染）。
      // dsh-system-prompt 装配时 complete section 唯一保留，
      // DSH 底座默认身份指涉全部被抑制——灵魂卡成为唯一身份来源。
      sectionDisposers.identity = ctx.systemPrompt.section({
        name: SECTION_IDENTITY,
        order: cfg().identity?.order ?? 0,
        text: () =>
          [renderIdentity(), renderJudgment(), renderMemory()]
            .filter(Boolean)
            .join("\n\n"),
        interpolate: false,
        complete: true,
      });
      return;
    }
    // 默认模式：记忆体线只注册记忆 section（soul:linghun-memory）。
    // 身份/判断 section 由旧线 dsh-linghun（灵魂卡）或底座提供——两条线并存不冲突；
    // standalone 用完整灵魂卡时走上方 identity.complete 覆盖模式。
    sectionDisposers.memory = ctx.systemPrompt.section({
      name: SECTION_MEMORY,
      order: cfg().memory?.order ?? 0.5,
      text: renderMemory,
      interpolate: false,
    });
  }

  /** 首次运行：在人设目录放一份默认灵魂卡（幂等，已有文件则不动，尊重用户编辑）。 */
  const ensureIdentityFile = async () => {
    try {
      const file = identityFile();
      await ensureParent(file);
      try {
        readFileSync(file, "utf8");
      } catch {
        await writeFile(file, DEFAULT_USER_CARD.trimEnd() + "\n", "utf8");
        fileCache.delete(file);
      }
    } catch {
      // 非致命：写不进去就继续用默认卡 / 配置内容
    }
  };

  ctx.effect(() => {
    void ensureIdentityFile();
    registerSections();
    return () => {
      for (const key of Object.keys(sectionDisposers)) {
        if (sectionDisposers[key]) {
          sectionDisposers[key]();
          sectionDisposers[key] = null;
        }
      }
    };
  }, "linghun.sections()");

  // ── settings-backed configuration ──────────────────────────────────────
  // 兼容 dsh-settings 0.1.1（模块导出）与 0.1.2+（ctx.settings）。
  const installSettingsSectionCompat = (ns, schema, entry, hooks) => {
    ctx.inject(["settings"], (sctx) => {
      const scope = sctx.settings.register(ns, schema, { base: entry });
      hooks.setSource(() => scope.get());
      sctx.effect(() => () => {
        hooks.setSource(() => entry);
        hooks.onChange();
      });
      hooks.onChange();
      scope.watch(() => {
        hooks.onChange();
      });
    });
  };
  installSettingsSectionCompat(NS, Config, config, {
    setSource: (getter) => {
      sourceGetter = getter;
    },
    onChange: () => {
      registerSections();
    },
  });

  // 收尾评估要发起模型调用：先声明 llm 依赖，把服务引用存下来供事件回调使用
  let llmClient = null;
  ctx.inject(["llm"], (sctx) => {
    llmClient = sctx.llm;
    return () => {
      llmClient = null;
    };
  });

  // ── helpers ─────────────────────────────────────────────────────────────
  const ensureParent = async (file) => {
    await mkdir(dirname(file), { recursive: true });
  };
  const byteLen = (text) => Buffer.byteLength(text, "utf8");
  const nowStamp = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  /** 序时账时间戳：YYYY-MM-DD HH:MM:SS（秒级，天内可精确定位）。 */
  const nowStampSec = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const todayName = () => nowStamp().slice(0, 10);

  // ── 海马体：记 / 读 / 沉淀 ──────────────────────────────────────────────
  /** 归档暖态 → 三本体档案分流 + episodic/cold，然后清空暖态。工程层可复用（阈值沉淀/收尾评估共用）。
   *  写侧协议 v1：event→记忆本体档案（时间线固化）、fact high→知识本体档案（精确值固化）、
   *  rule→规则本体（rules.md）；legacy/未验证/被翻转 → episodic 全文 + cold 摘要（原 F3/F4 逻辑）。
   *  F3：episodic 用 append + 按时刻分段——同日多次沉淀不覆盖；
   *  F4：cold 只写「每条一行的锚点摘要 + 全文指针」，不倾倒 warm 原文（注入预算不被冷储吃光）。 */
  const doConsolidate = async () => {
    const warm = layout.readWarm();
    if (!warm.trim()) return { archived: 0, warmCleared: true };
    const stamp = nowStampSec(); // YYYY-MM-DD HH:MM:SS
    const day = stamp.slice(0, 10);
    const hm = stamp.slice(11, 16); // HH:MM
    const entries = parseWarm(warm);
    const events = entries.filter((e) => e.kind === "event" && e.confidence !== "wrong");
    const factsHigh = entries.filter((e) => e.kind === "fact" && e.confidence === "high");
    const rules = entries.filter((e) => e.kind === "rule" && e.confidence !== "wrong");
    const rest = entries.filter((e) => !events.includes(e) && !factsHigh.includes(e) && !rules.includes(e));

    // 1) event → 记忆本体档案（事件时间线固化）
    if (events.length) {
      const file = layout.memoryOntologyFile();
      await ensureParent(file);
      await appendFile(file, `\n${events.map((e) => e.block).join("\n\n")}\n`, "utf8");
      fileCache.delete(file);
    }
    // 2) fact high → 知识本体档案（精确值固化）
    if (factsHigh.length) {
      const file = layout.knowledgeOntologyFile();
      await ensureParent(file);
      await appendFile(file, `\n${factsHigh.map((e) => e.block).join("\n\n")}\n`, "utf8");
      fileCache.delete(file);
    }
    // 3) rule → 规则本体（rules.md，主题节点式）
    if (rules.length) {
      const rulesPath =
        (cfg().memory?.rules?.path ?? "").trim() ||
        join(resolveDshHome(), "linghun", "memory", "rules.md");
      for (const r of rules) {
        const ruleText = r.block
          .replace(/^## .*$/m, "")
          .replace(/\n?<!-- last_access: [^>]+ -->/, "")
          .trim();
        if (ruleText) await appendRulesSafe(rulesPath, "记忆沉淀", ruleText, day);
      }
    }
    // 4) 其余（legacy/未验证/被翻转）→ episodic 全文 + cold 摘要
    if (rest.length) {
      const episodicFile = join(layout.episodicDir(), `${day}.md`);
      const restText = rest.map((e) => e.block).join("\n\n");
      const cold = layout.readCold();
      const lines = summarizeWarmForCold(restText);
      const coldNext = [
        cold.trim(),
        `## ${day} 沉淀（${lines.length} 条）`,
        ...lines,
        `（全文见 episodic/${day}.md）`,
      ].filter(Boolean).join("\n");
      await ensureParent(episodicFile);
      await appendFile(episodicFile, `\n## ${hm}\n\n${restText}\n`, "utf8");
      await ensureParent(layout.coldFile());
      await appendFile(layout.coldFile(), `\n\n${coldNext}\n`, "utf8");
      fileCache.delete(episodicFile);
      fileCache.delete(layout.coldFile());
    }
    await writeFile(layout.warmFile(), "", "utf8");
    fileCache.delete(layout.warmFile());
    return { archived: byteLen(warm), warmCleared: true };
  };

  /** 记忆本体投影（BEAM 机制回灌）：把暖态 warm 按主题桶 LLM 聚合 → ontology.md。
   *  供 linghun-assembler 检索「本体主题索引优先 + BM25 兜底」；投影失败返回 { ok:false, reason }。 */
  const doOntologyProject = async (overrides = {}) => {
    const warm = layout.readWarm();
    if (!warm.trim()) return { ok: false, reason: "warm 为空，无内容可投影" };
    const c = cfg().memory?.ontology ?? {};
    const buckets = [...(overrides.buckets ?? []), ...(c.buckets ?? [])].filter((b) => typeof b === "string" && b.trim());
    const maxNodes = overrides.maxNodes ?? c.maxNodes ?? 12;
    const cap = overrides.maxChars ?? c.maxChars ?? 12000;
    const entries = renderWarmEntries(parseWarm(warm), { numbered: true, includeWrong: true });
    if (!entries.trim()) return { ok: false, reason: "warm 无可渲染条目" };
    const trunk = entries.length > cap ? `${entries.slice(0, cap)}\n…(截断)…` : entries;
    const bucketsHint = buckets.length
      ? `主题桶提示（尽量对齐这些主题，可增可并）：${buckets.join(" / ")}`
      : "主题自由聚类：按条目自然主题分桶";
    const system = ONTOLOGY_SYSTEM
      .replace("{maxNodes}", String(maxNodes))
      .replace("{bucketsHint}", bucketsHint);
    const prompt = PROJECTION_PROMPT.replace("{entries}", trunk);
    const out = await callLlmText(system, prompt);
    if (!out.trim()) return { ok: false, reason: "LLM 返回空投影" };
    const path = (c.path ?? "").trim() || join(resolveDshHome(), "linghun", "memory", "ontology.md");
    const changed = writeOntologySafe(path, out);
    return { ok: true, path, changed, nodes: out.split(/\n(?=## )/).filter((b) => b.trim().startsWith("## ")).length };
  };

  /** 规则本体沉淀（BEAM 三本体方案·规则本体）：把一条总结经验追加进 rules.md（## 主题 节点）。
   *  供 assembler 检索「R_ALIAS 规则别名命中注入」。失败返回 { ok:false, reason }。 */
  const doRulesAppend = async (opts = {}) => {
    const rule = typeof opts?.rule === "string" ? opts.rule.trim() : "";
    const topic = typeof opts?.topic === "string" ? opts.topic.trim() : "";
    if (!rule) return { ok: false, reason: "rule 为空" };
    const c = cfg().memory?.rules ?? {};
    const path = (c.path ?? "").trim() || join(resolveDshHome(), "linghun", "memory", "rules.md");
    const stamp = new Date().toISOString().slice(0, 10);
    return appendRulesSafe(path, topic, rule, stamp);
  };

  /** 写侧协议 v1：kind 归一化（三型收敛）+ 结构化格式校验。
   *  兼容旧类别：decision/preference→rule（该怎么做），experience→event（发生了什么），identity→fact（是什么）。 */
  const KIND_MAP = {
    event: "event", fact: "fact", rule: "rule",
    decision: "rule", preference: "rule", experience: "event", identity: "fact",
  };
  const normalizeKind = (k) => {
    const key = String(k ?? "fact").trim().toLowerCase();
    return KIND_MAP[key] ?? "fact";
  };
  /** 校验结构化条目格式；返回错误文案（含示例），合规返回 null。 */
  const validateEntryFormat = (kind, content) => {
    const c = String(content ?? "").trim();
    if (!c) return "content 不能为空";
    if (kind === "event") {
      if (!c.includes("|")) {
        return "event 条目必须是结构行：`主语 | 动作 | 宾语 | 关联实体 | 细节`（示例：`金之杰 | 决定 | 事务表新增 4 列 | transactions 表 | 与 income 模块联动`）。不要写叙述段落。";
      }
    }
    if (kind === "fact") {
      const parts = c.split("|").map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) {
        return "fact 条目必须是结构行：`实体 | 属性 | 值 | 来源#`，值必须精确（数字/日期/版本）（示例：`事务表 | 新增列数 | 4 | 对话#188·批37`）。不要写叙述段落。";
      }
    }
    if (kind === "rule") {
      if (c.includes("|")) {
        return "rule 条目是一句可执行纪律，不要用结构行（示例：`安全功能优先做登录校验，再做角色权限`）。";
      }
    }
    return null;
  };

  /** 写一条暖态记忆；开启 autoConsolidate 且达到阈值时先自动归档再写（模型无感知，不 throw）。
   *  opts.update：翻转语义——ref 命中正常条目 → 旧条目标 wrong（被翻转），新内容另起一条（默认 high）；
   *                ref 命中 wrong 条目 → 复活为高置信新内容（替换）。
   *  opts.confidence：high/medium/low（默认 medium）。
   *  无 update 时自动查近似重复（findNearDuplicateWarm）：几乎相同内容 → 替换不追加（防 BEAM 式旧新并存）。
   *  返回 { mode: "append" | "update" | "dedupe", bytes, totalBytes }。 */
  const appendMemoryBlock = async (content, kind, opts = {}) => {
    const stamp = nowStamp();
    const kindNorm = normalizeKind(kind);
    const conf = ["high", "medium", "low"].includes(opts.confidence) ? opts.confidence : "medium";
    const err = validateEntryFormat(kindNorm, content);
    if (err) {
      throw new Error(`linghun_memory_append: ${err}`);
    }
    const block = `\n## ${stamp} [${kindNorm}] ${conf}\n\n${content}\n<!-- last_access: ${stamp} -->\n`;
    const file = layout.warmFile();
    const current = readCached(file) ?? "";

    if (opts.update) {
      const found = findWarmEntryRef(current, opts.update);
      if (found) {
        if (found.entry.confidence === "wrong") {
          // 复活：被翻转的条目被证明其实对，替换为高置信新内容
          const next = replaceWarmEntryText(current, opts.update, block.trim());
          await ensureParent(file);
          await writeFile(file, next, "utf8");
          fileCache.delete(file);
          return { mode: "update", bytes: byteLen(block), totalBytes: byteLen(next) };
        }
        // 翻转：旧条目标 wrong，新内容追加为独立条目（默认 high，除非显式传 confidence）
        const flipped = markWrongWarmEntryText(current, opts.update);
        const highBlock = `\n## ${stamp} [${kindNorm}] high\n\n${content}\n<!-- last_access: ${stamp} -->\n`;
        const next = flipped === null ? current : flipped;
        const finalText = `${next.trimEnd()}\n${highBlock.trim()}\n`;
        await ensureParent(file);
        await writeFile(file, finalText, "utf8");
        fileCache.delete(file);
        return { mode: "update", bytes: byteLen(highBlock), totalBytes: byteLen(finalText) };
      }
      // ref 没匹配到：fall through 追加（模型引用失效时不让写入失败）
    }

    const dup = findNearDuplicateWarm(current, content);
    if (dup) {
      const entries = parseWarm(current);
      entries[dup.index] = { ...entries[dup.index], block: block.trim() };
      const next = `${entries.map((e) => e.block).join("\n\n")}\n`;
      await ensureParent(file);
      await writeFile(file, next, "utf8");
      fileCache.delete(file);
      return { mode: "dedupe", bytes: byteLen(block), totalBytes: byteLen(next) };
    }

    let total = byteLen(current + block);
    const max = cfg().memory?.maxBytes ?? 1024 * 1024;
    const ac = cfg().memory?.autoConsolidate;
    if (ac?.enabled !== false) {
      const ratio = ac?.triggerRatio ?? 0.8;
      if (total > max * ratio) {
        await doConsolidate();
        const fresh = readCached(file) ?? "";
        total = byteLen(fresh + block);
      }
    }
    if (total > max) {
      throw new Error(`linghun_memory_append: 记忆超过上限（${max} 字节），先执行 linghun_memory_consolidate 沉淀`);
    }
    await ensureParent(file);
    await appendFile(file, block, "utf8");
    fileCache.delete(file);
    return { mode: "append", bytes: byteLen(block), totalBytes: total };
  };

  /** 标记「被用到」：匹配 ref 的暖态条目刷新 last_access（读≠用，用到才 touch）。 */
  const touchWarmAccess = async (ref) => {
    const file = layout.warmFile();
    const warm = readCached(file);
    if (!warm || !warm.trim()) return 0;
    const { text, touched } = touchWarmAccessText(warm, ref, nowStamp());
    if (text !== null) {
      await ensureParent(file);
      await writeFile(file, text, "utf8");
      fileCache.delete(file);
    }
    return touched;
  };

  ctx.tools.register(defineTool({
    name: "linghun_memory_append",
    description:
      "把一条带时间戳的**结构化认知条目**记进海马体暖态工位（warm.md），不是写叙述摘要。\n\n类别（kind）三型：\n- event（事件=记忆本体）：`主语 | 动作 | 宾语 | 关联实体 | 细节`——记录发生了什么；时间由条目自带。\n- fact（事实=知识本体）：`实体 | 属性 | 值 | 来源#`——记录是什么/多少，值必须精确（数字/日期/版本），来源指对话批次/事件。\n- rule（规则=规则本体）：一句可执行纪律（决策/偏好/经验），不要用结构行。\n\n一条目一事实，不要一次性倾倒。积累多了用 linghun_memory_consolidate 沉淀（按类别移出到本体档案：event→记忆本体时间线、fact 高置信→知识本体、rule→规则本体）。\n\n置信度（confidence）：high=用户直接说/已验证；medium=推断（默认）；low=存疑/猜测/过期待验。低置信条目注入时带【低置信·需验证】标记，引用时必须声明不确定。\n\n更新（update）：发现旧条目已被推翻/变更时，传 linghun_memory_read 返回的编号（如 [3]）或该条目内容片段——旧条目标记为 wrong（被翻转，不再注入），新内容另起一条（默认高置信）。近似重复内容会自动合并不追加。",
    parameters: {
      kind: {
        type: "string",
        enum: ["event", "fact", "rule"],
        description: "条目类别（写侧协议三型）：event（事件，结构行 `主语|动作|宾语|关联|细节`）/ fact（事实，结构行 `实体|属性|值|来源#`，值精确）/ rule（规则，一句可执行纪律），默认 fact",
      },
      content: { type: "string", required: true, description: "要记住的结构化内容：event/fact 用 `|` 分隔的结构行（见 kind 说明），rule 用一句可执行纪律。不要写叙述段落" },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "置信度：high（用户直接说/已验证）/ medium（推断，默认）/ low（存疑/猜测/过期待验）",
      },
      update: {
        type: "string",
        description: "可选。要翻转/覆盖的旧条目：传 linghun_memory_read 返回的编号（如 [3]）或内容片段。命中后旧条目标记为 wrong（被翻转），新内容另起一条（默认高置信）。用于旧事实被推翻、决策变更、偏好改变等场景",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
          bytes: { type: "integer" },
          totalBytes: { type: "integer" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value.mode === "update"
              ? `已翻转旧条目为新事实（${value.bytes} 字节，累计 ${value.totalBytes}）。`
              : value.mode === "dedupe"
                ? `已合并近似重复条目（${value.bytes} 字节，累计 ${value.totalBytes}）。`
                : `已记入海马体（${value.bytes} 字节，累计 ${value.totalBytes}）。`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("linghun_memory_append: `content` 不能为空");
      const kind = String(args.kind ?? "fact").trim() || "fact";
      const confidence = String(args.confidence ?? "").trim();
      const update = String(args.update ?? "").trim() || undefined;
      return appendMemoryBlock(content, kind, { confidence, update });
    },
    presentCall: (args) => ({ card: "generic", title: "海马体·记录", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "linghun_memory_read",
    description:
      "读取海马体记忆。kind 可选：event→只读记忆本体档案（事件时间线）、fact→只读知识本体档案（精确值）、rule→只读规则本体（纪律）、不传→冷储摘要（cold.md）+ 暖态近期（warm.md）+ 归档索引。需要细节时可读完整内容。读≠用：读到的条目只有实际派上用场，才用 linghun_memory_touch 标记（标记=活跃，吃灰管理）。",
    parameters: {
      kind: {
        type: "string",
        enum: ["event", "fact", "rule"],
        description: "可选。只读某个本体档案：event=记忆本体（事件时间线）/ fact=知识本体（精确值）/ rule=规则本体（纪律）；不传则读综合视图（cold+warm+索引）",
      },
      full: {
        type: "boolean",
        description: "true 返回完整内容（可能很长）；false 返回注入摘要，默认 false",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          exists: { type: "boolean" },
          bytes: { type: "integer" },
          content: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.exists
            ? `海马体记忆（${value.bytes} 字节）：\n${value.content}`
            : "海马体为空（尚无记忆）。",
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const c = cfg();
      const max = c.memory?.injectMaxChars ?? 6000;
      const useFull = args?.full === true;
      // kind 直读本体档案：查证=查节点（知识本体精确值/规则本体纪律/记忆本体事件时间线）
      if (args?.kind) {
        let raw;
        if (args.kind === "event") {
          raw = layout.readMemoryOntology();
        } else if (args.kind === "fact") {
          raw = layout.readKnowledgeOntology();
        } else if (args.kind === "rule") {
          const rulesPath =
            (c.memory?.rules?.path ?? "").trim() ||
            join(resolveDshHome(), "linghun", "memory", "rules.md");
          raw = readFileSync(rulesPath, "utf8");
        } else {
          return { exists: false, bytes: 0, content: "" };
        }
        if (!raw.trim()) return { exists: false, bytes: 0, content: "" };
        const limit = useFull ? 50000 : max;
        const truncated = raw.length > limit;
        return {
          exists: true,
          bytes: byteLen(raw),
          content: truncated ? `${raw.slice(0, limit)}\n…(截断)…` : raw,
        };
      }
      const cold = layout.readCold();
      const warm = renderWarmEntries(parseWarm(layout.readWarm()), {
        numbered: true,
        includeWrong: true,
      });
      const episodes = layout.listEpisodic();
      const parts = [];
      if (cold.trim()) parts.push(cold.trim());
      if (warm.trim()) parts.push(`## 近期记忆 / Recent\n\n${warm.trim()}`);
      if (episodes.length) {
        const rows = episodes
          .map((e) => `- ${e.name}${e.title ? ` — ${e.title}` : ""}`)
          .join("\n");
        parts.push(`## 归档索引 / Archive\n${rows}`);
      }
      const team = readTeamLedger();
      if (team) parts.push(team);
      const full = parts.join("\n\n");
      if (!full.trim()) return { exists: false, bytes: 0, content: "" };
      const limit = useFull ? 50000 : max;
      const truncated = full.length > limit;
      return {
        exists: true,
        bytes: byteLen(full),
        content: truncated ? `${full.slice(0, limit)}\n…(截断)…` : full,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_memory_journal_read",
    description:
      "读取序时账（journal）：原始对话流水，按发生时间（精确到秒）归档、全量不筛选。不传 date 返回所有天的索引（日期 + 条数）；传 date（YYYY-MM-DD）返回该天完整流水。传 start/end（YYYY-MM-DD HH:MM:SS，精确到秒）可**按任务时间范围精确检索**：只返回该时间窗口内的流水条目，避免翻整日全量（单日流水过大时框架会截断中间段，务必用时间范围收窄）。start/end 可跨天，二者至少传一个即可。用于追溯'当时到底说了什么'——序时账与暖态/冷储互补：warm 是遗忘梯度的近期摘要，journal 是完整原始记录。",
    parameters: {
      date: {
        type: "string",
        description: "YYYY-MM-DD，读取指定日期的完整流水；不传则列出所有天索引",
      },
      start: {
        type: "string",
        description: "YYYY-MM-DD HH:MM:SS，检索窗口起始（含，精确到秒）；与 end 至少传一个，可跨天",
      },
      end: {
        type: "string",
        description: "YYYY-MM-DD HH:MM:SS，检索窗口结束（含，精确到秒）；与 start 至少传一个，可跨天",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          exists: { type: "boolean" },
          bytes: { type: "integer" },
          content: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.exists
            ? `序时账（${value.bytes} 字节）：\n${value.content}`
            : "序时账为空（尚无流水）。",
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const day = String(args?.date ?? "").trim();
      const start = String(args?.start ?? "").trim();
      const end = String(args?.end ?? "").trim();
      const stampRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return { exists: false, bytes: 0, content: "date 格式应为 YYYY-MM-DD" };
      }
      if ((start && !stampRe.test(start)) || (end && !stampRe.test(end))) {
        return { exists: false, bytes: 0, content: "start/end 格式应为 YYYY-MM-DD HH:MM:SS（精确到秒）" };
      }
      if (start && end && start > end) {
        return { exists: false, bytes: 0, content: "start 应早于等于 end" };
      }
      // 无时间范围：沿用原逻辑（整天全量 / 天索引）
      if (!start && !end) {
        if (day) {
          const content = layout.readJournal(day);
          if (!content.trim()) return { exists: false, bytes: 0, content: `该日期（${day}）暂无流水。` };
          return { exists: true, bytes: byteLen(content), content };
        }
        const days = layout.listJournal();
        if (!days.length) return { exists: false, bytes: 0, content: "序时账为空（尚无流水）。" };
        const rows = days
          .map((j) => `- ${j.name}（${j.entries} 条流水）`)
          .join("\n");
        return { exists: true, bytes: byteLen(rows), content: rows };
      }
      // 有时间范围：只扫窗口覆盖的日期文件，块级过滤精确到秒
      const days = layout.listJournal();
      if (!days.length) return { exists: false, bytes: 0, content: "序时账为空（尚无流水）。" };
      const startDay = start.slice(0, 10);
      const endDay = end.slice(0, 10);
      const scanDays = days.filter((j) => j.name >= startDay && j.name <= endDay);
      if (!scanDays.length) return { exists: false, bytes: 0, content: `范围内（${start} ~ ${end}）暂无流水。` };
      const parts = [];
      for (const j of scanDays) {
        const content = layout.readJournal(j.name, { start, end });
        if (content.trim()) parts.push(`## ${j.name}\n${content.trim()}`);
      }
      if (!parts.length) return { exists: false, bytes: 0, content: `范围内（${start} ~ ${end}）暂无流水。` };
      const content = parts.join("\n\n");
      return { exists: true, bytes: byteLen(content), content };
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_memory_touch",
    description:
      "标记暖态记忆为「刚刚被用到」：传入该条记忆内容中的一段文字（ref），匹配到的条目 last_access 刷新为当前时间。读≠用——linghun_memory_read 读到的条目，只有实际派上用场的才 touch，这是吃灰管理的关键动作：一直不被用到的记忆会沉底、被挤出注入。",
    parameters: {
      ref: {
        type: "string",
        required: true,
        description: "要标记的记忆内容片段（出现在该条记忆里的一段文字，越独特越好）",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          touched: { type: "integer" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `已标记 ${value.touched} 条记忆为活跃。` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const ref = String(args?.ref ?? "").trim();
      if (!ref) throw new Error("linghun_memory_touch: `ref` 不能为空");
      if (cfg().memory?.timeWeight === false) return { touched: 0 };
      try {
        const touched = await touchWarmAccess(ref);
        return { touched };
      } catch {
        return { touched: 0 };
      }
    },
    presentCall: (args) => ({ card: "generic", title: "海马体·标记活跃", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "linghun_memory_consolidate",
    description:
      "海马体沉淀：把暖态工位（warm.md）的近期记忆归档进 episodic/<日期>.md，并合并进冷储摘要（cold.md），然后清空暖态。相当于「判断→被判定→反馈→机制化」循环里的归档动作。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          archived: { type: "integer" },
          warmCleared: { type: "boolean" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `海马体沉淀完成：归档 ${value.archived} 字节，暖态已清空。` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return doConsolidate();
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_memory_project",
    description:
      "记忆本体投影（BEAM 验证机制）：把暖态工位（warm.md）按主题桶 LLM 聚合成本体投影（ontology.md）——同主题条目合并为主题节点，保留时间锚点/数字/版本/结论。供记忆提取子智能体（linghun-assembler）检索时「本体主题索引优先 + BM25 兜底」，替代纯 BM25 的分散命中。适合在 warm 条目多、问题常跨主题时执行；本体文件可在多次投影间累积（每次用当前暖态重投影）。",
    parameters: {
      buckets: {
        type: "array",
        items: { type: "string" },
        description: "可选。主题桶提示（如 [\"RAG 管道\", \"向量数据库\", \"成本估算\"]）；不传由 LLM 按自然主题自由聚类",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          changed: { type: "boolean" },
          nodes: { type: "integer" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `记忆本体投影完成：${value.nodes} 个主题节点 → ${value.path}${value.changed ? "（已更新）" : "（内容未变）"}` : `记忆本体投影未完成：${value.reason ?? "未知原因"}` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return doOntologyProject({
        buckets: Array.isArray(args?.buckets) ? args.buckets.filter((b) => typeof b === "string" && b.trim()) : [],
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_memory_rules",
    description:
      "规则本体沉淀（BEAM 三本体方案·规则本体）：把一条可复用的总结经验追加进规则本体 rules.md（## 主题 节点下追加 - 规则行），供记忆提取子智能体（linghun-assembler）检索时 R_ALIAS 规则别名命中注入。规则是长期稳定的经验（如「矛盾不硬裁」「先查证再下结论」「记忆注入是素材不替代判定」），不是一次性事实——适合在实践得出可复用结论后调用；同主题规则自动聚合在同一节点下。\n\n签名分桶（v0.1.0）：topic 传签名格式 `[题型域|子题型|工具|错误码] 中文名`（如 `[推理题|矛盾辨析|无|无] 矛盾处置`）时，写入 `### 桶` 签名桶块——把「题型的抽象关系结构」工程化为签名桶，同签名自动聚合；普通主题维持旧节点格式，两者可共存。",
    parameters: {
      rule: {
        type: "string",
        description: "规则内容（一句话可复用经验，如「矛盾不硬裁：悖论场景承认无一致解，不强行自洽」）",
      },
      topic: {
        type: "string",
        description: "规则主题（如「判断纪律」「记忆纪律」「评测纪律」）或签名桶（`[题型域|子题型|工具|错误码] 中文名`）；同主题/同签名聚合在一个节点/桶下",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          changed: { type: "boolean" },
          path: { type: "string" },
          theme: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `规则本体已沉淀：${value.theme} → ${value.path}` : `规则本体沉淀失败：${value.reason ?? "未知原因"}` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return doRulesAppend({ rule: args?.rule, topic: args?.topic });
    },
  }));

  // ── 目标系统：get（残差触发检索）/ update（写侧信号合并）/ state（状态查询）────
  ctx.tools.register(defineTool({
    name: "linghun_goal_get",
    description:
      "目标主线处境触发检索：把当前处境（对话消息/情景）与目标档案做残差触发打分（触发分 = 相似度 + 目标激活分），返回按触发分降序的目标清单。目标=记忆的骨架（要达成什么+为什么）；goal/value 类联想是纯相似度的盲区——本工具用「目标激活」补上。命中目标主线时把它作为最高优先参考（温和注入，可用参考，不强制改写回答）。",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "当前处境文本（用户消息/情景描述），用于触发目标激活",
      },
      top: { type: "number", description: "返回目标条数上限，默认 5" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          goals: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                speaker: { type: "string" },
                statement: { type: "string" },
                domain: { type: "string" },
                state: { type: "string" },
                priority: { type: "string" },
                time: { type: "string" },
                detail: { type: "string" },
                linked: { type: "array", items: { type: "string" } },
                triggers: { type: "array", items: { type: "string" } },
              },
            },
          },
          scores: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                sim: { type: "number" },
                activate: { type: "number" },
                score: { type: "number" },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok
            ? `目标主线触发检索（触发分降序）：\n${(value.goals ?? []).map((g, i) => `[${i + 1}] ${g.domain ? `(${g.domain}) ` : ""}${g.statement}｜${g.state}｜触发分 ${((value.scores?.[i]?.score) ?? 0).toFixed(2)}`).join("\n") || "（无命中目标）"}`
            : "目标检索失败。",
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("linghun_goal_get: `query` 不能为空");
      const c = cfg();
      if (c.goals?.enabled === false) return { ok: false, goals: [], scores: [] };
      const ranked = rankGoalsByTrigger(readGoals(), query, {
        simWeight: c.goals?.simWeight ?? 1,
        activateWeight: c.goals?.activateWeight ?? 0.3,
      });
      const top = Number(args?.top ?? 5);
      const kept = ranked.slice(0, top);
      return {
        ok: true,
        goals: kept.map((r) => r.goal),
        scores: kept.map((r) => ({ id: r.goal.id, sim: r.sim, activate: r.activate, score: r.score })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_goal_update",
    description:
      "写侧目标信号合并：把对话中出现的目标信号（新目标/推进/调整/达成/放弃）合并进目标档案（$DSH_HOME/linghun/goals/goals.json）。目标系统=真实前瞻记忆：写时不预判未来会被问什么，只沉淀「这个人要达成什么」。同 speaker 同主题（domain 相同或表述相似）自动合并、不重复建档。action：new（新目标）/ progress（推进，追加 detail）/ change（调整 statement/domain/priority）/ achieve（达成）/ abandon（放弃）。triggers 为可选 Bridge 触发词（1-2 条「什么处境会激活这个目标」的语义远距桥，英文原文，如 college fund 目标 → \"reconsidering long-term financial plans after a family trip\"），只给 high/medium 目标、每条 3-8 词、不穷举未来提问。",
    parameters: {
      action: {
        type: "string",
        enum: ["new", "progress", "change", "achieve", "abandon"],
        description: "目标信号动作：new=新目标 / progress=推进 / change=调整 / achieve=达成 / abandon=放弃，默认 new",
      },
      statement: {
        type: "string",
        required: true,
        description: "目标表述（可检索的具体文本，如「攒钱买戒指向 Sarah 求婚」，不要抽象词；英文对话用英文原文）",
      },
      speaker: { type: "string", description: "目标属于谁，默认 self" },
      domain: { type: "string", description: "主题域标签（money/family/career/health/travel/belief 等）——检索轴" },
      priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级，默认 medium" },
      detail: { type: "string", description: "进度/事件细节（推进时追加，达成时写达成说明）" },
      triggers: {
        type: "array",
        items: { type: "string" },
        description: "可选 Bridge 触发词（1-2 条「什么处境会激活它」的语义远距桥，英文原文，仅 high/medium 目标）",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          mode: { type: "string" },
          goal: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              speaker: { type: "string" },
              statement: { type: "string" },
              domain: { type: "string" },
              state: { type: "string" },
              priority: { type: "string" },
              time: { type: "string" },
              detail: { type: "string" },
              linked: { type: "array", items: { type: "string" } },
              triggers: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok
            ? `目标档案已更新（${value.mode}）：${value.goal?.statement ?? ""}｜${value.goal?.state ?? ""}`
            : `目标更新未执行：${value.mode ?? "disabled"}。`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const c = cfg();
      if (c.goals?.enabled === false) return { ok: false, mode: "disabled", goal: null };
      const signal = {
        action: args?.action ?? "new",
        statement: args?.statement,
        speaker: args?.speaker,
        domain: args?.domain,
        priority: args?.priority,
        detail: args?.detail,
        triggers: args?.triggers,
      };
      const { goals, mode, goal } = mergeGoalSignal(readGoals(), signal, todayName());
      await writeGoals(goals);
      return { ok: true, mode, goal };
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_goal_state",
    description:
      "目标档案状态查询：返回当前全部目标及状态机统计（active/paused/achieved/abandoned 数量）。用于回顾目标主线、核对状态机是否随对话更新。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          total: { type: "number" },
          byState: {
            type: "object",
            additionalProperties: true,
          },
          goals: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                speaker: { type: "string" },
                statement: { type: "string" },
                domain: { type: "string" },
                state: { type: "string" },
                priority: { type: "string" },
                time: { type: "string" },
                detail: { type: "string" },
                linked: { type: "array", items: { type: "string" } },
                triggers: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok
            ? `目标状态机：共 ${value.total} 个目标（active ${value.byState?.active ?? 0} / paused ${value.byState?.paused ?? 0} / achieved ${value.byState?.achieved ?? 0} / abandoned ${value.byState?.abandoned ?? 0}）`
            : "目标状态查询未执行（disabled）。",
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const c = cfg();
      if (c.goals?.enabled === false) return { ok: false, total: 0, byState: {}, goals: [] };
      const goals = sortGoals(readGoals());
      const byState = {};
      for (const g of goals) byState[g.state ?? "unknown"] = (byState[g.state ?? "unknown"] ?? 0) + 1;
      return { ok: true, total: goals.length, byState, goals };
    },
  }));

  // ── 收尾评估：每轮对话结束由工程强制触发「有没有值得沉淀」──────────────
  // 记忆的"时机"是基础设施行为，不能赌模型自觉。读已在注入时自动完成；
  // 写与沉淀在这里由代码保证：turn/end 时评估一次，warm 超阈值时自动归档。
  let lastModel = { provider: "", model: "" };
  const collectTurnTranscript = (session) => {
    // 防御性事件获取：新版 DSH Session 契约用 snapshotEvents()（Inspect 形态），
    // 旧版暴露 log / events 字段。兼容两者，取不到就空转（收尾序时账不阻塞主流程）。
    const events =
      typeof session?.snapshotEvents === "function"
        ? session.snapshotEvents()
        : (session?.log ?? session?.events ?? []);
    // 以最后一个 turn/start 为边界，只收集本轮的用户/助手可见消息
    let turnStartSeq = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "turn/start") {
        turnStartSeq = events[i].seq;
        break;
      }
    }
    const lines = [];
    const textOf = (ev) => {
      const blocks =
        ev.type === "assistant/message"
          ? ev.data?.message?.content ?? []
          : ev.data?.content ?? [];
      return blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
    };
    for (const ev of events) {
      if (ev.seq < turnStartSeq) continue;
      if (ev.type === "user/message") {
        // 跳过运行时上下文/插件注入与模型侧注入，只保留真实用户消息
        // （MessageSource.kind 合法枚举：user / plugin / model / tool；runtime-context 不存在）
        const src = ev.data?.source;
        if (src?.kind === "plugin" || src?.kind === "model") continue;
        const t = textOf(ev);
        if (t) lines.push(`用户：${t}`);
      } else if (ev.type === "assistant/message") {
        const t = textOf(ev);
        if (t) lines.push(`助手：${t}`);
      }
    }
    return lines.join("\n");
  };
  const buildAssessmentPrompt = (transcript, warm) => {
    const cap = cfg().memory?.assessment?.maxChars ?? 4000;
    const t = transcript.length > cap ? transcript.slice(0, cap) + "\n…(截断)…" : transcript;
    const warmText = (warm ?? "").trim();
    const warmClean = warmText ? renderWarmEntries(parseWarm(warmText)) : "";
    const warmPart = warmClean ? `\n\n【已有记忆】\n${warmClean.slice(0, 2000)}` : "";
    return `【对话】\n${t}${warmPart}\n\n请全量沉淀对话中的事件/事实/约束（只跳过纯寒暄）。`;
  };
  const callLlmText = async (system, prompt) => {
    const a = cfg().memory?.assessment ?? {};
    if (!llmClient) return "";
    let text = "";
    for await (const chunk of llmClient.stream({
      provider: lastModel.provider,
      model: lastModel.model,
      system,
      messages: [
        {
          id: `linghun-assess-${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: prompt }],
          source: { kind: "plugin", plugin: NS },
        },
      ],
      temperature: a.temperature ?? 0.2,
      maxTokens: a.maxTokens ?? 300,
      purpose: "compaction",
    })) {
      if (chunk.type === "text-delta") text += chunk.text;
    }
    return text.trim();
  };
  const runAssessment = async (session) => {
    try {
      const c = cfg();
      if (c.memory?.enabled === false || c.memory?.assessment?.enabled === false) return;
      if (!lastModel.provider || !lastModel.model) return;
      const transcript = collectTurnTranscript(session);
      if (!transcript.trim()) return;
      const warm = layout.readWarm();
      const prompt = buildAssessmentPrompt(transcript, warm);
      const out = await callLlmText(ASSESS_SYSTEM, prompt);
      const { entries, touches } = parseAssessment(out);
      for (const e of entries) {
        await appendMemoryBlock(e.content, e.kind);
      }
      // 自动时间管理：评估 LLM 判断本轮实际用到了哪些已有记忆 → 自动 touch（读≠用，用到才活跃）
      if (c.memory?.timeWeight !== false && touches.length) {
        for (const ref of touches) {
          await touchWarmAccess(ref);
        }
      }
    } catch {
      // best-effort：评估失败静默跳过，绝不阻塞主流程
    }
  };
  ctx.on("session/event", (session, event) => {
    if (event?.type === "request/header" && event.data?.header?.config) {
      lastModel = {
        provider: event.data.header.config.provider ?? "",
        model: event.data.header.config.model ?? "",
      };
    }
    if (event?.type !== "turn/end") return;
    // 序时账：本轮原始对话全量 append（用户输入 + 助手回答），不筛选不评估
    try {
      const transcript = collectTurnTranscript(session);
      if (transcript) layout.appendJournal(nowStampSec(), transcript);
    } catch {
      // best-effort：journal 写入失败静默跳过，绝不阻塞主流程
    }
    void runAssessment(session);
  });

  // ── 灵魂：读 / 更新自己的灵魂卡（自进化）────────────────────────────────
  ctx.tools.register(defineTool({
    name: "linghun_soul_read",
    description:
      "读取自己的灵魂卡（身份锚点 + 判断纪律）。当你需要回顾「我是谁、我的边界、我的纪律」时使用。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          identity: { type: "string" },
          judgment: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `灵魂卡「${value.name || "未命名"}」：\n\n${value.identity}\n\n${value.judgment}` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const c = cfg();
      const fileText = readCached(identityFile());
      const name = parseName(fileText) || (c.identity?.name ?? "").trim();
      return {
        name,
        identity: resolveIdentity({
          fileText,
          configContent: c.identity?.content,
        }),
        judgment: c.judgment?.enabled === false ? "" : DEFAULT_JUDGMENT,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "linghun_soul_update",
    description:
      "更新自己的灵魂卡：把观察到的稳定特质、价值观、偏好折叠进身份内容（写入人设文件 $DSH_HOME/linghun/identity.md，用户可直接编辑该文件）。这是自我改进的动作——注意保留核心身份骨架，只补充/修订细节。",
    parameters: {
      content: { type: "string", required: true, description: "新的灵魂卡内容（完整替换身份部分，保留核心骨架）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          bytes: { type: "integer" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `灵魂卡已更新（${value.bytes} 字节）。` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("linghun_soul_update: `content` 不能为空");
      const max = cfg().identity?.maxBytes ?? 64 * 1024;
      if (byteLen(content) > max) {
        throw new Error(`linghun_soul_update: 内容超过上限（${max} 字节）`);
      }
      const file = identityFile();
      await ensureParent(file);
      await writeFile(file, content.trimEnd() + "\n", "utf8");
      fileCache.delete(file);
      return { bytes: byteLen(content) };
    },
  }));
}

export { Config, NS, SECTION_IDENTITY, SECTION_JUDGMENT, SECTION_MEMORY, apply, inject, name, parseAssessment };
