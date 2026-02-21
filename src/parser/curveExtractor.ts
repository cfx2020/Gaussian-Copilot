import { EnergyPoint } from './types';

export function extractCurves(lines: string[], scfEnergies: number[]): EnergyPoint[] {
  const points: EnergyPoint[] = [];

  let scanIndex = 0;
  let ircIndex = 0;
  let optIndex = 0;

  for (const e of scfEnergies) {
    points.push({ index: optIndex, energy: e, type: 'opt' });
    optIndex += 1;
  }

  for (const line of lines) {
    if (/summary of the potential surface scan/i.test(line)) {
      scanIndex = 0;
    }

    const scanMatch = line.match(/^\s*(\d+)\s+[-+]?\d+\.?\d*\s+(-?\d+\.\d+)/);
    if (scanMatch) {
      points.push({
        index: Number(scanMatch[1]),
        energy: Number(scanMatch[2]),
        type: 'scan',
      });
    }

    const ircEnergy = line.match(/irc.*?point\s*(\d+).*?energy\s*=\s*(-?\d+\.\d+)/i);
    if (ircEnergy) {
      points.push({
        index: Number(ircEnergy[1]),
        energy: Number(ircEnergy[2]),
        type: 'irc',
      });
      ircIndex += 1;
    }
  }

  if (!points.some((p) => p.type === 'scan') && scfEnergies.length > 0) {
    for (const e of scfEnergies) {
      points.push({ index: scanIndex, energy: e, type: 'scan' });
      scanIndex += 1;
    }
  }

  if (!points.some((p) => p.type === 'irc') && scfEnergies.length > 0) {
    for (const e of scfEnergies) {
      points.push({ index: ircIndex, energy: e, type: 'irc' });
      ircIndex += 1;
    }
  }

  return points;
}
