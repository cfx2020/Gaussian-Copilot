export interface Atom {
  atomicNumber: number;
  x: number;
  y: number;
  z: number;
}

export interface DisplacementVector {
  x: number;
  y: number;
  z: number;
}

export interface Frame {
  step: number;
  atoms: Atom[];
}

export interface FrequencyMode {
  value: number;
  vectors: DisplacementVector[];
}

export interface EnergyPoint {
  index: number;
  energy: number;
  type: 'opt' | 'scan' | 'irc';
  frameIndex?: number;
  pointNumber?: number;
  pathNumber?: number;
  coordinate?: number;
}

export interface OverviewInfo {
  calculationType?: string;
  method?: string;
  basisSet?: string;
  charge?: number;
  multiplicity?: number;
  electronicEnergy?: number;
  imaginaryFreqCount?: number;
  dipoleMoment?: number;
  polarizability?: number;
  pointGroup?: string;
  jobCpuTime?: string;
}

export interface ThermoInfo {
  temperatureK?: number;
  pressureAtm?: number;
  zeroPointCorrection?: number;
  thermalCorrectionToEnergy?: number;
  thermalCorrectionToEnthalpy?: number;
  thermalCorrectionToGibbs?: number;
  sumElectronicAndZeroPoint?: number;
  sumElectronicAndThermalEnergy?: number;
  sumElectronicAndThermalEnthalpy?: number;
  sumElectronicAndThermalFreeEnergy?: number;
  eThermalKcalMol?: number;
  heatCapacityCv?: number;
  entropyS?: number;
}

export interface GaussianSummary {
  frames: Frame[];
  frequencies: FrequencyMode[];
  scfEnergies: number[];
  freeEnergy?: number;
  basis?: string;
  normalTermination: boolean;
  terminationStatus: 'normal' | 'error' | 'running';
  terminationReason?: string;
  curves: EnergyPoint[];
  overview: OverviewInfo;
  thermo: ThermoInfo;
}
