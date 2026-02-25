## Gaussian Copilot v0.3.0

本版本聚焦于两个方向：
- Gaussian 后续任务衔接效率（TS / Sol / IRC）
- 远程集群结果下载到本机的可用性与稳定性

### 亮点
- 新增可视化面板 `Next` 标签页，一键生成后续输入：
  - 从当前帧 TS（calcfc）
  - 从当前帧 TS（readfc）
  - Sol（SMD）
  - IRC 路径验证
- 作业看板新增右键命令：`下载选中log/out`（支持多选）。

### 关键改进
- Next 生成继承策略更贴近 Gaussian 实操：
  - `%chk` 自动与输出文件名一致。
  - Sol 在 `smd` 子目录生成，并自动添加 `%oldchk=../<name>.chk`。
  - IRC / TS(readfc) 自动添加 `%oldchk=<name>.chk`。
  - Sol 对常见基组自动升级（`6-31G* -> 6-311++G**`，`lanl2dz -> SDD`）。
  - 自动过滤 fix/modredundant 约束，避免误继承。
  - 生成前提供预览确认，并支持“后续不再显示”。
- 下载流程优化为“本机优先交互”：
  - 单文件：本机“另存为”。
  - 多文件：首个文件“另存为”，后续自动保存到同目录。
  - 下载源优先服务器拉取，兼容本地回退。

### 修复
- 修复多选下载只成功首个文件的问题。
- 修复 Next 生成输入结尾空行不足的问题（保证文件末尾至少两行空白）。

### 性能与工程优化
- Webview 视图刷新改为调度式，减少冗余 `resize/zoom/render`。
- 去除日志解析中重复的 Gibbs 自由能正则匹配。
- 清理 `package.json` 冗余 `activationEvents`。