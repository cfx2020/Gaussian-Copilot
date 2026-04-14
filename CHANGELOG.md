# Changelog

## [0.6.0] - 2026-04-14

### Added
- Next 面板新增独立“继续优化”功能区，支持从当前帧保存续跑输入，默认输出为原文件名后加 `1`（如 `foo1.gjf`）。
- 溶剂化支持“从当前帧进行 Sol 溶剂化”，与原有 `read` 方法分开显示，便于按场景选择。

### Changed
- Next 面板重构为独立功能区布局：`TS 过渡态搜索`、`Sol 溶剂化`、`继续优化`、`IRC 路径验证`，并将 `TS 前后中间体` 内嵌到 TS 区块下方。
- TS 与 Sol 的主操作按钮改为并排展示，减少面板纵向长度。
- 溶剂下拉会记住上次选择；自定义溶剂也会在后续打开面板时自动恢复。

### Fixed
- 修复“从当前帧继续优化”错误重写任务类型的问题：现在优先继承原 `.gjf` 的 route，适用于 TS、fix、opt 等任务的中途续跑。
- 修复 Next 面板顶部冗余总标题，减少层级噪音并强化任务分区。

## [0.5.0] - 2026-04-06

### Added
- Next 流程新增 TS 中间体预览与双输入文件生成能力，减少手工拆分与检查工作。

### Changed
- 设置项命名空间统一为 `gaussianCopilot.*`，与扩展显示名称保持一致，提升配置一致性与可维护性。

### Fixed
- 修复 log 可视化中 scan 与 IRC 轨迹帧映射不正确的问题，避免结构序列错位。

## [0.4.0] - 2026-03-31

### Added
- 交互式测量面板：左侧面板支持点击原子进行测量，计算 2 原子键长、3 原子键角、4 原子二面角。
- 分子可视化风格增强：新增 CPK 球棍模型、Licorice 细棍模型、Spacefill 范德华球模型。
- 原子选中反馈：选中原子以青蓝色高亮并显示元素+序号标签。

### Changed
- 分子振动动画优化：性能提升至 60fps+，实现动态相位采样（根据 FPS 自动调整采样帧数 24～72 帧）。
- 术语更新：用户界面部分术语从"帧"更新为"轨迹"（工具栏、左侧面板）。

### Fixed
- 修复作业看板显示所有作业为相同名称（用户名）的严重 bug：重写 qstat 输出解析，支持格式检测和完整名称富集。
- 修复溶剂化路线基组升级条件不正确问题：新增金属检测，仅在非金属且无 gen/genecp 自定义基组时进行升级。
- 修复 macOS 下 .DS_Store 被版本控制的问题：更新 .gitignore。

## [0.3.2] - 2026-03-26

### Changed
- 作业看板作业名称识别改进：改用正则模式替代固定列索引解析 `qstat -u <username>` 的输出。
- `listUserJobs()` 命令改为优先使用 `qstat -a -u <username>`，以获得更好的格式化输出和长名支持。

### Fixed
- 修复长作业名称被截断导致不同作业被错误识别为同一个的问题（如 `ts1-fix1-search-ts1` 与 `ts1-fix1-search-ts` 混淆）。
- 改进 `parseQstatUserOutput()` 使其能够正确处理列对齐变化的 qstat 输出。

## [0.3.1] - 2026-03-04

### Changed
- 提交流程增强为 Linux 下优先通过 `bash` 执行，并自动加载 `~/.bashrc`，支持直接使用 `gsub` 等 alias。
- `gaussianCopilot.submit.preCommands` 由“保留项”改为实际参与执行，且与提交命令在同一 shell 顺序运行。
- 提交相关默认值调整：
  - `gaussianCopilot.submit.runCommandTemplate` 默认 `gsub {file}`
  - `gaussianCopilot.submit.preCommands` 默认 `source ~/.bashrc`
- `Next` 面板中 `Dichloro-methane` / `Dichloro-ethane` 统一改为无连字符写入（`dichloromethane` / `dichloroethane`）。
- 作业看板显示优化：任务标题不再显示 `.gjf` 后缀。
- 结构控制优化：帧滑块初始默认定位到最后一帧。

### Fixed
- 修复提交脚本路径在权限不足时失败的问题：遇到 `Permission denied` 时自动回退 `bash <script>` 重试一次。
- 修复 Sol 输入文件命名：改为 `<name>_sol.gjf`，并确保 `%chk` 与输出文件名始终一致。
- 修复 Sol 基组升级中 `6-31G* -> 6-311++G**` 未生效的问题（正则匹配边界修复）。

## [0.3.0] - 2026-02-25

### Added
- 可视化右侧面板新增 `Next` 标签页，支持一键生成后续计算输入文件：
  - 从当前帧进行 TS（`calcfc`）
  - 从当前帧进行 TS（`readfc` / `guess=read geom=check`）
  - Sol（SMD）
  - IRC 路径验证
- Sol 支持常用溶剂下拉与“自定义溶剂”输入。
- 作业看板新增右键命令：`下载选中log/out`。

### Changed
- Next 生成规则增强：
  - `%chk` 与输出文件名自动保持一致。
  - Sol 在 `smd/` 子目录生成同名输入，并自动写入 `%oldchk=../<name>.chk`。
  - IRC 与 TS(readfc) 自动写入 `%oldchk=<name>.chk`。
  - Sol 自动进行常见基组升级（如 `6-31G* -> 6-311++G**`，`lanl2dz -> SDD`）。
  - 统一过滤 fix/modredundant 约束行，避免被错误继承到 TS/Sol/IRC。
  - 生成前支持预览确认，并可选择“不再显示预览”。
- 下载流程优化：
  - 优先从服务器拉取输出文件到本机。
  - 单文件下载使用本机“另存为”；多文件下载首个文件“另存为”，其余自动保存到同目录。

### Fixed
- 修复多选下载时路径上下文导致只落首个文件的问题。
- 修复 Next 生成输入文件末尾空行不足的问题（统一保证结尾至少两行空白）。

### Performance
- 减少 Webview 中重复 `resize/zoom/render` 调用，改为调度式刷新，降低频繁重绘开销。
- 移除日志解析中重复的 Gibbs 自由能正则匹配，减少重复扫描。
- 清理 `package.json` 冗余 `activationEvents` 配置。

## [0.2.0] - 2026-02-23

### Added
- 新增“自动发现已有作业”能力：作业看板会根据 `qstat -u <username>` 自动识别当前用户已在队列中的作业（含安装插件前提交的作业）。
- 新增设置项 `gaussianCopilot.jobs.username`：支持显式指定调度器用户名；留空时自动从 `USER/LOGNAME/USERNAME` 推断。
- 作业看板新增多选能力（支持批量操作）。
- 新增作业右键命令：`打开选中gjf`、`重新提交选中gjf`。

### Changed
- 视图标题由“Gaussian Copilot 作业”调整为“Gaussian 作业看板”。
- 命令文案调整为“可视化选中log/out”，并优化作业右键菜单顺序。
- 看板刷新时会在已知任务上同步最新 `Jobname`，提升可读性。

### Fixed
- 修复仅显示“通过插件提交”任务的问题：现在会合并调度器中的现有任务。
- 修复 `qstat -u` 解析错误导致作业名/状态不正确的问题。
- 修复同名作业（不同课题目录）点击后可能打开错误输出文件的问题：
  - 优先通过 `qstat -f <jobId>` 解析工作目录线索定位；
  - 无法唯一定位时提供选择，并记住绑定路径，后续稳定命中。

---

## [0.1.1] - 2026-02-23
- 初始公开版本。
