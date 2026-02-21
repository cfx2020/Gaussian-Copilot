import * as vscode from 'vscode';

export function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}

export function warn(message: string): void {
  void vscode.window.showWarningMessage(message);
}

export function error(message: string): void {
  void vscode.window.showErrorMessage(message);
}
