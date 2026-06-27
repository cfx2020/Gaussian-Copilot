import { exec } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { GaussianCopilotSettings } from '../config/settings';
import { JobStatusResult, SchedulerJobSummary, SubmitRequest, SubmitResult, Submitter } from './types';

const SCHEDULER_COMMAND_TIMEOUT_MS = 20_000;
const JOB_DETAIL_TIMEOUT_MS = 5_000;
const JOB_DETAIL_CONCURRENCY = 4;

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

function executeCommand(
  command: string,
  cwd?: string,
  shell?: string,
  timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, shell, timeout }, (error, stdout, stderr) => {
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

async function runCommand(
  command: string,
  cwd?: string,
  preCommands: string[] = [],
  timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
  const shell = process.platform === 'win32' ? undefined : resolveUnixShell();
  const firstRun = buildCommandWithPrelude(command, preCommands, shell);

  try {
    return await executeCommand(firstRun.executableCommand, cwd, firstRun.shell, timeout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldRetryWithBash(command, message)) {
      throw error;
    }

    const retryRun = buildCommandWithPrelude(`bash ${command}`, preCommands, shell);
    return executeCommand(retryRun.executableCommand, cwd, retryRun.shell, timeout);
  }
}

function parseQstatUserOutput(stdout: string): SchedulerJobSummary[] {
  const lines = stdout.split(/\r?\n/);
  const jobs: SchedulerJobSummary[] = [];
  const seen = new Set<string>();
  let format: 'a' | 'u' | 'unknown' = 'unknown';

  for (const line of lines) {
    if (!line) {
      continue;
    }

    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    // Detect table format from headers.
    if (/^job\s+id\s+username\s+queue\s+jobname/i.test(trimmedLine)) {
      format = 'a';
      continue;
    }
    if (/^job\s+id\s+name\s+user\s+time\s+use\s+s\s+queue/i.test(trimmedLine)) {
      format = 'u';
      continue;
    }

    // Skip separators and generic header lines.
    if (/^[-\s]+$/.test(trimmedLine) || /^job\s+id\b/i.test(trimmedLine)) {
      continue;
    }

    const trimmed = trimmedLine;

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

    const parts = trimmed.split(/\s+/);

    let name = id;
    let rawState = '';

    if (format === 'a') {
      // qstat -a -u: JobID Username Queue JobName ... S ...
      if (parts.length >= 4) {
        name = parts[3];
      }
      if (parts.length >= 10 && /^[QRCEH]$/.test(parts[9])) {
        rawState = parts[9];
      }
    } else if (format === 'u') {
      // qstat -u: JobID Name User TimeUse S Queue
      if (parts.length >= 2) {
        name = parts[1];
      }
      if (parts.length >= 6 && /^[QRCEH]$/.test(parts[5])) {
        rawState = parts[5];
      }
    }

    if (!rawState) {
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^[QRCEH]$/.test(parts[i])) {
          rawState = parts[i];
          break;
        }
      }
    }

    if (!name || name === id) {
      // Fallback for unknown formats: prefer the second token after Job ID.
      if (parts.length >= 2 && parts[1]) {
        name = parts[1];
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

function extractFullJobNameFromQstatFull(stdout: string): string | undefined {
  const match = stdout.match(/\bJob_Name\s*=\s*([^\r\n]+)/i);
  if (!match?.[1]) {
    return undefined;
  }
  const value = match[1].trim();
  return value || undefined;
}

function extractWorkDirFromQstatFull(stdout: string): string | undefined {
  const dirs: string[] = [];

  const addDir = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const normalized = value.trim();
    if (normalized && !dirs.includes(normalized)) {
      dirs.push(normalized);
    }
  };

  const initWorkDirMatch = stdout.match(/\binit_work_dir\s*=\s*([^\r\n]+)/i);
  if (initWorkDirMatch?.[1]) {
    addDir(initWorkDirMatch[1]);
  }

  const variableListMatch = stdout.match(/\bVariable_List\s*=\s*([\s\S]+)/i);
  if (variableListMatch?.[1]) {
    const workdirMatch = variableListMatch[1].match(/\bPBS_O_WORKDIR=([^,\r\n]+)/i);
    if (workdirMatch?.[1]) {
      addDir(workdirMatch[1]);
    }
  }

  const outputPathMatch = stdout.match(/\bOutput_Path\s*=\s*[^:\s]+:([^\r\n]+)/i);
  if (outputPathMatch?.[1]) {
    addDir(path.dirname(outputPathMatch[1].trim()));
  }

  return dirs[0];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function enrichJobNamesWithQstatFull(
  jobs: SchedulerJobSummary[],
  preCommands: string[],
): Promise<SchedulerJobSummary[]> {
  if (!jobs.length) {
    return jobs;
  }

  const enriched = await mapWithConcurrency(jobs, JOB_DETAIL_CONCURRENCY, async (job) => {
    try {
      const result = await runCommand(`qstat -f ${job.id}`, undefined, preCommands, JOB_DETAIL_TIMEOUT_MS);
      const fullName = extractFullJobNameFromQstatFull(result.stdout);
      const workDir = extractWorkDirFromQstatFull(result.stdout);
      if (!fullName && !workDir) {
        return job;
      }
      return {
        ...job,
        name: fullName ?? job.name,
        workDir,
      };
    } catch {
      // Keep the parsed short name if qstat -f fails for a specific job.
      return job;
    }
  });

  return enriched;
}

export class LocalSubmitter implements Submitter {
  constructor(private readonly settings: GaussianCopilotSettings) {}

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

    const result = await runCommand(`qstat -f ${jobId}`, undefined, this.settings.preCommands, SCHEDULER_COMMAND_TIMEOUT_MS);
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
      result = await runCommand(`qdel ${jobId}`, undefined, this.settings.preCommands, SCHEDULER_COMMAND_TIMEOUT_MS);
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
      result = await runCommand(`qstat -a -u ${username}`, undefined, this.settings.preCommands, SCHEDULER_COMMAND_TIMEOUT_MS);
    } catch (e) {
      // Fallback to original command if -a is not supported
      try {
        result = await runCommand(`qstat -u ${username}`, undefined, this.settings.preCommands, SCHEDULER_COMMAND_TIMEOUT_MS);
      } catch (innerE) {
        const message = innerE instanceof Error ? innerE.message : String(innerE);
        throw new Error(`Failed to query job status: ${message}`);
      }
    }

    const jobs = parseQstatUserOutput(result.stdout);
    return enrichJobNamesWithQstatFull(jobs, this.settings.preCommands);
  }
}
