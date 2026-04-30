import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import { getSettings, mergeTemplates } from './config/settings';
import { initDiagnostics, logError, logInfo } from './logging/diagnostics';
import { parseGaussianLog } from './parser/gaussianLogParser';
import { parseXyzFile } from './parser/xyzParser';
import { createSubmitter } from './submission/submitter';
import { builtinTemplates } from './templates/builtinTemplates';
import { renderTemplate } from './templates/templateEngine';
import { validateTemplate } from './templates/templateValidator';
import { GjfTemplate } from './templates/types';
import { error, info, warn } from './ui/notifications';
import { JobRecord, JobTreeProvider } from './views/jobTreeView';
import { showLogPanel } from './webview/panel';

async function getActiveFile(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri;
}

function normalizeSelection(primary?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  const candidates = (selected && selected.length ? selected : (primary ? [primary] : []))
    .filter((item) => item && item.scheme === 'file');
  const seen = new Set<string>();
  const result: vscode.Uri[] = [];

  for (const uri of candidates) {
    if (!seen.has(uri.fsPath)) {
      seen.add(uri.fsPath);
      result.push(uri);
    }
  }

  return result;
}

function isOutputFile(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return ext === '.log' || ext === '.out' || ext === '.xyz';
}

function isInputFile(uri: vscode.Uri): boolean {
  return path.extname(uri.fsPath).toLowerCase() === '.gjf';
}

function getParentUri(uri: vscode.Uri): vscode.Uri {
  const normalizedPath = uri.path.replace(/\/+/g, '/');
  const parentPath = normalizedPath.replace(/\/[^/]*$/, '') || '/';
  return uri.with({ path: parentPath });
}

async function resolveUniqueTargetUri(dir: vscode.Uri, baseName: string): Promise<vscode.Uri> {
  const parsed = path.parse(baseName);
  let candidate = vscode.Uri.joinPath(dir, baseName);
  let index = 1;

  while (true) {
    try {
      await vscode.workspace.fs.stat(candidate);
      candidate = vscode.Uri.joinPath(dir, `${parsed.name}-${index}${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

function getJobRecordFromTreeItem(item: unknown): JobRecord | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const maybe = item as { job?: JobRecord };
  if (maybe.job && typeof maybe.job.id === 'string' && typeof maybe.job.fileName === 'string') {
    return maybe.job;
  }

  const raw = item as JobRecord;
  if (typeof raw.id === 'string' && typeof raw.fileName === 'string') {
    return raw;
  }

  return undefined;
}

function parseSchedulerOutputLocation(stdout: string): { host: string; remoteDir: string } | undefined {
  const match = stdout.match(/Output_Path\s*=\s*([^:\s]+):([^\r\n]+)/i);
  if (!match?.[1] || !match?.[2]) {
    return undefined;
  }

  const host = match[1].trim();
  const remoteFilePath = match[2].trim().replace(/\\/g, '/');
  const remoteDir = path.posix.dirname(remoteFilePath);
  if (!host || !remoteDir) {
    return undefined;
  }

  return { host, remoteDir };
}

function runScp(remoteSpec: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('scp', [remoteSpec, localPath], { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const message = stderr.trim() || `scp exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

async function fetchOutputFromServer(
  context: vscode.ExtensionContext,
  item: unknown,
): Promise<{ fileName: string; content: Uint8Array } | undefined> {
  const record = getJobRecordFromTreeItem(item);
  if (!record || !record.id || record.id.startsWith('local-')) {
    return undefined;
  }

  let location: { host: string; remoteDir: string } | undefined;
  try {
    const submitter = await createSubmitter(context);
    const status = await submitter.query(record.id);
    location = parseSchedulerOutputLocation(status.stdout);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logError(`Query scheduler for download failed (${record.id}): ${message}`);
  }

  if (!location && record.remotePath) {
    const normalizedRemote = record.remotePath.replace(/\\/g, '/').trim();
    const hostSplit = normalizedRemote.match(/^([^:]+):(.+)$/);
    if (hostSplit?.[1] && hostSplit?.[2]) {
      location = {
        host: hostSplit[1].trim(),
        remoteDir: path.posix.dirname(hostSplit[2].trim()),
      };
    }
  }

  if (!location) {
    return undefined;
  }

  const configuredUser = getSettings().jobs.username.trim();
  const username = configuredUser || (process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '').trim();
  const hostWithUser = location.host.includes('@') || !username
    ? location.host
    : `${username}@${location.host}`;

  const baseName = path.basename(record.fileName, path.extname(record.fileName));
  const candidates = ['.log', '.out', '.LOG', '.OUT'];
  const tmpDirUri = vscode.Uri.file(path.join(os.tmpdir(), 'gaussian-copilot-downloads'));
  await vscode.workspace.fs.createDirectory(tmpDirUri);

  for (const ext of candidates) {
    const remoteFile = path.posix.join(location.remoteDir, `${baseName}${ext}`);
    const tempName = `${baseName}-${Date.now()}-${Math.random().toString(16).slice(2)}${ext.toLowerCase()}`;
    const localTarget = vscode.Uri.joinPath(tmpDirUri, tempName);

    try {
      await runScp(`${hostWithUser}:${remoteFile}`, localTarget.fsPath);
      const content = await vscode.workspace.fs.readFile(localTarget);
      await vscode.workspace.fs.delete(localTarget, { useTrash: false });
      return {
        fileName: `${baseName}${ext.toLowerCase()}`,
        content,
      };
    } catch {
      try {
        await vscode.workspace.fs.delete(localTarget, { useTrash: false });
      } catch {
      }
    }
  }

  return undefined;
}

async function handleDownloadJobOutput(
  context: vscode.ExtensionContext,
  jobTreeView: vscode.TreeView<vscode.TreeItem>,
  jobsProvider: JobTreeProvider,
  item: unknown,
): Promise<void> {
  const selected = jobTreeView.selection
    .filter((entry) => (entry as { contextValue?: string }).contextValue === 'chemAssistJobItem');
  const targets = selected.length > 0 ? selected : [item];

  const targetItems = targets.filter(Boolean);
  if (!targetItems.length) {
    warn('请选择一个或多个作业后再下载。');
    return;
  }

  const isBatch = targetItems.length > 1;
  let batchDestinationDir: vscode.Uri | undefined;
  let batchFirstSaveHandled = false;

  let success = 0;
  let failed = 0;
  let skipped = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `下载 log/out (${targetItems.length})` },
    async (progress) => {
      for (let index = 0; index < targetItems.length; index += 1) {
        const target = targetItems[index];
        const record = getJobRecordFromTreeItem(target);
        progress.report({ message: `${index + 1}/${targetItems.length} ${record?.fileName ?? ''}`.trim() });

        try {
          let sourceFileName = '';
          let sourceContent: Uint8Array | undefined;

          const remoteFetched = await fetchOutputFromServer(context, target);
          if (remoteFetched) {
            sourceFileName = remoteFetched.fileName;
            sourceContent = remoteFetched.content;
          } else {
            const outputUri = await jobsProvider.resolveOutputFileUri(target);
            if (outputUri) {
              sourceFileName = path.basename(outputUri.fsPath);
              sourceContent = await vscode.workspace.fs.readFile(outputUri);
            }
          }

          if (!sourceContent) {
            skipped += 1;
            continue;
          }

          if (isBatch) {
            if (!batchFirstSaveHandled) {
              const firstSaveUri = await vscode.window.showSaveDialog({
                title: '选择批量下载位置（首个文件）',
                saveLabel: '下载',
                defaultUri: vscode.Uri.file(path.join(os.homedir(), sourceFileName)),
                filters: {
                  'Gaussian Output': ['log', 'out'],
                  'All Files': ['*'],
                },
              });

              if (!firstSaveUri) {
                skipped += 1;
                return;
              }

              await vscode.workspace.fs.writeFile(firstSaveUri, sourceContent);
              batchDestinationDir = getParentUri(firstSaveUri);
              batchFirstSaveHandled = true;
            } else if (batchDestinationDir) {
              const destinationUri = await resolveUniqueTargetUri(batchDestinationDir, sourceFileName);
              await vscode.workspace.fs.writeFile(destinationUri, sourceContent);
            } else {
              skipped += 1;
              continue;
            }
          } else {
            const saveUri = await vscode.window.showSaveDialog({
              title: '选择下载位置',
              saveLabel: '下载',
              defaultUri: vscode.Uri.file(path.join(os.homedir(), sourceFileName)),
              filters: {
                'Gaussian Output': ['log', 'out'],
                'All Files': ['*'],
              },
            });

            if (!saveUri) {
              skipped += 1;
              continue;
            }

            await vscode.workspace.fs.writeFile(saveUri, sourceContent);
          }
          success += 1;
        } catch (e) {
          failed += 1;
          const message = e instanceof Error ? e.message : String(e);
          logError(`Download output failed: ${message}`);
        }
      }
    },
  );

  if (failed === 0 && skipped === 0) {
    info(`下载完成：成功 ${success} 个。`);
    return;
  }

  warn(`下载完成：成功 ${success} 个，未找到 ${skipped} 个，失败 ${failed} 个。`);
}

async function handleVisualize(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? await getActiveFile();
  if (!target) {
    warn('未检测到活动文件。');
    return;
  }

  const ext = path.extname(target.fsPath).toLowerCase();
  if (ext !== '.log' && ext !== '.out' && ext !== '.xyz') {
    warn('当前文件不是 .log、.out 或 .xyz。');
    return;
  }

  const settings = getSettings();
  logInfo(`Parsing visualization file: ${target.fsPath}`);
  const summary = ext === '.xyz'
    ? await parseXyzFile(target.fsPath, settings.parser.maxFrames)
    : await parseGaussianLog(target.fsPath, settings.parser.maxFrames);
  showLogPanel(
    (globalThis as unknown as { extensionContext: vscode.ExtensionContext }).extensionContext,
    target.fsPath,
    path.basename(target.fsPath),
    summary,
    settings.viewer,
  );
}

function defaultTemplateVars(uri: vscode.Uri): Record<string, string> {
  const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
  return {
    nproc: '8',
    mem: '16GB',
    chk: `${base}.chk`,
    method: 'B3LYP',
    basis: '6-31G(d)',
    charge: '0',
    multiplicity: '1',
    solvent: 'acetonitrile',
    coordinates: 'Ir 0.0 0.0 0.0',
    ecpTail: 'Ir 0\nSDD\n****\n\nIr 0\nSDD\n',
  };
}

async function handleTemplateApply(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    warn('未检测到活动编辑器。');
    return;
  }

  const uri = editor.document.uri;
  if (path.extname(uri.fsPath).toLowerCase() !== '.gjf') {
    warn('当前文件不是 .gjf。');
    return;
  }

  const settings = getSettings();
  const templates = mergeTemplates(builtinTemplates, settings.customTemplates);
  const selected = await vscode.window.showQuickPick(
    templates.map((t) => ({ label: t.name, detail: t.description, template: t })),
    { placeHolder: '选择一个 GJF 模板' },
  );

  if (!selected) {
    return;
  }

  const chosen: GjfTemplate = selected.template;
  const errors = validateTemplate(chosen);
  if (errors.length) {
    error(`模板无效: ${errors.join('；')}`);
    return;
  }

  const rendered = renderTemplate(chosen, defaultTemplateVars(uri));
  await editor.edit((builder) => {
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length),
    );
    builder.replace(fullRange, rendered);
  });

  info(`已应用模板：${chosen.name}`);
}

async function handleSubmit(context: vscode.ExtensionContext, jobsProvider: JobTreeProvider, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? await getActiveFile();
  if (!target) {
    warn('未检测到活动文件。');
    return;
  }

  if (path.extname(target.fsPath).toLowerCase() !== '.gjf') {
    warn('当前文件不是 .gjf。');
    return;
  }

  try {
    const submitter = await createSubmitter(context);
    const fileName = path.basename(target.fsPath);
    const baseName = path.basename(target.fsPath, '.gjf');
    logInfo(`Submitting file: ${target.fsPath}`);

    const result = await submitter.submit({
      localFilePath: target.fsPath,
      fileName,
      baseName,
    });

    if (result.ok) {
      info(`提交成功：${result.jobId ?? '未识别作业号'}`);
      logInfo(`Submit ok: ${JSON.stringify(result)}`);
      await jobsProvider.addJobFromSubmit(result, fileName, target.fsPath);
    } else {
      error(`提交失败：${result.stderr || '未知错误'}`);
      logError(`Submit failed: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error(`提交异常：${message}`);
    logError(message);
  }
}

async function handleBatchVisualize(selection: vscode.Uri[]): Promise<void> {
  const targets = selection.filter(isOutputFile);
  if (!targets.length) {
    warn('未选中 .log、.out 或 .xyz 文件。');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `批量可视化 (${targets.length})` },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const current = targets[index];
        progress.report({ message: `${index + 1}/${targets.length}: ${path.basename(current.fsPath)}` });
        await handleVisualize(current);
      }
    },
  );

  info(`已处理 ${targets.length} 个可视化文件。`);
}

async function handleBatchSubmit(context: vscode.ExtensionContext, jobsProvider: JobTreeProvider, selection: vscode.Uri[]): Promise<void> {
  const targets = selection.filter(isInputFile);
  if (!targets.length) {
    warn('未选中 .gjf 文件。');
    return;
  }

  const submitter = await createSubmitter(context);
  let success = 0;
  let failed = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `批量提交 (${targets.length})` },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const current = targets[index];
        const fileName = path.basename(current.fsPath);
        const baseName = path.basename(current.fsPath, '.gjf');
        progress.report({ message: `${index + 1}/${targets.length}: ${fileName}` });

        try {
          const result = await submitter.submit({
            localFilePath: current.fsPath,
            fileName,
            baseName,
          });

          if (result.ok) {
            success += 1;
            await jobsProvider.addJobFromSubmit(result, fileName, current.fsPath);
          } else {
            failed += 1;
            logError(`Batch submit failed (${fileName}): ${result.stderr || 'unknown'}`);
          }
        } catch (e) {
          failed += 1;
          const message = e instanceof Error ? e.message : String(e);
          logError(`Batch submit exception (${fileName}): ${message}`);
        }
      }
    },
  );

  if (failed === 0) {
    info(`批量提交完成：成功 ${success} 个。`);
  } else {
    warn(`批量提交完成：成功 ${success} 个，失败 ${failed} 个（详见输出日志）。`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  (globalThis as unknown as { extensionContext: vscode.ExtensionContext }).extensionContext = context;
  initDiagnostics();
  const jobsProvider = new JobTreeProvider(context);

  context.subscriptions.push(jobsProvider);
  const jobTreeView = vscode.window.createTreeView('chemAssist.jobView', {
    treeDataProvider: jobsProvider,
    canSelectMany: true,
  });
  context.subscriptions.push(jobTreeView);

  void jobsProvider.refreshStatuses().catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    logError(`Initial refresh jobs failed: ${message}`);
  });

  context.subscriptions.push(
    jobTreeView.onDidChangeSelection(async (event) => {
      const first = event.selection[0] as { contextValue?: string } | undefined;
      if (!first || first.contextValue !== 'chemAssistJobItem') {
        return;
      }
      await jobsProvider.openJobOutput(first);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.visualizeLog', async (uri?: vscode.Uri) => {
      await handleVisualize(uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.submitGjf', async (uri?: vscode.Uri) => {
      await handleSubmit(context, jobsProvider, uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.batchSubmitGjf', async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      await handleBatchSubmit(context, jobsProvider, normalizeSelection(uri, selectedUris));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.batchVisualizeLog', async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      await handleBatchVisualize(normalizeSelection(uri, selectedUris));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.applyGjfTemplate', async () => {
      await handleTemplateApply();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.refreshJobs', async () => {
      await jobsProvider.refreshStatuses();
      info('作业状态已刷新');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.cancelJob', async (item: unknown) => {
      if (!item) {
        warn('请选择一个作业后再取消。');
        return;
      }
      await jobsProvider.cancelJob(item);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.removeJob', async (item: unknown) => {
      await jobsProvider.removeJob(item);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.clearFinishedJobs', async () => {
      await jobsProvider.clearFinishedJobs();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.openJobOutput', async (item: unknown) => {
      const selected = jobTreeView.selection.filter((entry) => (entry as { contextValue?: string }).contextValue === 'chemAssistJobItem');
      const targets = selected.length > 0 ? selected : [item];

      const uris: vscode.Uri[] = [];
      for (const target of targets) {
        const uri = await jobsProvider.resolveOutputFileUri(target);
        if (uri) {
          uris.push(uri);
        }
      }

      if (!uris.length) {
        warn('未找到对应的 .log/.out 文件。');
        return;
      }

      if (uris.length === 1) {
        await handleVisualize(uris[0]);
        return;
      }

      await handleBatchVisualize(uris);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.openJobGjf', async (item: unknown) => {
      const selected = jobTreeView.selection.filter((entry) => (entry as { contextValue?: string }).contextValue === 'chemAssistJobItem');
      const targets = selected.length > 0 ? selected : [item];

      const uris: vscode.Uri[] = [];
      for (const target of targets) {
        const uri = await jobsProvider.resolveInputFileUri(target);
        if (uri) {
          uris.push(uri);
        }
      }

      if (!uris.length) {
        warn('未找到对应的 .gjf 文件。');
        return;
      }

      for (const uri of uris) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.downloadJobOutput', async (item: unknown) => {
      await handleDownloadJobOutput(context, jobTreeView, jobsProvider, item);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chemAssist.resubmitJob', async (item: unknown) => {
      const selected = jobTreeView.selection.filter((entry) => (entry as { contextValue?: string }).contextValue === 'chemAssistJobItem');
      const targets = selected.length > 0 ? selected : [item];

      const uris: vscode.Uri[] = [];
      for (const target of targets) {
        const uri = await jobsProvider.resolveInputFileUri(target);
        if (uri) {
          uris.push(uri);
        }
      }

      if (!uris.length) {
        warn('未找到可重新提交的 .gjf 文件。');
        return;
      }

      await handleBatchSubmit(context, jobsProvider, uris);
    }),
  );

  logInfo('Gaussian Copilot activated.');
}

export function deactivate(): void {
  logInfo('Gaussian Copilot deactivated.');
}
