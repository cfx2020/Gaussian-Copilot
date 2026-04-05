# 本地命令提交配置示例（插件安装在服务器）

## 1. settings.json 示例

```json
{
  "gaussianCopilot.submit.runCommandTemplate": "gsub {file}",
  "gaussianCopilot.submit.preCommands": [
    "source /etc/profile",
    "module load gaussian/g16"
  ],
  "gaussianCopilot.pbs.queue": "normal",
  "gaussianCopilot.pbs.nodes": 1,
  "gaussianCopilot.pbs.ppn": 16,
  "gaussianCopilot.pbs.walltime": "72:00:00",
  "gaussianCopilot.pbs.mem": "32gb"
}
```

## 2. 可选命令模板示例

- `gsub {file}`
- `g16 {file}`
- `bash /share/scripts/gsub.sh {file}`

## 3. 作业状态命令

- 查询：`qstat -f <jobId>`
- 取消：`qdel <jobId>`

状态映射：
- `Q` -> queued
- `R` -> running
- `C` -> completed
- `E` -> failed
- `H` -> queued
