import * as fs from 'fs/promises';
import { Atom, EnergyPoint, Frame, FrequencyMode, GaussianSummary, OverviewInfo, ThermoInfo } from './types';
import { classifyGaussianTermination } from './termination';

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
  const termination = classifyGaussianTermination(content);
  const terminationReason = termination.reason;

  const frames: Frame[] = [];
  const frequencies: FrequencyMode[] = [];
  const scfEnergies: number[] = [];
  const scfPoints: Array<{ energy: number; frameIndex?: number }> = [];
  const scanPointStates = new Map<number, { energy: number; frameIndex?: number }>();
  const ircCurveMap = new Map<string, EnergyPoint>();

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
  let inScanSummary = false;
  let scanSummaryOffset = 0;
  const scanSummaryEnergies: number[] = [];
  const scanSummaryCoordinates: number[] = [];
  let currentScanPoint: number | undefined;
  let scanCoordinateLabel: string | undefined;
  const ircScfQueue: Array<{ energy: number; frameIndex?: number }> = [];
  let pendingIrcAnnotation: { pointNumber: number; pathNumber: number } | undefined;
  let inIrcSummary = false;
  let ircSummaryTsEnergy: number | undefined;
  const ircSummaryPoints: Array<{ order: number; relativeEnergy: number; coordinate: number }> = [];

  let currentStep = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmedLine = line.trim();

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
      const routeText = line.toLowerCase();
      if (!calculationType) {
        if (routeText.includes('irc')) {
          calculationType = 'IRC';
        } else if (routeText.includes('freq') && routeText.includes('opt')) {
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

    const scanCountMatch = line.match(/Number of optimizations in scan=\s*(\d+)/i);
    if (scanCountMatch) {
      calculationType = 'SCAN';
    }

    const scanCoordinateMatch = line.match(/!\s*([RAD]\d+)\s+[RAD]\([^)]+\)\s+(-?\d+\.\d+)\s+Scan\s*!/i);
    if (scanCoordinateMatch) {
      scanCoordinateLabel = scanCoordinateMatch[1];
      calculationType = 'SCAN';
    }

    const scanStepMatch = line.match(/Step number\s+\d+\s+out of a maximum of\s+\d+\s+on scan point\s+(\d+)\s+out of\s+\d+/i);
    if (scanStepMatch) {
      currentScanPoint = Number(scanStepMatch[1]);
      calculationType = 'SCAN';
    }

    const scanSummaryMatch = line.match(/Summary of Optimized Potential Surface Scan \(add\s+(-?\d+\.\d+)\s+to energies\)/i);
    if (scanSummaryMatch) {
      inScanSummary = true;
      scanSummaryOffset = Number(scanSummaryMatch[1]);
      calculationType = 'SCAN';
      continue;
    }

    if (inScanSummary) {
      if (!trimmedLine || /^Job cpu time:/i.test(line) || /^Normal termination/i.test(line) || /^1\\1\\/.test(trimmedLine)) {
        inScanSummary = false;
        continue;
      }

      if (/^-+$/.test(trimmedLine) || /^Summary\b/i.test(trimmedLine)) {
        continue;
      }

      const eigenvalueMatch = line.match(/^\s*Eigenvalues\s+--\s+(.+)$/i);
      if (eigenvalueMatch) {
        const values = eigenvalueMatch[1]
          .trim()
          .split(/\s+/)
          .map(parseFloatGaussianToken)
          .filter((value) => Number.isFinite(value))
          .map((value) => value + scanSummaryOffset);
        scanSummaryEnergies.push(...values);
        continue;
      }

      if (scanCoordinateLabel) {
        const scanCoordinateRowMatch = line.match(new RegExp(`^\\s*${scanCoordinateLabel}\\s+(.+)$`, 'i'));
        if (scanCoordinateRowMatch) {
          const values = scanCoordinateRowMatch[1]
            .trim()
            .split(/\s+/)
            .map(parseFloatGaussianToken)
            .filter((value) => Number.isFinite(value));
          scanSummaryCoordinates.push(...values);
          continue;
        }
      }
    }

    const ircPointMatch = line.match(/Point Number:\s*(\d+)\s+Path Number:\s*(-?\d+)/i);
    if (ircPointMatch) {
      pendingIrcAnnotation = {
        pointNumber: Number(ircPointMatch[1]),
        pathNumber: Number(ircPointMatch[2]),
      };
      calculationType = 'IRC';

      if (pendingIrcAnnotation.pointNumber === 0) {
        const currentPoint = ircScfQueue.shift();
        if (currentPoint) {
          ircCurveMap.set('0:0', {
            index: 0,
            energy: currentPoint.energy,
            type: 'irc',
            frameIndex: currentPoint.frameIndex,
            pointNumber: 0,
            pathNumber: 0,
            coordinate: 0,
          });
          pendingIrcAnnotation = undefined;
        }
      }
    }

    const ircCoordMatch = line.match(/NET REACTION COORDINATE UP TO THIS POINT =\s*(-?\d+\.\d+)/i);
    if (ircCoordMatch && pendingIrcAnnotation) {
      const currentPoint = ircScfQueue.shift();
      if (currentPoint) {
        const baseCoordinate = Number(ircCoordMatch[1]);
        const coordinate = pendingIrcAnnotation.pathNumber === 2 ? -baseCoordinate : baseCoordinate;
        const signedIndex = pendingIrcAnnotation.pathNumber === 2
          ? -pendingIrcAnnotation.pointNumber
          : pendingIrcAnnotation.pointNumber;

        ircCurveMap.set(`${pendingIrcAnnotation.pathNumber}:${pendingIrcAnnotation.pointNumber}`, {
          index: signedIndex,
          energy: currentPoint.energy,
          type: 'irc',
          frameIndex: currentPoint.frameIndex,
          pointNumber: pendingIrcAnnotation.pointNumber,
          pathNumber: pendingIrcAnnotation.pathNumber,
          coordinate,
        });
      }
      pendingIrcAnnotation = undefined;
    }

    const ircSummaryTsMatch = line.match(/Energies reported relative to the TS energy of\s+(-?\d+\.\d+)/i);
    if (ircSummaryTsMatch) {
      ircSummaryTsEnergy = Number(ircSummaryTsMatch[1]);
    }

    if (/^\s*Summary of reaction path following\b/i.test(line)) {
      inIrcSummary = true;
      continue;
    }

    if (inIrcSummary) {
      if (!trimmedLine || /^-+$/.test(trimmedLine) || /^Summary of reaction path following/i.test(trimmedLine)) {
        continue;
      }
      const rowMatch = line.match(/^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/);
      if (rowMatch) {
        ircSummaryPoints.push({
          order: Number(rowMatch[1]),
          relativeEnergy: Number(rowMatch[2]),
          coordinate: Number(rowMatch[3]),
        });
        continue;
      }
      if (/^Total number of points:/i.test(trimmedLine) || /^IRC-IRC-/i.test(trimmedLine) || /^\(Enter /i.test(trimmedLine)) {
        inIrcSummary = false;
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
      const energy = Number(scfMatch[1]);
      const frameIndex = frames.length > 0 ? frames.length - 1 : undefined;
      scfEnergies.push(energy);
      scfPoints.push({ energy, frameIndex });
      const scfMethodMatch = line.match(/SCF Done:\s+E\(([^)]+)\)/);
      if (scfMethodMatch) {
        methodFromScf = scfMethodMatch[1];
      }

      if (calculationType === 'IRC') {
        ircScfQueue.push({ energy, frameIndex });
      } else if (currentScanPoint !== undefined) {
        scanPointStates.set(currentScanPoint, {
          energy,
          frameIndex,
        });
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
  const clippedFrameStart = Math.max(frames.length - clippedFrames.length, 0);
  const clippedFrameEnd = clippedFrameStart + clippedFrames.length - 1;
  const adjustFrameIndex = (frameIndex?: number): number | undefined => {
    if (!Number.isFinite(frameIndex) || clippedFrames.length === 0) {
      return undefined;
    }
    const normalizedFrameIndex = Number(frameIndex);
    if (normalizedFrameIndex < clippedFrameStart || normalizedFrameIndex > clippedFrameEnd) {
      return undefined;
    }
    return normalizedFrameIndex - clippedFrameStart;
  };

  const optCurves: EnergyPoint[] = scfPoints.map((point, index) => ({
    index: index + 1,
    energy: point.energy,
    type: 'opt',
    frameIndex: adjustFrameIndex(point.frameIndex),
  }));

  const scanCurveMap = new Map<number, EnergyPoint>(
    Array.from(scanPointStates.entries()).map(([pointNumber, point]) => ([
      pointNumber,
      {
        index: pointNumber,
        energy: point.energy,
        type: 'scan' as const,
        frameIndex: point.frameIndex,
        pointNumber,
        coordinate: undefined,
      },
    ])),
  );

  if (scanSummaryEnergies.length > 0) {
    for (let index = 0; index < scanSummaryEnergies.length; index += 1) {
      const pointNumber = index + 1;
      const existing = scanCurveMap.get(pointNumber);
      scanCurveMap.set(pointNumber, {
        index: pointNumber,
        energy: scanSummaryEnergies[index],
        type: 'scan',
        frameIndex: existing?.frameIndex,
        pointNumber,
        coordinate: scanSummaryCoordinates[index],
      });
    }
  }

  const scanCurveSource: EnergyPoint[] = Array.from(scanCurveMap.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, point]) => point);

  const normalizedScanCurves = (scanCurveSource.length > 0
    ? scanCurveSource
    : (calculationType === 'SCAN'
      ? scfPoints.length > 0
        ? [{
          index: 1,
          energy: scfPoints[scfPoints.length - 1].energy,
          type: 'scan' as const,
          frameIndex: scfPoints[scfPoints.length - 1].frameIndex,
          pointNumber: 1,
          coordinate: scanSummaryCoordinates[0],
        }]
        : []
      : []))
    .map((point) => ({
      ...point,
      frameIndex: adjustFrameIndex(point.frameIndex),
    }));

  const normalizedIrcCurves = (() => {
    const mappedPoints = Array.from(ircCurveMap.values());

    if (ircSummaryPoints.length > 0 && Number.isFinite(ircSummaryTsEnergy)) {
      const reverseCount = ircSummaryPoints.filter((point) => point.coordinate < 0).length;
      const forwardCount = ircSummaryPoints.filter((point) => point.coordinate > 0).length;
      const lookup = new Map<string, EnergyPoint>();
      for (const point of mappedPoints) {
        lookup.set(`${point.pathNumber}:${point.pointNumber}`, point);
      }

      return ircSummaryPoints
        .map((point, index) => {
          let pathNumber = 0;
          let pointNumber = 0;
          if (point.coordinate < 0) {
            pathNumber = 2;
            pointNumber = reverseCount - index;
          } else if (point.coordinate > 0) {
            pathNumber = 1;
            pointNumber = index - reverseCount;
          } else {
            pathNumber = 0;
            pointNumber = 0;
          }

          const key = `${pathNumber}:${pointNumber}`;
          const matched = lookup.get(key);

          return {
            index: point.coordinate,
            energy: Number(ircSummaryTsEnergy) + point.relativeEnergy,
            type: 'irc' as const,
            frameIndex: adjustFrameIndex(
              matched?.frameIndex ?? (point.coordinate === 0 ? scfPoints[0]?.frameIndex : undefined),
            ),
            pointNumber,
            pathNumber,
            coordinate: point.coordinate,
          };
        })
        .slice(0, reverseCount + forwardCount + 1);
    }

    if (mappedPoints.length > 0) {
      return mappedPoints
        .map((point) => ({
          ...point,
          index: point.coordinate ?? point.index,
          frameIndex: adjustFrameIndex(point.frameIndex),
        }))
        .sort((left, right) => (left.coordinate ?? left.index) - (right.coordinate ?? right.index));
    }

    return calculationType === 'IRC' && scfPoints.length > 0
      ? [{
        index: 0,
        energy: scfPoints[0].energy,
        type: 'irc' as const,
        frameIndex: adjustFrameIndex(scfPoints[0].frameIndex),
        pointNumber: 0,
        pathNumber: 0,
        coordinate: 0,
      }]
      : [];
  })();

  const curves = calculationType === 'IRC'
    ? normalizedIrcCurves.slice(-2000)
    : calculationType === 'SCAN'
      ? normalizedScanCurves.slice(-2000)
      : optCurves.slice(-2000);

  if (normalizedIrcCurves.length > 0) {
    calculationType = 'IRC';
  } else if (normalizedScanCurves.length > 0) {
    calculationType = 'SCAN';
  }

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

  const terminationStatus: GaussianSummary['terminationStatus'] = normalTermination
    ? 'normal'
    : termination.status;

  return {
    frames: clippedFrames,
    frequencies,
    scfEnergies,
    freeEnergy,
    basis,
    normalTermination,
    terminationStatus,
    terminationReason,
    curves,
    overview,
    thermo,
  };
}
