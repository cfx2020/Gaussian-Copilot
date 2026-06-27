export type SubmitMode = 'local';

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface SubmitRequest {
  localFilePath: string;
  fileName: string;
  baseName: string;
}

export interface SubmitResult {
  ok: boolean;
  backend: SubmitMode;
  jobId?: string;
  rawJobId?: string;
  stdout: string;
  stderr: string;
  submittedAt: string;
  localFilePath?: string;
  remotePath?: string;
}

export interface JobStatusResult {
  ok: boolean;
  backend: SubmitMode;
  state: JobState;
  stdout: string;
  stderr: string;
}

export interface SchedulerJobSummary {
  id: string;
  name: string;
  state: JobState;
  workDir?: string;
}

export interface Submitter {
  submit(request: SubmitRequest): Promise<SubmitResult>;
  query(jobId: string): Promise<JobStatusResult>;
  cancel(jobId: string): Promise<JobStatusResult>;
  listUserJobs(username: string): Promise<SchedulerJobSummary[]>;
}

export class SubmitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly stage: string,
    public readonly retryable: boolean,
    public readonly rawOutput?: string,
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}
