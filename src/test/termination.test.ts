import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseGaussianLog } from '../parser/gaussianLogParser';
import { classifyGaussianTermination } from '../parser/termination';

test('classifyGaussianTermination detects L301 linker failures', () => {
  const content = `
 Error termination request processed by link 9999.
 Error termination via Lnk1e in /opt/gaussian/g16/l301.exe at Tue Apr 14 20:00:00 2026.
`;

  assert.deepEqual(classifyGaussianTermination(content), {
    status: 'error',
    reason: 'L301',
  });
});

test('parseGaussianLog surfaces L301 as an error termination status', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gaussian-copilot-'));
  const filePath = path.join(dir, 'l301.log');
  const content = `
 Entering Gaussian System, Link 0=g16
 ------------------------------------------------------------
 Error termination via Lnk1e in /opt/gaussian/g16/l301.exe at Tue Apr 14 20:00:00 2026.
`;

  await writeFile(filePath, content, 'utf8');
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.terminationStatus, 'error');
  assert.equal(summary.terminationReason, 'L301');
  assert.equal(summary.normalTermination, false);
});
