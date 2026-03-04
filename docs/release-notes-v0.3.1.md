## Gaussian Copilot v0.3.1

本次版本主要是“提交稳定性 + Next 生成准确性 + 交互细节”的集中修复。

### 亮点
- Linux 提交流程支持 alias：提交时自动加载 `~/.bashrc`，可直接使用 `gsub`。
- Sol 输入命名统一为 `<name>_sol.gjf`，`%chk` 自动与文件名一致。
- `Dichloro-methane` / `Dichloro-ethane` 统一写入为 `dichloromethane` / `dichloroethane`。

### 关键改进
- `chemAssist.submit.preCommands` 现在会真正参与执行，并与提交命令在同一 shell 顺序运行。
- 默认提交配置更新：
  - `chemAssist.submit.runCommandTemplate` 默认值改为 `gsub {file}`
  - `chemAssist.submit.preCommands` 默认值改为 `source ~/.bashrc`
- 作业看板任务显示名不再带 `.gjf` 后缀（仅显示层变更，不影响内部匹配逻辑）。
- 可视化“结构控制”帧滑块默认显示最后一帧。

### 修复
- 处理脚本路径执行遇到 `Permission denied` 的情况：自动回退为 `bash <script>` 重试一次。
- 修复 Sol 基组升级中 `6-31G* -> 6-311++G**` 匹配失败的问题。

### 发布产物
- VSIX：`gaussian-copilot-0.3.1.vsix`
