# Glassmorphism Plus Changelog

本文件只记录 **Glassmorphism Plus** 自己的发行版本。原始 Glassmorphism 的版本历史请查看[上游仓库](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases)；Plus 的选择性同步记录见 [UPSTREAM.md](UPSTREAM.md)。

## [2.7.3] - 2026-09-06

### Changed

- 当前维护者、正式仓库和有效发布链接统一为 VoyagerProbe；页脚仅保留由 manifest 构建版本提供的 `v<version> · VoyagerProbe`，仓库上游归属与 LICENSE 保持。
- 永久验证与报告流程按变更风险执行必要门禁，复用一致依赖和构建产物，不重复执行无关矩阵。

### Fixed

- PingChart 任务统计 Tooltip 使用配套、不透明的 popover 背景与前景色；深浅主题及打开时切换主题均保持可读，数值与单位不换行，窄屏使用局部布局。
- 列表 Ping 单元格复用既有停用快照保留机制，避免旧列表离场时回退为空灰格；节点、任务与可见权限身份变化会使保留失效，原有订阅仍立即停止。

### Compatibility and performance

- 未修改 Ping RPC、请求参数、Metric／Legacy、共享缓存、调度器、任务配置、bucket 或图表统计公式；未新增依赖、请求或 timer，继续兼容 Komari `1.4.3`。

## [2.7.2] - 2026-09-04

### Fixed

- 首页节点卡片的每个有效 Ping 任务现在始终渲染同一共享窗口内的 20 个三分钟 bucket；最新槽由既有窗口结构直接提供，正常与异常任务同步显示，不再因 `PENDING` 透明规则看似缺少最右一格。
- 将既有 `PENDING` 与 `CONFIRMED_MISSING` 分别映射为独立的 `WAITING_SAMPLE`／“等待采样”和 `NO_SAMPLE`／“无采样”展示语义；旧空槽仍须在时间推进、既有写入宽限结束且成功查询覆盖后才收敛，late backfill 可原位恢复真实数据。
- `WAITING_SAMPLE` 精确复用 v2.6.0 中性灰色 token；`NO_SAMPLE` 迁移复用 v2.7.1 原延迟不可达的红色对角斜纹、透明度与内描边；真实 `latency=null + loss=100%` 的 `UNREACHABLE` 两条轨道统一复用现有 `--ping-outage` 实心红色。
- 当前等待 bucket 恢复既有 Tooltip 触发路径和 ARIA 文案；“等待采样”“无采样”“探测不可达”“更新失败”“任务失效”保持互不混用，空值不显示或统计为 `100%` 丢包。

### Compatibility and performance

- Ping RPC、请求参数、Metric／Legacy、缓存键、共享 scheduler、timer、任务绑定、长范围图表、首页卡片尺寸与双轨几何均未修改；未增加生产依赖或请求。
- 继续兼容 Komari `1.4.3`。

## [2.7.1] - 2026-09-04

### Fixed

- 首页节点卡片将成功查询后仍为空的已结束 Ping bucket 明确收敛为“无采样”：延迟与丢包保持空值、不计入平均，并使用红色低透明斜纹内描边，与真实 `100%` 丢包的不可达实心红状态区分。
- 当前采集桶始终保持等待；刚关闭的桶沿用既有写入宽限与有限重试预算，连续离线桶可各自收敛，迟到真实样本仍可把“无采样”恢复为数据或不可达。
- 移除首页 Header 工具按钮重复的黑色自定义 Tooltip，只保留浏览器原生 `title`，并保留 `aria-label` 与键盘焦点能力。
- Header 主题快捷入口改为“浅色模式／北京时间自动／深色模式”三个直接选择按钮；访客显式偏好沿用既有本地键并优先于后台默认，“北京时间自动”复用现有 UTC+8 07:00–18:59 明亮、19:00–06:59 暗色的中央时钟逻辑。

### Compatibility and performance

- Ping RPC、请求参数、Metric／Legacy、批处理、去重、缓存键、调度器、并发、任务目录、长范围图表、绑定与三分钟 20 bucket 几何均未修改；未增加生产依赖、请求或 timer。
- 继续兼容 Komari `1.4.3`。

## [2.7.0] - 2026-09-04

### Fixed

- 节点详情页与首页 Ping 弹窗共用同一显示时间域：相对范围的右边界收紧到当前已选中且可见任务中的最新最终真实样本，不再显示所有曲线结束后的共同空白尾部。
- 保留请求窗口原始左边界、7／14／30 天多层历史、自定义固定范围和内部真实缺口；不复制末值、不插值、不添加合成终点，继续使用 `connectNulls: false`。

### Changed

- 浅色主题首页 NodeCard 外沿改为由既有玻璃边框与文字 token 混合出的轻量边界；三块信息面板与 Ping 任务条使用同一语义来源的内描边，在图片、模糊和遮罩背景下更易分辨。
- 深色主题卡片边框、背景、阴影与 Ping 颜色保持不变，四种 NodeCard 尺寸及单任务／三网布局继续保持原有几何。

### Compatibility and performance

- Ping RPC、请求参数、Metric／Legacy 选择、归一化、缓存键、刷新调度、长范围 coverage、三分钟 bucket、Tooltip 与任务绑定均未修改；展示域重算不新增请求、timer 或生产依赖。
- 继续兼容 Komari `1.4.3`。

## [2.6.0] - 2026-09-04

### Changed

- 将公开 Ping 页面文案统一为“延迟监测中心”“延迟任务概览”和“延迟任务配置”。
- 延迟任务概览卡片移除冗余的延迟／丢包摘要，只保留任务名称、ID、类型、间隔、覆盖数量与覆盖节点。
- 覆盖节点改为带标题的自动换行胶囊标签列表；长列表使用有界滚动，避免撑坏任务卡片并保留全部节点信息。

### Compatibility

- 本版仅调整延迟任务概览页面与对应入口文案；首页节点卡片、三网监控、延迟／丢包 bucket、Tooltip、任务绑定、API／RPC 与指标读取逻辑保持不变。
- 继续兼容 Komari `1.4.3`，未增加生产依赖。

## [2.5.0] - 2026-09-03

### Hotfix

- 修正干净生产构建遗漏 Komari 1.4.x `/api` 基址、导致公开首页错误请求 `/rpc2` 并进入全局 RPC 错误状态的问题。
- 区分 JSON-RPC application error、真实网络故障与主题初始化故障；Retry 在基础网络恢复后可直接重新载入节点。
- 增加公开启动、可选 Ping／汇率失败隔离、HTTP 200 RPC error、网络恢复与构建资产引用完整性回归；版本继续为 `2.5.0`。

### Changed

- 首页 NodeCard Ping 统一为同一小时窗口内对齐的 20 个三分钟半开区间；Tooltip 同时展示固定 bucket 区间和最新真实样本时刻，不再把两者混为一个时间。
- OPEN / PENDING 采集槽保留固定几何，但在有真实结果或确认的不可达、缺失、错误前不可见、不可交互且不显示等待 Tooltip。
- 价值与费用明细在 iPhone 与其他小屏上改为 safe-area 内的近全屏内部滚动布局，使用固定标题、响应式摘要、标准 Switch 与移动卡片投影；桌面表格保持原样。

### Compatibility and performance

- 保留既有 task/node identity、Metric/Legacy fallback、有限重试、grace/deadline、heartbeat、cleanup、late backfill、计费算法与 API/schema 契约。
- 12 节点 × 3 任务仍只使用共享窗口与有界请求；Chromium 完整回归 188/188、WebKit desktop + iPhone 376/376 通过。

## [2.3.1] - 2026-09-03

### Changed

- 为同一真实样本中 `latency = null` 且 `loss = 100%` 的明确不可达状态加入独立强错误红色；严重高延迟或部分丢包继续使用 critical degradation 色，不再与完全不可达同色。
- 移除 NodeCard Ping 任务条原生 `title`，任务摘要统一由信息图标触发即时 portal Tooltip，并支持 hover、focus、点击／触摸、Esc、外部点击与 viewport 碰撞处理。
- 时间桶改用同一自定义 Tooltip 系统，标签／数值 grid 可完整容纳三位数延迟、100% 丢包、不可达、缺失、等待与更新失败状态。
- task header 使用稳定 grid，为任务名、延迟、丢包和信息图标保留独立空间；四种卡片尺寸的单任务／三网模式继续保持双轨各 20 格固定几何。

### Compatibility and release

- 既有 task identity、Metric／Legacy 查询、归一化、缓存、fallback、timer、scheduler 与 subscriber 均未改写；Tooltip 交互不新增 RPC。
- 正式 Release 默认上传本地已验证客户安装 ZIP 作为唯一自定义 asset；ZIP 继续留在 Git 之外，上传后须回下载并复核 SHA-256、根结构与 manifest。

## [2.3.0] - 2026-09-03

### Changed

- 修正 NodeCard Ping 延迟严重度误判：`158–180ms` 不再直接显示为严重红色；延迟按 `60 / 100 / 160 / 200ms` 分级，`>200ms` 才进入严重档，丢包继续独立判级。
- 强化延迟／丢包双 20 格的固定标签栏，在 mini、compact、comfortable、large、单任务／三任务及深浅模式下保持固定 bucket 几何与更清晰的信息层级。
- 每个 bucket 的 hover／focus Tooltip 统一展示同一任务、同一时间点的延迟与丢包；等待、暂无采样、更新失败和不可达使用互不混淆的文案。
- 真实 `latency = null` 且同点 `loss = 100%` 的观测明确显示为不可达：延迟轨和丢包轨均使用错误红，摘要保持 `延迟 -`／`丢包 100%`；单独的 null、补点空值与失败请求不会冒充不可达。

### Compatibility and performance

- 本版仅调整 NodeCard Ping 展示判定、样式与回归测试；既有 task identity、Metric／Legacy 归一化、分桶、缓存、fallback、共享 scheduler、timer 与 subscriber 均未改写。
- 新增阈值边界、正常／部分丢包／不可达／等待／确认缺失／请求失败、Tooltip 成对语义，以及四种尺寸 × 单／三任务 × 桌面／平板／移动端 × 深浅模式的固定几何回归。

### Credits

- 延迟分级和色彩语义参考了 Komari-Theme-LuminaPlus v1.3.1 的公开行为；实现仍为 Glassmorphism Plus 架构内的 clean-room reimplementation，详见 [CREDITS.md](CREDITS.md)。

## [2.2.0] - 2026-09-02

### Changed

- 首页 NodeCard Ping 延迟与丢包轨道统一为固定 20 格；mini、compact、comfortable、large 使用明确的固定高度、bucket gap 与行间距，数值、hover、focus 和 tooltip 不再改变几何。
- 100% 丢包统一显示为 `延迟 -` 与唯一的 `丢包 100%`；延迟轨标记不可达，丢包轨显示完整红色 bucket，不制造 `0 ms` 或跨任务数据。
- Ping 监控中心的三网监控开关改用标准 Switch 并移至全局配置右上区域，支持键盘和 ARIA；切换仍只修改草稿，关闭不删除任务 2／3 ID。
- 单节点与批量继承流程移除重复的“恢复继承”入口；“继承全局”在完成后统一删除节点 override，取消编辑不会修改草稿。

### Compatibility and performance

- 继续使用既有 v3 配置、task identity、task-grouped Metric 查询、精确 pair fallback、缓存与单一 sample-aware scheduler；本版不新增生产依赖、Ping RPC、timer 或 subscriber。
- 补充四种卡片尺寸、正常／高延迟／部分与完全丢包、等待／缺失／错误／失效、tooltip 几何、Switch 草稿与 reload、继承取消／保存失败及请求不回归测试。

## [2.1.0] - 2026-09-02

### Changed

- 首页 Ping 显示由 1／2／3 项选择收敛为单任务与三网监控两种全局模式；关闭三网仅隐藏任务 2／3，不删除既有任务 ID。
- Ping 监控中心统一为简体中文，主筛选精简为全部、继承全局、单独配置和需要处理，并支持点击覆盖状态进行精确筛选。
- 重新排列全局任务配置、单节点配置和批量工具栏，保留搜索组合、跨筛选选择、未保存修改提醒与并发保存合并。
- NodeCard Ping 区域改为固定任务条，明确标示延迟和丢包双 20 格轨道；单任务及三网模式在 mini、compact、comfortable、large 与移动端保持稳定高度。

### Compatibility and correctness

- 新增不透明的 `nodeCardPingDisplayConfigV3`；v2.0 `displayCount=1/3` 分别迁移为单任务／三网模式，`displayCount=2` 保留前两项并把第三项明确留空，不自动猜测任务。
- v1／v2 设置原值继续保留，v3 迁移与序列化保持幂等；保存时只合并 v3 key，并在写入后重新读取验证。
- 正常任务不再重复显示“有效数据”；等待采样、暂无采样、更新失败、任务失效、未配置与 100% 丢包保持同一几何结构和严格 node／task identity。
- 任务目录按需预取，既有 task-grouped 查询、精确 pair fallback、缓存与调度管线保持不变；卡片尺寸和配置筛选切换不增加 Ping 请求。

### Credits

- 三任务信息层级和管理流程参考了 Komari-Theme-LuminaPlus 的公开行为；实现仍为 Glassmorphism Plus 架构内的 clean-room reimplementation，详见 [CREDITS.md](CREDITS.md)。

## [2.0.0] - 2026-09-02

### Added

- 首页节点卡支持按全局默认或每服务器 override 显示 1、2 或 3 个真实 Ping task，并完整适配 mini、compact、comfortable 与 large。
- 将现有心跳入口升级为统一 Ping Center：访客可查看公开概览，管理员可配置全局默认、单服务器 override 与多服务器批量设置。
- 新增版本化、不透明的 `nodeCardPingDisplayConfigV2`，含严格 parser、validator、deterministic serialization、coverage 与 orphan recovery。

### Changed

- 首页 Ping 数据改为 task-grouped 多 entity batching、精确 pair fallback、共享 Promise／cache／persistent snapshot，以及单一 sample-aware scheduler。
- 列表模式显示第一个有效任务；详情页继续使用既有 aggregate Ping 图表，不把首页 selected-task 设置错误带入详情查询。
- 测试构建不再生成 installer；只有正式 `bun run build` 会创建版本化本地 ZIP，避免覆盖历史 release artifact。

### Compatibility and security

- v1.x `nodeCardPingTaskBindings` 自动迁移为一任务显示且原始 bytes 保留，升级与降级均不丢设置。
- 保存前重新读取最新管理员 settings，只 merge v2 key，并重新读取验证；401／403、logout、快速重新登录与 in-flight request 均按 session 隔离。
- 每个 task 必须真实包含节点 UUID；Metric、Legacy、cache 和 fallback 均保持精确 node／task identity，不混入 aggregate 或其他任务数据。
- 保留 `0 ms`、`0%`、`100% loss`、PENDING／DATA／CONFIRMED_MISSING、late backfill、outage gap 与长范围历史语义。

### Credits

- 多 Ping 配置与加载体验参考了 Komari-Theme-LuminaPlus 的公开行为；实现为 Glassmorphism Plus 架构内的 clean-room reimplementation，详见 [CREDITS.md](CREDITS.md)。

## [1.4.0] - 2026-08-24

### Changed

- 选择性同步上游 Glassmorphism v3.3.6：平铺地图不再强制固定六张总览卡片，而是遵循 Plus 的总览卡片配置和顺序。
- 选择性同步上游 Glassmorphism v3.3.7：历史查询中 `net.total.up` 与 `net.total.down` 使用每个 bucket 的最后值，普通 gauge 保持平均聚合。
- 区分包含不同 per-metric aggregation 的请求缓存键，并强化不支持新参数时的 Legacy fallback。
- 防止快速切换历史范围时，较早的慢响应覆盖较新的选择。

### Documentation

- 主 README 改为 Plus 自有身份、功能、安装、兼容性和版本体系。
- 新增 Plus-only CHANGELOG 与上游同步记录，重整维护者、原作者和 LICENSE 边界。
- 明确 v1.4.0 GitHub Release 不附加客户安装 ZIP；installer 只在本地生成和验证。

## [1.3.6] - 2026-08-14

- 为 30 天 Ping 范围加入多层历史覆盖，在保留近期细节的同时覆盖完整查询区间。
- 长范围数据继续保留真实断网缺口，不用错误连线填补无数据时段。

## [1.3.5] - 2026-08-13

- 修正 30 天 Ping 图表的时间域，使横轴对应完整选择范围。
- 保留 outage gap，避免跨缺失区间绘制误导性连线。

## [1.3.4] - 2026-08-12

- 恢复 Ping 图表“平滑峰值”控制。
- 为 Ping 图表加入 7 天与 14 天范围。
- 修复 iPhone Safari safe-area、弹窗与路由切换后的底部异常区域。

## [1.3.3] - 2026-08-11

- 将首页 Ping 时间桶区分为 `PENDING`、`DATA` 与 `CONFIRMED_MISSING`。
- 支持真实迟到样本回填，避免新采样尚未写入时过早显示为缺失。
- 保留真实空桶，不复用旧值或伪造时间戳。

## [1.3.2] - 2026-08-11

- 调整 Ping 面板和移动端布局对齐。
- 统一本地发布工作区、release snapshot 与版本化安装包路径。

## [1.3.1] - 2026-08-11

- 修正旧快照和不同任务缓存串用，避免切换后显示过期 Ping 结果。
- 加强 managed theme 选择控件与卡片趋势条几何一致性。

## [1.3.0] - 2026-08-11

- 选择性吸收上游 v3.3.4／v3.3.5 的适用修复，同时保留 Plus 行为。
- 统一 Ping 丢包语义、任务顺序与指定任务 fallback。

## [1.2.1] - 2026-08-07

- 加入以节点 UUID 为中心的每节点 Ping task 绑定。
- 候选任务根据后端 `task.clients` 关系过滤；首页按节点读取指定任务并在失效时回退原聚合。

## Historical tags - 2026-07-31

Git tags `1.0`、`1.1` 与 `1.2` 指向同一历史 commit。现有证据不足以为这三个 tag 分别重建独立、可靠的变更列表，因此这里只保留历史事实，不推测具体修复内容。

[2.7.3]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v2.7.2...v2.7.3
[2.5.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v2.3.1...v2.5.0
[2.3.1]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v1.4.0...v2.0.0
[1.4.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/compare/v1.3.6...v1.4.0
[1.3.6]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/v1.3.6
[1.3.5]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/v1.3.5
[1.3.4]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/v1.3.4
[1.3.3]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/v1.3.3
[1.3.2]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/v1.3.2
[1.3.1]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/v1.3.1
[1.3.0]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/1.3.0
[1.2.1]: https://github.com/VoyagerProbe/Glassmorphism-Plus/releases/tag/1.2.1
