import * as path from 'path';
import * as vscode from 'vscode';
import { getSettings, mergeTemplates } from './config/settings';
import { initDiagnostics, logError, logInfo } from './logging/diagnostics';
import { parseGaussianLog } from './parser/gaussianLogParser';
import { createSubmitter } from './submission/submitter';
import { builtinTemplates } from './templates/builtinTemplates';
import { renderTemplate } from './templates/templateEngine';
import { validateTemplate } from './templates/templateValidator';
import { GjfTemplate } from './templates/types';
import { error, info, warn } from './ui/notifications';
import { JobTreeProvider } from './views/jobTreeView';
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
  return ext === '.log' || ext === '.out';
}

function isInputFile(uri: vscode.Uri): boolean {
  return path.extname(uri.fsPath).toLowerCase() === '.gjf';
}

async function handleVisualize(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? await getActiveFile();
  if (!target) {
    warn('未检测到活动文件。');
    return;
  }

  const ext = path.extname(target.fsPath).toLowerCase();
  if (ext !== '.log' && ext !== '.out') {
    warn('当前文件不是 .log 或 .out。');
    return;
  }

  const settings = getSettings();
  logInfo(`Parsing log file: ${target.fsPath}`);
  const summary = await parseGaussianLog(target.fsPath, settings.parser.maxFrames);
  showLogPanel(
    (globalThis as unknown as { extensionContext: vscode.ExtensionContext }).extensionContext,
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
    warn('未选中 .log 或 .out 文件。');
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

  info(`已处理 ${targets.length} 个输出文件。`);
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
  const jobTreeView = vscode.window.createTreeView('chemAssist.jobView', { treeDataProvider: jobsProvider });
  context.subscriptions.push(jobTreeView);

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
      const uri = await jobsProvider.resolveOutputFileUri(item);
      if (!uri) {
        warn('未找到对应的 .log/.out 文件。');
        return;
      }
      await handleVisualize(uri);
    }),
  );

  logInfo('Gaussian Copilot activated.');
}

export function deactivate(): void {
  logInfo('Gaussian Copilot deactivated.');
}
