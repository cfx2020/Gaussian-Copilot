import { exec } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { ChemAssistSettings } from '../config/settings';
import { JobStatusResult, SchedulerJobSummary, SubmitRequest, SubmitResult, Submitter } from './types';

function renderCommand(template: string, req: SubmitRequest): string {
  const dir = path.dirname(req.localFilePath);
  return template
    .split('{file}').join(req.localFilePath)
    .split('{basename}').join(req.baseName)
    .split('{dir}').join(dir);
}

function normalizePbsState(raw: string): JobStatusResult['state'] {
  switch (raw.trim()) {
    case 'Q':
      return 'queued';
    case 'R':
      return 'running';
    case 'C':
      return 'completed';
    case 'E':
      return 'failed';
    case 'H':
      return 'queued';
    default:
      return 'unknown';
  }
}

function extractJobId(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\d+(\.[\w.-]+)?$/.test(line));
}

function isJobMissingInScheduler(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('unknown job id')
    || lower.includes('unknown job')
    || lower.includes('invalid job id')
    || lower.includes('does not exist');
}

function resolveUnixShell(): string | undefined {
  const candidates = ['/bin/bash', '/usr/bin/bash', process.env.SHELL];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function buildCommandWithPrelude(command: string, preCommands: string[], shell?: string): { executableCommand: string; shell?: string } {
  const normalizedPreCommands = preCommands
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (process.platform === 'win32') {
    if (!normalizedPreCommands.length) {
      return { executableCommand: command };
    }
    return {
      executableCommand: `${normalizedPreCommands.join(' && ')} && ${command}`,
    };
  }

  const prelude: string[] = [];
  const shellLooksLikeBash = !!shell && /(?:^|\/)bash(?:\.exe)?$/i.test(shell);
  if (shellLooksLikeBash) {
    prelude.push('shopt -s expand_aliases >/dev/null 2>&1 || true');
    prelude.push('[ -f ~/.bashrc ] && source ~/.bashrc || true');
  } else {
    prelude.push('[ -f ~/.profile ] && . ~/.profile || true');
  }

  prelude.push(...normalizedPreCommands);
  prelude.push(command);

  return {
    executableCommand: prelude.join('\n'),
    shell,
  };
}

function executeCommand(command: string, cwd?: string, shell?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, shell }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function shouldRetryWithBash(command: string, message: string): boolean {
  if (process.platform === 'win32') {
    return false;
  }

  if (!/permission denied|eacces/i.test(message)) {
    return false;
  }

  const trimmed = command.trim();
  if (!trimmed || /^bash\b/i.test(trimmed)) {
    return false;
  }

  return trimmed.includes('/') || /\.sh(?:\s|$)/i.test(trimmed);
}

async function runCommand(command: string, cwd?: string, preCommands: string[] = []): Promise<{ stdout: string; stderr: string }> {
  const shell = process.platform === 'win32' ? undefined : resolveUnixShell();
  const firstRun = buildCommandWithPrelude(command, preCommands, shell);

  try {
    return await executeCommand(firstRun.executableCommand, cwd, firstRun.shell);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldRetryWithBash(command, message)) {
      throw error;
    }

    const retryRun = buildCommandWithPrelude(`bash ${command}`, preCommands, shell);
    return executeCommand(retryRun.executableCommand, cwd, retryRun.shell);
  }
}

function parseQstatUserOutput(stdout: string): SchedulerJobSummary[] {
  const lines = stdout.split(/\r?\n/);
  const jobs: SchedulerJobSummary[] = [];
  const seen = new Set<string>();

  let inDataSection = false;

  for (const line of lines) {
    // Skip header and separator lines
    if (!line || /^\s*job\s+id|^\s*-+\s*$/i.test(line)) {
      inDataSection = /^\s*-+\s*$/.test(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Parse job line: extract Job ID (always first field)
    // Job ID format: digits.hostname (e.g., 1234.server)
    const jobIdMatch = trimmed.match(/^(\d+[\.\w.-]*)\s+/);
    if (!jobIdMatch) {
      continue;
    }

    const id = jobIdMatch[1];
    if (!/^\d+(\.[\w.-]+)?$/.test(id)) {
      continue;
    }

    if (seen.has(id)) {
      continue;
    }

    // Extract state: single uppercase letter (Q/R/C/E/H)
    // Usually appears near the end of the line
    let rawState = '';
    const stateMatch = line.match(/\s([QRCEH])\s+/);
    if (stateMatch) {
      rawState = stateMatch[1];
    }

    // If state not found with spaces, try to find it at end or near end
    if (!rawState) {
      const parts = trimmed.split(/\s+/);
      if (parts.length > 0) {
        // Look from right to left for state letter
        for (let i = parts.length - 1; i >= 0; i--) {
          if (/^[QRCEH]$/.test(parts[i])) {
            rawState = parts[i];
            break;
          }
        }
      }
    }

    // Extract name: everything after Job ID until we hit extra whitespace
    // or until we find the state field
    // The name is the second field after Job ID
    const idEndIndex = jobIdMatch[0].length;
    const remainder = trimmed.substring(idEndIndex).trim();
    const nameMatch = remainder.match(/^(\S+(?:\s+\S+)*?)(?:\s{2,}|\s+[A-Z])/);
    
    let name = id;
    if (nameMatch) {
      name = nameMatch[1];
    } else {
      // Fallback: take second space-separated field as name
      const parts = remainder.split(/\s+/);
      if (parts.length > 0 && parts[0]) {
        name = parts[0];
      }
    }

    jobs.push({
      id,
      name,
      state: normalizePbsState(rawState),
    });
    seen.add(id);
  }

  return jobs;
}

export class LocalSubmitter implements Submitter {
  constructor(private readonly settings: ChemAssistSettings) {}

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const command = renderCommand(this.settings.runCommandTemplate, request);
    const cwd = path.dirname(request.localFilePath);
    const result = await runCommand(command, cwd, this.settings.preCommands);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const parsedJobId = extractJobId(output);
    const fallbackJobId = `local-${Date.now()}`;
    const jobId = parsedJobId ?? fallbackJobId;

    return {
      ok: true,
      backend: 'local',
      stdout: result.stdout,
      stderr: result.stderr,
      submittedAt: new Date().toISOString(),
      localFilePath: request.localFilePath,
      jobId,
      rawJobId: jobId,
    };
  }

  async query(jobId: string): Promise<JobStatusResult> {
    if (!jobId || jobId.startsWith('local-')) {
      return {
        ok: true,
        backend: 'local',
        state: 'unknown',
        stdout: 'Local mode does not track scheduler states.',
        stderr: '',
      };
    }

    const result = await runCommand(`qstat -f ${jobId}`, undefined, this.settings.preCommands);
    const stateMatch = result.stdout.match(/job_state\s*=\s*([A-Z])/);
    const state = stateMatch ? normalizePbsState(stateMatch[1]) : 'unknown';

    return {
      ok: true,
      backend: 'local',
      state,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async cancel(jobId: string): Promise<JobStatusResult> {
    if (!jobId || jobId.startsWith('local-')) {
      return {
        ok: false,
        backend: 'local',
        state: 'unknown',
        stdout: '',
        stderr: '该作业不是 PBS 作业，无法取消。',
      };
    }

    let result;
    try {
      result = await runCommand(`qdel ${jobId}`, undefined, this.settings.preCommands);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isJobMissingInScheduler(message)) {
        return {
          ok: true,
          backend: 'local',
          state: 'cancelled',
          stdout: '',
          stderr: '',
        };
      }
      throw e;
    }

    return {
      ok: !result.stderr.trim(),
      backend: 'local',
      state: 'cancelled',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async listUserJobs(username: string): Promise<SchedulerJobSummary[]> {
    if (!username.trim()) {
      return [];
    }

    // Use -a flag to show all job states, which often provides better formatting
    // of long job names. Fallback to -u if -a doesn't work
    let result;
    try {
      result = await runCommand(`qstat -a -u ${username}`, undefined, this.settings.preCommands);
    } catch (e) {
      // Fallback to original command if -a is not supported
      try {
        result = await runCommand(`qstat -u ${username}`, undefined, this.settings.preCommands);
      } catch (innerE) {
        const message = innerE instanceof Error ? innerE.message : String(innerE);
        throw new Error(`Failed to query job status: ${message}`);
      }
    }

    return parseQstatUserOutput(result.stdout);
  }
}
