import * as vscode from 'vscode';
import { BuiltinTemplate, GjfTemplate } from '../templates/types';

export interface ChemAssistSettings {
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
    style: 'ballStick' | 'stick' | 'sphere' | 'line';
    stickRadius: number;
    sphereScale: number;
    vibrationFps: number;
    maxDisplayedFrequencies: number;
    autoZoomOnFrameChange: boolean;
  };
  customTemplates: GjfTemplate[];
}

export function getSettings(): ChemAssistSettings {
  const cfg = vscode.workspace.getConfiguration('chemAssist');
  return {
    runCommandTemplate: cfg.get<string>('submit.runCommandTemplate', cfg.get<string>('submit.localCommandTemplate', 'g16 {file}')),
    preCommands: cfg.get<string[]>('submit.preCommands', ['source /etc/profile']),
    pbs: {
      queue: cfg.get<string>('pbs.queue', ''),
      nodes: cfg.get<number>('pbs.nodes', 1),
      ppn: cfg.get<number>('pbs.ppn', 8),
      walltime: cfg.get<string>('pbs.walltime', '48:00:00'),
      mem: cfg.get<string>('pbs.mem', '16gb'),
    },
    parser: {
      maxFrames: cfg.get<number>('parser.maxFrames', 500),
    },
    jobs: {
      autoRefreshSeconds: cfg.get<number>('jobs.autoRefreshSeconds', 60),
      username: cfg.get<string>('jobs.username', ''),
    },
    viewer: {
      backgroundColor: cfg.get<string>('viewer.backgroundColor', 'white'),
      style: cfg.get<'ballStick' | 'stick' | 'sphere' | 'line'>('viewer.style', 'ballStick'),
      stickRadius: cfg.get<number>('viewer.stickRadius', 0.18),
      sphereScale: cfg.get<number>('viewer.sphereScale', 0.25),
      vibrationFps: cfg.get<number>('viewer.vibrationFps', 10),
      maxDisplayedFrequencies: cfg.get<number>('viewer.maxDisplayedFrequencies', 180),
      autoZoomOnFrameChange: cfg.get<boolean>('viewer.autoZoomOnFrameChange', true),
    },
    customTemplates: cfg.get<GjfTemplate[]>('templates.custom', []),
  };
}

export function mergeTemplates(builtin: BuiltinTemplate[], custom: GjfTemplate[]): GjfTemplate[] {
  return [...builtin, ...custom];
}
