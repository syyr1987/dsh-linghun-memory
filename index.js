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
import { basename, dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";


import { MEMORY_DISCIPLINE, COGNITION_CYCLE, PROFILE_DISCIPLINE } from "./identity.js";
import { createMemoryLayout, parseWarm, renderWarmEntries, summarizeWarmForCold, touchWarmAccessText, findWarmEntryRef, replaceWarmEntryText, markWrongWarmEntryText, findNearDuplicateWarm, sortWarmNewestFirst, filterWarmByRef, filterTextByRef, matchRef, tokenizeForSim, buildBm25Stats, bm25Retrieve, parseProfiles, renderProfileIndex, renderProfileFull, upsertProfileSlotText, normalizeSubject, PROFILE_SLOTS, activateWarmUnit, renderEpisodicIndex, parseEpisodicUnit, unitFileName } from "./memory.js";
import { parseGraph, renderGraph, buildGraph, queryGraph, graphFromJson, graphToJson, renderGraphIndex, normalizeSubject as graphNormSubject, unitNodeId, subjectNodeId, profileNodeId, GRAPH_FILE, GRAPH_JSON } from "./graph.js";
import { writeOntologySafe, appendRulesSafe, parseRulesBuckets } from "./ontology.js";
import { parseGoals, serializeGoals, sortGoals, mergeGoalSignal, rankGoalsByTrigger, renderGoalsForInject, GOAL_DISCIPLINE } from "./goal.js";
import { renderMemoryMap, MAP_DISCIPLINE } from "./map.js";

const name = "linghun";
const inject = ["systemPrompt", "tools"];
const NS = "linghun";

// 记忆体线 section 命名空间独立：与旧线 dsh-linghun 的 soul:memory 隔离，
// 两条线并存时 prompt section 不冲突。
const SECTION_MEMORY = "soul:linghun-memory";

const MEMORY_DIR = join("linghun", "memory");
const Config = z.object({
  memory: z.object({
    /** 海马体总开关：false 则记忆完全停用（不读不写不注入）。 */
    enabled: z.boolean().default(true),
    /** 禁用的工具名列表：命中则注册时跳过（如 linghun_memory_read/linghun_graph_query）。
     *  用于评测隔离——设置 assembler + 禁模型阅读记忆工具时，模型只剩作答通道。 */
    disableTools: z.array(z.string()).default([]),
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
    /** 记忆地图（检索图方案，v018 按图回溯回灌 DSH）：写侧机制渲染成四轴导航图注入读侧，
     *  认知主体按图回溯——看图定位（情境/目标/档案轴）→ 沿轴翻 → memory_read/journal 下钻证据。
     *  地图是索引密度（导航不倾倒），细节走已有下钻工具；默认开启，与本体素材注入互补。 */
    map: z.object({
      /** 记忆地图开关：false 则不注入地图段与按图回溯纪律。 */
      enabled: z.boolean().default(true),
      /** 地图注入预算上限（字符）：导航索引不需要大预算，默认 2000。 */
      injectMaxChars: z.number().default(2000),
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

  /** 评测隔离：命中 memory.disableTools 的工具不注册（模型无法调用）。 */
  const regTool = (name, tool) => {
    if ((cfg()?.memory?.disableTools ?? []).includes(name)) return;
    ctx.tools.register(tool);
  };

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
  const layout = createMemoryLayout(memoryDir, readCached);

  // ── v0.3.0 图谱（graph.js）：单元↔画像要素的关系网 ─────────────────
  const graphDir = () => join(resolveDshHome(), "linghun", "graph");
  const graphMdFile = () => join(graphDir(), GRAPH_FILE);
  const graphJsonFile = () => join(graphDir(), GRAPH_JSON);

  /** 读图谱：graph.json 优先，缺失/损坏回退 graph.md 解析。 */
  const readGraph = () => {
    const j = readCached(graphJsonFile());
    if (j) {
      try {
        return JSON.parse(j);
      } catch {
        /* json 损坏回退 md */
      }
    }
    const m = readCached(graphMdFile());
    return m ? parseGraph(m) : null;
  };

  /** 写图谱双格式（md 人读 + json 机器读）。 */
  const writeGraph = async (g) => {
    await ensureParent(graphMdFile());
    await writeFile(graphMdFile(), renderGraph(g), "utf8");
    fileCache.delete(graphMdFile());
    await writeFile(graphJsonFile(), graphToJson(g), "utf8");
    fileCache.delete(graphJsonFile());
  };

  /** 从冷储单元 + 画像文件全量重建图谱（幂等）。 */
  const buildGraphFromFiles = async () => {
    const units = layout.listEpisodic().map((e) => ({
      file: basename(e.file),
      stamp: e.stamp ?? "",
      theme: e.theme ?? "",
      subjects: e.subjects ?? [],
      title: e.title ?? "",
    }));
    const profiles = layout.listProfiles();
    // 画像要素文本 → 边线索：单元内容含画像要素关键词 → supports；单元与要素同主体但内容冲突 → contradicts（由 hint 文件提供）
    const hintEdges = readGraphHints();
    const g = buildGraph({ units, profiles, hintEdges });
    await writeGraph(g);
    return g;
  };

  /** 读取 hint 边文件（graph/hints.json）：手工/模型写进去的 supports/contradicts 线索。
   *  格式：[{from:"U:episodic/x.md", rel:"supports|contradicts", to:"P:Caroline:fact:0"}] */
  const readGraphHints = () => {
    const raw = readCached(join(graphDir(), "hints.json"));
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  /** 追加 hint 边（幂等去重后写回）。 */
  const appendGraphHint = async (from, rel, to) => {
    const file = join(graphDir(), "hints.json");
    const cur = readGraphHints();
    if (cur.some((e) => e.from === from && e.rel === rel && e.to === to)) return;
    await ensureParent(file);
    await writeFile(file, JSON.stringify([...cur, { from, rel, to }], null, 1), "utf8");
    fileCache.delete(file);
  };

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
  /** ACC 模式注入纪律：素材不自动注入，由模型主动获取（agentic RAG 闭环）。 */
  const ACC_DISCIPLINE = `## 主动认知控制（ACC）
当前为 ACC 模式：记忆素材不自动注入，由你主动控制获取。
- 全局状态：linghun_memory_status（暖冷条数/目标主线/已加载领域/可用工具）
- 候选检索：linghun_retrieval_probe（只给候选不注入，挑 1-3 条 linghun_memory_read 精读）
- 领域指导：知识本体按领域组织（linghun_memory_read kind=fact 读分领域主题），跨领域共性规律在规则本体（kind=rule），需要时主动读取
- 数值/时间/文本计算：linghun_math_analyze（calc 表达式 / date 日期间隔 / relative 相对日期换算 / aggregate 聚合 / compare 比较 / text 字数统计）。检索到数值或日期证据后用它算，别硬算、别目测字数
- 目标主线：linghun_goal_get / linghun_goal_state
记忆写入/目标修改仍由系统自动完成，你不需要也不应该改档案。`;

  /** 组装目标主线段（GOAL_DISCIPLINE + 按触发分排序的目标清单）。返回 { goalSection, goals }。 */
  const renderGoalSection = (c) => {
    const goalsCfg = c.goals;
    let goalSection = "";
    let goals = [];
    if (goalsCfg?.enabled !== false && goalsCfg?.inject !== false) {
      try {
        goals = readGoals();
        if (goals.length) {
          goalSection = `${GOAL_DISCIPLINE}\n\n${renderGoalsForInject(goals, "", { maxGoals: goalsCfg?.maxGoals ?? 5 })}`;
        }
      } catch {
        /* 目标档案不可读则跳过目标主线 */
      }
    }
    return { goalSection, goals };
  };

  /** 组装记忆地图段（四轴导航 + 证据层）。返回 mapSection 文本。 */
  const renderMapSection = (c, goals) => {
    const mapCfg = c.memory?.map;
    let mapSection = "";
    if (mapCfg?.enabled !== false) {
      try {
        const rulesPath =
          (c.memory?.rules?.path ?? "").trim() ||
          join(resolveDshHome(), "linghun", "memory", "rules.md");
        mapSection = renderMemoryMap(
          {
            warmEntries: parseWarm(layout.readWarm()),
            coldSummary: layout.readCold(),
            knowledgeOnt: layout.readKnowledgeOntology(),
            memoryOnt: layout.readMemoryOntology(),
            rules: readCached(rulesPath),
            journals: layout.listJournal(),
            episodes: layout.listEpisodic(),
            goals,
          },
          { maxChars: mapCfg?.injectMaxChars ?? 2000 },
        );
      } catch (err) {
        /* 地图渲染失败则跳过地图段（不影响本体素材注入） */
        if (process.env.LINGHUN_MAP_DEBUG === "1") console.error("[map] renderMemoryMap failed:", err);
      }
    }
    return mapSection;
  };

  /** 组装人物画像导航段（主体轴 + 一句话摘要 + 画像纪律）。返回 profileSection 文本。 */
  const renderProfileSection = () => {
    const c = cfg();
    const profileCfg = c.memory?.profiles;
    if (profileCfg?.enabled === false) return "";
    try {
      const profiles = layout.listProfiles();
      if (!profiles.length) return "";
      const indexText = renderProfileIndex(profiles, {
        maxChars: profileCfg?.injectMaxChars ?? 300,
      });
      if (!indexText) return "";
      return `${PROFILE_DISCIPLINE}\n\n${indexText}`;
    } catch (err) {
      if (process.env.LINGHUN_MAP_DEBUG === "1") console.error("[profile] renderProfileSection failed:", err);
      return "";
    }
  };

  /** assembled.md 时效判定：超过 maxAgeMs 未更新即视为失效（assembler 每轮覆写）。 */
  const asmFresh = (p, maxAgeMs) => {
    try {
      return Date.now() - statSync(p).mtimeMs <= maxAgeMs;
    } catch {
      return false;
    }
  };

  const renderMemory = () => {
    const c = cfg();
    if (c.memory?.enabled === false || c.memory?.inject === false) return "";
    // ACC 模式：注入收窄为核心导航层（地图/画像/纪律/目标），素材全部走工具主动获取。
    if (c.memory?.acc?.enabled === true) {
      const { goalSection, goals } = renderGoalSection(c);
      const mapSection = renderMapSection(c, goals);
      const profileSection = renderProfileSection();
      const parts = [];
      if (mapSection) parts.push(mapSection);
      if (profileSection) parts.push(profileSection);
      parts.push(ACC_DISCIPLINE);
      if (goalSection) parts.push(goalSection);
      const discipline = mapSection
        ? `${MAP_DISCIPLINE}\n\n${MEMORY_DISCIPLINE}\n\n${COGNITION_CYCLE}`
        : `${MEMORY_DISCIPLINE}\n\n${COGNITION_CYCLE}`;
      return `${discipline}\n\n${parts.join("\n\n")}`;
    }
    // 组装模式（提取侧子智能体）：配置 injectPath / 环境变量 / 默认约定路径（与 assembler 侧零配置联动）
    const asmPath =
      (c.memory?.assembler?.injectPath ?? "").trim() ||
      process.env.LINGHUN_MEMORY_OVERRIDE ||
      join(resolveDshHome(), "linghun", "memory", "assembled.md");
    // 2026-11-02 修：assembled.md 由 dsh-linghun-assembler 每轮 query 覆写。
    // 未装 assembler 的 profile（如 lanke）没人刷新它，读到的是历史残留
    // ——实测 10-29 的 corpus_search 单步任务条目被当记忆注入 4 天，
    // 纪律段（MEMORY_DISCIPLINE/COGNITION_CYCLE/MAP_DISCIPLINE/GOAL_DISCIPLINE）
    // 与 warm 全被跳过。加时效闸：超期视为失效，回退纪律段 + warm 注入。
    const asmMaxAge = c.memory?.assembler?.maxAgeMs ?? 600000;
    if (asmPath && asmFresh(asmPath, asmMaxAge)) {
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
    const { goalSection, goals } = renderGoalSection(c);
    // 记忆地图（检索图方案）：写侧机制导航图（四轴+证据层），读侧按图回溯
    const mapSection = renderMapSection(c, goals);
    // 人物画像（主体轴）：有哪些主体 + 各画像一句话摘要，先画像后下钻
    const profileSection = renderProfileSection();
    const parts = [];
    if (mapSection) parts.push(mapSection);
    if (profileSection) parts.push(profileSection);
    if (rendered) parts.push(rendered);
    if (goalSection) parts.push(goalSection);
    if (!parts.length) return "";
    const discipline = mapSection
      ? `${MAP_DISCIPLINE}\n\n${MEMORY_DISCIPLINE}\n\n${COGNITION_CYCLE}`
      : `${MEMORY_DISCIPLINE}\n\n${COGNITION_CYCLE}`;
    return `${discipline}\n\n${parts.join("\n\n")}`;
  };

  const sectionDisposers = { memory: null };
  function registerSections() {
    for (const key of Object.keys(sectionDisposers)) {
      if (sectionDisposers[key]) {
        sectionDisposers[key]();
        sectionDisposers[key] = null;
      }
    }
    // 记忆体线只注册记忆 section（soul:linghun-memory）。
    // 收口者（灵魂卡/判断纪律）回到 linghun 侧（dsh-linghun 收口者线）提供，
    // 记忆体插件不再注入身份/判断——回归记忆定位（v0.4.0 架构调整）。
    sectionDisposers.memory = ctx.systemPrompt.section({
      name: SECTION_MEMORY,
      order: cfg().memory?.order ?? 0.5,
      text: renderMemory,
      interpolate: false,
    });
  }

  ctx.effect(() => {
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
    // 写侧相对时间锚定（v0.4.3）：today/by Friday/EOD 之类就地标成 [=YYYY-MM-DD]，读侧不再重算。
    content = anchorRelativeDatesInText(content, stamp.slice(0, 10));
    const kindNorm = normalizeKind(kind);
    const conf = ["high", "medium", "low"].includes(opts.confidence) ? opts.confidence : "medium";
    const err = validateEntryFormat(kindNorm, content);
    if (err) {
      throw new Error(`linghun_memory_append: ${err}`);
    }
    const subjTag = opts.subject ? ` @${normalizeSubject(opts.subject)}` : "";
    const block = `\n## ${stamp} [${kindNorm}] ${conf}${subjTag}\n\n${content}\n<!-- last_access: ${stamp} -->\n`;
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
        const highBlock = `\n## ${stamp} [${kindNorm}] high${subjTag}\n\n${content}\n<!-- last_access: ${stamp} -->\n`;
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

  regTool('linghun_memory_append', defineTool({
    name: "linghun_memory_append",
    description:
      "把一条带时间戳的**结构化认知条目**记进海马体暖态工位（warm.md），不是写叙述摘要。\n\n类别（kind）三型：\n- event（事件=记忆本体）：`主语 | 动作 | 宾语 | 关联实体 | 细节`——记录发生了什么；时间由条目自带。\n- fact（事实=知识本体）：`实体 | 属性 | 值 | 来源#`——记录是什么/多少，值必须精确（数字/日期/版本），来源指对话批次/事件。\n- rule（规则=规则本体）：一句可执行纪律（决策/偏好/经验），不要用结构行。\n\n一条目一事实，不要一次性倾倒。积累多了用 linghun_memory_consolidate 沉淀（按类别移出到本体档案：event→记忆本体时间线、fact 高置信→知识本体、rule→规则本体）。\n\n置信度（confidence，必填）：high=用户直接说/已验证；medium=推断；low=存疑/猜测/过期待验。**每条都要显式判断档位，不许无脑填 medium**——high 条目注入时优先保留、永不因久未使用被挤出，low 条目带【低置信·需验证】标记。\n\n主体（subject）：建议每条都判断，用户本人的信息标 owner，助手侧约定标 assistant，第三方标其名字。\n\n更新（update）：发现旧条目已被推翻/变更时，传 linghun_memory_read 返回的编号（如 [3]）或该条目内容片段——旧条目标记为 wrong（被翻转，不再注入），新内容另起一条（默认高置信）。近似重复内容会自动合并不追加。\n\n**只记用户侧信息**：记用户说过什么、用户的事实、用户的规则。助手自己做了什么（采取了什么动作、检索了什么、给了什么判断）不入 warm——那是运行痕迹，写 journal。混进 warm 会让后续会话把自己的旧动作当成用户说过的话，向用户复述内部调度细节。",
    parameters: {
      kind: {
        type: "string",
        enum: ["event", "fact", "rule"],
        description: "条目类别（写侧协议三型）：event（事件，结构行 `主语|动作|宾语|关联|细节`）/ fact（事实，结构行 `实体|属性|值|来源#`，值精确）/ rule（规则，一句可执行纪律），默认 fact",
      },
      content: { type: "string", required: true, description: "要记住的结构化内容：event/fact 用 `|` 分隔的结构行（见 kind 说明），rule 用一句可执行纪律。不要写叙述段落" },
      confidence: {
        type: "string",
        required: true,
        enum: ["high", "medium", "low"],
        description: "置信度，**必填，必须显式判断**。high=用户直接陈述的事实/决定，或已用工具、原文、代码验证过；medium=从上下文推断得出、用户未直接确认；low=猜测/存疑/含时效性但未复核。宁可填 medium 也不要谎报 high；但不要因为省事一律 medium——注入时 high 优先保留不被挤出、low 带【低置信·需验证】标记，档位错了后续引用就会出错",
      },
      update: {
        type: "string",
        description: "可选。要翻转/覆盖的旧条目：传 linghun_memory_read 返回的编号（如 [3]）或内容片段。命中后旧条目标记为 wrong（被翻转），新内容另起一条（默认高置信）。用于旧事实被推翻、决策变更、偏好改变等场景",
      },
      subject: {
        type: "string",
        description: "主体标签，**建议每一条都判断一次**。这条信息属于谁：用户本人的事实/偏好/决定填 owner；助手侧约定填 assistant；涉及具体第三方填其名字（如 张三）。标题行会带 @主体，可按主体过滤与下钻；不填则该条只能全局检索，无法按主体归集",
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
      const subject = String(args.subject ?? "").trim() || undefined;
      return appendMemoryBlock(content, kind, { confidence, update, subject });
    },
    presentCall: (args) => ({ card: "generic", title: "海马体·记录", kind: "other", rawInput: args }),
  }));

  regTool('linghun_memory_read', defineTool({
    name: "linghun_memory_read",
    description:
      "读取记忆。kind 可选：event→事件时间线、fact→知识本体（精确值）、rule→规则本体（纪律）、不传→综合视图。\n\nv0.3.0 检索路径（四级）：linghun_profile_get（画像要素）→ linghun_graph_query（图谱定位相关单元）→ linghun_memory_read（unit=单元文件精读冷储原文）→ 暖态自动激活（命中原文复制到 warm.md 工作记忆）。\n\n参数：ref 关键词定向过滤；unit=冷储单元文件名（如 2023-05-03_session_summer.md）直接读原文并复制到暖态；full=true 返回完整内容。多维筛选：confidence（high/medium/low/wrong 多选）、subject（主体）、kinds（event/fact/rule 多选），可与 ref 叠加。读≠用：实际派上用场的条目用 linghun_memory_touch 标记。",
    parameters: {
      kind: {
        type: "string",
        enum: ["event", "fact", "rule"],
        description: "可选。只读某个本体档案：event=记忆本体（事件时间线）/ fact=知识本体（精确值）/ rule=规则本体（纪律）；不传则读综合视图（cold+warm+图谱索引）",
      },
      ref: {
        type: "string",
        description: "可选。关键词过滤——只返回命中该关键词的条目/行（多词空格分隔=任一命中即可）。大记忆量下的定向读取：优先用它精确定位（如传人名/项目名/时间词）",
      },
      unit: {
        type: "string",
        description: "可选。冷储原文单元文件名（episodic/ 下的 md，不含路径前缀，如 2023-05-03_session_summer.md）。读取该单元全文原文并复制到暖态（工作记忆激活）；不存在返回提示",
      },
      full: {
        type: "boolean",
        description: "true 返回完整内容（可能很长）；false 返回注入摘要，默认 false",
      },
      confidence: {
        type: "array",
        items: { type: "string", enum: ["high", "medium", "low", "wrong"] },
        description: "可选。按置信度筛选（可多选）。high=用户直接说/已验证、medium=推断、low=存疑待验、wrong=已翻转。默认读全部（wrong 带【已翻转·勿引用】标记）；传本参数后只返回所选档位——[\"high\"] 只看已验证结论，[\"wrong\"] 只看被推翻的旧条目",
      },
      subject: {
        type: "string",
        description: "可选。按主体筛选（条目头 `@主体` 标记，如 owner / User_5）。子串匹配，只作用于暖态条目",
      },
      kinds: {
        type: "array",
        items: { type: "string", enum: ["event", "fact", "rule"] },
        description: "可选。按类别筛选暖态条目（可多选）。注意与 kind 的区别：kind 是直读某个本体档案全文，kinds 是在暖态/综合视图内按类别筛",
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
      const ref = String(args?.ref ?? "").trim();
      // v0.3.0：unit 精读冷储原文 + 复制暖态（工作记忆激活）
      const unitName = String(args?.unit ?? "").trim();
      if (unitName) {
        const unitRaw = layout.readEpisodicUnit(unitName.replace(/\.md$/, ""));
        if (!unitRaw.trim()) {
          return { exists: false, bytes: 0, content: `冷储中不存在单元「${unitName}」。可用 linghun_graph_query 或 linghun_memory_status 查看单元列表。` };
        }
        const parsed = parseEpisodicUnit(unitRaw);
        // 复制暖态：冷储不动，命中激活
        const warmFile = layout.warmFile();
        const warmCur = readCached(warmFile) ?? "";
        const nextWarm = activateWarmUnit(warmCur, {
          stamp: parsed.stamp || nowStamp(),
          theme: parsed.theme,
          subject: parsed.subjects?.[0],
          unitFile: unitName.replace(/\.md$/, ""),
          content: parsed.content,
          conf: "high",
        });
        if (nextWarm !== warmCur) {
          await ensureParent(warmFile);
          await writeFile(warmFile, nextWarm, "utf8");
          fileCache.delete(warmFile);
        }
        const out = useFull
          ? `## 原文单元：${unitName}\n\n${parsed.content}`
          : `## 原文单元：${unitName}${parsed.theme ? `（${parsed.theme}）` : ""}\n\n${parsed.content.slice(0, max)}\n${parsed.content.length > max ? `…(截断：单元原文 ${byteLen(parsed.content)} 字符)` : ""}`;
        return { exists: true, bytes: byteLen(parsed.content), content: out };
      }
      // 统一截断：提示模型最新条目已前置、可用 ref 定向过滤（v0.1.8）
      const clip = (text) => {
        const limit = useFull ? 50000 : max;
        if (text.length <= limit) return { content: text, truncated: false };
        return {
          content: `${text.slice(0, limit)}\n…(截断：全文 ${byteLen(text)} 字节，仅显示前 ${limit} 字符。近期条目已按最新优先排列；传 ref 关键词可定向过滤读取)…`,
          truncated: true,
        };
      };
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
        const filtered = ref ? filterTextByRef(raw, ref) : raw;
        if (!filtered.trim()) {
          return { exists: true, bytes: 0, content: `（本体档案中无命中「${ref}」的条目）` };
        }
        const out = clip(filtered);
        return { exists: true, bytes: byteLen(filtered), content: out.content };
      }
      const coldRaw = layout.readCold();
      // ref 模式下冷储摘要同样参与过滤：cold 可达 15KB+，全量放入会把过滤结果
      // 挤出截断窗口（0.1.8-alpha.1 实测发现的真 bug），定向读取必须全段过滤（v0.1.8）
      const cold = ref ? filterTextByRef(coldRaw, ref) : coldRaw;
      const warmEntries = parseWarm(layout.readWarm());
      // 多维筛选（v0.4.6）：ref 关键词 ∩ 置信度 ∩ 主体 ∩ 类别，逐层收窄
      let kept = ref ? filterWarmByRef(warmEntries, ref) : warmEntries;
      const CONF_OK = ["high", "medium", "low", "wrong"];
      const confFilter = Array.isArray(args?.confidence)
        ? args.confidence.map((x) => String(x).trim().toLowerCase()).filter((x) => CONF_OK.includes(x))
        : [];
      if (confFilter.length) kept = kept.filter((e) => confFilter.includes(e.confidence));
      const subjFilter = String(args?.subject ?? "").trim().toLowerCase();
      if (subjFilter) kept = kept.filter((e) => String(e.subject ?? "").toLowerCase().includes(subjFilter));
      const KIND_OK = ["event", "fact", "rule"];
      const kindsFilter = Array.isArray(args?.kinds)
        ? args.kinds.map((x) => String(x).trim().toLowerCase()).filter((x) => KIND_OK.includes(x))
        : [];
      if (kindsFilter.length) kept = kept.filter((e) => kindsFilter.includes(e.kind));
      // 筛选条件给了却一条没剩：说清是筛空的，不伪装成「无记忆」
      const filteredEmpty = !kept.length && (confFilter.length > 0 || !!subjFilter || kindsFilter.length > 0);
      // 暖态最新优先：写入序倒序渲染——大暖态被截断时砍最旧、保最新，编号 [n] 仍为文件序（v0.1.8）
      const warm = renderWarmEntries(sortWarmNewestFirst(kept), {
        numbered: true,
        includeWrong: true,
      });
      const episodes = layout.listEpisodic();
      const parts = [];
      if (cold.trim()) parts.push(cold.trim());
      if (warm.trim()) parts.push(`## 近期记忆 / Recent\n\n${warm.trim()}`);
      // v0.3.0：图谱相关单元（ref 命中主体/要素时，展示关联单元供精读）
      let graphHits = [];
      if (ref) {
        const g = readGraph();
        if (g) {
          graphHits = queryGraph(g, ref, { limit: 5 });
          if (graphHits.length) {
            const unitRows = graphHits
              .map((h) => `- ${h.file}${h.rels?.length ? `（${h.rels.join("；")}）` : ""}`)
              .join("\n");
            parts.push(`## 图谱关联单元 / Graph\n${unitRows}\n> 用 linghun_memory_read unit=<文件名> 精读原文。`);
          }
        }
      }
      if (episodes.length) {
        let rows = episodes
          .map((e) => `- ${e.name}${e.title ? ` — ${e.title}` : ""}`)
          .filter((r) => !ref || matchRef(r, ref));
        if (rows.length) parts.push(`## 归档索引 / Archive\n${rows.join("\n")}`);
      }
      const team = readTeamLedger();
      if (team) parts.push(team);
      const full = parts.join("\n\n");
      if (!full.trim()) {
        if (filteredEmpty) {
          const f = [
            confFilter.length ? `置信度=${confFilter.join("/")}` : "",
            subjFilter ? `主体=${subjFilter}` : "",
            kindsFilter.length ? `类别=${kindsFilter.join("/")}` : "",
          ]
            .filter(Boolean)
            .join(" + ");
          return {
            exists: true,
            bytes: 0,
            content: `（暖态无满足「${f}」的条目。可用 linghun_memory_status 看整体分布，或去掉筛选条件重读）`,
          };
        }
        if (ref) return { exists: true, bytes: 0, content: `（海马体中无命中「${ref}」的条目）` };
        return { exists: false, bytes: 0, content: "" };
      }
      const out = clip(full);
      return { exists: true, bytes: byteLen(full), content: out.content };
    },
  }));

  regTool('linghun_unit_append', defineTool({
    name: "linghun_unit_append",
    description:
      "把一段**原始对话原文**落成冷储记忆单元（episodic/<日期>_session_<主题>.md，一 session 一文件），原文一字不动；随后建图谱边：单元--mentions-->主体。\n\n这是 v0.3.0 记忆主写路径：记忆单元=原文，不做结构化加工（不拆 fact/event/rule、不写置信度摘要）。主体（subjects）指该段对话涉及的人（说话双方/被谈论的第三方），图谱据此把单元挂到主体轴上。\n\n若该段原文**印证/反驳**某画像要素，用 supports/contradicts 参数显式建边：传 linghun_profile_get 可见的画像要素内容片段（如「职业为金融分析师」），图谱生成 单元--supports-->画像要素 或 单元--contradicts-->画像要素。\n\n已存在的同名单元不覆盖（冷储原文不动档案）。",
    parameters: {
      stamp: { type: "string", description: "可选。单元时间戳（ISO，如 2023-05-03T14:00:00 或 2023-05-03）；缺省用当前时间。文件名以日期开头" },
      theme: { type: "string", required: true, description: "单元主题（短词，如 summer_trip / job_search / andrew_promotion），用于文件名 slug 与索引" },
      content: { type: "string", required: true, description: "该 session 的完整原始对话原文（说话人+文本，逐条保留，一字不改）" },
      subjects: {
        type: "array",
        items: { type: "string" },
        description: "可选。该单元涉及的主体名单（说话双方/被谈论者），如 [\"Caroline\", \"Melanie\"]。图谱据此建 单元--mentions-->主体 边",
      },
      supports: {
        type: "array",
        items: { type: "string" },
        description: "可选。被本单元原文**印证**的画像要素内容片段列表（须与 linghun_profile_get 中的条目文本一致，如 \"职业为金融分析师\"）。图谱建 单元--supports-->画像要素 边",
      },
      contradicts: {
        type: "array",
        items: { type: "string" },
        description: "可选。被本单元原文**反驳/更新**的画像要素内容片段列表。图谱建 单元--contradicts-->画像要素 边",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          created: { type: "boolean" },
          file: { type: "string" },
          bytes: { type: "integer" },
          edges: { type: "integer" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.created
            ? `原文单元已落冷储：${value.file}（${value.bytes} 字节，建边 ${value.edges} 条）。`
            : `单元已存在（冷储不动档案）：${value.file}（建边 ${value.edges} 条）。`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("linghun_unit_append: `content` 不能为空");
      const theme = String(args.theme ?? "").trim();
      if (!theme) throw new Error("linghun_unit_append: `theme` 不能为空");
      const subjects = Array.isArray(args.subjects) ? args.subjects.map((s) => String(s).trim()).filter(Boolean) : [];
      const stamp = String(args.stamp ?? "").trim() || nowStamp();
      const unit = { stamp, theme, subjects, content };
      const res = layout.appendEpisodicUnit(unit);
      if (!res) return { created: false, file: "", bytes: 0, edges: 0 };
      const file = res.name;
      // 建边：U--mentions-->S
      let edges = 0;
      const seenS = new Set();
      for (const s of subjects) {
        const key = normalizeSubject(s);
        if (seenS.has(key) || !key) continue;
        seenS.add(key);
        await appendGraphHint(unitNodeId(file), "mentions", subjectNodeId(s));
        edges++;
      }
      // 建边：U--supports/contradicts-->P（画像要素按文本定位）
      const profiles = layout.listProfiles();
      const byText = new Map();
      for (const p of profiles) {
        const slots = p.slots ?? {};
        for (const slot of Object.keys(slots)) {
          (slots[slot] ?? []).forEach((it, i) => {
            byText.set(normalizeForMatch(String(it?.text ?? "")), profileNodeId(p.subject, slot, i));
          });
        }
      }
      const linkByText = async (items, rel) => {
        for (const item of Array.isArray(items) ? items : []) {
          const t = String(item ?? "").trim();
          if (!t) continue;
          const key = normalizeForMatch(t);
          const pId = byText.get(key) || [...byText.keys()].find((k) => k.includes(normalizeForMatch(t)) || normalizeForMatch(t).includes(k));
          if (pId) {
            await appendGraphHint(unitNodeId(file), rel, pId);
            edges++;
          }
        }
      };
      await linkByText(args.supports, "supports");
      await linkByText(args.contradicts, "contradicts");
      return { created: res.created, file, bytes: byteLen(content), edges };
    },
    presentCall: (args) => ({ card: "generic", title: "冷储·原文单元", kind: "other", rawInput: args }),
  }));

  regTool('linghun_graph_build', defineTool({
    name: "linghun_graph_build",
    description:
      "全量重建记忆图谱（幂等，可随时重跑）：扫描冷储单元（episodic/）+ 人物画像（profiles/）+ 边线索（graph/hints.json），重建 graph.md + graph.json。\n\n图谱把记忆单元与人物画像要素连起来：单元--mentions-->主体、主体--has_profile-->画像要素、单元--supports/contradicts-->画像要素。重建不会改动冷储原文。写完返回图谱速览。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          summary: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `记忆图谱已重建：\n${value.summary}` : "图谱重建失败。" },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const g = await buildGraphFromFiles();
      if (!g) return { ok: false, summary: "" };
      return { ok: true, summary: renderGraphIndex(g, { maxChars: 600 }) };
    },
    presentCall: (_args) => ({ card: "generic", title: "图谱·重建", kind: "other", rawInput: {} }),
  }));

  regTool('linghun_graph_query', defineTool({
    name: "linghun_graph_query",
    description:
      "图谱查询：输入主体名（如 Caroline / Andrew）或画像要素关键词，返回**关联的冷储原文单元**列表（含 关联关系与边类型）。图谱是联想网络——从主体/要素出发找最相关的单元，再用 linghun_memory_read unit=<文件名> 精读原文。\n\n典型用法：问「Andrew 的职业」→ graph_query Andrew → 得到 mentions/supports 边关联的单元 → memory_read unit=... 读原文确认。",
    parameters: {
      query: { type: "string", required: true, description: "主体名或画像要素关键词（如 Andrew / 职业 / summer trip）" },
      limit: { type: "integer", description: "返回单元数上限，默认 20" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          content: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? value.content : "图谱查询失败。" },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, content: "query 不能为空" };
      const g = readGraph();
      if (!g) return { ok: false, content: "图谱尚未建立，先执行 linghun_graph_build。" };
      const hits = queryGraph(g, query, { limit: args.limit });
      if (!hits.length) {
        return { ok: true, content: `图谱中无命中「${query}」的单元。可用 linghun_graph_build 重建或用 linghun_memory_read ref=${query} 关键词检索。` };
      }
      const rows = hits
        .map((h, i) => `- ${i + 1}. ${h.file}${h.rels?.length ? `（${h.rels.join("；")}）` : ""}`)
        .join("\n");
      return { ok: true, content: `图谱命中「${query}」相关单元 ${hits.length} 个：\n${rows}\n> 用 linghun_memory_read unit=<文件名> 精读原文。` };
    },
    presentCall: (args) => ({ card: "generic", title: "图谱·查询", kind: "other", rawInput: args }),
  }));

  regTool('linghun_memory_journal_read', defineTool({
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

  regTool('linghun_memory_touch', defineTool({
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

  regTool('linghun_memory_consolidate', defineTool({
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

  regTool('linghun_memory_project', defineTool({
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

  regTool('linghun_memory_rules', defineTool({
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

  // ── 本体装配（DSH 本体分工定案：存储合并资源池 memory 管、使用归 linghun 收口者）────
  regTool('linghun_ontology_assemble', defineTool({
    name: "linghun_ontology_assemble",
    description:
      "本体装配（收口者的上下文工程）：读取本体资源池（知识本体 knowledge_ontology.md + 规则本体 rules.md 合并存管、只读索引），按 query 命中主题/桶，装配本轮所需的 知识+规则 素材块。ask 前调用，把命中本体注入上下文作为收口判断的上下文素材（不是判定本身）：知识本体=精确值（回答「是什么/多少」），规则本体=行为纪律（回答「该怎么做」）。同主题/签名桶自动聚合；未命中时返回资源池索引供定位。query 留空仅返回资源池索引。",
    parameters: {
      query: {
        type: "string",
        description: "本轮任务/问题描述，用于命中知识本体主题与规则本体桶/节点（如「悖论处置」「评测纪律」「m401 评测」）；留空返回资源池索引",
      },
      maxHits: {
        type: "number",
        description: "每个分区最多返回的命中块数，默认 3",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          section: { type: "string" },
          hits: { type: "array", items: { type: "string" } },
          text: { type: "string" },
          total: {
            type: "object",
            additionalProperties: false,
            properties: {
              knowledge: {
                type: "object",
                additionalProperties: false,
                properties: {
                  file: { type: "string" },
                  themes: { type: "array", items: { type: "string" } },
                  entries: { type: "number" },
                },
              },
              rules: {
                type: "object",
                additionalProperties: false,
                properties: {
                  file: { type: "string" },
                  themes: { type: "array", items: { type: "string" } },
                  entries: { type: "number" },
                },
              },
            },
          },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `本体装配完成：${value.section}${value.hits.length ? `（命中 ${value.hits.length} 块）` : "（无命中，返回资源池索引）"}` : `本体装配失败：${value.reason ?? "未知原因"}` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const q = String(args?.query ?? "").trim();
      const maxHits = Math.max(1, Math.floor(Number(args?.maxHits) || 3));
      const total = layout.listOntologyPool();
      if (!q) return { ok: true, section: "none", hits: [], text: "", total };
      try {
        // query 分词（空白/标点切，取长度 >=2 的词）
        const words = q.split(/[\s,，。;；:：、|/]+/).filter((w) => w.length >= 2);
        const hitWords = (text) => words.some((w) => text.includes(w));
        const parts = [];
        const hits = [];
        // 知识本体：按 ## 主题块切分，块头命中 → 整块装配
        const ontK = layout.readKnowledgeOntology();
        const kBlocks = String(ontK ?? "").split(/^(?=##\s)/m).filter((b) => b.trim());
        const kHit = kBlocks.filter((b) => hitWords((b.split("\n", 1)[0] ?? "") + "\n" + b)).slice(0, maxHits);
        if (kHit.length) {
          hits.push(...kHit.map((b) => `knowledge:${(b.split("\n", 1)[0] ?? "").trim()}`));
          parts.push(`## 知识本体命中 / Knowledge\n${kHit.join("\n\n").trim()}`);
        }
        // 规则本体：parseRulesBuckets 解析桶/节点，桶名或桶体命中 → 装配
        const rulesPath = join(memoryDir(), "rules.md");
        const rulesText = readCached(rulesPath);
        let rHit = [];
        if (rulesText) {
          const rBuckets = parseRulesBuckets(rulesText);
          rHit = rBuckets.filter((b) => hitWords(`${b.name} ${b.header} ${b.body}`)).slice(0, maxHits);
          if (rHit.length) {
            hits.push(...rHit.map((b) => `rules:${b.name}`));
            parts.push(`## 规则本体命中 / Rules\n${rHit.map((b) => `${b.header}\n${b.body}`.trim()).join("\n\n")}`);
          }
        }
        const section = kHit.length && rHit.length ? "both" : kHit.length ? "knowledge" : rHit.length ? "rules" : "none";
        return { ok: true, section, hits, text: parts.join("\n\n"), total };
      } catch (err) {
        return { ok: false, section: "none", hits: [], text: "", total, reason: String(err?.message ?? err) };
      }
    },
  }));

  // ── 目标系统：get（残差触发检索）/ update（写侧信号合并）/ state（状态查询）────
  regTool('linghun_goal_get', defineTool({
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

  regTool('linghun_goal_update', defineTool({
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

  regTool('linghun_goal_state', defineTool({
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

  // ── 人物画像层（v0.2.1）：画像=记忆的第一索引键（主体轴）────────────────
  regTool('linghun_profile_update', defineTool({
    name: "linghun_profile_update",
    description:
      "向指定主体的画像槽位写入/更新一条要点。画像按主体分家（owner=你 / assistant=我 / 第三方=他），是记忆的第一索引键；六槽：fact（是什么）/ state（在忙什么）/ goal（想要什么）/ value（底线）/ causal（来龙去脉）/ preference（偏好）。\n\n每条记忆都该有归属主体（谁说的/关于谁/对谁说的）；画像由系统自动沉淀，模型读到新事实后用本工具更新对应槽位，不要整段改写档案。更新（update）：传 linghun_profile_get 返回的条目内容片段，命中后旧条目标注已更新，新要点另起一条。",
    parameters: {
      subject: { type: "string", required: true, description: "主体（画像主键）：owner / assistant / 第三方名字" },
      slot: {
        type: "string",
        enum: ["fact", "state", "goal", "value", "causal", "preference"],
        description: "画像槽位：fact（是什么）/ state（在忙什么）/ goal（想要什么）/ value（底线）/ causal（来龙去脉）/ preference（偏好）",
      },
      content: { type: "string", required: true, description: "要点内容（一句话，精炼）" },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "置信度：high（用户直接说/已验证）/ medium（推断，默认）/ low（存疑/猜测/过期待验）",
      },
      update: {
        type: "string",
        description: "可选。要更新的旧要点内容片段：命中后旧条目标注 ⚠️ 已更新，新要点另起一条",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          subject: { type: "string" },
          slot: { type: "string" },
          mode: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok
            ? `画像「${value.subject}」· ${value.slot} 已更新（${value.mode}）。`
            : `画像更新失败。`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const subject = String(args.subject ?? "").trim();
      if (!subject) throw new Error("linghun_profile_update: `subject` 不能为空");
      const slot = String(args.slot ?? "").trim() || "fact";
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("linghun_profile_update: `content` 不能为空");
      const confidence = ["high", "medium", "low"].includes(args.confidence) ? args.confidence : "medium";
      const update = String(args.update ?? "").trim() || undefined;
      const stamp = nowStamp();
      const file = layout.profilesDir() + `/${normalizeSubject(subject)}.md`;
      const current = readCached(file) ?? "";
      const next = upsertProfileSlotText(current, slot, `[${confidence}] ${content}`, update, stamp);
      if (next === null) throw new Error("linghun_profile_update: content 为空");
      await ensureParent(file);
      await writeFile(file, next, "utf8");
      fileCache.delete(file);
      return { ok: true, subject: normalizeSubject(subject), slot, mode: "upsert" };
    },
    presentCall: (args) => ({ card: "generic", title: "画像·沉淀", kind: "other", rawInput: args }),
  }));

  regTool('linghun_profile_get', defineTool({
    name: "linghun_profile_get",
    description:
      "读指定主体的画像（六槽全文或指定槽）。**画像=路标**：只提供身份/状态/价值观等定位线索，不是答案本身。要事件细节、原话、时间线，必须继续 linghun_graph_query <主体> 定位原文单元 → linghun_memory_read unit=<单元文件> 精读原文确认；画像条目带 (session N) 标注的，直接读对应单元。禁止把画像条目当答案直接引用。",
    parameters: {
      subject: { type: "string", required: true, description: "主体（画像主键）：owner / assistant / 第三方名字" },
      slots: {
        type: "array",
        items: { type: "string" },
        description: "可选。要读的槽位子集（默认全部六槽）：fact/state/goal/value/causal/preference",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string" },
          text: { type: "string" },
          slots: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.text || `画像「${value.subject}」暂无内容，可用 linghun_profile_update 沉淀。`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subject = String(args.subject ?? "").trim();
      if (!subject) throw new Error("linghun_profile_get: `subject` 不能为空");
      const file = layout.profilesDir() + `/${normalizeSubject(subject)}.md`;
      const current = readCached(file) ?? "";
      const profile = parseProfiles(current) ?? { subject: normalizeSubject(subject), summary: "", slots: {} };
      const slots = Array.isArray(args.slots) ? args.slots.map((s) => String(s)) : undefined;
      const text = renderProfileFull(profile, { slots });
      const guide =
        "\n\n> 画像=路标：以上只是定位线索。要事件细节/原话/时间线：① linghun_graph_query <主体名> 定位相关原文单元 → ② linghun_memory_read unit=<单元文件> 精读原文确认。画像条目带 (session N) 的直接读对应单元。不要把画像条目当答案直接引用。";
      return { subject: normalizeSubject(subject), text: text + guide, slots: slots ?? PROFILE_SLOTS };
    },
    presentCall: (args) => ({ card: "generic", title: "画像·读取", kind: "other", rawInput: args }),
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

  const firstLine = (text, cap) => {
    const lines = String(text ?? "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    // 跳过 markdown 标题行（## 块头），取正文首行作为摘要；无正文时退回首行
    const line = lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "";
    return line.length > cap ? `${line.slice(0, cap)}…` : line;
  };
  /** 收集 probe 候选池：暖态条目 + 冷储块 + 三本体档案块 + 规则行。 */
  const collectProbeCandidates = () => {
    const c = cfg();
    const out = [];
    for (const e of parseWarm(layout.readWarm())) {
      out.push({
        block: e.block,
        source: "warm",
        anchor: `[${(typeof e.idx === "number" ? e.idx : 0) + 1}]`,
        lastAccess: e.lastAccess ?? "",
        confidence: e.confidence,
        kind: e.kind,
      });
    }
    for (const b of layout.readCold().split(/\n(?=## )/).map((x) => x.trim()).filter(Boolean)) {
      out.push({ block: b, source: "cold", anchor: firstLine(b, 60), lastAccess: "", confidence: "", kind: "" });
    }
    for (const [source, raw] of [
      ["fact", layout.readKnowledgeOntology()],
      ["event", layout.readMemoryOntology()],
    ]) {
      for (const b of raw.split(/\n(?=## )/).map((x) => x.trim()).filter(Boolean)) {
        out.push({ block: b, source, anchor: firstLine(b, 60), lastAccess: "", confidence: "", kind: source });
      }
    }
    const rulesPath =
      (c.memory?.rules?.path ?? "").trim() ||
      join(resolveDshHome(), "linghun", "memory", "rules.md");
    let rulesText = "";
    try {
      rulesText = readFileSync(rulesPath, "utf8");
    } catch {
      /* 无规则文件则跳过 */
    }
    for (const line of rulesText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      out.push({ block: line, source: "rule", anchor: firstLine(line, 60), lastAccess: "", confidence: "", kind: "rule" });
    }
    return out;
  };

  regTool('linghun_retrieval_probe', defineTool({
    name: "linghun_retrieval_probe",
    description:
      "主动检索记忆候选（ACC 核心工具）：对暖态/冷储/三本体档案（知识/事件/规则）做 BM25 打分检索，返回候选列表（来源/锚点/分数/摘要），不注入正文。模型据此挑 1-3 条用 linghun_memory_read 精读——检索决定权在模型，不在自动注入。",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "检索意图（描述要找什么，如'用户偏好什么沟通风格'），支持换词面",
      },
      ref: {
        type: "string",
        description: "可选。定向关键词（多词空格分隔=任一命中，大小写不限）；传专名/项目名/时间词可精确过滤候选",
      },
      top_k: {
        type: "number",
        description: "返回候选数，默认 8，上限 20",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          query: { type: "string" },
          total_candidates: { type: "number" },
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                rank: { type: "number" },
                source: { type: "string" },
                anchor: { type: "string" },
                title: { type: "string" },
                score: { type: "number" },
                confidence: { type: "string" },
                last_access: { type: "string" },
                read_hint: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: "候选检索未执行（disabled）。" }];
        if (!value.results?.length) {
          return [{ type: "text", text: `候选检索无命中：${value.query}（候选池 ${value.total_candidates} 条）` }];
        }
        const lines = [`候选检索：${value.query}（候选池 ${value.total_candidates} 条，返回 ${value.results.length}）`];
        for (const r of value.results) {
          lines.push(`${r.rank}. [${r.source}${r.anchor ? ` ${r.anchor}` : ""}] ${r.title}${r.confidence === "low" ? " 【低置信】" : ""}（score ${typeof r.score === "number" ? r.score.toFixed(2) : r.score}）`);
          if (r.last_access) lines.push(`   最后访问 ${r.last_access}`);
          lines.push(`   精读：${r.read_hint}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const c = cfg();
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("linghun_retrieval_probe: `query` 不能为空");
      const ref = String(args?.ref ?? "").trim();
      let topK = Number(args?.top_k ?? c.memory?.acc?.probeTopK ?? 8) || 8;
      topK = Math.min(Math.max(1, Math.floor(topK)), 20);
      const candidates = collectProbeCandidates().filter((x) => !ref || matchRef(x.block, ref));
      if (!candidates.length) return { ok: true, query, total_candidates: 0, results: [] };
      const stats = buildBm25Stats(candidates.map((x) => tokenizeForSim(x.block)));
      const hits = bm25Retrieve(candidates, query, stats, { topk: topK });
      const results = hits.map((h, i) => {
        const x = candidates[h.idx];
        return {
          rank: i + 1,
          source: x.source,
          anchor: x.anchor,
          title: firstLine(x.block, 100),
          score: Number(Number(h.score).toFixed(4)),
          confidence: x.confidence || "",
          last_access: x.lastAccess || "",
          read_hint:
            x.source === "warm"
              ? `linghun_memory_read ref=${x.anchor}（或传专名）`
              : `linghun_memory_read kind=${x.kind || (x.source === "fact" ? "fact" : x.source === "event" ? "event" : "rule")}${x.anchor ? ` ref="${x.anchor}"` : ""}`,
        };
      });
      return { ok: true, query, total_candidates: candidates.length, results };
    },
  }));

  /** CJK 判定（linghun_math_analyze op=text 用） */
  function isCjkCodePoint(cp) {
    return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);
  }

  /** 文本精确统计（linghun_math_analyze op=text 用）：字符/字节/行/词/CJK/空白/估算 token */
  function computeTextStats(text) {
    const s = String(text ?? "");
    const chars = [...s].length;
    const bytes = Buffer.byteLength(s, "utf8");
    const lines = s.length === 0 ? 0 : s.split(/\r?\n/).length;
    const nonEmptyLines = s.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const words = s.trim() ? s.trim().split(/\s+/).length : 0;
    let cjk = 0, whitespace = 0, nonAscii = 0, tokens = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (/\s/.test(ch)) whitespace += 1;
      else if (isCjkCodePoint(cp)) cjk += 1;
      if (cp >= 0x80) nonAscii += 1;
      tokens += isCjkCodePoint(cp) ? 0.6 : 0.25;
    }
    return {
      characters: chars,
      charactersNoWhitespace: chars - whitespace,
      bytes,
      lines,
      nonEmptyLines,
      words,
      cjkCharacters: cjk,
      whitespace,
      nonAsciiCharacters: nonAscii,
      estimatedTokens: Math.ceil(tokens),
    };
  }

  /** 写侧相对时间锚定（v0.4.3）：把文本里的相对时间表达就地标成绝对日期，形态 `原文 [=YYYY-MM-DD]`。
   *  只追加标注、不改写原文；已带 `[=...]` 的跳过。
   *  锚点 = 条目写入时刻的日期，写入即固定、之后不再变动。
   *  注意：只锚定「哪一天」这类不变量；「相隔多少天」是相对量（随"现在"漂移），不在写侧存，读侧用
   *  linghun_math_analyze op=date 现算。 */
  function anchorRelativeDatesInText(text, anchorDate) {
    const src = String(text ?? "");
    if (!src) return src;
    const anchor = String(anchorDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return src;
    const REL = /\b(?:today|tonight|tomorrow|yesterday|end of (?:the )?day|end of (?:the )?week|next month|this week|next week|in \d+ (?:day|days|week|weeks)|eod(?:\s+(?:today|tonight|tomorrow))?|(?:by|on|before|after|next|this)\s+(?:eod\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi;
    return src.replace(REL, (m, offset, whole) => {
      const tail = whole.slice(offset + m.length, offset + m.length + 16);
      if (/^\s*\[=\d{4}-\d{2}-\d{2}\]/.test(tail)) return m;
      try {
        const r = resolveRelativeDate(anchor, m);
        if (!r || !r.ok || !r.result || !r.result.resolved) return m;
        return `${m} [=${r.result.resolved}]`;
      } catch {
        return m;
      }
    });
  }

  /** 相对日期换算（linghun_math_analyze op=relative 用）：锚点日期 + 相对表达 -> 绝对日期（确定性，勿心算） */
  function resolveRelativeDate(anchor, expr) {
    const m = String(expr || "").toLowerCase();
    const a = new Date(String(anchor).slice(0, 10) + "T00:00:00Z");
    if (Number.isNaN(a.getTime())) throw new Error(`linghun_math_analyze: 锚点日期格式应为 YYYY-MM-DD，收到 "${anchor}"`);
    const iso = (dt) => dt.toISOString().slice(0, 10);
    const add = (n) => { const d = new Date(a.getTime() + n * 86400000); return iso(d); };
    const wdMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
      sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
    const deadline = /deadline|due|by\s|expected to complete|complete by|submit by|finish by|confirm by|no later than|target date|must (be\s+)?completed/.test(m);
    const nextWd = (wd, plusWeek) => add(((wd - a.getUTCDay()) % 7 + 7) % 7 + (plusWeek ? 7 : 0));
    let out = null, matched = "";
    if (/\b(eod|end\s+of\s+day|eob|end\s+of\s+business|close\s+of\s+business)\b/.test(m)) {
      const mm = m.match(/\b(eod|end\s+of\s+day|eob|end\s+of\s+business|close\s+of\s+business)[,\s]*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/);
      if (mm) { out = nextWd(wdMap[mm[2]], false); matched = mm[0]; }
      else { out = add(0); matched = "eod"; }
    }
    else if (/\btoday\b/.test(m)) { out = add(0); matched = "today"; }
    else if (/\btomorrow\b/.test(m)) { out = add(1); matched = "tomorrow"; }
    else if (/\byesterday\b/.test(m)) { out = add(-1); matched = "yesterday"; }
    else if (/\bin\s+(\d+)\s+(day|days|week|weeks)\b/.test(m)) {
      const mm = m.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
      const n = Number(mm[1]); const dlt = /^week/.test(mm[2]) ? n * 7 : n;
      out = add(dlt); matched = mm[0];
    }
    else if (/\bnext\s+week\b/.test(m)) { out = nextWd(5, true); matched = "next week"; }
    else if (/\bthis\s+week\b/.test(m)) { out = nextWd(5, false); matched = "this week"; }
    else if (/\b(end\s+of\s+(?:this\s+)?week|eow)\b/.test(m)) { out = nextWd(5, false); matched = "end of week"; }
    else if (/\bnext\s+month\b/.test(m)) {
      const y = a.getUTCFullYear(), mo = a.getUTCMonth() + 1;
      out = iso(new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1)));
      matched = "next month";
    }
    else {
      const mm = m.match(/\b(next|this|by|on|before|after)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/);
      if (mm) {
        const wd = wdMap[mm[2]];
        out = mm[1] === "next" ? nextWd(wd, true) : nextWd(wd, false);
        matched = mm[0];
      }
    }
    if (!out) return { ok: false, error: `无法识别相对日期表达："${expr}"（支持 today/tomorrow/yesterday/in N days|weeks/next|this week/next|this|by|on|before|after + 星期/end of week/next month）` };
    return { ok: true, result: { expr: matched, anchor: iso(a), resolved: out, deadline } };
  }

  regTool('linghun_math_analyze', defineTool({
    name: "linghun_math_analyze",
    description:
      "数学/时间/文本分析工具（ACC）：检索到数值证据后用它算，别硬算、别目测。op 选一：calc=表达式求值（四则/百分号/括号）；date=日期间隔或先后（传两个日期）；relative=相对日期换算（传 anchor 锚点日期 YYYY-MM-DD + expr 相对表达如 by Friday/in 3 days/end of week/next month，按锚点确定性换算成绝对日期）；aggregate=数值列表求和/均值/最值/计数；compare=数值比较返回最大最小与差值；text=文本精确统计（字符/字节/行/词/CJK/空白/估算 token，判「字数超限」「篇幅」类规则时必用）。",
    parameters: {
      op: {
        type: "string",
        required: true,
        description: "calc | date | relative | aggregate | compare | text",
      },
      expr: {
        type: "string",
        description: "calc 传表达式（如 12*7+3，支持 + - * / % 括号）；date 传 'A 到 B'（日期格式 YYYY-MM-DD）或 'A vs B'；relative 传相对日期表达（by Friday / in 3 days / end of week / next month / tomorrow 等）",
      },
      anchor: {
        type: "string",
        description: "relative 传消息锚点日期（YYYY-MM-DD，即该消息发布当天），相对日期按它换算",
      },
      values: {
        type: "array",
        description: "aggregate 传数值数组；compare 传 {label, value} 数组",
      },
      text: {
        type: "string",
        description: "text 传要统计的原文（原样传入，不要截断、不要自己数）",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          op: { type: "string" },
          result: { type: "json" },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: `数学分析失败：${value.error || "未知"}` }];
        return [{ type: "text", text: `数学分析（${value.op}）：${JSON.stringify(value.result)}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const op = String(args?.op ?? "").trim();
      if (!["calc", "date", "relative", "aggregate", "compare", "text"].includes(op)) throw new Error(`linghun_math_analyze: op 必须是 calc|date|relative|aggregate|compare|text，收到 "${op}"`);
      if (op === "text") {
        const raw = args?.text;
        if (typeof raw !== "string" || raw.length === 0) throw new Error("linghun_math_analyze: text 需要 text（要统计的原文，原样传入不要截断）");
        return { ok: true, op, result: computeTextStats(raw) };
      }
      if (op === "relative") {
        const expr = String(args?.expr ?? "").trim();
        const anchor = String(args?.anchor ?? "").trim();
        if (!expr || !anchor) throw new Error("linghun_math_analyze: relative 需要 expr（相对日期表达）和 anchor（消息锚点日期 YYYY-MM-DD）");
        return resolveRelativeDate(anchor, expr);
      }
      if (op === "calc") {
        const expr = String(args?.expr ?? "").trim();
        if (!expr) throw new Error("linghun_math_analyze: calc 需要 expr");
        if (!/^[0-9+\-*/().%\s]+$/.test(expr)) throw new Error(`linghun_math_analyze: 表达式含非法字符 "${expr}"`);
        // 安全求值：仅数字与 + - * / ( ) . %，用受限 Function
        const val = Function(`"use strict"; return (${expr.replace(/%/g, "/100")});`)();
        if (typeof val !== "number" || !Number.isFinite(val)) throw new Error("linghun_math_analyze: 表达式结果非有限数");
        return { ok: true, op, result: { expr, value: Number(val.toFixed(6)) } };
      }
      if (op === "date") {
        const expr = String(args?.expr ?? "").trim();
        const m = expr.match(/^(\S+)\s+(?:到|至|vs|VS|versus|—|-)\s+(\S+)$/);
        if (!m) throw new Error(`linghun_math_analyze: date 需传 'A 到 B' 或 'A vs B'（如 2024-03-01 到 2024-05-15），收到 "${expr}"`);
        const d1 = new Date(m[1]);
        const d2 = new Date(m[2]);
        if (isNaN(d1) || isNaN(d2)) throw new Error("linghun_math_analyze: 日期格式应为 YYYY-MM-DD");
        const ms = Math.abs(d2 - d1);
        const days = Math.round(ms / 86400000);
        return { ok: true, op, result: { from: m[1], to: m[2], days, earlier: d1 <= d2 ? m[1] : m[2], later: d1 <= d2 ? m[2] : m[1] } };
      }
      if (op === "aggregate") {
        const values = Array.isArray(args?.values) ? args.values.map(Number) : [];
        if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error("linghun_math_analyze: aggregate 需要 values 数值数组");
        return { ok: true, op, result: { n: values.length, sum: values.reduce((a, b) => a + b, 0), avg: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) } };
      }
      // compare
      const items = Array.isArray(args?.values) ? args.values : [];
      if (!items.length) throw new Error("linghun_math_analyze: compare 需要 values 为 {label, value} 数组");
      const norm = items.map((it) => ({ label: String(it?.label ?? "?"), value: Number(it?.value) }));
      if (norm.some((x) => !Number.isFinite(x.value))) throw new Error("linghun_math_analyze: compare 的 value 必须可转为数字");
      const sorted = [...norm].sort((a, b) => b.value - a.value);
      const max = sorted[0], min = sorted[sorted.length - 1];
      return { ok: true, op, result: { sorted: sorted.map((x) => `${x.label}=${x.value}`), max: `${max.label}=${max.value}`, min: `${min.label}=${min.value}`, diff: Number((max.value - min.value).toFixed(6)) } };
    },
  }));

  regTool('linghun_memory_status', defineTool({
    name: "linghun_memory_status",
    description:
      "记忆状态一览（ACC 核心工具）：暖冷条数、三本体、归档/序时账计数、目标主线、可用认知工具。做任何记忆操作前先看全局，再决定 probe/read 的路径。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          acc: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              probeTopK: { type: "number" },
            },
          },
          memory: {
            type: "object",
            additionalProperties: false,
            properties: {
              warm_entries: { type: "number" },
              cold_blocks: { type: "number" },
              fact_blocks: { type: "number" },
              event_blocks: { type: "number" },
              rule_lines: { type: "number" },
              journal_days: { type: "number" },
              episodic_days: { type: "number" },
              graph_nodes: { type: "number" },
              graph_edges: { type: "number" },
            },
          },
          goals: {
            type: "object",
            additionalProperties: false,
            properties: {
              total: { type: "number" },
              active: { type: "number" },
              active_list: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    statement: { type: "string" },
                    domain: { type: "string" },
                    priority: { type: "string" },
                    time: { type: "string" },
                  },
                },
              },
            },
          },
          tools: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: "记忆状态查询未执行（disabled）。" }];
        const m = value.memory ?? {};
        const g = value.goals ?? {};
        const acc = value.acc ?? {};
        const lines = [
          `记忆状态（ACC ${acc.enabled ? "开" : "关"}，probeTopK ${acc.probeTopK ?? 8}）：`,
          `暖态 ${m.warm_entries ?? 0} 条 / 冷储 ${m.cold_blocks ?? 0} 块 / 知识本体 ${m.fact_blocks ?? 0} / 事件时间线 ${m.event_blocks ?? 0} / 规则 ${m.rule_lines ?? 0} 行`,
          `归档单元 ${m.episodic_days ?? 0} 个 / 序时账 ${m.journal_days ?? 0} 天 / 图谱 ${m.graph_nodes ?? 0} 节点 ${m.graph_edges ?? 0} 边`,
          `目标：${g.active ?? 0}/${g.total ?? 0} active${(g.active_list ?? []).length ? ` — ${g.active_list.map((x) => `${x.statement}`).join("；")}` : ""}`,
          `认知工具：${(value.tools ?? []).join(" / ")}`,
        ];
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const c = cfg();
      const warmEntries = parseWarm(layout.readWarm());
      const countBlocks = (raw) => raw.split(/\n(?=## )/).map((x) => x.trim()).filter(Boolean).length;
      const rulesPath =
        (c.memory?.rules?.path ?? "").trim() ||
        join(resolveDshHome(), "linghun", "memory", "rules.md");
      let ruleLines = 0;
      try {
        ruleLines = readFileSync(rulesPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
      } catch {
        /* 无规则文件 */
      }
      let goals = [];
      try {
        goals = sortGoals(readGoals());
      } catch {
        /* 无目标档案 */
      }
      const active = goals.filter((g) => (g.state ?? "active") === "active");
      return {
        ok: true,
        acc: { enabled: c.memory?.acc?.enabled === true, probeTopK: c.memory?.acc?.probeTopK ?? 8 },
        memory: {
          warm_entries: warmEntries.length,
          cold_blocks: countBlocks(layout.readCold()),
          fact_blocks: countBlocks(layout.readKnowledgeOntology()),
          event_blocks: countBlocks(layout.readMemoryOntology()),
          rule_lines: ruleLines,
          journal_days: layout.listJournal().length,
          episodic_days: layout.listEpisodic().length,
          graph_nodes: readGraph()?.nodes?.length ?? 0,
          graph_edges: readGraph()?.edges?.length ?? 0,
        },
        goals: {
          total: goals.length,
          active: active.length,
          active_list: active.slice(0, 8).map((g) => ({
            id: g.id,
            statement: g.statement,
            domain: g.domain,
            priority: g.priority,
            time: g.time,
          })),
        },
        tools: [
          "linghun_retrieval_probe",
          "linghun_memory_status",
          "linghun_math_analyze",
          "linghun_memory_read",
          "linghun_unit_append",
          "linghun_graph_query",
          "linghun_graph_build",
          "linghun_profile_get",
          "linghun_goal_get",
          "linghun_goal_state",
        ],
      };
    },
  }));
}

export { Config, NS, SECTION_MEMORY, apply, inject, name, parseAssessment };
