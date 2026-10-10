# dsh-linghun-memory（灵魂记忆） — 记忆体方案 · 记忆完全本体化

给 DeepSeek Harness 装上**记忆体**：海马体不再存叙述摘要，而是按**结构化三型条目**写入，warm 层按 kind 分组原生渲染即三本体——记忆本体 / 知识本体 / 规则本体，读写两侧完全本体化。

## 核心机制

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

**本体投影（BEAM 验证机制回灌）**
- `memory_project`：warm 按主题桶 LLM 聚合 → ontology.md 主题节点，组装侧「本体主题索引优先 + BM25 兜底」

## 安装

```bash
dsh plugin --profile web add dsh-linghun-memory
```

## 许可

AGPL-3.0（Copyright (c) 2026 山越野人 & 岚客）
