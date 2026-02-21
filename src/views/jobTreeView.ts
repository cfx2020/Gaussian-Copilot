import * as vscode from 'vscode';
import { access } from 'fs/promises';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { getSettings } from '../config/settings';
import { logError, logInfo } from '../logging/diagnostics';
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

function summarizeBatchStates(jobs: JobRecord[]): string {
  const count = (state: JobState) => jobs.filter((job) => job.state === state).length;
  return `运${count('running')} 排${count('queued')} 成${count('completed')} 失${count('failed')} 取${count('cancelled')}`;
}

function detectFailureReason(content: string): string | undefined {
  if (/l9999\.exe/i.test(content)) {
    return 'L9999（SCF/收敛问题）';
  }
  if (/l103\.exe/i.test(content)) {
    return 'L103（几何/初猜问题）';
  }
  if (/l502\.exe/i.test(content)) {
    return 'L502（SCF不收敛）';
  }
  if (/segmentation fault/i.test(content)) {
    return 'Segmentation fault';
  }
  if (/killed|signal/i.test(content)) {
    return '进程被系统终止';
  }
  if (/error termination/i.test(content)) {
    return 'Gaussian Error termination';
  }
  return undefined;
}

class JobTreeItem extends vscode.TreeItem {
  constructor(public readonly job: JobRecord) {
    super(job.fileName, vscode.TreeItemCollapsibleState.None);
    this.description = getStateLabel(job.state);
    const reasonLine = job.failureReason ? `\n失败原因: ${job.failureReason}` : '';
    this.tooltip = `${job.fileName}\nJobID: ${job.id}\n状态: ${getStateLabel(job.state)}\n提交时间: ${job.submittedAt}${reasonLine}`;
    this.contextValue = 'chemAssistJobItem';
    this.iconPath = getStateIcon(job.state);
  }
}

class BatchTreeItem extends vscode.TreeItem {
  constructor(public readonly batch: BatchRecord) {
    super(`${batch.startTime}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${batch.jobs.length} 个作业`;
    this.tooltip = `时间: ${batch.startTime}\n作业数: ${batch.jobs.length}\n${summarizeBatchStates(batch.jobs)}`;
    this.contextValue = 'chemAssistJobBatchItem';
    this.iconPath = undefined;
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

      try {
        const status = await submitter.query(job.id);
        updated.push({ ...job, state: status.state, failureReason: status.state === 'failed' ? job.failureReason : undefined });
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
    return this.findOutputFile(target);
  }

  private async findOutputFile(job: JobRecord): Promise<vscode.Uri | undefined> {
    const baseName = path.basename(job.fileName, path.extname(job.fileName));
    const exts = ['.log', '.out', '.LOG', '.OUT'];

    if (job.filePath) {
      const dir = path.dirname(job.filePath);
      for (const ext of exts) {
        const candidate = path.join(dir, `${baseName}${ext}`);
        try {
          await access(candidate);
          return vscode.Uri.file(candidate);
        } catch {
        }
      }
    }

    const found = await vscode.workspace.findFiles(`**/${baseName}.{log,out,LOG,OUT}`, undefined, 1);
    return found[0];
  }

  private async inferTerminalState(job: JobRecord): Promise<{ state: JobState; reason?: string }> {
    if (job.state === 'cancelled') {
      return { state: 'cancelled' };
    }

    const outputUri = await this.findOutputFile(job);
    if (!outputUri) {
      return { state: 'completed' };
    }

    try {
      const content = await readFile(outputUri.fsPath, 'utf8');
      if (/normal termination/i.test(content)) {
        return { state: 'completed' };
      }
      if (/error termination|l9999\.exe|segmentation fault|killed|terminated/i.test(content)) {
        return { state: 'failed', reason: detectFailureReason(content) ?? '计算异常结束' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`Read output file failed (${outputUri.fsPath}): ${message}`);
    }

    return { state: 'failed', reason: '未检测到 Normal termination' };
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
