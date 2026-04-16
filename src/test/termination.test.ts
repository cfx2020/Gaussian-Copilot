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

test('classifyGaussianTermination does not treat startup linker entries as failures', () => {
  const content = `
 Entering Gaussian System, Link 0=g16
 /opt/soft/gauss/g16c01_avx2/g16/l1.exe "/tmp/example.inp"
 Entering Link 1 = /opt/soft/gauss/g16c01_avx2/g16/l1.exe PID=12345.
 (Enter /opt/soft/gauss/g16c01_avx2/g16/l301.exe)
 Leave Link 301 at Wed Apr 15 06:11:08 2026.
 Cycle 6 Pass 1 IDiag 1:
 E= -2059.87688386385 Delta-E= -0.000003959303
 `;

  assert.deepEqual(classifyGaussianTermination(content), {
    status: 'running',
  });
});

test('classifyGaussianTermination prefers the linker from explicit error termination lines', () => {
  const content = `
 Entering Gaussian System, Link 0=g16
 /opt/soft/gauss/g16c01_avx2/g16/l1.exe "/tmp/example.inp"
 Entering Link 1 = /opt/soft/gauss/g16c01_avx2/g16/l1.exe PID=89827.
 Leave Link 601 at Wed Apr 15 12:14:53 2026.
 (Enter /opt/soft/gauss/g16c01_avx2/g16/l9999.exe)

 Error termination request processed by link 9999.
 Error termination via Lnk1e in /opt/soft/gauss/g16c01_avx2/g16/l9999.exe at Wed Apr 15 12:14:53 2026.
 Job cpu time:       5 days 16 hours 53 minutes 23.1 seconds.
 `;

  assert.deepEqual(classifyGaussianTermination(content), {
    status: 'error',
    reason: 'L9999',
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

test('parseGaussianLog surfaces L9999 even when the log contains earlier l1.exe entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gaussian-copilot-'));
  const filePath = path.join(dir, 'l9999.log');
  const content = `
 Entering Gaussian System, Link 0=g16
 /opt/soft/gauss/g16c01_avx2/g16/l1.exe "/tmp/example.inp"
 Entering Link 1 = /opt/soft/gauss/g16c01_avx2/g16/l1.exe PID=89827.
 Leave Link 601 at Wed Apr 15 12:14:53 2026.
 (Enter /opt/soft/gauss/g16c01_avx2/g16/l9999.exe)

 Error termination request processed by link 9999.
 Error termination via Lnk1e in /opt/soft/gauss/g16c01_avx2/g16/l9999.exe at Wed Apr 15 12:14:53 2026.
 Job cpu time:       5 days 16 hours 53 minutes 23.1 seconds.
 `;

  await writeFile(filePath, content, 'utf8');
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.terminationStatus, 'error');
  assert.equal(summary.terminationReason, 'L9999');
  assert.equal(summary.normalTermination, false);
});
