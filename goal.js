/**
 * 目标系统（Goal System）— 真实前瞻记忆模块。
 *
 * 目标 = 记忆的骨架：事件/状态/信念都挂在目标上；目标让认知循环有方向。
 * 与 T-Mem 前瞻记忆的本质区别：写时不预判「未来会被问什么」，只沉淀「这个人要达成什么」；
 * 读侧用「处境触发」而不是「词面 cue 匹配」。
 *
 * 存储：$DSH_HOME/linghun/goals/goals.json
 * 目标字段：id / speaker / statement / domain / state / priority / time / detail / linked / triggers
 * 状态机：active（进行中）| paused（暂停）| achieved（达成）| abandoned（放弃）
 *
 * triggers（v0.1.5 加入，Bridge 触发词·节制版）：high/medium 目标写侧附 1-2 条「什么处境会激活它」
 * 的语义远距桥（如 college fund → "reconsidering long-term financial plans after a family trip"）。
 * 读侧 bridgeHit：当前处境与桥共现 ≥2 词即加成。节制边界：每个目标最多 2 条桥、只服务语义远距，
 * 不做写侧穷举 query——触发仍发生在读时，桥只是给目标一个可被远距处境激活的语义锚点。
 *
 * 读侧残差触发（MADELEINE arXiv:2610.01118 借鉴）：
 *   触发分(q, m) = α·sim(q, m) + β·goalActivate(m | q)
 *   sim = 主题域相似度（词面/BM25，只做候选筛）
 *   goalActivate = 目标状态机 ∩ 处境语义（残差项，只编码相似度解释不了的「目标激活」）
 * 两条纪律：
 *   1. 不做「匹配判断」，做「目标激活」——reranker 匹配视角在目标类联想上反而降分；
 *   2. 写侧只抽象归纳独立沉淀 + 少量 Bridge 锚点，不退回写侧穷举预判。
 */
import { tokenizeForSim, jaccardSim } from "./memory.js";

/** 目标状态机权重：active 最高，achieved/abandoned 不再触发（激活分为 0）。 */
export const GOAL_STATE_WEIGHT = {
  active: 1,
  paused: 0.5,
  achieved: 0,
  abandoned: 0,
};

/** 主题域词典（v1.4 中英双语词面启发，供 goalActivate 的 domainHit 加成；离线零成本）。
 *  英文词用词边界匹配（见 goalActivateScore 的 domainHit），"art" 不会误伤 "party"。
 *  英文词表服务英文处境触发（如 LoCoMo-Plus 英文 trigger vs 中文/英文目标档案）。 */
export const DOMAIN_LEXICON = {
  money: ["钱", "攒", "买", "花", "贵", "省", "预算", "工资", "收入", "欠", "存",
    "money", "loan", "debt", "pay", "paid", "payment", "budget", "expense", "spend", "spent", "spending",
    "save", "saving", "savings", "price", "prices", "cost", "costs", "afford", "broke", "rent", "bill", "bills",
    "salary", "income", "financial", "finance", "invest", "investing", "expensive", "cheap", "rich", "poor",
    "student", "tuition", "mortgage", "owe", "owing", "check", "track", "tracking", "frugal"],
  family: ["家", "婚", "妻", "夫", "父母", "孩子", "家人", "求婚", "戒指", "买房",
    "family", "marry", "marriage", "married", "wife", "husband", "parent", "parents", "child", "children",
    "kid", "kids", "home", "house", "adopt", "adoption", "adopting", "wedding", "ring", "fiance", "fiancee",
    "girlfriend", "boyfriend", "partner", "mother", "father", "mom", "dad", "baby", "baby's", "nest"],
  career: ["工作", "事业", "升职", "加班", "项目", "辞职", "职业", "上班", "老板",
    "job", "career", "promotion", "promote", "work", "working", "boss", "company", "office", "interview",
    "resign", "quit", "colleague", "study", "degree", "school", "college", "university", "class", "course",
    "counseling", "counselor", "therapy", "psychology", "mental", "career", "profession", "grow", "growth", "skill", "skills"],
  health: ["健康", "累", "病", "睡", "锻炼", "医院", "身体", "焦虑", "失眠",
    "health", "healthy", "tired", "exhausted", "sleep", "sick", "ill", "hospital", "doctor", "pain",
    "headache", "migraine", "anxiety", "stress", "depress", "depression", "therapy", "therapist", "light",
    "insomnia", "rest", "wellness", "self-care", "selfcare", "mental", "chronic", "medication", "recover", "recovery", "healing"],
  travel: ["旅行", "旅游", "机票", "假期", "出发", "玩", "签证",
    "travel", "trip", "vacation", "flight", "ticket", "airport", "visit", "tour", "holiday", "journey",
    "iceland", "abroad", "overseas", "destination", "explore", "adventure", "summer", "winter"],
  belief: ["信念", "价值", "原则", "信仰", "追求", "底线", "谣言", "隐私", "尊重", "声誉",
    "belief", "believe", "value", "values", "principle", "faith", "truth", "honest", "honesty", "authentic",
    "accept", "acceptance", "pride", "right", "fair", "fairness", "justice", "respect", "kind", "kindness",
    "love", "inclusion", "inclusive", "advocacy", "advocate", "equality", "human", "rights", "voice", "freedom",
    "privacy", "reputation", "rumor", "rumors", "gossip", "integrity", "dignity", "ethical", "ethics",
    "moral", "morals", "conscience", "spread", "spreading", "confidential"],
  lifestyle: ["生活", "习惯", "日常", "周末", "兴趣", "享受", "放松", "犒劳",
    "lifestyle", "habit", "routine", "daily", "weekend", "fun", "hobby", "enjoy", "relax", "relaxing",
    "treat", "splurge", "indulge", "comfort", "ramen", "meal", "dinner", "food", "eat", "eating", "restaurant", "cook", "cooking"],
  art: ["艺术", "画", "绘画", "创作", "展览", "音乐", "吉他", "钢琴", "表演",
    "art", "artwork", "painting", "paint", "draw", "drawing", "music", "guitar", "piano", "violin",
    "ceramic", "ceramics", "exhibition", "show", "performance", "creative", "creativity", "sing", "singing",
    "artist", "gallery", "craft", "sculpture", "poetry", "writing", "write"],
  education: ["教育", "学习", "学位", "学校", "大学", "课程", "考试", "研究", "毕业",
    "education", "study", "studying", "learn", "degree", "school", "college", "university", "course",
    "class", "graduate", "grad", "homework", "exam", "research", "academic", "student", "tuition", "enroll"],
  community: ["社区", "志愿", "公益", "导师", "青年", "中心", "群体", "服务", "回馈",
    "community", "volunteer", "volunteering", "mentor", "mentoring", "youth", "center", "group", "club",
    "charity", "activism", "activist", "support", "peer", "serve", "service", "outreach", "advocacy",
    "connected", "network", "giving", "help", "helping", "others"],
  relationship: ["朋友", "友谊", "关系", "伴侣", "约会", "一起", "支持",
    "friend", "friends", "friendship", "relationship", "love", "partner", "girlfriend", "boyfriend",
    "together", "date", "dating", "support", "supportive", "close", "bond", "connection", "melanie"],
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

/** 归一化 Bridge 触发词：非空去重、最多 2 条（节制版——不穷举 query，只给目标的语义远距桥）。 */
function normalizeTriggers(triggers) {
  if (!Array.isArray(triggers)) return [];
  const seen = new Set();
  const out = [];
  for (const t of triggers) {
    const s = String(t ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

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
 * signal = { speaker?, action, statement, domain?, priority?, detail?, triggers? }
 * action：new（新目标）/ progress（推进）/ change（调整）/ achieve（达成）/ abandon（放弃）
 * triggers：可选，1-2 条 Bridge 触发词（「什么处境会激活它」的语义远距桥，英文原文）。
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
    triggers: normalizeTriggers(signal?.triggers),
    ...over,
  });

  const merged = findMergeCandidate(list, signal);
  if (action === "new") {
    if (merged) {
      // 已存在同主题目标：不重复建档，视为推进（detail/triggers 追加）
      const idx = list.indexOf(merged);
      const updated = { ...merged, time: stamp };
      if (signal?.detail && !String(updated.detail ?? "").includes(String(signal.detail))) {
        updated.detail = [updated.detail, signal.detail].filter(Boolean).join("；");
      }
      updated.triggers = normalizeTriggers([...(updated.triggers ?? []), ...normalizeTriggers(signal?.triggers)]);
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
    if (signal?.triggers) updated.triggers = normalizeTriggers([...(updated.triggers ?? []), ...normalizeTriggers(signal.triggers)]);
  } else if (action === "change") {
    if (statement) updated.statement = statement;
    if (domain) updated.domain = domain;
    if (signal?.priority) updated.priority = signal.priority;
    if (signal?.detail) updated.detail = signal.detail;
    if (signal?.triggers) updated.triggers = normalizeTriggers(signal.triggers);
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
 * Bridge 命中：目标 triggers（写侧 1-2 条「什么处境会激活它」的语义远距桥）与当前处境共现 ≥2 个词 → 1。
 * 词面零线索的远距处境（如「推迟 that approach + 家庭旅行后重新思考」→ college fund）由 Bridge 桥接。
 * 节制版：每个目标最多 2 条桥，不做写侧穷举 query。
 */
function bridgeHitScore(goal, q) {
  const triggers = Array.isArray(goal?.triggers) ? goal.triggers : [];
  if (!triggers.length || !q) return 0;
  const qt = tokenizeForSim(q);
  if (!qt.length) return 0;
  for (const t of triggers) {
    const tt = tokenizeForSim(String(t));
    if (tt.length < 2) continue;
    const inter = qt.filter((x) => tt.includes(x));
    if (inter.length >= 2) return 1;
  }
  return 0;
}

/**
 * 目标激活分（残差项）：状态机权重 ×（domain 命中 + Bridge 命中 + 表述语义接近度）。
 * 核心：处境越贴近 active 目标的达成路径，激活分越高；achieved/abandoned 一律 0。
 * opts.domainWeight（默认 0.25）：domain 命中占比；opts.bridgeWeight（默认 0.35）：Bridge 命中占比
 * （Bridge 是目标专属语义远距桥，命中比泛 domain 更可信，权重更高）；其余权重给表述相似度。
 */
export function goalActivateScore(goal, situation, opts = {}) {
  const q = String(situation ?? "").trim();
  if (!q || !goal?.statement) return 0;
  const stateW = GOAL_STATE_WEIGHT[goal.state] ?? 0;
  if (stateW <= 0) return 0;
  const domain = String(goal.domain ?? "").toLowerCase();
  const lex = DOMAIN_LEXICON[domain] ?? [];
  // v1.4：domainHit 用词边界匹配（英文词 "art" 不误伤 "party"；中文词前后为标点/空格/中日韩字符即边界）
  const qLower = q.toLowerCase();
  const domainHit = lex.some((w) => {
    if (!w) return false;
    if (/^[a-z0-9]/.test(w)) {
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      return re.test(qLower);
    }
    return qLower.includes(w);
  }) ? 1 : 0;
  const sim = jaccardSim(tokenizeForSim(q), tokenizeForSim(`${goal.statement} ${domain}`));
  const dw = opts.domainWeight ?? 0.25;
  const bw = opts.bridgeWeight ?? 0.35;
  const bridgeHit = bridgeHitScore(goal, q);
  return stateW * (dw * domainHit + bw * bridgeHit + (1 - dw - bw) * sim + 0.15);
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
