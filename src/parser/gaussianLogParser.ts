import * as fs from 'fs/promises';
import { Atom, Frame, FrequencyMode, GaussianSummary, OverviewInfo, ThermoInfo } from './types';

function parseFloatGaussianToken(token: string): number {
  return Number(token.replace(/d/i, 'e'));
}

function parseFrequencyBlock(lines: string[], startIndex: number, values: number[]): { modes: FrequencyMode[]; nextIndex: number } {
  const modes: FrequencyMode[] = values.map((value) => ({ value, vectors: [] }));
  let i = startIndex + 1;

  while (i < lines.length && !/^\s*Atom\s+AN/i.test(lines[i])) {
    i += 1;
  }

  if (i >= lines.length) {
    return { modes, nextIndex: startIndex };
  }

  i += 1;
  while (i < lines.length) {
    const row = lines[i];
    if (!row.trim() || !/^\s*\d+\s+\d+/.test(row)) {
      break;
    }

    const cols = row.trim().split(/\s+/);
    const data = cols.slice(2).map(parseFloatGaussianToken);
    for (let modeIndex = 0; modeIndex < modes.length; modeIndex += 1) {
      const base = modeIndex * 3;
      if (data.length >= base + 3 && data.slice(base, base + 3).every((n) => Number.isFinite(n))) {
        modes[modeIndex].vectors.push({
          x: data[base],
          y: data[base + 1],
          z: data[base + 2],
        });
      }
    }
    i += 1;
  }

  return { modes, nextIndex: i - 1 };
}

export async function parseGaussianLog(filePath: string, maxFrames: number): Promise<GaussianSummary> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  const frames: Frame[] = [];
  const frequencies: FrequencyMode[] = [];
  const scfEnergies: number[] = [];

  let basis: string | undefined;
  let freeEnergy: number | undefined;
  let normalTermination = false;
  let methodFromScf: string | undefined;
  let basisFromRoute: string | undefined;
  let calculationType: string | undefined;
  let charge: number | undefined;
  let multiplicity: number | undefined;
  let pointGroup: string | undefined;
  let dipoleMoment: number | undefined;
  let polarizability: number | undefined;
  let jobCpuTime: string | undefined;
  let imaginaryFreqCount: number | undefined;
  let temperatureK: number | undefined;
  let pressureAtm: number | undefined;
  let zeroPointCorrection: number | undefined;
  let thermalCorrectionToEnergy: number | undefined;
  let thermalCorrectionToEnthalpy: number | undefined;
  let thermalCorrectionToGibbs: number | undefined;
  let sumElectronicAndZeroPoint: number | undefined;
  let sumElectronicAndThermalEnergy: number | undefined;
  let sumElectronicAndThermalEnthalpy: number | undefined;
  let sumElectronicAndThermalFreeEnergy: number | undefined;
  let eThermalKcalMol: number | undefined;
  let heatCapacityCv: number | undefined;
  let entropyS: number | undefined;

  let currentStep = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const basisMatch = line.match(/Standard basis:\s*(.+)/i)
      ?? line.match(/General basis read from cards:\s*(.+)/i)
      ?? line.match(/AO basis set\s*\w*:\s*(.+)/i);
    if (basisMatch) {
      basis = basisMatch[1].trim();
    }

    const routeMatch = line.match(/^\s*#\S*\s+.*?([A-Za-z0-9-]+)\/([A-Za-z0-9()+-]+)\s+(.*)$/i)
      ?? line.match(/^\s*#\S*\s+.*?([A-Za-z0-9-]+)\/([A-Za-z0-9()+-]+)\b/i);
    if (routeMatch) {
      basisFromRoute = routeMatch[2];
      if (!calculationType) {
        const routeText = line.toLowerCase();
        if (routeText.includes('freq') && routeText.includes('opt')) {
          calculationType = 'OPT+FREQ';
        } else if (routeText.includes('freq')) {
          calculationType = 'FREQ';
        } else if (routeText.includes('opt')) {
          calculationType = 'OPT';
        } else {
          calculationType = 'SP';
        }
      }
    }

    const chargeMultiMatch = line.match(/Charge\s*=\s*(-?\d+)\s+Multiplicity\s*=\s*(\d+)/i);
    if (chargeMultiMatch) {
      charge = Number(chargeMultiMatch[1]);
      multiplicity = Number(chargeMultiMatch[2]);
    }

    const pointGroupMatch = line.match(/Full point group\s+([A-Za-z0-9]+)/i);
    if (pointGroupMatch) {
      pointGroup = pointGroupMatch[1];
    }

    const dipoleMatch = line.match(/\bTot=\s*(-?\d+\.\d+)/);
    if (dipoleMatch) {
      dipoleMoment = Number(dipoleMatch[1]);
    }

    const polarMatch = line.match(/Isotropic polarizability.*?(-?\d+\.\d+)\s+Bohr\*\*3\./i);
    if (polarMatch) {
      polarizability = Number(polarMatch[1]);
    }

    const cpuMatch = line.match(/Job cpu time:\s*(.+)/i);
    if (cpuMatch) {
      jobCpuTime = cpuMatch[1].trim().replace(/\.$/, '');
    }

    const imagMatch = line.match(/\*+\s*(\d+)\s+imaginary frequencies/i);
    if (imagMatch) {
      imaginaryFreqCount = Number(imagMatch[1]);
    }

    const tpMatch = line.match(/Temperature\s+(-?\d+\.\d+)\s+Kelvin\.\s+Pressure\s+(-?\d+\.\d+)\s+Atm\./i);
    if (tpMatch) {
      temperatureK = Number(tpMatch[1]);
      pressureAtm = Number(tpMatch[2]);
    }

    const zpeMatch = line.match(/Zero-point correction=\s*(-?\d+\.\d+)/i);
    if (zpeMatch) {
      zeroPointCorrection = Number(zpeMatch[1]);
    }

    const tceMatch = line.match(/Thermal correction to Energy=\s*(-?\d+\.\d+)/i);
    if (tceMatch) {
      thermalCorrectionToEnergy = Number(tceMatch[1]);
    }

    const tchMatch = line.match(/Thermal correction to Enthalpy=\s*(-?\d+\.\d+)/i);
    if (tchMatch) {
      thermalCorrectionToEnthalpy = Number(tchMatch[1]);
    }

    const tcgMatch = line.match(/Thermal correction to Gibbs Free Energy=\s*(-?\d+\.\d+)/i);
    if (tcgMatch) {
      thermalCorrectionToGibbs = Number(tcgMatch[1]);
    }

    const szeMatch = line.match(/Sum of electronic and zero-point Energies=\s*(-?\d+\.\d+)/i);
    if (szeMatch) {
      sumElectronicAndZeroPoint = Number(szeMatch[1]);
    }

    const steMatch = line.match(/Sum of electronic and thermal Energies=\s*(-?\d+\.\d+)/i);
    if (steMatch) {
      sumElectronicAndThermalEnergy = Number(steMatch[1]);
    }

    const sthMatch = line.match(/Sum of electronic and thermal Enthalpies=\s*(-?\d+\.\d+)/i);
    if (sthMatch) {
      sumElectronicAndThermalEnthalpy = Number(sthMatch[1]);
    }

    const stfMatch = line.match(/Sum of electronic and thermal Free Energies=\s*(-?\d+\.\d+)/i);
    if (stfMatch) {
      const free = Number(stfMatch[1]);
      sumElectronicAndThermalFreeEnergy = free;
      freeEnergy = free;
    }

    const totalThermoMatch = line.match(/^\s*Total\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/);
    if (totalThermoMatch) {
      eThermalKcalMol = Number(totalThermoMatch[1]);
      heatCapacityCv = Number(totalThermoMatch[2]);
      entropyS = Number(totalThermoMatch[3]);
    }

    const scfMatch = line.match(/SCF Done:\s+E\([^)]+\)\s*=\s*(-?\d+\.\d+)/);
    if (scfMatch) {
      scfEnergies.push(Number(scfMatch[1]));
      const scfMethodMatch = line.match(/SCF Done:\s+E\(([^)]+)\)/);
      if (scfMethodMatch) {
        methodFromScf = scfMethodMatch[1];
      }
    }

    const freqMatch = line.match(/Frequencies --\s+(.+)/);
    if (freqMatch) {
      const vals = freqMatch[1].trim().split(/\s+/).map(Number).filter((v) => Number.isFinite(v));
      const parsed = parseFrequencyBlock(lines, i, vals);
      frequencies.push(...parsed.modes);
      i = Math.max(i, parsed.nextIndex);
    }

    if (/Normal termination of Gaussian/i.test(line)) {
      normalTermination = true;
    }

    if (/Standard orientation:/i.test(line) || /Input orientation:/i.test(line)) {
      const atoms: Atom[] = [];
      i += 5;
      while (i < lines.length && !/^\s*-+/.test(lines[i])) {
        const cols = lines[i].trim().split(/\s+/);
        if (cols.length >= 6) {
          atoms.push({
            atomicNumber: Number(cols[1]),
            x: Number(cols[3]),
            y: Number(cols[4]),
            z: Number(cols[5]),
          });
        }
        i += 1;
      }

      if (atoms.length > 0) {
        frames.push({ step: currentStep, atoms });
        currentStep += 1;
      }
    }
  }

  const clippedFrames = frames.slice(-maxFrames);
  const curves = scfEnergies
    .map((energy, index) => ({ index: index + 1, energy, type: 'opt' as const }))
    .slice(0, 6000);

  const overview: OverviewInfo = {
    calculationType,
    method: methodFromScf,
    basisSet: basisFromRoute ?? basis,
    charge,
    multiplicity,
    electronicEnergy: scfEnergies.length ? scfEnergies[scfEnergies.length - 1] : undefined,
    imaginaryFreqCount: imaginaryFreqCount ?? frequencies.filter((f) => f.value < 0).length,
    dipoleMoment,
    polarizability,
    pointGroup,
    jobCpuTime,
  };

  const thermo: ThermoInfo = {
    temperatureK,
    pressureAtm,
    zeroPointCorrection,
    thermalCorrectionToEnergy,
    thermalCorrectionToEnthalpy,
    thermalCorrectionToGibbs,
    sumElectronicAndZeroPoint,
    sumElectronicAndThermalEnergy,
    sumElectronicAndThermalEnthalpy,
    sumElectronicAndThermalFreeEnergy,
    eThermalKcalMol,
    heatCapacityCv,
    entropyS,
  };

  return {
    frames: clippedFrames,
    frequencies,
    scfEnergies,
    freeEnergy,
    basis,
    normalTermination,
    curves,
    overview,
    thermo,
  };
}
