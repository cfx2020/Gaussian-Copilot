import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function initDiagnostics(): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Gaussian Copilot');
  }
}

export function logInfo(message: string): void {
  outputChannel?.appendLine(`[INFO] ${new Date().toISOString()} ${message}`);
}

export function logError(message: string): void {
  outputChannel?.appendLine(`[ERROR] ${new Date().toISOString()} ${message}`);
}

export function showDiagnostics(): void {
  outputChannel?.show(true);
}
