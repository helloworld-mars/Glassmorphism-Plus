<div align="center">

# 🌌 Komari Glassmorphism Plus

面向 Komari Monitor 的增强玻璃拟态主题，重点强化每节点 Ping 任务绑定、长时间历史、性能、移动端体验和日常运维能力。

![Version](https://img.shields.io/github/v/release/helloworld-mars/Glassmorphism-Plus?style=for-the-badge&label=release&color=10b981)
![Vue](https://img.shields.io/badge/Vue-3-42b883?style=for-the-badge&logo=vue.js)
![Vite](https://img.shields.io/badge/Vite-7-646cff?style=for-the-badge&logo=vite)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-v4-38bdf8?style=for-the-badge&logo=tailwindcss)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.2-000000?style=for-the-badge&logo=bun)
![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)

**[功能概览](#-功能概览)** ·
**[安装与升级](#-安装与升级)** ·
**[兼容性](#-兼容性)** ·
**[本地开发](#️-本地开发)** ·
**[版本历史](CHANGELOG.md)**

</div>

---

## 📸 预览

<div align="center">

<img src="docs/preview.png" width="80%" alt="Glassmorphism Plus 主题预览" />

</div>

---

## 🚦 项目状态

| 项目               | 当前状态                                                                                                               |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------- |
| 当前 Plus 版本     | **v2.7.2**                                                                                                             |
| 上游同步基线       | [sanrokamlan Glassmorphism v3.3.7](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases/tag/v3.3.7) |
| 当前维护者         | [helloworld-mars](https://github.com/helloworld-mars)                                                                  |
| 适用平台           | [Komari Monitor](https://github.com/komari-monitor/komari)                                                             |
| 已验证 Komari 版本 | **1.4.3**                                                                                                              |
| 技术栈             | Vue 3、TypeScript、Vite 7、Tailwind CSS 4、Pinia、ECharts、Bun                                                         |
| 源码发布           | GitHub `main` 与 `v2.7.2` Release；Release 默认附加唯一、已验证的客户安装包                                            |
| 本地安装包         | `2.7.2/Glassmorphism-Plus-release-2.7.2.zip`                                                                           |

Glassmorphism Plus 是独立维护的 Glassmorphism 衍生主题，Plus 使用自己的版本体系；上游 v3.3.7 仅代表当前同步基线，并非 Plus 的版本号。同步来源、选择性合并和署名详见 [UPSTREAM.md](UPSTREAM.md)。

### ✨ 最新版本 · v2.7.2

- 首页所有节点与任务现在同步显示同一最新三分钟时间槽；尚无真实样本的当前槽以“等待采样”呈现，不再因透明样式看似少一格。
- `WAITING_SAMPLE` 使用 v2.6.0 的中性灰占位；成功查询确认的 `NO_SAMPLE` 使用 v2.7.1 原延迟不可达红色斜纹；真实 `latency=null + loss=100%` 的 `UNREACHABLE` 延迟与丢包两轨统一为现有实心故障红。
- 等待采样、无采样、探测不可达、更新失败与任务失效保持独立语义；bucket Tooltip 与 ARIA 同步，迟到真实样本仍可原位恢复为数据或不可达。
- 本版不改动 Ping RPC、请求参数、Metric／Legacy、缓存、共享调度、三分钟 20 bucket 几何、任务绑定或长范围图表行为。

---

## ➕ Glassmorphism Plus 的主要增强

在保留原始 Glassmorphism 视觉基础的同时，Plus 重点维护以下能力：

- 以节点 UUID 为中心，为首页卡片显示单个任务或固定三行的三网任务；统一延迟监测中心位于 `pingsettings`。
- 支持全局三网监控开关、每服务器继承全局／单独配置，以及严格任务交集下的多服务器批量配置。
- 任务目录、配置解析、分组查询、精确 pair fallback、缓存与共享刷新器组成同一数据管线；单任务失败不会阻塞其他任务。
- 指定任务的 Metric 与同任务 Legacy 保持严格的节点／任务归属验证；有效 selected task 不会被 aggregate 数据冒充。
- Ping 支持 1 小时至 30 天及自定义范围，并为长范围采用多层历史覆盖。
- 首页时间桶明确区分 `PENDING`、`DATA` 与 `CONFIRMED_MISSING`，支持真实迟到样本 late backfill。
- Cold/Warm Start、原始缓存桥接与 Promise 去重让卡片先恢复可靠快照，再静默刷新真实数据。
- `0 ms`、`0%` 与 `100% loss` 均采用明确数据语义；断网缺口不会被伪造或错误连线。
- iPhone Safari safe-area、弹窗滚动锁、移动端布局和返回路径经过专项回归。
- Plus 自己维护版本、发布、隐私扫描、安装包校验和桌面／移动端视觉回归流程。

这些增强是在原主题之上的维护与二次开发；原项目贡献不被重新声明为 Plus 原创。

---

## ✨ 功能概览

### 首页与节点卡片

- 卡片、列表、真实地球、点阵地球、平铺地图与隐藏地球布局。
- 总览卡片预设、自定义 keys 和顺序在所有地球布局中使用同一配置来源。
- CPU、内存、磁盘、流量、价格、到期状态、收藏、分组、搜索和快捷筛选。
- 多尺寸节点卡片、响应式密度与访客可见字段控制。

### Ping 与丢包

- 每张首页节点卡只采用单任务或三网监控模式；三网模式始终保留三行几何结构，未覆盖或失效任务不会被折叠。
- 候选任务必须真实包含该节点 UUID，重复、未分配或失效任务会被明确拦截或标记，不会由聚合结果冒充。
- 全局默认、单服务器单独配置和批量配置均由统一延迟监测中心管理；批量候选取所选服务器的严格 task 交集。
- 每个任务条明确标示延迟与丢包，并各保留 20 个固定宽高时间桶；数值、hover、focus 和 tooltip 只改变颜色或提示，不改变双轨几何。
- 100% 丢包只显示一次 `丢包 100%`，延迟明确显示 `延迟 -`；延迟轨使用不可达状态，丢包轨使用红色满丢包状态。
- 延迟、丢包与趋势条来自同一节点／任务 pair；Metric 批量查询不支持时才降级为精确 pair 请求，同任务 Legacy 是最后的数据 fallback。
- 共享 Promise、内存／持久快照和单一 sample-aware scheduler 提供快速 Warm Start，同时在 hidden／offline／unmount 时暂停或清理。
- 1 小时、6 小时、12 小时、1 天、7 天、14 天、30 天与自定义范围。
- 平滑峰值、真实 outage gap、late backfill、固定卡片时间桶与 100% loss 语义。

### 历史 Metric

- Metric Store 优先，旧 records 路径作为兼容 fallback。
- 历史范围支持实时、4 小时、1 天、7 天、30 天与自定义查询。
- 普通 gauge 按 bucket 平均；累计上传／下载 counter 按 bucket 最后值保留累计语义。
- 请求去重、缓存隔离和快速切换范围的旧响应防覆盖。

### 节点详情

- CPU／负载、内存／Swap、磁盘、网络、累计与周期流量、连接、进程、GPU、温度和 Ping 图表。
- 概览卡与图表预设、英文 key 自定义、旧配置解析和响应式分区。
- 节点切换、硬件和系统信息、供应商与运行状态展示。

### 高级工具

- 节点拓扑、节点对比、性价比、健康摘要和当前视图快照导出。
- 流量、费用、到期、离线与高负载等运维筛选。
- 登录状态下按需显示高级工具，避免普通访客误触管理能力。

### 隐私与权限

- 未登录隐藏后台入口、价格与费用信息等 managed theme 配置。
- 心跳图标向访客提供只读 Ping 概览；设置页、保存动作与管理员 API 仍以真实管理员权限为安全边界。
- “隐藏延迟任务绑定入口”只控制公开心跳入口；管理员仍可通过 `?view=pingsettings` 直接进入设置，访客永远不能保存。
- 导出二级密码、访客字段控制和发布前敏感信息扫描。

### 移动端与浏览器

- 桌面、Android、iPhone Safari 与窄屏布局。
- WebKit safe-area、动态视口、弹窗关闭和路由返回后的滚动状态修复。
- 亮色、暗色、北京时间自动模式和色觉辅助配色。

### 主题配置

- Komari managed theme 配置，无需修改源码即可调整布局、卡片、图表、背景和隐私选项。
- `pingsettings` 延迟监测中心提供公开概览及管理员设置页，采用简体中文主筛选、可点击覆盖状态、紧凑节点列表和批量操作，不要求手写任务 ID。
- v3 配置使用不透明、版本化的 `nodeCardPingDisplayConfigV3`，记录全局三网模式、三个任务槽与节点单独配置；保存前会重新读取最新 settings，并只合并本功能 key。
- v2.0 的 `displayCount=1` 迁移为单任务模式，`displayCount=3` 迁移为三网模式，`displayCount=2` 迁移为保留前两项且第三项留空的待补全三网模式；迁移不会猜测或删除任务。
- 旧 `nodeCardPingTaskBindings` 与 `nodeCardPingDisplayConfigV2` 原值均会保留，升级不要求重新配置，也保留降级读取能力；关闭三网监控只隐藏任务 2／3，不删除其 ID。

---

## 📦 安装与升级

正式源码仓库：<https://github.com/helloworld-mars/Glassmorphism-Plus>

### 重要说明

- **v2.7.2 GitHub Release 默认附加且只附加一个已验证的 installer asset：** `Glassmorphism-Plus-release-2.7.2.zip`。
- GitHub 自动生成的 **Source code (zip)** 是源码快照，**不是** Komari 可安装主题包。
- Komari 的远程仓库导入流程应使用正式 Release 中的 installer asset；仍不要用 GitHub 自动生成的源码压缩包代替。

### 方式一：本地生成安装包

Windows、macOS 或 Linux 安装 Node.js 与 Bun 后，在项目根目录执行：

```bash
bun install --frozen-lockfile
bun run lint
bun run type-check
bun run build
bun run release:prepare
```

`bun run build` 会在源码目录的上一级创建客户安装 ZIP：

```text
<version>/Glassmorphism-Plus-release-<version>.zip
```

安装 ZIP 根目录直接包含：

```text
komari-theme.json
preview.png
dist/
```

随后在 Komari 后台进入“主题管理 → 上传主题”，选择该 ZIP 并启用 **Komari Glassmorphism Plus**。

### 方式二：使用 GitHub Release 安装包

从对应版本的 [GitHub Release](https://github.com/helloworld-mars/Glassmorphism-Plus/releases) 下载 `Glassmorphism-Plus-release-<version>.zip`，核对版本与发布记录后可直接在 Komari 后台上传。不要用 GitHub 的 Source code zip 代替。

### 升级提示

- 升级前记录当前 managed theme 设置，尤其是每节点 Ping 任务绑定。
- v1.x 的单任务绑定会自动兼容为 v2 的一任务配置，原始 v1 key 不会被重写或删除。
- 上传新 ZIP 后确认站点名称、首页布局、`pingsettings`、节点详情和 Ping 长范围数据。
- Komari 后台显示的主题版本取自根目录 [`komari-theme.json`](komari-theme.json) 的 `version`。

---

## 🧩 兼容性

| Komari 版本     | 状态            | 说明                                                                                      |
| :-------------- | :-------------- | :---------------------------------------------------------------------------------------- |
| **1.4.3**       | **Verified**    | 本项目当前主要实机与回归目标。Metric Store、每节点 Ping 绑定和历史查询已验证。            |
| **1.2.6–1.4.2** | **Best effort** | 保留能力检测与 Legacy fallback，但没有对每个中间版本执行完整回归矩阵。                    |
| **1.2.5**       | **Not tested**  | 保留旧 records／Ping fallback；该版本缺少当前主要 `queryMetrics` 能力，不作完整兼容承诺。 |

兼容状态描述的是当前测试证据，不等同于对整个 `1.2.x` 系列的统一保证。部署到未验证版本前，请先在测试环境检查首页、节点详情、Ping、累计流量和管理页面。

---

## 🛠️ 本地开发

```bash
bun install --frozen-lockfile
bun run dev
bun run type-check
bun run lint
bun run build
bun run test:visual
bun run release:prepare
```

- `bun run lint` 会使用 ESLint `--fix`，执行后应检查 diff。
- `bun run test:visual`／`bun run test:webkit` 会先做不产出 installer 的测试构建，再运行 Playwright；除非有明确视觉变更，不要更新基准快照。
- `bun run build` 才执行正式 production build 与版本化 Komari installer 打包，避免测试覆盖历史版本产物。
- 首次运行浏览器测试可能需要 `bunx playwright install chromium`。
- `bun run release:prepare` 会验证 `bun run build` 已生成的客户安装 ZIP，并建立过滤后的本地 release snapshot；两者都不得加入 Git。正式发布默认将这一个已验证 ZIP 上传为唯一自定义 Release asset，随后从 Release 回下载并复核 SHA-256、结构与 manifest。

源码边界与 AI 开发规则见 [AGENTS.md](AGENTS.md)；前端目录规则见 [src/AGENTS.md](src/AGENTS.md)。

---

## 📝 版本历史

当前版本更新见上方「最新版本 · v2.7.2」。

<details>
<summary><strong>📚 查看历史版本更新</strong></summary>

<br>

### v2.7.1

- 将成功查询后仍为空的已结束 Ping bucket 明确收敛为“无采样”，保持延迟／丢包空值且不参与平均，并与真实 100% 丢包状态区分。
- 当前采集桶与写入宽限期内的刚关闭桶继续等待；迟到真实样本仍可原位恢复为正常数据或不可达。
- 移除首页 Header 工具按钮重复的自定义 Tooltip，保留原生 `title`、`aria-label` 与键盘操作。
- 访客端主题切换改为“浅色模式／北京时间自动／深色模式”三个直接按钮；北京时间自动继续采用 UTC+8 的既有昼夜规则。
- 保持 Ping RPC、请求、缓存、调度、任务绑定和三分钟 bucket 几何不变。

### v2.7.0

- 修复节点详情页与首页 Ping 弹窗右侧显示无数据时间段的问题。
- Ping 图表以当前可见任务的最新可用数据作为显示终点，不再预留明显空白尾部。
- 统一详情页与首页弹窗的时间域规则，同时保留真实缺口、自定义范围和长时间历史。
- 提高浅色主题下首页 NodeCard 及内部信息区的边框清晰度，深色主题保持不变。
- 保持 Ping 数据读取、缓存、刷新和任务绑定行为不变。

### v2.6.0

- 将公开页面文案统一为“延迟监测中心”“延迟任务概览”和“延迟任务配置”。
- 移除延迟任务概览卡片中冗余的延迟／丢包摘要，集中展示任务信息与覆盖关系。
- 覆盖节点改为带标题、节点总数和自动换行胶囊标签的有界列表，长列表可在区域内滚动。
- 保持首页 NodeCard、三网监控、Ping bucket、Tooltip、任务绑定、API／RPC 与指标读取逻辑不变。

### v2.5.0

- 统一首页 Ping 为固定 20 个三分钟时间区间，并同时展示固定区间与真实采样时间。
- 隐藏未完成采样格的交互与 Tooltip，避免把等待状态误作历史数据。
- 重构移动端价值与费用明细，并修复 Komari 1.4.x 生产环境 JSON-RPC 基址。
- 加强 RPC、网络与初始化错误分类，保持可选功能故障隔离。

### v2.3.1（预发布）

- 新增不可达 Ping 目标的独立严重故障状态。
- 明确区分完全断线与高延迟／部分丢包。
- 使用即时自定义 Tooltip 替代浏览器原生 Ping Tooltip。
- 优化三位数延迟与 100% 丢包的显示空间。
- Release 开始提供经过校验的客户安装 ZIP。

### v2.3.0（预发布）

- 优化 Ping 延迟与丢包颜色等级。
- 避免正常跨区域高延迟被错误显示为严重故障。
- 重构 NodeCard 延迟／丢包标签和趋势轨道。
- 优化不可达任务与 100% 丢包状态。
- 保持固定 20 格趋势布局。

### v2.2.0（预发布）

- 加粗并固定 Ping 延迟／丢包历史格尺寸。
- 修复数值、hover、focus 和 Tooltip 导致历史格变形。
- 优化 100% 丢包、不可达及异常状态。
- 改善三网监控开关布局、无障碍与草稿／保存交互。
- 简化单节点继承配置，移除重复入口。

### v2.1.0（预发布）

- 将首页 Ping 配置简化为单任务／三网监控。
- 优化三网节点卡片的延迟、丢包和状态展示。
- 改进 Ping 监控中心、筛选、单节点与批量配置。
- Ping 配置界面统一使用简体中文。
- 增加 v2.0 多任务设置兼容迁移。

### v2.0.0（预发布）

- 重构首页 Ping 数据读取、缓存与刷新流程。
- 首页节点卡支持最多三项 Ping 任务。
- 增加全局默认、单节点覆盖及批量服务器配置。
- 四种节点卡片尺寸适配多 Ping 布局。
- 自动兼容旧 v1.x 单任务绑定。

### v1.4.0

- 选择性同步上游 Glassmorphism v3.3.6 与 v3.3.7。
- 平铺地图遵循 Plus 的总览卡片选择和顺序。
- 累计上传／下载历史在降采样时保留计数器语义。
- 重整 Plus 版本、兼容性与上游署名文档。

### v1.3.6（预发布）

- 修复 Komari Metric Store 中 30 天 Ping 图表历史覆盖不完整。
- 增加感知数据留存周期的多层 Ping 历史合并。
- 保留真实缺口与原始样本，并加强 Komari 1.4.x 汇总兼容性。

### v1.3.5（预发布）

- 修复 30 天 Ping 范围被后端部分日级汇总压缩成约 7 天的问题。
- 防止断连边界的失败探测被平均成虚假低延迟。
- 保留 7／14 天范围、平滑峰值、每节点 Ping 绑定与运行指标行为。

### v1.3.4（预发布）

- 恢复模态视图和节点详情中的 Ping 峰值平滑控制。
- 增加 7 天与 14 天 Ping 图表范围。
- 修复 iPhone Safari 底部黑边与 safe-area 问题。
- 提升移动端 Ping 弹窗和图表稳定性。

### v1.3.3（预发布）

- 区分等待采样、真实数据与确认缺失状态。
- 支持迟到 Ping 数据自动回填。
- 改善 NodeCard 与详情页的数据同步、冷启动和无痕模式表现。
- 保留 100% 丢包、20 格趋势与每节点独立 Ping 任务语义。

### v1.3.2

- 调整 Ping 面板和移动端布局对齐。
- 稳定 NodeCard Ping 趋势条的几何和状态呈现。
- 统一版本化 publish、release snapshot 与客户安装包准备路径。

### v1.3.1

- 修正旧快照和不同任务缓存串用。
- 避免任务切换后显示过期 Ping 结果。
- 加强 managed theme 选择控件与卡片趋势条几何一致性。

### 1.3.0（预发布）

- 选择性同步上游 Glassmorphism v3.3.4 与 v3.3.5。
- 修复指定 Ping 任务 100% 丢包时错误回退聚合数据。
- 优化首页延迟／丢包加载、缓存与自动刷新。
- 统一 Ping 任务顺序，并继续完善每节点独立任务绑定。

### 1.2.1（预发布）

- 加入以节点 UUID 为中心的每节点 Ping 任务绑定。
- 候选任务按后端 `task.clients` 关系过滤。
- 首页按节点读取指定任务，并在绑定失效时回退原聚合数据。
- 改善数据加载速度和自动更新体验。

### 1.2（预发布）

- 这是 Glassmorphism Plus 的早期测试 Release。
- 在原版 Komari Glassmorphism 主题基础上继续开发。
- 保留对原作者 [sanrokamlan-prog](https://github.com/sanrokamlan-prog) 的署名。

</details>

完整版本记录请查看 [CHANGELOG.md](CHANGELOG.md) 与 [GitHub Releases](https://github.com/helloworld-mars/Glassmorphism-Plus/releases)。上游来源与选择性同步记录见 [UPSTREAM.md](UPSTREAM.md)。

---

## 🙏 Credits & License

- Glassmorphism Plus 维护者：[helloworld-mars](https://github.com/helloworld-mars)
- 原始 Glassmorphism 主题与维护者：[sanrokamlan](https://github.com/sanrokamlan-prog)
- 原始仓库：[sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism)
- License：[MIT](LICENSE)

详细贡献与版权边界见 [CREDITS.md](CREDITS.md)；上游同步策略见 [UPSTREAM.md](UPSTREAM.md)。原始 LICENSE 文本与版权声明保持不变。
