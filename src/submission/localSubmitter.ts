import { exec } from 'child_process';
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

function runCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseQstatUserOutput(stdout: string): SchedulerJobSummary[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !!line);

  const jobs: SchedulerJobSummary[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^job\s+id/i.test(line) || /^-+$/.test(line)) {
      continue;
    }

    const columns = line.split(/\s+/);
    if (columns.length < 4) {
      continue;
    }

    const id = columns[0];
    if (!/^\d+(\.[\w.-]+)?$/.test(id)) {
      continue;
    }

    if (seen.has(id)) {
      continue;
    }

    const name = columns[3] ?? id;
    let rawState = '';
    for (let i = columns.length - 1; i >= 0; i -= 1) {
      if (/^[A-Z]$/.test(columns[i])) {
        rawState = columns[i];
        break;
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
    const result = await runCommand(command, cwd);
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

    const result = await runCommand(`qstat -f ${jobId}`);
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
      result = await runCommand(`qdel ${jobId}`);
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

    const result = await runCommand(`qstat -u ${username}`);
    return parseQstatUserOutput(result.stdout);
  }
}
