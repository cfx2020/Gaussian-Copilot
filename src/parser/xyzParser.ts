import * as fs from 'fs/promises';
import { Atom, EnergyPoint, Frame, GaussianSummary } from './types';

const symbolToAtomicNumber = new Map<string, number>([
  ['H', 1], ['He', 2], ['Li', 3], ['Be', 4], ['B', 5], ['C', 6], ['N', 7], ['O', 8], ['F', 9], ['Ne', 10],
  ['Na', 11], ['Mg', 12], ['Al', 13], ['Si', 14], ['P', 15], ['S', 16], ['Cl', 17], ['Ar', 18], ['K', 19], ['Ca', 20],
  ['Sc', 21], ['Ti', 22], ['V', 23], ['Cr', 24], ['Mn', 25], ['Fe', 26], ['Co', 27], ['Ni', 28], ['Cu', 29], ['Zn', 30],
  ['Ga', 31], ['Ge', 32], ['As', 33], ['Se', 34], ['Br', 35], ['Kr', 36], ['Rb', 37], ['Sr', 38], ['Y', 39], ['Zr', 40],
  ['Nb', 41], ['Mo', 42], ['Tc', 43], ['Ru', 44], ['Rh', 45], ['Pd', 46], ['Ag', 47], ['Cd', 48], ['In', 49], ['Sn', 50],
  ['Sb', 51], ['Te', 52], ['I', 53], ['Xe', 54], ['Cs', 55], ['Ba', 56], ['La', 57], ['Ce', 58], ['Pr', 59], ['Nd', 60],
  ['Pm', 61], ['Sm', 62], ['Eu', 63], ['Gd', 64], ['Tb', 65], ['Dy', 66], ['Ho', 67], ['Er', 68], ['Tm', 69], ['Yb', 70],
  ['Lu', 71], ['Hf', 72], ['Ta', 73], ['W', 74], ['Re', 75], ['Os', 76], ['Ir', 77], ['Pt', 78], ['Au', 79], ['Hg', 80],
  ['Tl', 81], ['Pb', 82], ['Bi', 83], ['Po', 84], ['At', 85], ['Rn', 86], ['Fr', 87], ['Ra', 88], ['Ac', 89], ['Th', 90],
  ['Pa', 91], ['U', 92], ['Np', 93], ['Pu', 94], ['Am', 95], ['Cm', 96], ['Bk', 97], ['Cf', 98], ['Es', 99], ['Fm', 100],
  ['Md', 101], ['No', 102], ['Lr', 103], ['Rf', 104], ['Db', 105], ['Sg', 106], ['Bh', 107], ['Hs', 108], ['Mt', 109],
  ['Ds', 110], ['Rg', 111], ['Cn', 112], ['Nh', 113], ['Fl', 114], ['Mc', 115], ['Lv', 116], ['Ts', 117], ['Og', 118],
]);

function parseFloatToken(token: string): number {
  return Number(token.replace(/d/i, 'e'));
}

function normalizeElementToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function atomicNumberFromToken(token: string): number {
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }

  const normalized = normalizeElementToken(token);
  if (normalized === 'X' || normalized === 'Dummy') {
    return 0;
  }
  return symbolToAtomicNumber.get(normalized) ?? 0;
}

function isAtomLine(line: string): boolean {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 4) {
    return false;
  }
  const atomicNumber = atomicNumberFromToken(cols[0]);
  const coords = cols.slice(1, 4).map(parseFloatToken);
  return atomicNumber >= 0 && coords.every((value) => Number.isFinite(value));
}

function parseAtomLine(line: string, lineNumber: number): Atom {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 4) {
    throw new Error(`Invalid XYZ atom line at ${lineNumber}: expected element and x/y/z`);
  }

  const atomicNumber = atomicNumberFromToken(cols[0]);
  const x = parseFloatToken(cols[1]);
  const y = parseFloatToken(cols[2]);
  const z = parseFloatToken(cols[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`Invalid XYZ coordinates at line ${lineNumber}`);
  }

  return { atomicNumber, x, y, z };
}

function parseEnergyFromComment(comment: string): number | undefined {
  const match = comment.match(/\b(?:energy|e)\s*[:=]\s*(-?\d+(?:\.\d*)?(?:[DdEe][+-]?\d+)?)/i);
  if (!match) {
    return undefined;
  }

  const energy = parseFloatToken(match[1]);
  return Number.isFinite(energy) ? energy : undefined;
}

function parseImageIndexFromComment(comment: string): number | undefined {
  const match = comment.match(/\b(?:image|frame)\s*[:#=]?\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) {
    return undefined;
  }

  const index = Number(match[1]);
  return Number.isFinite(index) ? index : undefined;
}

function buildSummary(frames: Frame[], curves: EnergyPoint[], maxFrames: number): GaussianSummary {
  const clippedFrames = frames.slice(-maxFrames);
  const clippedFrameStart = Math.max(frames.length - clippedFrames.length, 0);
  const clippedFrameEnd = clippedFrameStart + clippedFrames.length - 1;
  const clippedCurves = curves
    .filter((point) => Number.isFinite(point.frameIndex)
      && Number(point.frameIndex) >= clippedFrameStart
      && Number(point.frameIndex) <= clippedFrameEnd)
    .map((point) => ({
      ...point,
      frameIndex: Number(point.frameIndex) - clippedFrameStart,
    }));
  const energies = curves.map((point) => point.energy);
  const lastEnergy = energies.length ? energies[energies.length - 1] : undefined;
  const calculationType = frames.length > 1 ? 'XYZ TRAJECTORY' : 'XYZ';

  return {
    frames: clippedFrames,
    frequencies: [],
    scfEnergies: energies,
    freeEnergy: undefined,
    basis: undefined,
    normalTermination: true,
    terminationStatus: 'normal',
    terminationReason: undefined,
    curves: clippedCurves,
    overview: {
      calculationType,
      electronicEnergy: lastEnergy,
    },
    thermo: {},
  };
}

export async function parseXyzFile(filePath: string, maxFrames: number): Promise<GaussianSummary> {
  const content = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  const frames: Frame[] = [];
  const curves: EnergyPoint[] = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) {
      i += 1;
    }
    if (i >= lines.length) {
      break;
    }

    const atomCount = Number(lines[i].trim());
    if (!Number.isInteger(atomCount) || atomCount < 0) {
      break;
    }

    const maybeComment = lines[i + 1] ?? '';
    const hasOmittedComment = isAtomLine(maybeComment) && lines.length - (i + 1) >= atomCount;
    const comment = hasOmittedComment ? '' : maybeComment;
    const atomStart = hasOmittedComment ? i + 1 : i + 2;
    if (lines.length - atomStart < atomCount) {
      throw new Error(`Invalid XYZ frame at line ${i + 1}: expected ${atomCount} atoms`);
    }

    const atoms: Atom[] = [];
    for (let atomOffset = 0; atomOffset < atomCount; atomOffset += 1) {
      atoms.push(parseAtomLine(lines[atomStart + atomOffset], atomStart + atomOffset + 1));
    }

    const frameIndex = frames.length;
    frames.push({ step: frameIndex, atoms });
    const energy = parseEnergyFromComment(comment);
    if (energy !== undefined) {
      const imageIndex = parseImageIndexFromComment(comment);
      const index = imageIndex ?? frameIndex + 1;
      curves.push({
        index,
        energy,
        type: 'xyz',
        frameIndex,
        pointNumber: imageIndex ?? frameIndex + 1,
        coordinate: index,
      });
    }

    i = atomStart + atomCount;
  }

  if (!frames.length) {
    const atomLines = lines.filter((line) => line.trim());
    if (atomLines.length && atomLines.every(isAtomLine)) {
      frames.push({
        step: 0,
        atoms: atomLines.map((line, index) => parseAtomLine(line, index + 1)),
      });
    }
  }

  if (!frames.length) {
    throw new Error('No XYZ frames found');
  }

  return buildSummary(frames, curves, maxFrames);
}
