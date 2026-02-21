export interface GjfTemplate {
  id: string;
  name: string;
  description?: string;
  link0: string[];
  route: string;
  title: string;
  chargeMultiplicity: string;
  coordinatesPlaceholder: string;
  tail?: string;
}

export type BuiltinTemplate = GjfTemplate;
