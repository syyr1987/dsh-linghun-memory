# dsh-linghun-memory（灵魂记忆） — 记忆体方案 · 记忆完全本体化

给 DeepSeek Harness 装上**记忆体**：这是一整套插件——**收口者灵魂卡（身份 + 判断纪律）** + **记忆体方案（读写两侧完全本体化）**，两者一体交付，独立于原 dsh-linghun 演进（两条线并行，互不覆盖）。

## 一整套：收口者 + 记忆体

**收口者灵魂卡（identity.js，随插件注入）**
- `DEFAULT_IDENTITY`：认知架构垫底——收口者身份锚点（大模型供直觉、你做收口）、行为纪律（承接即预检·方法论并入、拒绝伪约束）、方法论工具箱、成长（海马体 memory_* 主动沉淀）
- `DEFAULT_JUDGMENT`：边界判断纪律——模糊概念/悖论/身份/能力/知识/伦理七类边界扫描 + 置信度声明 + 价值排序（诚实>友善>有用）+ 判分收口职责
- `MEMORY_DISCIPLINE`：记忆使用纪律（记忆体适配版）——注入段按序承载「知识本体 → 规则本体 → 事件时间线 → 冷储摘要」；需要近期具体事实时用 `memory_read` 按需直读本体（fact 直读知识本体、event 直读事件时间线、rule 直读规则本体，查证=查节点），读到即用 `memory_touch` 标记
- 注入方式：`soul:identity`（灵魂卡）+ `soul:judgment`（判断纪律）两个 section，由插件自动垫底，用户人设卡在上、架构在下，冲突时架构优先

**记忆体（memory.js + ontology.js，见下）**

> 说明：为适配记忆体提示词，收口者纪律已做对应调整（MEMORY_DISCIPLINE 按三本体注入顺序重写）。这是与 dsh-linghun（原灵魂线）**并行独立的两条线**——memory 线以记忆体方案为主线，原 linghun 线保持钉版不动。

## 记忆体核心机制

**写侧（memory_append，结构化三型）**
- `event`（事件 = 记忆本体）：`主语 | 动作 | 宾语 | 关联实体 | 细节`——时间线
- `fact`（事实 = 知识本体）：`实体 | 属性 | 值 | 来源#`——精确值，可回溯
- `rule`（规则 = 规则本体）：一句可执行纪律

一条目一事实，置信度三档（high/medium/low），低置信注入带【低置信·需验证】标记；`update` 翻转旧条目（标记 wrong）。

**读侧（warm 按 kind 分组原生渲染 = 三本体）**
- 不再需要外部投影脚本：海马体自己就是三本体
- 三本体档案固化：`memory_ontology.md`（事件时间线）/ `knowledge_ontology.md`（精确值）/ `rules.md`（纪律）
- 回答纪律：定位（时间窗口+主题命中）→ 精筛 3-8 条 → 翻译成人话；查到的照实说、口径写清楚、没查到明说没有

**读写沉淀闭环**
- `memory_read`：按需读取暖态近期记忆
- `memory_touch`：标记「刚刚被用到」，吃灰管理（一直不用的沉底挤出）
- `memory_consolidate`：沉淀——event→记忆本体时间线、fact 高置信→知识本体、rule→规则本体
- 序时账（journal）每次对话全量留痕、情景归档（episodic）冷储

**目标系统（goal.js，v0.1.1 新增 → v0.1.5 增强）**
- 目标 = 记忆的骨架：事件/状态/信念挂在目标上；认知循环「实践→认识→再实践」的未来维度（不只提炼过去的因果，还提炼想创造的未来）
- 写侧 `linghun_goal_update`：目标信号合并（new/progress/change/achieve/abandon），同 speaker 同主题自动合并不重复建档；v0.1.5 起价值观/底线陈述（I believe in… / I refused to…）也收录（belief 域）；high/medium 目标附 1-2 条 Bridge 触发词（triggers：什么处境会激活它）——写时轻量结构化、**不穷举**
- 读侧 `linghun_goal_get`：残差触发 `触发分 = α·sim + β·goalActivate`——纯相似度是 goal/value 类联想的盲区（MADELEINE 实证漏检 33–43%），目标激活分补上；v0.1.5 激活分 = `stateW × (0.25·domainHit + 0.35·bridgeHit + 0.40·sim + 0.15)`，Bridge 命中（触发词与处境共现 ≥2 token）补上语义远距联想；achieved/abandoned 不再触发
- `linghun_goal_state`：状态机查询（active/paused/achieved/abandoned）
- 两条纪律：不做「匹配判断」做「目标激活」；写侧只加 1-2 条结构化触发词、**绝不写侧穷举**（对比 T-Mem/HyperMem 千次写时调用，成本低两个数量级）
- 注入：目标主线（active 目标按 priority）随记忆段渲染，配合目标激活纪律提示

**评测（LoCoMo-Plus，16 题 × 独立 home，官方 Memory Awareness Judge）**
- **v0.1.4 14/16（87.5%）→ v0.1.5 16/16（100% 满分）**：题 12（college fund 语义远距）、题 13（拒绝谣言价值观）双双转正，零回归
- 机制验证：题 12 college fund 目标靠 Bridge 触发词从排 18/24 → #5（score 0.150）；题 13「尊重隐私、不散播谣言」belief 目标建档后排 #1（score 0.581）
- 结论：真正的杠杆在目标档案结构化 + 读侧重匹配，不在写侧枚举预算——写侧只需每条目标 1-2 条触发词

**本体投影（BEAM 验证机制回灌）**
- `memory_project`：warm 按主题桶 LLM 聚合 → ontology.md 主题节点，组装侧「本体主题索引优先 + BM25 兜底」

## 与 dsh-linghun 的关系

| | dsh-linghun（原灵魂线） | dsh-linghun-memory（记忆体线） |
|---|---|---|
| 主线 | 收口者 + 叙述式海马体 | 收口者 + 记忆完全本体化（三型三本体） |
| 状态 | 钉版（0.4.x 保持不动） | v0.0.1 起独立演进 |
| 提示词 | 原版收口者纪律 | 记忆体适配版（MEMORY_DISCIPLINE 三本体注入序） |

两条线并行发布，`dsh-linghun-memory` 的调整不影响 `dsh-linghun`。

## 安装

```bash
dsh plugin --profile web add dsh-linghun-memory
```

## 致谢

感谢 **Zhiyun Shi** 对本项目的支持与帮助。

## 许可

AGPL-3.0（Copyright (c) 2026 山越野人 & 岚客）
