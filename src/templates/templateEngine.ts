import { GjfTemplate } from './types';

export function renderTemplate(template: GjfTemplate, vars: Record<string, string>): string {
  const render = (text: string) => text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);

  const lines: string[] = [];
  for (const l of template.link0) {
    lines.push(render(l));
  }
  lines.push(render(template.route));
  lines.push('');
  lines.push(render(template.title));
  lines.push('');
  lines.push(render(template.chargeMultiplicity));
  lines.push(render(template.coordinatesPlaceholder));
  lines.push('');
  if (template.tail) {
    lines.push(render(template.tail));
    lines.push('');
  }

  return lines.join('\n');
}
