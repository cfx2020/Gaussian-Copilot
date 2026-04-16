export type GaussianTerminationStatus = 'normal' | 'error' | 'running';

export interface GaussianTerminationInfo {
  status: GaussianTerminationStatus;
  reason?: string;
}

export function classifyGaussianTermination(content: string): GaussianTerminationInfo {
  if (/normal termination/i.test(content)) {
    return { status: 'normal' };
  }

  const errorLinkerMatch = content.match(/error termination via lnk1e in .*?\bl(\d+)\.exe\b/i);
  if (errorLinkerMatch?.[1]) {
    return { status: 'error', reason: `L${errorLinkerMatch[1]}` };
  }

  const processedByLinkMatch = content.match(/error termination request processed by link\s+(\d+)/i);
  if (processedByLinkMatch?.[1]) {
    return { status: 'error', reason: `L${processedByLinkMatch[1]}` };
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
