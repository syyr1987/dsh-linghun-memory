/**
 * 目标系统（Goal System）— 真实前瞻记忆模块。
 *
 * 目标 = 记忆的骨架：事件/状态/信念都挂在目标上；目标让认知循环有方向。
 * 与 T-Mem 前瞻记忆的本质区别：写时不预判「未来会被问什么」，只沉淀「这个人要达成什么」；
 * 读侧用「处境触发」而不是「词面 cue 匹配」。
 *
 * 存储：$DSH_HOME/linghun/goals/goals.json
 * 目标字段：id / speaker / statement / domain / state / priority / time / detail / linked
 * 状态机：active（进行中）| paused（暂停）| achieved（达成）| abandoned（放弃）
 *
 * 读侧残差触发（MADELEINE arXiv:2610.01118 借鉴）：
 *   触发分(q, m) = α·sim(q, m) + β·goalActivate(m | q)
 *   sim = 主题域相似度（词面/BM25，只做候选筛）
 *   goalActivate = 目标状态机 ∩ 处境语义（残差项，只编码相似度解释不了的「目标激活」）
 * 两条纪律：
 *   1. 不做「匹配判断」，做「目标激活」——reranker 匹配视角在目标类联想上反而降分；
 *   2. 只改读侧——写侧抽象归纳独立沉淀，不退回写侧穷举。
 */
import { tokenizeForSim, jaccardSim } from "./memory.js";

/** 目标状态机权重：active 最高，achieved/abandoned 不再触发（激活分为 0）。 */
export const GOAL_STATE_WEIGHT = {
  active: 1,
  paused: 0.5,
  achieved: 0,
  abandoned: 0,
};

/** 主题域词典（v1 词面启发，供 goalActivate 的 domainHit 加成；离线零成本）。 */
export const DOMAIN_LEXICON = {
  money: ["钱", "攒", "买", "花", "贵", "省", "预算", "工资", "收入", "欠", "存"],
  family: ["家", "婚", "妻", "夫", "父母", "孩子", "家人", "求婚", "戒指", "买房"],
  career: ["工作", "事业", "升职", "加班", "项目", "辞职", "职业", "上班", "老板"],
  health: ["健康", "累", "病", "睡", "锻炼", "医院", "身体", "焦虑", "失眠"],
  travel: ["旅行", "旅游", "机票", "假期", "出发", "玩", "签证"],
  belief: ["信念", "价值", "原则", "信仰", "追求", "底线"],
};

/** 归一化目标列表（容错空/非数组）。 */
export function parseGoals(text) {
  if (!text || !String(text).trim()) return [];
  try {
    const data = JSON.parse(String(text));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** 序列化目标列表（JSON，稳定排序：active 在前、priority 高在前）。 */
export function serializeGoals(goals) {
  const list = Array.isArray(goals) ? goals : [];
  return JSON.stringify(list, null, 2);
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** 目标排序：状态（active/paused 在前）→ priority → time 新在前。 */
export function sortGoals(goals) {
  return [...(Array.isArray(goals) ? goals : [])].sort((a, b) => {
    const wa = GOAL_STATE_WEIGHT[a.state] ?? 0;
    const wb = GOAL_STATE_WEIGHT[b.state] ?? 0;
    if (wa !== wb) return wb - wa;
    const pa = PRIORITY_RANK[a.priority] ?? 1;
    const pb = PRIORITY_RANK[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return String(b.time ?? "").localeCompare(String(a.time ?? ""), "en");
  });
}

/** 找可合并的目标：同 speaker 且（同 domain 或 表述词面相似）。已达成/放弃的不参与合并。 */
export function findMergeCandidate(goals, signal) {
  const list = Array.isArray(goals) ? goals : [];
  const speaker = String(signal?.speaker ?? "").trim() || "self";
  const statement = String(signal?.statement ?? "").trim();
  const domain = String(signal?.domain ?? "").trim().toLowerCase();
  for (const g of list) {
    if (g.speaker !== speaker) continue;
    if (g.state === "achieved" || g.state === "abandoned") continue;
    if (domain && g.domain === domain) return g;
    if (statement) {
      const sim = jaccardSim(tokenizeForSim(statement), tokenizeForSim(String(g.statement ?? "")));
      if (sim >= 0.25) return g;
    }
  }
  return null;
}

/**
 * 目标信号合并（写侧：随对话持续运行，不预判问题）。
 * signal = { speaker?, action, statement, domain?, priority?, detail? }
 * action：new（新目标）/ progress（推进）/ change（调整）/ achieve（达成）/ abandon（放弃）
 * 返回 { goals, mode, goal }：mode = new | merge | progress | change | achieve | abandon
 */
export function mergeGoalSignal(goals, signal, now) {
  const list = Array.isArray(goals) ? goals : [];
  const action = String(signal?.action ?? "new").toLowerCase();
  const statement = String(signal?.statement ?? "").trim();
  const domain = String(signal?.domain ?? "").trim().toLowerCase();
  const stamp = now ?? new Date().toISOString().slice(0, 10);

  const makeGoal = (over = {}) => ({
    id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    speaker: String(signal?.speaker ?? "").trim() || "self",
    statement,
    domain,
    state: "active",
    priority: signal?.priority ?? "medium",
    time: stamp,
    detail: signal?.detail ?? "",
    linked: [],
    ...over,
  });

  const merged = findMergeCandidate(list, signal);
  if (action === "new") {
    if (merged) {
      // 已存在同主题目标：不重复建档，视为推进（detail 追加）
      const idx = list.indexOf(merged);
      const updated = { ...merged, time: stamp };
      if (signal?.detail && !String(updated.detail ?? "").includes(String(signal.detail))) {
        updated.detail = [updated.detail, signal.detail].filter(Boolean).join("；");
      }
      const next = [...list];
      next[idx] = updated;
      return { goals: next, mode: "merge", goal: updated };
    }
    const goal = makeGoal();
    return { goals: [...list, goal], mode: "new", goal };
  }

  if (!merged) {
    // 没有可合并目标：progress/change/achieve/abandon 都落到新建档案
    const goal = makeGoal(
      action === "achieve" ? { state: "achieved" } : action === "abandon" ? { state: "abandoned" } : {},
    );
    return { goals: [...list, goal], mode: action, goal };
  }

  const idx = list.indexOf(merged);
  const updated = { ...merged };
  if (action === "progress") {
    if (signal?.detail && !String(updated.detail ?? "").includes(String(signal.detail))) {
      updated.detail = [updated.detail, signal.detail].filter(Boolean).join("；");
    }
    updated.time = stamp;
    if (signal?.priority) updated.priority = signal.priority;
  } else if (action === "change") {
    if (statement) updated.statement = statement;
    if (domain) updated.domain = domain;
    if (signal?.priority) updated.priority = signal.priority;
    if (signal?.detail) updated.detail = signal.detail;
    updated.time = stamp;
  } else if (action === "achieve") {
    updated.state = "achieved";
    if (signal?.detail) updated.detail = signal.detail;
    updated.time = stamp;
  } else if (action === "abandon") {
    updated.state = "abandoned";
    updated.time = stamp;
  }
  const next = [...list];
  next[idx] = updated;
  return { goals: next, mode: action, goal: updated };
}

/**
 * 目标激活分（残差项）：状态机权重 ×（domain 命中 + 表述语义接近度）。
 * 核心：处境越贴近 active 目标的达成路径，激活分越高；achieved/abandoned 一律 0。
 * opts.domainWeight（默认 0.35）：domain 命中在激活分中的占比，剩余权重给表述相似度。
 */
export function goalActivateScore(goal, situation, opts = {}) {
  const q = String(situation ?? "").trim();
  if (!q || !goal?.statement) return 0;
  const stateW = GOAL_STATE_WEIGHT[goal.state] ?? 0;
  if (stateW <= 0) return 0;
  const domain = String(goal.domain ?? "").toLowerCase();
  const lex = DOMAIN_LEXICON[domain] ?? [];
  const domainHit = lex.some((w) => q.includes(w)) ? 1 : 0;
  const sim = jaccardSim(tokenizeForSim(q), tokenizeForSim(`${goal.statement} ${domain}`));
  const dw = opts.domainWeight ?? 0.35;
  return stateW * (dw * domainHit + (1 - dw) * sim + 0.15);
}

/**
 * 读侧残差触发：触发分(q, m) = α·sim(q, m) + β·goalActivate(m | q)。
 * α/sim 做候选筛，β/activate 抬升「目标激活」类联想（纯相似度盲区）。
 * 返回按触发分降序的 { goal, sim, activate, score } 列表。
 */
export function rankGoalsByTrigger(goals, situation, opts = {}) {
  const q = String(situation ?? "").trim();
  if (!q) return [];
  const alpha = opts.simWeight ?? 1;
  const beta = opts.activateWeight ?? 0.3;
  const minScore = opts.minScore ?? 0.02;
  const list = Array.isArray(goals) ? goals : [];
  return list
    .filter((goal) => (GOAL_STATE_WEIGHT[goal.state] ?? 0) > 0)
    .map((goal) => {
      const sim = jaccardSim(tokenizeForSim(q), tokenizeForSim(`${goal.statement} ${goal.domain ?? ""}`));
      const activate = goalActivateScore(goal, q, opts);
      return { goal, sim, activate, score: alpha * sim + beta * activate };
    })
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score);
}

/** 渲染目标主线（注入段用）：active/paused 目标按触发分降序，单条一行。 */
export function renderGoalsForInject(goals, situation, opts = {}) {
  const list = Array.isArray(goals) ? goals : [];
  if (!list.length) return "";
  const maxGoals = opts.maxGoals ?? 5;
  const ranked = situation
    ? rankGoalsByTrigger(list, situation, opts).slice(0, maxGoals)
    : sortGoals(list)
        .slice(0, maxGoals)
        .map((goal) => ({ goal, score: 0 }));
  if (!ranked.length) return "";
  const lines = ranked.map(({ goal, score }) => {
    const stateTag = goal.state === "paused" ? "·暂停" : "";
    const prioTag = goal.priority ? `·${goal.priority}` : "";
    const when = goal.time ? `（${goal.time}）` : "";
    const detail = goal.detail ? ` — ${goal.detail}` : "";
    return `- [${goal.domain ?? "goal"}${stateTag}${prioTag}] ${goal.statement}${when}${detail}`;
  });
  return `> 目标主线（认知循环·未来维度，按处境触发分排序；命中时作为最高优先参考，可用不强制）：\n${lines.join("\n")}`;
}

/** 注入纪律（读侧）：处境触发先激活目标，命中即最高优先参考；温和注入不强制改写。 */
export const GOAL_DISCIPLINE = `> 目标激活纪律（读侧）：当前消息先判断它激活了哪个目标——是某个目标的推进、受阻、反转还是回响。命中目标主线时把它作为最高优先参考（温和注入：可用参考，不强制改写回答）。目标状态机：active（进行中）/ paused（暂停）/ achieved（达成）/ abandoned（放弃）；已达成/放弃的目标不再作为行动参考。目标激活做「处境→目标」的激活判断，不做「消息→记忆」的匹配判断。`;
