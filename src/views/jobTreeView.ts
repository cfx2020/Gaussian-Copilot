import * as vscode from 'vscode';
import { access } from 'fs/promises';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { getSettings } from '../config/settings';
import { logError, logInfo } from '../logging/diagnostics';
import { classifyGaussianTermination } from '../parser/termination';
import { createSubmitter } from '../submission/submitter';
import { JobState, SubmitMode, SubmitResult } from '../submission/types';

const STORAGE_KEY = 'chemAssist.jobs';

export interface JobRecord {
  id: string;
  backend: SubmitMode;
  fileName: string;
  filePath?: string;
  submittedAt: string;
  state: JobState;
  failureReason?: string;
  remotePath?: string;
}

interface BatchRecord {
  key: string;
  startTime: string;
  jobs: JobRecord[];
}

type TreeNode = BatchTreeItem | JobTreeItem;

function looksLikePbsJobId(id: string): boolean {
  return /^\d+(\.[\w.-]+)?$/.test(id.trim());
}

function isJobMissingInScheduler(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('unknown job id')
    || lower.includes('unknown job')
    || lower.includes('invalid job id')
    || lower.includes('does not exist');
}

function normalizeDiscoveredFileName(name: string): string {
  if (!name) {
    return 'unknown';
  }

  return name;
}

function toDisplayJobName(fileName: string): string {
  return fileName.replace(/\.gjf$/i, '');
}

function parseSchedulerHintDirs(stdout: string): string[] {
  const dirs: string[] = [];

  const addDir = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const normalized = value.trim();
    if (!normalized || dirs.includes(normalized)) {
      return;
    }
    dirs.push(normalized);
  };

  const outputPathMatch = stdout.match(/Output_Path\s*=\s*[^:\s]+:([^\r\n]+)/i);
  if (outputPathMatch?.[1]) {
    addDir(path.dirname(outputPathMatch[1].trim()));
  }

  const initWorkDirMatch = stdout.match(/init_work_dir\s*=\s*([^\r\n]+)/i);
  if (initWorkDirMatch?.[1]) {
    addDir(initWorkDirMatch[1]);
  }

  const variableListMatch = stdout.match(/Variable_List\s*=\s*([\s\S]+)/i);
  if (variableListMatch?.[1]) {
    const variableList = variableListMatch[1];
    const workdirMatch = variableList.match(/PBS_O_WORKDIR=([^,\r\n]+)/i);
    if (workdirMatch?.[1]) {
      addDir(workdirMatch[1]);
    }
  }

  return dirs;
}

function getStateLabel(state: JobState): string {
  switch (state) {
    case 'queued':
      return '排队中';
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '未知';
  }
}

function getStateIcon(state: JobState): vscode.ThemeIcon {
  switch (state) {
    case 'running':
      return new vscode.ThemeIcon('sync~spin');
    case 'queued':
      return new vscode.ThemeIcon('history');
    case 'completed':
      return new vscode.ThemeIcon('pass');
    case 'failed':
      return new vscode.ThemeIcon('error');
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash');
    default:
      return new vscode.ThemeIcon('beaker');
  }
}

function formatCompactTime(isoText: string): string {
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) {
    return isoText;
  }

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBatchDescription(jobs: JobRecord[]): string {
  const count = (state: JobState) => jobs.filter((job) => job.state === state).length;
  const parts: string[] = [];

  if (count('running') > 0) {
    parts.push(`运行 ${count('running')}`);
  }
  if (count('queued') > 0) {
    parts.push(`排队 ${count('queued')}`);
  }
  if (count('completed') > 0) {
    parts.push(`完成 ${count('completed')}`);
  }
  if (count('failed') > 0) {
    parts.push(`失败 ${count('failed')}`);
  }
  if (count('cancelled') > 0) {
    parts.push(`取消 ${count('cancelled')}`);
  }

  return parts.length > 0 ? parts.join(' · ') : '暂无状态';
}

function summarizeBatchStates(jobs: JobRecord[]): string {
  const count = (state: JobState) => jobs.filter((job) => job.state === state).length;
  return `运${count('running')} 排${count('queued')} 成${count('completed')} 失${count('failed')} 取${count('cancelled')}`;
}

function formatFailureReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'L9999':
      return 'L9999（SCF/收敛问题）';
    case 'L103':
      return 'L103（几何/初猜问题）';
    case 'L301':
      return 'L301（输入/基组或分子规格问题）';
    case 'L502':
      return 'L502（SCF不收敛）';
    case 'Segmentation fault':
      return 'Segmentation fault';
    case 'Killed':
      return '进程被系统终止';
    case 'Error termination':
      return 'Gaussian Error termination';
    default:
      return reason;
  }
}

class JobTreeItem extends vscode.TreeItem {
  constructor(public readonly job: JobRecord) {
    const displayName = toDisplayJobName(job.fileName);
    super(displayName, vscode.TreeItemCollapsibleState.None);
    const submitted = formatCompactTime(job.submittedAt);
    this.description = job.failureReason
      ? `${getStateLabel(job.state)} · ${job.failureReason}`
      : `${getStateLabel(job.state)} · ${submitted}`;
    const detail = new vscode.MarkdownString(undefined, true);
    detail.isTrusted = false;
    detail.appendMarkdown(`**${displayName}**\n\n`);
    detail.appendMarkdown(`状态：\`${getStateLabel(job.state)}\`\n\n`);
    detail.appendMarkdown(`Job ID：\`${job.id}\`\n\n`);
    detail.appendMarkdown(`提交时间：\`${job.submittedAt}\`\n\n`);
    if (job.failureReason) {
      detail.appendMarkdown(`失败原因：${job.failureReason}\n\n`);
    }
    if (job.filePath) {
      detail.appendMarkdown(`输入文件：\`${job.filePath}\`\n\n`);
    }
    if (job.remotePath) {
      detail.appendMarkdown(`远端路径：\`${job.remotePath}\`\n\n`);
    }
    this.tooltip = detail;
    this.contextValue = 'chemAssistJobItem';
    this.iconPath = getStateIcon(job.state);
  }
}

class BatchTreeItem extends vscode.TreeItem {
  constructor(public readonly batch: BatchRecord) {
    super(`${batch.startTime}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = formatBatchDescription(batch.jobs);
    const detail = new vscode.MarkdownString(undefined, true);
    detail.isTrusted = false;
    detail.appendMarkdown(`**提交批次**\n\n`);
    detail.appendMarkdown(`时间：\`${batch.startTime}\`\n\n`);
    detail.appendMarkdown(`作业数：\`${batch.jobs.length}\`\n\n`);
    detail.appendMarkdown(`概览：${summarizeBatchStates(batch.jobs)}`);
    this.tooltip = detail;
    this.contextValue = 'chemAssistJobBatchItem';
    this.iconPath = new vscode.ThemeIcon('layers');
  }
}

function getJobFromUnknown(item: unknown): JobRecord | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const maybe = item as { job?: JobRecord };
  if (maybe.job && typeof maybe.job.id === 'string') {
    return maybe.job;
  }

  const raw = item as JobRecord;
  if (typeof raw.id === 'string' && typeof raw.fileName === 'string') {
    return raw;
  }

  return undefined;
}

export class JobTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private jobs: JobRecord[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.jobs = this.context.workspaceState.get<JobRecord[]>(STORAGE_KEY, []);
    this.configureAutoRefresh();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element instanceof BatchTreeItem) {
      return element.batch.jobs
        .slice()
        .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
        .map((job) => new JobTreeItem(job));
    }

    return this.buildBatches().map((batch) => new BatchTreeItem(batch));
  }

  private buildBatches(): BatchRecord[] {
    const bucketMs = 30 * 60 * 1000;
    const batches = new Map<string, BatchRecord>();

    for (const job of this.jobs) {
      const ms = Date.parse(job.submittedAt);
      const bucketStart = Number.isFinite(ms) ? Math.floor(ms / bucketMs) * bucketMs : Date.now();
      const key = new Date(bucketStart).toISOString();

      if (!batches.has(key)) {
        batches.set(key, {
          key,
          startTime: this.formatBatchTime(bucketStart),
          jobs: [],
        });
      }

      batches.get(key)?.jobs.push(job);
    }

    return Array.from(batches.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
  }

  private formatBatchTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async addJobFromSubmit(result: SubmitResult, fileName: string, filePath?: string): Promise<void> {
    if (!result.jobId) {
      return;
    }

    const record: JobRecord = {
      id: result.jobId,
      backend: result.backend,
      fileName,
      filePath: filePath ?? result.localFilePath,
      submittedAt: result.submittedAt,
      state: looksLikePbsJobId(result.jobId) ? 'queued' : 'unknown',
      remotePath: result.remotePath,
    };

    this.jobs = [record, ...this.jobs].slice(0, 200);
    await this.persist();
    this.refresh();
  }

  async refreshStatuses(): Promise<void> {
    const submitter = await createSubmitter(this.context);
    const activeJobsById = await this.fetchActiveJobsMap(submitter);
    this.mergeDiscoveredJobs(activeJobsById);

    const updated: JobRecord[] = [];

    for (const job of this.jobs) {
      if (job.state === 'cancelled') {
        updated.push(job);
        continue;
      }

      if (!looksLikePbsJobId(job.id)) {
        updated.push(job);
        continue;
      }

      const active = activeJobsById.get(job.id);
      if (active) {
        const nextName = !job.filePath ? normalizeDiscoveredFileName(active.name) : job.fileName;
        const nextJob = { ...job, fileName: nextName };
        const terminal = await this.detectTerminalStateFromOutput(nextJob);
        updated.push(
          terminal
            ? { ...nextJob, state: terminal.state, failureReason: terminal.reason }
            : { ...nextJob, state: active.state, failureReason: undefined },
        );
        continue;
      }

      try {
        const status = await submitter.query(job.id);
        const terminal = await this.detectTerminalStateFromOutput(job);
        updated.push(
          terminal
            ? { ...job, state: terminal.state, failureReason: terminal.reason }
            : { ...job, state: status.state, failureReason: status.state === 'failed' ? job.failureReason : undefined },
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logError(`Refresh job ${job.id} failed: ${message}`);
        if (isJobMissingInScheduler(message)) {
          const terminal = await this.inferTerminalState(job);
          updated.push({ ...job, state: terminal.state, failureReason: terminal.reason });
        } else {
          updated.push(job);
        }
      }
    }

    this.jobs = updated;
    await this.persist();
    this.refresh();
  }

  private async fetchActiveJobsMap(submitter: Awaited<ReturnType<typeof createSubmitter>>): Promise<Map<string, { name: string; state: JobState }>> {
    const username = this.resolveSchedulerUsername();
    if (!username) {
      return new Map();
    }

    try {
      const jobs = await submitter.listUserJobs(username);
      return new Map(jobs.map((job) => [job.id, { name: job.name, state: job.state }]));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`Fetch jobs by user failed (${username}): ${message}`);
      return new Map();
    }
  }

  private mergeDiscoveredJobs(activeJobsById: Map<string, { name: string; state: JobState }>): void {
    if (!activeJobsById.size) {
      return;
    }

    const known = new Set(this.jobs.map((job) => job.id));
    const discovered: JobRecord[] = [];

    for (const [id, data] of activeJobsById.entries()) {
      if (known.has(id)) {
        continue;
      }

      discovered.push({
        id,
        backend: 'local',
        fileName: normalizeDiscoveredFileName(data.name),
        submittedAt: new Date().toISOString(),
        state: data.state,
      });
    }

    if (discovered.length > 0) {
      this.jobs = [...discovered, ...this.jobs].slice(0, 200);
      logInfo(`Discovered ${discovered.length} existing jobs from scheduler.`);
    }
  }

  private resolveSchedulerUsername(): string {
    const configured = getSettings().jobs.username.trim();
    if (configured) {
      return configured;
    }

    return (process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '').trim();
  }

  async cancelJob(item: unknown): Promise<void> {
    const target = getJobFromUnknown(item);
    if (!target) {
      void vscode.window.showWarningMessage('未识别到可取消的作业条目。');
      return;
    }
    if (!looksLikePbsJobId(target.id)) {
      void vscode.window.showWarningMessage('该作业不是 PBS 作业，无法取消。');
      return;
    }

    if (target.state === 'cancelled' || target.state === 'completed' || target.state === 'failed') {
      void vscode.window.showInformationMessage(`作业 ${target.id} 已是终态（${target.state}），无需再次取消。`);
      return;
    }

    const submitter = await createSubmitter(this.context);
    let result;
    try {
      result = await submitter.cancel(target.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isJobMissingInScheduler(message)) {
        this.jobs = this.jobs.map((job) => (job.id === target.id ? { ...job, state: 'cancelled' } : job));
        await this.persist();
        this.refresh();
        void vscode.window.showInformationMessage(`作业 ${target.id} 已不在队列中，状态已更新为 cancelled。`);
        return;
      }
      throw e;
    }

    const nextState: JobState = result.ok ? 'cancelled' : target.state;
    this.jobs = this.jobs.map((job) => (job.id === target.id ? { ...job, state: nextState } : job));
    await this.persist();
    this.refresh();

    if (result.ok) {
      void vscode.window.showInformationMessage(`已取消作业 ${target.id}`);
    } else {
      void vscode.window.showErrorMessage(`取消失败: ${result.stderr || '未知错误'}`);
    }
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async removeJob(item: unknown): Promise<void> {
    const target = getJobFromUnknown(item);
    if (!target) {
      void vscode.window.showWarningMessage('未识别到可删除的作业条目。');
      return;
    }

    this.jobs = this.jobs.filter((job) => !(job.id === target.id && job.submittedAt === target.submittedAt));
    await this.persist();
    this.refresh();
  }

  async clearFinishedJobs(): Promise<void> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => !['completed', 'failed', 'cancelled'].includes(job.state));
    await this.persist();
    this.refresh();
    void vscode.window.showInformationMessage(`已清理 ${before - this.jobs.length} 个已结束作业。`);
  }

  async openJobOutput(item: unknown): Promise<void> {
    const target = getJobFromUnknown(item);
    if (!target) {
      void vscode.window.showWarningMessage('未识别到作业条目。');
      return;
    }

    const fileUri = await this.resolveOutputFileUri(target);
    if (!fileUri) {
      void vscode.window.showWarningMessage(`未找到 ${target.fileName} 对应的 .log/.out 文件。`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async resolveOutputFileUri(item: unknown): Promise<vscode.Uri | undefined> {
    const target = getJobFromUnknown(item);
    if (!target) {
      return undefined;
    }

    const result = await this.findOutputFile(target);
    if (result?.linkedPath && target.filePath !== result.linkedPath) {
      this.jobs = this.jobs.map((job) => (
        job.id === target.id && job.submittedAt === target.submittedAt
          ? { ...job, filePath: result.linkedPath }
          : job
      ));
      await this.persist();
    }

    return result?.uri;
  }

  async resolveInputFileUri(item: unknown): Promise<vscode.Uri | undefined> {
    const target = getJobFromUnknown(item);
    if (!target) {
      return undefined;
    }

    const result = await this.findInputFile(target);
    if (result?.linkedPath && target.filePath !== result.linkedPath) {
      this.jobs = this.jobs.map((job) => (
        job.id === target.id && job.submittedAt === target.submittedAt
          ? { ...job, filePath: result.linkedPath }
          : job
      ));
      await this.persist();
    }

    return result?.uri;
  }

  private async findOutputFile(job: JobRecord): Promise<{ uri: vscode.Uri; linkedPath?: string } | undefined> {
    const baseName = path.basename(job.fileName, path.extname(job.fileName));
    const exts = ['.log', '.out', '.LOG', '.OUT'];

    if (job.filePath) {
      const dir = path.dirname(job.filePath);
      for (const ext of exts) {
        const candidate = path.join(dir, `${baseName}${ext}`);
        try {
          await access(candidate);
          return { uri: vscode.Uri.file(candidate) };
        } catch {
        }
      }
    }

    if (looksLikePbsJobId(job.id)) {
      try {
        const submitter = await createSubmitter(this.context);
        const status = await submitter.query(job.id);
        const hintDirs = parseSchedulerHintDirs(status.stdout);

        for (const dir of hintDirs) {
          for (const ext of exts) {
            const candidate = path.join(dir, `${baseName}${ext}`);
            try {
              await access(candidate);
              return { uri: vscode.Uri.file(candidate), linkedPath: candidate };
            } catch {
            }
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logError(`Resolve output by scheduler failed (${job.id}): ${message}`);
      }
    }

    const found = await vscode.workspace.findFiles(`**/${baseName}.{log,out,LOG,OUT}`, undefined, 50);
    if (found.length === 0) {
      return undefined;
    }
    if (found.length === 1) {
      return { uri: found[0], linkedPath: found[0].fsPath };
    }

    const selected = await vscode.window.showQuickPick(
      found.map((uri) => ({
        label: path.basename(uri.fsPath),
        description: vscode.workspace.asRelativePath(uri.fsPath),
        uri,
      })),
      { placeHolder: `找到 ${found.length} 个同名结果，请选择 ${job.fileName} 对应文件` },
    );

    if (!selected) {
      return undefined;
    }

    return { uri: selected.uri, linkedPath: selected.uri.fsPath };
  }

  private async findInputFile(job: JobRecord): Promise<{ uri: vscode.Uri; linkedPath?: string } | undefined> {
    const baseName = path.basename(job.fileName, path.extname(job.fileName));
    const fileName = `${baseName}.gjf`;

    if (job.filePath) {
      const candidateInSameDir = path.join(path.dirname(job.filePath), fileName);
      try {
        await access(candidateInSameDir);
        return { uri: vscode.Uri.file(candidateInSameDir), linkedPath: candidateInSameDir };
      } catch {
      }
    }

    if (looksLikePbsJobId(job.id)) {
      try {
        const submitter = await createSubmitter(this.context);
        const status = await submitter.query(job.id);
        const hintDirs = parseSchedulerHintDirs(status.stdout);

        for (const dir of hintDirs) {
          const candidate = path.join(dir, fileName);
          try {
            await access(candidate);
            return { uri: vscode.Uri.file(candidate), linkedPath: candidate };
          } catch {
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logError(`Resolve input by scheduler failed (${job.id}): ${message}`);
      }
    }

    const found = await vscode.workspace.findFiles(`**/${fileName}`, undefined, 50);
    if (found.length === 0) {
      return undefined;
    }
    if (found.length === 1) {
      return { uri: found[0], linkedPath: found[0].fsPath };
    }

    const selected = await vscode.window.showQuickPick(
      found.map((uri) => ({
        label: path.basename(uri.fsPath),
        description: vscode.workspace.asRelativePath(uri.fsPath),
        uri,
      })),
      { placeHolder: `找到 ${found.length} 个同名输入文件，请选择 ${fileName}` },
    );

    if (!selected) {
      return undefined;
    }

    return { uri: selected.uri, linkedPath: selected.uri.fsPath };
  }

  private async inferTerminalState(job: JobRecord): Promise<{ state: JobState; reason?: string }> {
    if (job.state === 'cancelled') {
      return { state: 'cancelled' };
    }

    const terminal = await this.detectTerminalStateFromOutput(job);
    if (terminal) {
      return terminal;
    }

    const output = await this.findOutputFile(job);
    if (!output) {
      return { state: 'completed' };
    }

    return { state: 'failed', reason: '未检测到 Normal termination' };
  }

  private async detectTerminalStateFromOutput(job: JobRecord): Promise<{ state: JobState; reason?: string } | undefined> {
    const output = await this.findOutputFile(job);
    if (!output) {
      return undefined;
    }

    try {
      const content = await readFile(output.uri.fsPath, 'utf8');
      const termination = classifyGaussianTermination(content);
      if (termination.status === 'normal') {
        return { state: 'completed' };
      }
      if (termination.status === 'error') {
        return { state: 'failed', reason: formatFailureReason(termination.reason) ?? '计算异常结束' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`Read output file failed (${output.uri.fsPath}): ${message}`);
    }

    return undefined;
  }

  private configureAutoRefresh(): void {
    const seconds = getSettings().jobs.autoRefreshSeconds;
    if (seconds <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      void this.refreshStatuses().catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        logError(`Auto refresh jobs failed: ${message}`);
      });
    }, seconds * 1000);

    logInfo(`Job auto refresh enabled: every ${seconds}s`);
  }

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, this.jobs);
  }
}
