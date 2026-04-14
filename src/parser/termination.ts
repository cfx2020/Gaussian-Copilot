export type GaussianTerminationStatus = 'normal' | 'error' | 'running';

export interface GaussianTerminationInfo {
  status: GaussianTerminationStatus;
  reason?: string;
}

export function classifyGaussianTermination(content: string): GaussianTerminationInfo {
  if (/normal termination/i.test(content)) {
    return { status: 'normal' };
  }

  const linkerMatch = content.match(/\bl(\d+)\.exe\b/i);
  if (linkerMatch?.[1]) {
    return { status: 'error', reason: `L${linkerMatch[1]}` };
  }

  if (/segmentation fault/i.test(content)) {
    return { status: 'error', reason: 'Segmentation fault' };
  }

  if (/killed|signal/i.test(content)) {
    return { status: 'error', reason: 'Killed' };
  }

  if (/error termination/i.test(content)) {
    return { status: 'error', reason: 'Error termination' };
  }

  return { status: 'running' };
}
