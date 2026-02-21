import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { LocalSubmitter } from './localSubmitter';
import { Submitter } from './types';

export async function createSubmitter(context: vscode.ExtensionContext): Promise<Submitter> {
  void context;
  const settings = getSettings();
  return new LocalSubmitter(settings);
}
