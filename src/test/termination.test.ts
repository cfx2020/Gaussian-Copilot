import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseGaussianLog } from '../parser/gaussianLogParser';
import { classifyGaussianTermination } from '../parser/termination';
import { parseXyzFile } from '../parser/xyzParser';

async function writeTempLog(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gaussian-copilot-'));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

function orientationBlock(z: number): string {
  return `
 Standard orientation:
 ---------------------------------------------------------------------
 Center     Atomic      Atomic             Coordinates (Angstroms)
 Number     Number       Type             X           Y           Z
 ---------------------------------------------------------------------
      1          6           0        0.000000    0.000000    ${z.toFixed(6)}
 ---------------------------------------------------------------------
 `;
}

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

test('classifyGaussianTermination prefers normal termination over earlier error markers', () => {
  const content = `
 Error termination via Lnk1e in /opt/gaussian/g16/l301.exe at Tue Apr 14 20:00:00 2026.
 Job cpu time:       5 days 16 hours 53 minutes 23.1 seconds.
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `;

  assert.deepEqual(classifyGaussianTermination(content), {
    status: 'normal',
  });
});

test('classifyGaussianTermination detects segmentation faults', () => {
  const content = `
 File lengths (MBytes):  RWF=      12 Int=      0 D2E=      0 Chk=      1 Scr=      1
 Error: segmentation fault
 `;

  assert.deepEqual(classifyGaussianTermination(content), {
    status: 'error',
    reason: 'Segmentation fault',
  });
});

test('classifyGaussianTermination detects killed signal exits', () => {
  const content = `
 Error: process killed by signal 9
 `;

  assert.deepEqual(classifyGaussianTermination(content), {
    status: 'error',
    reason: 'Killed',
  });
});

test('parseGaussianLog surfaces L301 as an error termination status', async () => {
  const filePath = await writeTempLog('l301.log', `
 Entering Gaussian System, Link 0=g16
 ------------------------------------------------------------
 Error termination via Lnk1e in /opt/gaussian/g16/l301.exe at Tue Apr 14 20:00:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.terminationStatus, 'error');
  assert.equal(summary.terminationReason, 'L301');
  assert.equal(summary.normalTermination, false);
});

test('parseGaussianLog surfaces L9999 even when the log contains earlier l1.exe entries', async () => {
  const filePath = await writeTempLog('l9999.log', `
 Entering Gaussian System, Link 0=g16
 /opt/soft/gauss/g16c01_avx2/g16/l1.exe "/tmp/example.inp"
 Entering Link 1 = /opt/soft/gauss/g16c01_avx2/g16/l1.exe PID=89827.
 Leave Link 601 at Wed Apr 15 12:14:53 2026.
 (Enter /opt/soft/gauss/g16c01_avx2/g16/l9999.exe)

 Error termination request processed by link 9999.
 Error termination via Lnk1e in /opt/soft/gauss/g16c01_avx2/g16/l9999.exe at Wed Apr 15 12:14:53 2026.
 Job cpu time:       5 days 16 hours 53 minutes 23.1 seconds.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.terminationStatus, 'error');
  assert.equal(summary.terminationReason, 'L9999');
  assert.equal(summary.normalTermination, false);
});

test('parseGaussianLog reports normal termination even when earlier error markers appear', async () => {
  const filePath = await writeTempLog('normal-after-error.log', `
 Error termination via Lnk1e in /opt/gaussian/g16/l301.exe at Tue Apr 14 20:00:00 2026.
 Job cpu time:       5 days 16 hours 53 minutes 23.1 seconds.
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.normalTermination, true);
  assert.equal(summary.terminationStatus, 'normal');
  assert.equal(summary.terminationReason, undefined);
});

test('parseGaussianLog remaps frame indices after clipping old frames', async () => {
  const filePath = await writeTempLog('frame-clipping.log', `
 ${orientationBlock(0)}
 SCF Done:  E(RB3LYP) =  -100.100000     A.U. after   1 cycles
 ${orientationBlock(1)}
 SCF Done:  E(RB3LYP) =  -100.200000     A.U. after   1 cycles
 ${orientationBlock(2)}
 SCF Done:  E(RB3LYP) =  -100.300000     A.U. after   1 cycles
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 2);

  assert.equal(summary.frames.length, 2);
  assert.equal(summary.frames[0]?.atoms[0]?.z, 1);
  assert.equal(summary.frames[1]?.atoms[0]?.z, 2);
  assert.deepEqual(summary.curves.map((point) => point.frameIndex), [undefined, 0, 1]);
});

test('parseGaussianLog builds scan curves from summary energies and coordinates', async () => {
  const filePath = await writeTempLog('scan-summary.log', `
 Number of optimizations in scan= 2
 ! R1 R(1,2) 1.0000 Scan !
 Step number 1 out of a maximum of 10 on scan point 1 out of 2
 ${orientationBlock(0)}
 SCF Done:  E(RB3LYP) =  -100.050000     A.U. after   1 cycles
 Step number 2 out of a maximum of 10 on scan point 2 out of 2
 ${orientationBlock(1)}
 SCF Done:  E(RB3LYP) =  -100.150000     A.U. after   1 cycles
 Summary of Optimized Potential Surface Scan (add -99.0000 to energies)
 Summary of the potential surface scan:
 Eigenvalues -- -1.0500 -1.1500
 R1 1.1111 1.2222
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.overview.calculationType, 'SCAN');
  assert.deepEqual(summary.curves, [
    {
      index: 1,
      energy: -100.05,
      type: 'scan',
      frameIndex: 0,
      pointNumber: 1,
      coordinate: 1.1111,
    },
    {
      index: 2,
      energy: -100.15,
      type: 'scan',
      frameIndex: 1,
      pointNumber: 2,
      coordinate: 1.2222,
    },
  ]);
});

test('parseGaussianLog falls back to the last SCF point for scan jobs without a summary', async () => {
  const filePath = await writeTempLog('scan-fallback.log', `
 Number of optimizations in scan= 1
 ${orientationBlock(0)}
 SCF Done:  E(RB3LYP) =  -100.250000     A.U. after   1 cycles
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.deepEqual(summary.curves, [
    {
      index: 1,
      energy: -100.25,
      type: 'scan',
      frameIndex: 0,
      pointNumber: 1,
      coordinate: undefined,
    },
  ]);
});

test('parseGaussianLog builds IRC curves from point annotations and reaction coordinates', async () => {
  const filePath = await writeTempLog('irc-annotations.log', `
 # irc b3lyp/6-31g(d)
 ${orientationBlock(0)}
 SCF Done:  E(RB3LYP) =  -100.000000     A.U. after   1 cycles
 Point Number: 0 Path Number: 0
 ${orientationBlock(1)}
 SCF Done:  E(RB3LYP) =  -99.900000     A.U. after   1 cycles
 Point Number: 1 Path Number: 1
 NET REACTION COORDINATE UP TO THIS POINT = 0.1234
 ${orientationBlock(2)}
 SCF Done:  E(RB3LYP) =  -99.800000     A.U. after   1 cycles
 Point Number: 1 Path Number: 2
 NET REACTION COORDINATE UP TO THIS POINT = 0.2345
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.equal(summary.overview.calculationType, 'IRC');
  assert.deepEqual(summary.curves, [
    {
      index: -0.2345,
      energy: -99.8,
      type: 'irc',
      frameIndex: 2,
      pointNumber: 1,
      pathNumber: 2,
      coordinate: -0.2345,
    },
    {
      index: 0,
      energy: -100,
      type: 'irc',
      frameIndex: 0,
      pointNumber: 0,
      pathNumber: 0,
      coordinate: 0,
    },
    {
      index: 0.1234,
      energy: -99.9,
      type: 'irc',
      frameIndex: 1,
      pointNumber: 1,
      pathNumber: 1,
      coordinate: 0.1234,
    },
  ]);
});

test('parseXyzFile parses a single XYZ structure with a blank comment line', async () => {
  const filePath = await writeTempLog('single.xyz', `
3

C 0.000000 0.000000 0.000000
H 0.000000 0.000000 1.089000
H 1.026719 0.000000 -0.363000
`);
  const summary = await parseXyzFile(filePath, 10);

  assert.equal(summary.frames.length, 1);
  assert.equal(summary.frames[0]?.atoms.length, 3);
  assert.equal(summary.frames[0]?.atoms[0]?.atomicNumber, 6);
  assert.equal(summary.overview.calculationType, 'XYZ');
  assert.deepEqual(summary.curves, []);
});

test('parseXyzFile parses multi-frame XYZ energy comments as a trajectory curve', async () => {
  const filePath = await writeTempLog('trajectory.xyz', `
1
Image 0 Energy = -1.000000
H 0.000000 0.000000 0.000000
1
Image 1 Energy = -2.000000
H 0.000000 0.000000 1.000000
1
Image 2 Energy = -3.000000
H 0.000000 0.000000 2.000000
`);
  const summary = await parseXyzFile(filePath, 2);

  assert.equal(summary.frames.length, 2);
  assert.equal(summary.frames[0]?.atoms[0]?.z, 1);
  assert.equal(summary.frames[1]?.atoms[0]?.z, 2);
  assert.equal(summary.overview.calculationType, 'XYZ TRAJECTORY');
  assert.deepEqual(summary.scfEnergies, [-1, -2, -3]);
  assert.deepEqual(summary.curves, [
    {
      index: 1,
      energy: -2,
      type: 'xyz',
      frameIndex: 0,
      pointNumber: 1,
      coordinate: 1,
    },
    {
      index: 2,
      energy: -3,
      type: 'xyz',
      frameIndex: 1,
      pointNumber: 2,
      coordinate: 2,
    },
  ]);
});

test('parseGaussianLog prefers IRC summary energies while preserving mapped frame indices', async () => {
  const filePath = await writeTempLog('irc-summary.log', `
 # irc b3lyp/6-31g(d)
 ${orientationBlock(0)}
 SCF Done:  E(RB3LYP) =  -100.000000     A.U. after   1 cycles
 Point Number: 0 Path Number: 0
 ${orientationBlock(1)}
 SCF Done:  E(RB3LYP) =  -99.900000     A.U. after   1 cycles
 Point Number: 1 Path Number: 1
 NET REACTION COORDINATE UP TO THIS POINT = 0.1234
 ${orientationBlock(2)}
 SCF Done:  E(RB3LYP) =  -99.800000     A.U. after   1 cycles
 Point Number: 1 Path Number: 2
 NET REACTION COORDINATE UP TO THIS POINT = 0.2345
 Energies reported relative to the TS energy of -100.0000
 Summary of reaction path following
      1   -0.2000   -0.2345
      2    0.0000    0.0000
      3    0.1000    0.1234
 Total number of points: 3
 Normal termination of Gaussian 16 at Tue Apr 14 20:05:00 2026.
 `);
  const summary = await parseGaussianLog(filePath, 10);

  assert.deepEqual(summary.curves, [
    {
      index: -0.2345,
      energy: -100.2,
      type: 'irc',
      frameIndex: 2,
      pointNumber: 1,
      pathNumber: 2,
      coordinate: -0.2345,
    },
    {
      index: 0,
      energy: -100,
      type: 'irc',
      frameIndex: 0,
      pointNumber: 0,
      pathNumber: 0,
      coordinate: 0,
    },
    {
      index: 0.1234,
      energy: -99.9,
      type: 'irc',
      frameIndex: 1,
      pointNumber: 1,
      pathNumber: 1,
      coordinate: 0.1234,
    },
  ]);
});
