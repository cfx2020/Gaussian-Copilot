import { GjfTemplate } from './types';

export function validateTemplate(template: GjfTemplate): string[] {
  const errors: string[] = [];

  if (!template.link0.length) {
    errors.push('Link0 不能为空');
  }

  if (!template.route.trim().startsWith('#')) {
    errors.push('Route 必须以 # 开头');
  }

  if (!template.chargeMultiplicity.trim()) {
    errors.push('电荷与多重度不能为空');
  }

  if (!template.coordinatesPlaceholder.trim()) {
    errors.push('坐标占位不能为空');
  }

  const routeLower = template.route.toLowerCase();
  const hasGen = routeLower.includes('gen');
  const hasPseudoRead = routeLower.includes('pseudo=read');
  if ((hasGen || hasPseudoRead) && !template.tail) {
    errors.push('当 route 包含 gen 或 pseudo=read 时，必须提供 tail 段');
  }

  return errors;
}
