## Gaussian Copilot v0.3.2

本次版本主要是"作业识别准确性"的增强，修复了长作业名称被截断导致的识别错误。

### 亮点
- 作业看板支持正确识别长作业名称：修复了 `qstat` 输出被截断时将不同作业错误识别为同一个的问题。
- 相似名称作业（如 `ts1-fix1-search-ts1` 和 `ts1-fix1-search-ts`）现在能被准确区分。

### 关键改进
- **作业解析增强**：
  - 改进 `parseQstatUserOutput()` 使用更健壮的正则模式替代固定列索引解析
  - Job ID 提取：`^\d+(\.[\w.-]*)`
  - 状态识别：通过 `\s([QRCEH])\s+` 或右向左扫描定位
  - 名称提取：获取 ID 和状态之间的完整内容，不再依赖于固定列位置

- **qstat 命令改进**：
  - `listUserJobs()` 优先使用 `qstat -a -u <username>` 获取更好的格式化输出
  - 向后兼容：如果 `-a` 选项不支持，自动降级至 `qstat -u <username>`

### 修复
- 修复 `qstat -u username` 输出中长作业名被截断导致的识别错误。
- 改进列式输出解析，不再受列对齐变化影响。

### 发布产物
- VSIX：`gaussian-copilot-0.3.2.vsix`
