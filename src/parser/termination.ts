export type GaussianTerminationStatus = 'normal' | 'error' | 'running';

export interface GaussianTerminationInfo {
  status: GaussianTerminationStatus;
  reason?: string;
}

function lastMatch(content: string, regex: RegExp): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const match of content.matchAll(regex)) {
    last = match;
  }
  return last;
}

function hasPostNormalContinuation(content: string): boolean {
  return /^\s*(?:--Link1--|Link1:)/mi.test(content)
    || /^\s*Entering Gaussian System\b/mi.test(content)
    || /^\s*Entering Link\s+\d+\s*=/mi.test(content)
    || /^\s*\(Enter .*?\bl\d+\.exe\)/mi.test(content);
}

export function classifyGaussianTermination(content: string): GaussianTerminationInfo {
  const normalMatch = lastMatch(content, /normal termination of gaussian[^\n]*/gi);
  const normalEnd = normalMatch ? normalMatch.index + normalMatch[0].length : -1;

  const errorLinkerMatch = lastMatch(content, /error termination via lnk1e in .*?\bl(\d+)\.exe\b/gi);
  const processedByLinkMatch = lastMatch(content, /error termination request processed by link\s+(\d+)/gi);
  const errorTerminationMatch = lastMatch(content, /error termination/gi);
  const segmentationFaultMatch = lastMatch(content, /segmentation fault/gi);
  const killedMatch = lastMatch(content, /(?:killed|signal)/gi);

  const errorCandidates = [
    errorLinkerMatch ? { index: errorLinkerMatch.index, reason: `L${errorLinkerMatch[1]}` } : undefined,
    processedByLinkMatch ? { index: processedByLinkMatch.index, reason: `L${processedByLinkMatch[1]}` } : undefined,
    segmentationFaultMatch ? { index: segmentationFaultMatch.index, reason: 'Segmentation fault' } : undefined,
    killedMatch ? { index: killedMatch.index, reason: 'Killed' } : undefined,
    errorTerminationMatch ? { index: errorTerminationMatch.index, reason: 'Error termination' } : undefined,
  ].filter((candidate): candidate is { index: number; reason: string } => candidate !== undefined)
    .sort((left, right) => right.index - left.index);

  const latestError = errorCandidates[0];
  if (latestError && latestError.index > normalEnd) {
    return { status: 'error', reason: latestError.reason };
  }

  if (normalMatch) {
    const afterNormal = content.slice(normalEnd);
    if (hasPostNormalContinuation(afterNormal)) {
      return { status: 'running' };
    }
    return { status: 'normal' };
  }

  if (latestError) {
    return { status: 'error', reason: latestError.reason };
  }

  return { status: 'running' };
}
