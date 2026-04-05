import * as vscode from 'vscode';
import { BuiltinTemplate, GjfTemplate } from '../templates/types';

export interface GaussianCopilotSettings {
  runCommandTemplate: string;
  preCommands: string[];
  pbs: {
    queue: string;
    nodes: number;
    ppn: number;
    walltime: string;
    mem: string;
  };
  parser: {
    maxFrames: number;
  };
  jobs: {
    autoRefreshSeconds: number;
    username: string;
  };
  viewer: {
    backgroundColor: string;
    style: 'ballStick' | 'stick' | 'sphere' | 'line' | 'cpkBallStick' | 'licorice' | 'spacefill';
    stickRadius: number;
    sphereScale: number;
    vibrationFps: number;
    maxDisplayedFrequencies: number;
    autoZoomOnFrameChange: boolean;
  };
  customTemplates: GjfTemplate[];
}

function getExplicitConfigValue<T>(section: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const inspected = section.inspect<T>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

function getConfigValue<T>(
  section: vscode.WorkspaceConfiguration,
  legacySection: vscode.WorkspaceConfiguration,
  key: string,
  defaultValue: T,
): T {
  const value = getExplicitConfigValue<T>(section, key);
  if (value !== undefined) {
    return value;
  }

  const legacyValue = getExplicitConfigValue<T>(legacySection, key);
  if (legacyValue !== undefined) {
    return legacyValue;
  }

  return section.get<T>(key, defaultValue);
}

export function getSettings(): GaussianCopilotSettings {
  const cfg = vscode.workspace.getConfiguration('gaussianCopilot');
  const legacyCfg = vscode.workspace.getConfiguration('chemAssist');
  return {
    runCommandTemplate: getConfigValue(
      cfg,
      legacyCfg,
      'submit.runCommandTemplate',
      legacyCfg.get<string>('submit.localCommandTemplate', 'gsub {file}'),
    ),
    preCommands: getConfigValue(cfg, legacyCfg, 'submit.preCommands', ['source ~/.bashrc']),
    pbs: {
      queue: getConfigValue(cfg, legacyCfg, 'pbs.queue', ''),
      nodes: getConfigValue(cfg, legacyCfg, 'pbs.nodes', 1),
      ppn: getConfigValue(cfg, legacyCfg, 'pbs.ppn', 8),
      walltime: getConfigValue(cfg, legacyCfg, 'pbs.walltime', '48:00:00'),
      mem: getConfigValue(cfg, legacyCfg, 'pbs.mem', '16gb'),
    },
    parser: {
      maxFrames: getConfigValue(cfg, legacyCfg, 'parser.maxFrames', 500),
    },
    jobs: {
      autoRefreshSeconds: getConfigValue(cfg, legacyCfg, 'jobs.autoRefreshSeconds', 60),
      username: getConfigValue(cfg, legacyCfg, 'jobs.username', ''),
    },
    viewer: {
      backgroundColor: getConfigValue(cfg, legacyCfg, 'viewer.backgroundColor', 'white'),
      style: getConfigValue<'ballStick' | 'stick' | 'sphere' | 'line' | 'cpkBallStick' | 'licorice' | 'spacefill'>(
        cfg,
        legacyCfg,
        'viewer.style',
        'ballStick',
      ),
      stickRadius: getConfigValue(cfg, legacyCfg, 'viewer.stickRadius', 0.18),
      sphereScale: getConfigValue(cfg, legacyCfg, 'viewer.sphereScale', 0.25),
      vibrationFps: getConfigValue(cfg, legacyCfg, 'viewer.vibrationFps', 10),
      maxDisplayedFrequencies: getConfigValue(cfg, legacyCfg, 'viewer.maxDisplayedFrequencies', 180),
      autoZoomOnFrameChange: getConfigValue(cfg, legacyCfg, 'viewer.autoZoomOnFrameChange', true),
    },
    customTemplates: getConfigValue(cfg, legacyCfg, 'templates.custom', [] as GjfTemplate[]),
  };
}

export function mergeTemplates(builtin: BuiltinTemplate[], custom: GjfTemplate[]): GjfTemplate[] {
  return [...builtin, ...custom];
}
