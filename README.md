# 🧪 Gaussian Copilot

Gaussian 工作流增强扩展：在 VS Code 中完成 `.gjf` 提交、`.log/.out` 可视化、批量操作与作业跟踪。

## Why Gaussian Copilot

把“写输入文件 → 提交计算 → 看结果 → 回溯批次”放在一个编辑器里完成，减少命令行和文件管理的来回切换。

## ✨ Features

### 1) 一键提交与可视化
- 编辑器右上角：
  - 打开 `.gjf` 时显示 **提交此gjf**
  - 打开 `.log/.out` 时显示 **可视化此log**

### 2) 文件列表批量操作
- 在资源管理器中多选文件后右键：
  - **Gaussian Copilot: 提交选中gjf文件**
  - **Gaussian Copilot: 可视化选中log文件**

### 3) Gaussian 输出可视化
- 结构帧浏览与 3D 交互
- 频率模式与振动播放
- 能量变化曲线（支持点选联动）
- Overview / Thermo / Next 信息面板
- Next 面板支持一键生成 TS / Sol / IRC 后续输入

### 4) 作业时间线与状态跟踪
- 按时间批次分组显示提交记录
- 自动识别 `qstat -u <username>` 中该用户已在队列中的作业（含安装插件前提交的作业）
- 状态显示：排队中 / 运行中 / 已完成 / 失败 / 已取消
- 失败作业可显示原因摘要（如 L9999、SCF 不收敛等）
- 支持杀作业、重新提交选中 `.gjf`、删除单条、清理已结束作业

### 5) 作业结果快速定位
- 单击作业项即可跳转对应 `.log/.out`
- 作业右键可直接“可视化对应log/out”
- 作业右键支持“可视化选中log/out”“打开选中gjf”“下载选中log/out”

## 🚀 Quick Start

1. 安装扩展并打开你的 Gaussian 工作目录。
2. 打开设置，配置提交命令模板：

```json
{
  "chemAssist.submit.runCommandTemplate": "gsub {file}"
}
```

常见命令模板：
- `gsub {file}`
- `g16 {file}`
- `bash /path/to/gsub.sh {file}`

3. 打开任意 `.gjf`，点击右上角 **提交此gjf**。
4. 在侧边栏 **Gaussian 作业看板** 中查看状态和历史批次。

## 📦 Release Notes

详见 [CHANGELOG.md](CHANGELOG.md)。

## ⚙️ Configuration

### Submit
- `chemAssist.submit.runCommandTemplate`：提交命令模板（占位符：`{file}`、`{basename}`、`{dir}`）
- `chemAssist.submit.preCommands`：提交前预执行命令（与提交命令在同一 shell 中顺序执行）

### Job View
- `chemAssist.jobs.autoRefreshSeconds`：作业状态自动刷新间隔（秒，`0` 表示关闭）
- `chemAssist.jobs.username`：用于 `qstat -u` 的用户名；留空时自动从 `USER/LOGNAME/USERNAME` 推断

### Parser
- `chemAssist.parser.maxFrames`：解析时保留的最大结构帧数

### Viewer
- `chemAssist.viewer.backgroundColor`
- `chemAssist.viewer.style`
- `chemAssist.viewer.stickRadius`
- `chemAssist.viewer.sphereScale`
- `chemAssist.viewer.vibrationFps`
- `chemAssist.viewer.maxDisplayedFrequencies`
- `chemAssist.viewer.autoZoomOnFrameChange`

### Templates
- `chemAssist.templates.custom`：自定义 `.gjf` 模板

## 🔄 Typical Workflow

1. 用模板生成/编辑 `.gjf`
2. 单个或批量提交作业
3. 在作业栏查看时间线与状态
4. 单击作业快速打开结果
5. 进入可视化面板检查几何、频率和能量变化

## 📝 Notes

- 推荐在 Linux / 集群环境中使用（如 CentOS + PBS）。
- Linux 下提交会优先使用 `bash` 并自动加载 `~/.bashrc`，可直接使用 `gsub` 这类 alias。
- 若提交命令是脚本路径且遇到 `Permission denied`，扩展会自动回退为 `bash <你的脚本命令>` 重试一次。
- 当调度器状态不可用时，扩展会根据输出文件内容推断“完成/失败”。

## Development

```bash
npm install
npm run compile
```

按 `F5` 启动扩展开发主机。

