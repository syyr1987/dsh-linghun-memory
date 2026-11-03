# 人物画像层 v1（dsh-linghun-memory v0.2.1）

> 设计定案：2026-10-20 主客对话。画像 = 记忆的第一索引键（主体轴）。这不是 LoCoMo 优化，是产品形态——"画像就是记忆的家"。

## 问题

检索不缺，缺的是**记忆的归属**：每条记忆不知道自己是"谁的记忆、关于谁、对谁说的"，捞出来就是噪音。按图索骥的前提是图上有主——主体分界就是图的主键。

## 方案

**画像 = 记忆的第一索引键（主体轴）**
- 你（owner/主人）、我（assistant/助手）、他（第三方，按名字动态建档）各一张画像
- 每条记忆入档先打主体标签：谁说的（speaker）/ 关于谁（about）/ 对谁说的（addressee）
- 检索先定位画像再下钻，天然按主体过滤——直接掐掉噪音源头

**画像六槽**（fact/state/goal/value/causal/preference）：
- fact：稳定事实（身份、关系、职业）
- state：动态状态（现在在忙什么、情绪水位）
- goal：目标意图（近期要什么、在推什么）
- value：原则底线（价值观、雷区）
- causal：因果背景（来龙去脉、为什么是这样）
- preference：偏好（沟通、口味、习惯）

**挂载关系**：情境/事件/对话全挂在画像下——"这个人的这条情境"。上层是视角（你我他），下层是时间轴。

**检索路径**：视角 → 画像 → 情境 → 细节
1. 视角：这条记忆/这个问题属于谁（owner/assistant/第三方）
2. 画像：linghun_profile_get <主体> 读六槽精炼要点
3. 情境：画像只给精炼，细节用 linghun_memory_read 下钻（warm 条目带 @主体 标签可按主体过滤）
4. 细节：本体/时间线/序时账

## 实现

### 数据层
- 目录：`$DSH_HOME/linghun/profiles/<subject>.md`，每主体一文件
- 文件格式：六槽分组（`## fact` / `## state` / `## goal` / `## value` / `## causal` / `## preference`），槽内条目 `- 要点（置信度 high/medium/low，来源可追溯）`
- 摘要行：文件头 `> 摘要：一句话画像`（供速览注入）

### 写侧
- **linghun_profile_update**（新工具）：向指定主体的画像槽位写入/更新。参数：subject、slot、content、confidence、update（翻转旧条目）
- **linghun_memory_append 扩展**：新增 `about` / `speaker` 参数，标题行带主体标签 `## <stamp> [<kind>] <conf> @<subject>`，warm 条目可被按主体过滤

### 读侧
- **linghun_profile_get**（新工具）：读指定主体画像（六槽全文或指定槽）
- **画像速览注入**：soul:linghun-memory section 增加"人物画像层"导航段——有哪些主体 + 各画像一句话摘要（默认 300 字预算），配合 PROFILE_DISCIPLINE 纪律（先画像后下钻）

### 注入纪律（PROFILE_DISCIPLINE）
```
## 人物画像层
记忆先按主体分家：你（owner）、我（assistant）、他（第三方）各有画像，是记忆的第一索引键。
- 涉及"某人是谁 / 在忙什么 / 想要什么 / 底线 / 偏好" → 先 linghun_profile_get <主体> 读画像
- 画像只给精炼要点，细节用 linghun_memory_read 下钻（warm 条目带 @主体 标签）
- 检索路径：视角（你/我/他）→ 画像 → 情境 → 细节
- 新画像槽位由 linghun_profile_update 沉淀，系统自动写，模型不需要也不应该改档案
```

## 与现有机制的关系
- USER / SOUL / CONTACT = 三张画像的胚胎 → v0.2.1 统一成 profiles/ 一层，并作为全局挂载点
- LoCoMo profile 轴（profile_index）= 画像召回的评测版 → 画像层是它的产品化
- 记忆地图（map.js）是索引密度导航 → 画像层是它的主体轴（视角维度）
- 目标系统（goal.js）挂主体：goal 槽与目标主线互链（goal 是"想要什么"，画像 goal 槽是其主体归属）

## 验收
- [ ] profile 文件六槽可写可读（linghun_profile_update / linghun_profile_get）
- [ ] warm 条目可带 @subject，可按主体过滤
- [ ] 注入段含画像速览 + PROFILE_DISCIPLINE
- [ ] 测试通过（tests/profile.test.mjs）
- [ ] 打包 0.2.1
