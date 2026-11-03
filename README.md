# dsh-linghun-memory（灵魂记忆） — 记忆体方案 · 记忆结构化

给 DeepSeek Harness 装上**记忆体**：读写两侧结构化（事实/规则→两本体，事件→记忆文件），独立于原 dsh-linghun 演进（两条线并行，互不覆盖）。

## 认知同步（2026-10-25，源码侧；未发版，package.json 仍 0.4.0）

**上下文工程领域建层吸收（与领域层本体联动，不重复造）。** 新认知同步进 `identity.js` 输入侧纪律：

- **上下文工程纪律（MEMORY_DISCIPLINE 追加）**：上下文工程本质是引导大模型固定状态→智能体记忆状态，核心是引导怎么走——不是塞什么料，是排什么路径。对应记忆侧动作：进前降噪（渲染/布局阶段过滤）、多轮检索直到翻到（memory_read 按需 + memory_touch 标记活跃）、检索侧 bait 过滤兜底 prompt 层压不住的数字锚定。
- **海马体 v3.0 语料拼装工作台定位**：海马体负责备料——提取冷储、多轮检索翻到；优势=进上下文前剔除无关降噪（上下文不能删）；思考在拼好语料上进行。
- **证据聚焦甜点区**：方向性检查采信（提及⇏定义、值出现⇏属性断言）；防御规则自身也有甜点区，过度工程化反伤（R-E23 实证：v3 属性错配 7/9 < v2 值对齐 8/9）。
- 领域层锚点：`领域层/上下文工程领域/`（R-500~532）、`领域层/数学领域/`（R-460~463 充要方向、R-470~476 方法论工具箱）、`领域层/实验领域/`（R-E21~E23）。

## v0.4.0 更新（2026-10-22）

**定位回归：memory 回归记忆定位，收口者回到 linghun 侧。** 本版本不再注入收口者（身份锚点 / 判断纪律 / 用户人设模板），只注册记忆 section（`soul:linghun-memory`）；收口者（灵魂卡）由 `dsh-linghun` 收口者线提供。保留 `MEMORY_DISCIPLINE`（输入侧纪律）、`PROFILE_DISCIPLINE`（画像纪律）、`COGNITION_CYCLE`（认知循环=记忆组织方式）。

**成本硬伤简化：发布期自包含 vendor 内嵌。** 记忆体存在成本硬伤——若依赖未发布的公共包 `dsh-hippocampus`，会在安装/评测沙箱断链路（npm 依赖解析失败），属于不可接受的成本。v0.4.0 将海马体以 `vendor/hippocampus.js` 副本打入发布包，**零 npm 依赖、零审核等待**，评测钉版（0.3.0 tgz）不受影响。开发期真源仍为三方共享单例（`dsh-hippocampus/index.js`），发布副本由 `scripts/sync-vendor.mjs` 同步（`--check` 校验）。

**LoCoMo-Plus 全量成绩（m401，程序化索引画像）**

| 路线 | acc |
|---|---|
| 闭卷基线 m401oacc（0.1.8） | 75.31% |
| **m401v4（程序化索引画像）** | **92.52%（371/401，+17.21pp）** |
| 开卷（全文直答） | 94.76% |

画像成本归零（87%→0）的前提下，全量只比开卷低 2.24pp——程序化路标 + 原文检索这条路线成立。

## 记忆体核心机制

**写侧（memory_append，结构化三型）**
- `event`（事件 = 记忆）：`主语 | 动作 | 宾语 | 关联实体 | 细节`——时间线
- `fact`（事实 = 知识本体）：`实体 | 属性 | 值 | 来源#`——精确值，可回溯
- `rule`（规则 = 规则本体）：一句可执行纪律

一条目一事实，置信度三档（high/medium/low），低置信注入带【低置信·需验证】标记；`update` 翻转旧条目（标记 wrong）。

**读侧（warm 按 kind 分组原生渲染 = 两本体）**
- 不再需要外部投影脚本：海马体自己就是两本体加记忆文件
- 本体档案与记忆文件固化：`memory_ontology.md`（事件时间线）/ `knowledge_ontology.md`（精确值）/ `rules.md`（纪律）
- 回答纪律：定位（时间窗口+主题命中）→ 精筛 3-8 条 → 翻译成人话；查到的照实说、口径写清楚、没查到明说没有

**读写沉淀闭环**
- `memory_read`：按需读取暖态近期记忆
- `memory_touch`：标记「刚刚被用到」，吃灰管理（一直不用的沉底挤出）
- `memory_consolidate`：沉淀——event→记忆时间线、fact 高置信→知识本体、rule→规则本体
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

**记忆地图（检索图方案，v0.1.7 新增）**
- 写侧只建图、读侧按图回溯：把沉淀产物组织成四轴导航注入读侧——情境轴（暖态主题索引 + `[n]` 编号指针）/ 目标轴（目标速览 domain·state·priority）/ 档案轴（本体节点索引：知识/规则/时间线/冷储）/ 证据层（序时账 + 情景归档索引）
- 地图是索引密度（导航不倾倒，默认 2000 字预算），细节由认知主体用 `memory_read`（`[n]` 编号/本体直读）或 `memory_journal`（时间窗口）下钻；能解决就停
- 编号对齐 `memory_read` 原始 `parseWarm` 索引；`map.enabled=false` 可关
- 来源验证：白板按图回溯评测（LoCoMo-Plus 401 题全量，deepseek-chat + 地图注入）83.04%，首次超过 v015 候选注入（80.05%）——「读侧放权给图让模型自走 > 读侧代劳替模型选候选」；goal 型 +13pp 是目标轴红利，value 型 −9pp 暴露难桥（行为↔价值观）需写侧补 triggers

**人物画像层（v0.2.1 新增）**
- 画像 = 记忆的第一索引键（主体轴）：记忆先按主体分家（owner=你 / assistant=我 / 第三方=他），每条 warm 条目可带 `@主体` 标签
- 数据层：`$DSH_HOME/linghun/profiles/<subject>.md`，每主体一文件；六槽画像——fact（是什么）/ state（在忙什么）/ goal（想要什么）/ value（底线）/ causal（来龙去脉）/ preference（偏好）
- 写侧 `linghun_profile_update`：向主体画像槽位沉淀/更新要点（`update` 命中旧条目标注 ⚠️ 已更新）；`linghun_memory_append` 新增 `subject` 参数，warm 标题行带 `@主体`，可按主体过滤
- 读侧 `linghun_profile_get`：读六槽全文或指定槽；注入段带画像速览（主体名 + 一句话摘要，默认 300 字预算）+ PROFILE_DISCIPLINE 纪律
- 检索路径：视角 → 画像 → 情境 → 细节——画像只给精炼要点，细节用 `linghun_memory_read` 下钻（warm 条目带 @主体 标签可按主体过滤）
- 关系：USER / SOUL / CONTACT = 三张画像的胚胎 → v0.2.1 统一成 profiles/ 一层；记忆地图（map.js）是索引密度导航、画像层是它的主体轴；目标系统（goal.js）的 goal 槽与目标主线互链
- 产品形态说明：LoCoMo profile 轴（profile_index）是画像召回的评测版，人物画像层是它的产品化——不是 LoCoMo 优化，是记忆的第一索引键

## 技术报告

- [v0.1.7 技术报告（docs/TECH_REPORT_v0.1.7.md）](docs/TECH_REPORT_v0.1.7.md)：记忆地图检索图方案全量技术文档——系统设计 / 评测结果 / 设计原则 / 版本线

**ACC（Agentic Cognitive Control，v0.2.0 新增）**
- 把记忆检索/领域加载的控制权交给模型：默认（`acc.enabled=false`）保持自动注入不变；开启后注入收窄为核心导航层（记忆地图 + ACC 纪律 + 目标主线），素材全部走工具主动获取
- `linghun_retrieval_probe`：给候选不给结论——BM25 + ref 过滤产出 top_k 候选（默认 8，上限 20），模型挑 1-3 条 `memory_read` 精读（agentic RAG：模型决定读什么，而非系统替它选）
- `linghun_domain_load`：领域按需加载（load/unload/status，TTL 默认 30min 自动回收）；内置五域（code/writing/analysis/planning/locomo，工作纪律+检索导航），`$DSH_HOME/linghun/domains/<name>.md` 自定义覆盖（文件优先）
- `linghun_memory_status`：状态可见——暖冷规模、目标、已加载领域、可用工具清单，让模型先盘点再决策
- 评测：A/B 对照（A=自动注入现行为 / B=ACC 主动模式），指标含任务成功率 + 信息决策（检索命中率/精读条数/注入 token 成本/领域加载次数），跑通后再全切注入策略

## 与 dsh-linghun 的关系

| | dsh-linghun（灵魂旧线） | dsh-linghun-memory（记忆体线） |
|---|---|---|
| 主线 | 收口者（身份锚点 + 判断纪律） | 记忆结构化（三型两本体） |
| 状态 | 钉版（1.0.x 不动） | v0.0.1 起独立演进；v0.4.0 回归记忆定位，收口者回 linghun 侧 |
| 提示词 | 原版收口者纪律 | 记忆体适配版（MEMORY_DISCIPLINE 两本体注入序） |

两条线并行发布，`dsh-linghun-memory` 的调整不影响 `dsh-linghun`；收口者（身份/判断）统一由 `dsh-linghun` 提供，记忆体插件不再重复注入。

## 安装

```bash
dsh plugin --profile web add dsh-linghun-memory
```

## 致谢

感谢 **Zhiyun Shi** 对本项目的支持与帮助。

## 许可

AGPL-3.0（Copyright (c) 2026 山越野人 & 岚客）
