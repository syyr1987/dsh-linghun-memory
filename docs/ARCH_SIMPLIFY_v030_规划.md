# dsh-linghun-memory 架构简化 v0.3.0 规划

> **术语说明（2026-11-02 更新）**：本文档记录当时方案，正文中的「记忆本体」「三本体」「记忆完全本体化」属历史术语，保留原貌以存史。
> 现行定义：**知识本体**（`knowledge_ontology.md`）与**规则本体**（`rules.md`）是本体；**记忆**是 md 文件（`memory_timeline.md`，原 `memory_ontology.md`），不再称本体。


> 状态：待主人确认变量后实施
> 日期：2026-10-22
> 触发：主人 02:17 指令——"记忆单元太复杂了，记忆单元就原文存成一个个md文件就够了，放冷储用图谱将单元和人物画像里的要素连起来表示关系"

## 一、目标

把记忆单元从「暖态结构化三型条目」（fact/event/rule + 置信度 + 摘要加工）**简化为「原文 md 单元文件」**：

1. **记忆单元 = 原文 md 文件**——一条记忆就是一个保留对话原文的 md 文件，不做结构化加工；
2. **放冷储**——原文单元落在冷储层（episodic/），暖态只留轻量索引（或不留）；
3. **图谱连接关系**——新增图谱，把「记忆单元」与「人物画像要素」连起来表示关系（谁→经历了什么/说了什么/偏好什么）。

## 二、现状盘点（已调研确认）

| 层 | 现状 0.2.1 | 问题 |
|---|---|---|
| 暖态 warm.md | 结构化三型条目 `## 日期 [kind] confidence` + 摘要式三行 | 加工重、丢失原文细节（正是丢分根因） |
| 冷储 | consolidate 压 cold.md 摘要 + episodic/ 归档 | 评测基本未触发；摘要再压缩更丢细节 |
| 三本体 | memory_ontology / knowledge_ontology / rules | 与 warm 同源重复归档，复杂 |
| 人物画像 | profiles/*.md 六槽 fact/state/goal/value/causal/preference | 保留（图谱要素端） |
| 图谱 | **不存在**；map.js 是四轴导航图 | 新增真正的关系图谱 |
| 工具 | 16 个（append/read/journal/touch/consolidate/project/rules + goal/profile/soul/retrieval/math/status） | 精简 |

## 三、新架构设计

### 3.1 单元层（冷储原文 · 不动档案）

```
memory/
  episodic/
    2023-05-03_session_主题A.md     ← 记忆单元 = 原文 md，一 session 一文件
    2023-05-06_session_主题B.md
    ...
  index.md                  ← 冷储索引：单元清单（时间/主体/主题 一行一条）
```

- 单元文件名：`<时间戳>_session_<主题slug>.md`，内容 = 该 session **原文对话全量**（复用评测已验证的 save_raw 原文，不做 mem_to_warm 结构化加工）
- **冷储不动**：原文单元落盘后永不加工/改写，是纯原文档案（长期记忆）
- 头信息：首部注释块写 `时间 / session / 涉及主体(@主体) / 主题`，供图谱与检索用

### 3.2 暖态（当前条目 · 工作记忆）

- **不是删除**：warm.md 保留，但语义变为「当前条目」——检索命中某冷储单元时，把该**原文**复制到 warm.md（激活为当前条目，带 last_access 触达标记）
- 暖态 = 从冷储复制激活的原文条目集，不做三型加工；超出预算按 LRU 淘汰
- 冷储是源头、暖态是缓存：冷储不动、暖态流动

### 3.3 画像层（图谱要素端）

- 保留 profiles 六槽（fact/state/goal/value/causal/preference）——这就是"人物画像里的要素"
- 画像要素 = 画像文件里的**每条槽位条目**（例如 fact 槽："Andrew | 职业为金融分析师"）
- 画像更新时同步建边（主体→相关单元）

### 3.4 图谱层（新增，核心 · 联想网络）

```
memory/
  graph.md    ← 人读图谱：节点与边清单
  graph.json  ← 机器读图谱：{nodes:[...], edges:[...]}
```

- **节点**：
  - 单元节点 `U:episodic/2023-05-03_session_主题A.md`
  - 画像要素节点 `P:xeval:<subject>:<slot>:<条目id>`（指向 profiles 具体槽条目）
  - 主体节点 `S:<subject>`（中间枢纽）
- **边（主人选定：含支持/反驳）**：
  - `U --mentions--> S` 单元涉及某主体
  - `S --has_profile--> P` 主体拥有该画像要素
  - `U --supports--> P` 单元支撑画像要素（印证细节）
  - `U --contradicts--> P` 单元反驳/更新画像要素（冲突细节）
- **构建时机**：
  - feed/append 写原文单元时：提取主体标签 → 建 `U--mentions-->S`
  - profile_update 时：建 `S--has_profile-->P`
  - 图谱由工具自动维护，模型不手工改

### 3.5 检索路径（ask 时）

```
linghun_profile_get <主体>      → 画像要素（P 节点）
linghun_graph_query <主体/要素>  → 相关单元（U 节点，含 supports/contradicts 关系）
linghun_memory_read <单元>      → 冷储原文 md（细节兜底）→ 复制到暖态
```

即：**画像 → 图谱 → 原文（冷储）→ 暖态激活** 四级，替代现在的"暖态全量结构化检索"。

## 四、工具清单（改造后）

- **改造**：
  - `linghun_memory_append`：原文落单元 + 自动建边
  - `linghun_memory_read`：图谱定位 + 读原文单元
  - `linghun_profile_update`：画像更新 + 建边
- **新增**：
  - `linghun_graph_build`：全量重建图谱（幂等）
  - `linghun_graph_query`：主体/要素 → 单元
- **删除/合并**：
  - 三本体归档（memory_ontology/knowledge_ontology/rules 独立层）→ 合并进画像因果/preference 或直接去掉
  - map.js 四轴导航 → 图谱取代
  - consolidate 的摘要压缩 → 改为原文归档（不做二次摘要）
- 保留：goal/state、soul、journal、retrieval_probe、math_analyze、memory_status

## 五、变量（主人拍板 · 已确认）

| 变量 | 选项 | 确认结果 |
|---|---|---|
| V1 单元粒度 | A=按 session 切；B=按主题/事件切 | **A 按 session 切**（一次对话一个 md） |
| V2 暖态去留 | A=删 warm；B=保留 | **保留，改为"当前条目"**——冷储不动，检索命中复制到暖态（工作记忆语义） |
| V3 图谱边集 | A=只留 mentions+has_profile；B=加 supports/contradicts | **B 加 supports/contradicts**（单元对画像要素的印证/反驳） |

## 六、成本上限

- 实现：memory.js / index.js 改造（0.3.0），PCLK 上进行（DSH 插件开发专用）
- 验证：先跑 **m401oacc 单形态全量**（ask+judge，PCLK 20 分钟硬切 × 2 段），达标后再跑 uacc
- 预算：两次 401 全量（约等于上一轮烧量），超预算即停

## 七、判据

- **主判据**：新架构 m401oacc ≥ 75.31%（当前基线），uacc ≥ 72.57%；最好有提升
- **副判据**：救回部分"查无此条"错题——新答案应带原文细节（对照旧错误答案）
- 工具调用纪律：ask 阶段 memory_read/status 调用率正常

## 八、终止

- 实现超预算（超过一轮确认外的重大返工）
- 评测显著低于基线（m401oacc < 70%）且修复两轮无效 → 停止，回退 0.2.1 基线

---
## 与已验证路径的关系

本轮评测已证明：**原文落盘（raw/conversation.md）→ journal 灌原文 → ask 按时间窗检索**，把 71.32→75.31（+3.99pp）/ 68.33→72.57（+4.24pp）。v0.3.0 正是把这条"原文兜底"正式机制化：单元=原文 md（对应 raw/journal 的原文），冷储=episodic 归档，图谱补上"谁与什么相关"的关系维度。
