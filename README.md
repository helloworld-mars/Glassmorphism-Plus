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
| 当前 Plus 版本     | **v1.4.0**                                                                                                             |
| 上游同步基线       | [sanrokamlan Glassmorphism v3.3.7](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases/tag/v3.3.7) |
| 当前维护者         | [helloworld-mars](https://github.com/helloworld-mars)                                                                  |
| 适用平台           | [Komari Monitor](https://github.com/komari-monitor/komari)                                                             |
| 已验证 Komari 版本 | **1.4.3**                                                                                                              |
| 技术栈             | Vue 3、TypeScript、Vite 7、Tailwind CSS 4、Pinia、ECharts、Bun                                                         |
| 源码发布           | GitHub `main` 与 `v1.4.0` Release；Release 不附加客户安装包                                                            |
| 本地安装包         | `<version>/Glassmorphism-Plus-release-<version>.zip`                                                                   |

Glassmorphism Plus 是独立维护的衍生主题，使用自己的 v1.x 版本体系。上游 v3.3.7 是同步基线，不是 Plus 的当前版本。同步来源、取舍和署名详见 [UPSTREAM.md](UPSTREAM.md)。

---

## ➕ Glassmorphism Plus 的主要增强

在保留原始 Glassmorphism 视觉基础的同时，Plus 重点维护以下能力：

- 以节点 UUID 为中心，为每台节点独立绑定一个真实分配的 Ping task；管理页面位于 `pingsettings`。
- 指定任务的 Metric、同任务 Legacy 与原聚合 fallback 保持一致的任务归属验证和数据语义。
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

- 每节点单任务绑定；候选任务必须真实包含该节点 UUID。
- 延迟、丢包与趋势条来自同一指定任务；无效绑定安全回退原聚合。
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
- 延迟任务绑定管理入口与直接路由均遵循管理员权限。
- 导出二级密码、访客字段控制和发布前敏感信息扫描。

### 移动端与浏览器

- 桌面、Android、iPhone Safari 与窄屏布局。
- WebKit safe-area、动态视口、弹窗关闭和路由返回后的滚动状态修复。
- 亮色、暗色、北京时间自动模式和色觉辅助配色。

### 主题配置

- Komari managed theme 配置，无需修改源码即可调整布局、卡片、图表、背景和隐私选项。
- `pingsettings` 管理页面以节点为中心选择有效 Ping task，不要求手写任务 ID。
- 每节点绑定保存为 `节点 UUID → 数值 task ID` 的 JSON object。

---

## 📦 安装与升级

正式源码仓库：<https://github.com/helloworld-mars/Glassmorphism-Plus>

### 重要说明

- **v1.4.0 GitHub Release 的 installer asset 数量为 0。** 客户安装 ZIP 只在本地生成和验证，不上传 GitHub Release。
- GitHub 自动生成的 **Source code (zip)** 是源码快照，**不是** Komari 可安装主题包。
- Komari 的远程仓库导入流程需要可用的 Release installer asset；因此本版不要把仓库 URL 当作可直接导入的安装地址。

### 方式一：本地生成安装包

Windows、macOS 或 Linux 安装 Node.js 与 Bun 后，在项目根目录执行：

```bash
bun install --frozen-lockfile
bun run lint
bun run type-check
bun run build
bun run release:prepare
```

`release:prepare` 会在源码目录的上一级创建：

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

### 方式二：使用维护者单独提供的安装包

如果维护者通过可信渠道单独提供经过校验的 `Glassmorphism-Plus-release-<version>.zip`，可直接在 Komari 后台上传。请核对来源、版本与 SHA-256；不要用 GitHub 的 Source code zip 代替。

### 升级提示

- 升级前记录当前 managed theme 设置，尤其是每节点 Ping 任务绑定。
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
- `bun run test:visual` 会先构建，再运行 Playwright；除非有明确视觉变更，不要更新基准快照。
- 首次运行浏览器测试可能需要 `bunx playwright install chromium`。
- `bun run release:prepare` 生成本地 release snapshot 和客户安装 ZIP；生成物不得加入 Git 或上传 Release。

源码边界与 AI 开发规则见 [AGENTS.md](AGENTS.md)；前端目录规则见 [src/AGENTS.md](src/AGENTS.md)。

---

## 📝 版本历史

v1.4.0 的用户可见重点：

- 选择性同步上游 v3.3.6：平铺地图尊重管理员配置的总览卡片选择与顺序。
- 选择性同步上游 v3.3.7：累计上传／下载历史 downsampling 使用 bucket `last`，普通 gauge 继续使用 `avg`。
- 重整 README、Plus 版本历史、上游同步记录和署名边界。

完整 Plus 历史见 [CHANGELOG.md](CHANGELOG.md)。上游来源与选择性同步记录见 [UPSTREAM.md](UPSTREAM.md)。GitHub 发布记录见 [Releases](https://github.com/helloworld-mars/Glassmorphism-Plus/releases)。

---

## 🙏 Credits & License

- Glassmorphism Plus 维护者：[helloworld-mars](https://github.com/helloworld-mars)
- 原始 Glassmorphism 主题与维护者：[sanrokamlan](https://github.com/sanrokamlan-prog)
- 原始仓库：[sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism)
- License：[MIT](LICENSE)

详细贡献与版权边界见 [CREDITS.md](CREDITS.md)；上游同步策略见 [UPSTREAM.md](UPSTREAM.md)。原始 LICENSE 文本与版权声明保持不变。
