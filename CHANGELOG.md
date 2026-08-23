# Glassmorphism Plus Changelog

本文件只记录 **Glassmorphism Plus** 自己的发行版本。原始 Glassmorphism 的版本历史请查看[上游仓库](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases)；Plus 的选择性同步记录见 [UPSTREAM.md](UPSTREAM.md)。

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

[1.4.0]: https://github.com/helloworld-mars/Glassmorphism-Plus/compare/v1.3.6...v1.4.0
[1.3.6]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/v1.3.6
[1.3.5]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/v1.3.5
[1.3.4]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/v1.3.4
[1.3.3]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/v1.3.3
[1.3.2]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/v1.3.2
[1.3.1]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/v1.3.1
[1.3.0]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/1.3.0
[1.2.1]: https://github.com/helloworld-mars/Glassmorphism-Plus/releases/tag/1.2.1
