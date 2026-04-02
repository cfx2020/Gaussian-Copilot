import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GaussianSummary } from '../parser/types';

export interface ViewerRenderOptions {
  backgroundColor: string;
  style: 'ballStick' | 'stick' | 'sphere' | 'line' | 'cpkBallStick' | 'licorice' | 'spacefill';
  stickRadius: number;
  sphereScale: number;
  vibrationFps: number;
  maxDisplayedFrequencies: number;
  autoZoomOnFrameChange: boolean;
}

const symbols = ['', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg'];

interface GjfTemplateInfo {
  link0: string[];
  route: string;
  title: string;
  chargeMultiplicity: string;
  basisTail: string;
}

interface NextInputPlan {
  outputPath: string;
  route: string;
  chkName: string;
  oldChkValue?: string;
  content: string;
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function removeRouteKeywords(routeBody: string, names: string[]): string {
  let text = routeBody;
  for (const name of names) {
    const regex = new RegExp(`\\b${name}\\b(?:\\s*=\\s*(?:\\([^)]*\\)|[^\\s]+))?`, 'ig');
    text = text.replace(regex, ' ');
  }
  return normalizeSpaces(text);
}

function ensureRoutePrefix(route: string): { prefix: string; body: string } {
  const trimmed = route.trim();
  const match = trimmed.match(/^(#\S*)(?:\s+(.*))?$/i);
  if (!match) {
    return { prefix: '#p', body: normalizeSpaces(trimmed) };
  }
  return {
    prefix: match[1],
    body: normalizeSpaces(match[2] ?? ''),
  };
}

function normalizeSolventKeyword(solvent: string): string {
  const trimmed = solvent.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'dichloro-methane') {
    return 'dichloromethane';
  }
  if (lower === 'dichloro-ethane') {
    return 'dichloroethane';
  }
  return trimmed;
}

function buildRoute(route: string, kind: 'ts' | 'sol' | 'irc', solvent?: string): string {
  const { prefix, body } = ensureRoutePrefix(route || '#p');
  if (kind === 'ts') {
    const kept = removeRouteKeywords(body, ['opt', 'guess', 'geom']);
    const combined = normalizeSpaces(`${kept} opt=(calcfc,ts,nofreeze,noeigentest)`);
    return `${prefix} ${combined}`.trim();
  }

  if (kind === 'sol') {
    const kept = removeRouteKeywords(body, ['opt', 'freq', 'irc', 'scrf', 'guess', 'geom']);
    const sol = solvent && solvent.trim() ? normalizeSolventKeyword(solvent) : 'water';
    const combined = normalizeSpaces(`${kept} scrf=(smd,solvent=${sol}) guess=read geom=check`);
    return `${prefix} ${combined}`.trim();
  }

  const kept = removeRouteKeywords(body, ['opt', 'freq', 'irc', 'scrf', 'guess', 'geom']);
  const combined = normalizeSpaces(`${kept} irc=(maxpoints=200,maxcyc=500,rcfc,LQA) guess=read geom=check`);
  return `${prefix} ${combined}`.trim();
}

function buildReadTsRoute(route: string): string {
  const { prefix, body } = ensureRoutePrefix(route || '#p');
  const kept = removeRouteKeywords(body, ['opt', 'guess', 'geom']);
  const combined = normalizeSpaces(`${kept} opt=(readfc,ts,nofreeze,noeigentest) guess=read geom=check`);
  return `${prefix} ${combined}`.trim();
}

function routeHasGenLikeBasis(route: string): boolean {
  const { body } = ensureRoutePrefix(route || '#p');
  return /\/(gen|genecp)\b/i.test(body);
}

function looksLikeModredundantLine(line: string): boolean {
  const trimmed = line.trim();
  // Basis shell headers like "d 1 1.00" or "sp 3 1.00" must be preserved.
  if (/^[A-Za-z]{1,2}\s+\d+\s+[-+]?\d*\.?\d+(?:[DdEe][-+]?\d+)?\s*$/.test(trimmed)) {
    return false;
  }
  return /^\s*[BADXL]\s+\d+/i.test(trimmed);
}

function extractBasisTailFromTail(tail: string): string {
  if (!tail.trim()) {
    return '';
  }

  const lines = tail.split(/\r?\n/);
  const firstBasisHeader = lines.findIndex((line) => /^\s*[A-Za-z][A-Za-z\s]*\s+0\s*$/i.test(line));
  const start = firstBasisHeader >= 0 ? firstBasisHeader : 0;
  const filtered = lines
    .slice(start)
    .filter((line) => !looksLikeModredundantLine(line))
    .join('\n')
    .trim();

  return filtered;
}

function upgradeBasisTextForSolvent(text: string): string {
  if (!text) {
    return text;
  }

  return text
    .replace(/\blanl2dz\b/ig, 'SDD')
    .replace(/\b6-31\s*\+?\+?g\*\*(?!\*)/ig, '6-311++G**')
    .replace(/\b6-31\s*g\*(?!\*)/ig, '6-311++G**');
}

function upgradeRouteBasisForSolvent(route: string): string {
  if (!route) {
    return route;
  }

  const upgraded = route
    .replace(/\/\s*lanl2dz\b/ig, '/SDD')
    .replace(/\/\s*6-31\s*g\s*\(\s*d\s*\)\b/ig, '/6-311++G**')
    .replace(/\/\s*6-31\s*g\s*\(\s*d\s*,\s*p\s*\)\b/ig, '/6-311++G**')
    .replace(/\/\s*6-31\s*\+?\+?g\*\*(?!\*)/ig, '/6-311++G**')
    .replace(/\/\s*6-31\s*g\*(?!\*)/ig, '/6-311++G**');

  return upgraded;
}

function isMetalAtomicNumber(atomicNumber: number): boolean {
  // Common non-metals and metalloids are excluded.
  const nonMetals = new Set([1, 2, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 33, 34, 35, 36, 52, 53, 54]);
  return Number.isFinite(atomicNumber) && atomicNumber > 0 && !nonMetals.has(atomicNumber);
}

function hasMetalAtoms(summary: GaussianSummary): boolean {
  const lastFrame = summary.frames[summary.frames.length - 1];
  const atoms = lastFrame?.atoms ?? [];
  return atoms.some((atom) => isMetalAtomicNumber(atom.atomicNumber));
}

function normalizeLink0(
  inheritedLink0: string[],
  chkName: string,
  oldChkValue?: string,
): string[] {
  const kept = inheritedLink0
    .map((line) => line.trim())
    .filter((line) => line && !/^%chk\s*=/i.test(line) && !/^%oldchk\s*=/i.test(line));
  const result = [...kept, `%chk=${chkName}`];
  if (oldChkValue) {
    result.push(`%oldchk=${oldChkValue}`);
  }
  return result;
}

function parseGjfTemplate(content: string): GjfTemplateInfo | undefined {
  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length && !lines[i].trim()) {
    i += 1;
  }

  const link0: string[] = [];
  while (i < lines.length && lines[i].trim().startsWith('%')) {
    link0.push(lines[i].trim());
    i += 1;
  }

  while (i < lines.length && !lines[i].trim()) {
    i += 1;
  }

  const routeLines: string[] = [];
  while (i < lines.length && lines[i].trim()) {
    routeLines.push(lines[i].trim());
    i += 1;
  }
  if (!routeLines.length) {
    return undefined;
  }

  while (i < lines.length && !lines[i].trim()) {
    i += 1;
  }

  const titleLines: string[] = [];
  while (i < lines.length && lines[i].trim()) {
    titleLines.push(lines[i]);
    i += 1;
  }

  while (i < lines.length && !lines[i].trim()) {
    i += 1;
  }

  const chargeMultiplicity = i < lines.length && lines[i].trim() ? lines[i].trim() : '0 1';
  if (i < lines.length) {
    i += 1;
  }

  while (i < lines.length && lines[i].trim()) {
    i += 1;
  }

  while (i < lines.length && !lines[i].trim()) {
    i += 1;
  }

  const tail = lines.slice(i).join('\n').trim();
  const route = normalizeSpaces(routeLines.join(' '));
  const basisTail = routeHasGenLikeBasis(route) ? extractBasisTailFromTail(tail) : '';

  return {
    link0,
    route,
    title: titleLines.join(' ').trim() || 'Generated by Gaussian Copilot',
    chargeMultiplicity,
    basisTail,
  };
}

async function loadTemplateFromCompanionGjf(logPath: string): Promise<GjfTemplateInfo | undefined> {
  const parsed = path.parse(logPath);
  const gjfPath = path.join(parsed.dir, `${parsed.name}.gjf`);
  try {
    const raw = await fs.readFile(gjfPath, 'utf8');
    return parseGjfTemplate(raw);
  } catch {
    return undefined;
  }
}

function defaultTemplateFromSummary(logPath: string, summary: GaussianSummary): GjfTemplateInfo {
  const parsed = path.parse(logPath);
  const method = summary.overview.method?.trim() || 'B3LYP';
  const basis = summary.overview.basisSet?.trim() || summary.basis?.trim() || '6-31G*';
  const charge = Number.isFinite(summary.overview.charge) ? String(summary.overview.charge) : '0';
  const multiplicity = Number.isFinite(summary.overview.multiplicity) ? String(summary.overview.multiplicity) : '1';

  return {
    link0: [
      '%nprocshared=8',
      '%mem=16GB',
      `%chk=${parsed.name}.chk`,
    ],
    route: `#p ${method}/${basis}`,
    title: `${parsed.name} generated by Gaussian Copilot`,
    chargeMultiplicity: `${charge} ${multiplicity}`,
    basisTail: '',
  };
}

function atomsToGaussianCoordinates(atoms: Array<{ atomicNumber: number; x: number; y: number; z: number }>): string {
  return atoms.map((atom) => {
    const symbol = symbols[atom.atomicNumber] || 'X';
    const x = Number(atom.x).toFixed(6);
    const y = Number(atom.y).toFixed(6);
    const z = Number(atom.z).toFixed(6);
    return `${symbol} ${x} ${y} ${z}`;
  }).join('\n');
}

async function buildNextInputPlan(
  logPath: string,
  summary: GaussianSummary,
  kind: 'ts' | 'ts-read' | 'sol' | 'irc',
  frameIndex: number,
  solvent?: string,
): Promise<NextInputPlan> {
  const template = await loadTemplateFromCompanionGjf(logPath) ?? defaultTemplateFromSummary(logPath, summary);
  const parsed = path.parse(logPath);
  let outputPath: string;
  if (kind === 'sol') {
    const smdDir = path.join(parsed.dir, 'smd');
    await fs.mkdir(smdDir, { recursive: true });
    outputPath = path.join(smdDir, `${parsed.name}_sol.gjf`);
  } else if (kind === 'irc') {
    outputPath = path.join(parsed.dir, `${parsed.name}-irc.gjf`);
  } else {
    outputPath = path.join(parsed.dir, `${parsed.name}-ts.gjf`);
  }

  const outputBase = path.parse(outputPath).name;
  const chkName = `${outputBase}.chk`;
  const oldChkValue = kind === 'sol'
    ? `../${parsed.name}.chk`
    : (kind === 'irc' || kind === 'ts-read' ? `${parsed.name}.chk` : undefined);

  const link0 = normalizeLink0(template.link0, chkName, oldChkValue);

  let route: string;
  if (kind === 'ts-read') {
    route = buildReadTsRoute(template.route);
  } else {
    route = buildRoute(template.route, kind, solvent);
  }

  if (kind === 'sol') {
    const shouldUpgradeBasis = !routeHasGenLikeBasis(route) && !hasMetalAtoms(summary);
    if (shouldUpgradeBasis) {
      route = upgradeRouteBasisForSolvent(route);
    }
  }

  const frame = summary.frames[Math.max(0, Math.min(summary.frames.length - 1, frameIndex))];
  const coordinates = frame ? atomsToGaussianCoordinates(frame.atoms) : '';
  const basisTail = kind === 'sol'
    ? (routeHasGenLikeBasis(route) ? upgradeBasisTextForSolvent(template.basisTail) : template.basisTail)
    : template.basisTail;

  const lines: string[] = [];
  lines.push(...link0);
  lines.push(route);
  lines.push('');
  lines.push(template.title);
  lines.push('');
  lines.push(template.chargeMultiplicity);
  if (kind === 'ts') {
    lines.push(coordinates);
  }
  lines.push('');
  if (basisTail) {
    lines.push(basisTail);
    lines.push('');
  }

  const content = `${lines.join('\n').replace(/\n+$/g, '')}\n\n\n`;
  return {
    outputPath,
    route,
    chkName,
    oldChkValue,
    content,
  };
}

async function writeNextInputFile(plan: NextInputPlan): Promise<string> {
  await fs.writeFile(plan.outputPath, plan.content, 'utf8');
  return plan.outputPath;
}

function toXyzString(summary: GaussianSummary, frameIndex: number): string {
  const frame = summary.frames[frameIndex];
  if (!frame) {
    return '0\nempty\n';
  }

  const lines = frame.atoms.map((atom) => {
    const symbol = symbols[atom.atomicNumber] || 'X';
    return `${symbol} ${atom.x} ${atom.y} ${atom.z}`;
  });

  return `${frame.atoms.length}\nframe-${frame.step}\n${lines.join('\n')}\n`;
}

function toXyzFromAtoms(atoms: Array<{ atomicNumber: number; x: number; y: number; z: number }>): string {
  if (!atoms.length) {
    return '0\nempty\n';
  }

  const lines = atoms.map((atom) => {
    const symbol = symbols[atom.atomicNumber] || 'X';
    return `${symbol} ${atom.x} ${atom.y} ${atom.z}`;
  });

  return `${atoms.length}\nanimated\n${lines.join('\n')}\n`;
}

export function showLogPanel(
  context: vscode.ExtensionContext,
  sourceLogPath: string,
  title: string,
  summary: GaussianSummary,
  viewerOptions: ViewerRenderOptions,
): void {
  const panel = vscode.window.createWebviewPanel(
    'gaussianLogViewer',
    `Gaussian 可视化: ${title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media'),
      ],
    },
  );

  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const threeJsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'vendor', '3Dmol-min.js'));
  const echartsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'vendor', 'echarts.min.js'));
  const cspSource = panel.webview.cspSource;
  const frameXyz = summary.frames.map((_, i) => toXyzString(summary, i));
  const baseAtoms = summary.frames.length > 0 ? summary.frames[summary.frames.length - 1].atoms : [];
  const payload = JSON.stringify({
    frameXyz,
    baseAtoms,
    frequencies: summary.frequencies,
    energies: summary.scfEnergies,
    curves: summary.curves,
    freeEnergy: summary.freeEnergy,
    basis: summary.basis,
    normalTermination: summary.normalTermination,
    overview: summary.overview,
    thermo: summary.thermo,
    viewer: viewerOptions,
  });

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const req = message as {
      type?: string;
      kind?: 'ts' | 'ts-read' | 'sol' | 'irc';
      frameIndex?: number;
      solvent?: string;
      currentValue?: string;
    };

    if (req?.type === 'requestCustomSolvent') {
      const picked = await vscode.window.showInputBox({
        title: '输入自定义溶剂',
        prompt: '用于 scrf=(smd,solvent=xxx) 中的 xxx',
        placeHolder: '例如：dmf',
        value: req.currentValue?.trim() || '',
      });

      panel.webview.postMessage({
        type: 'setCustomSolvent',
        value: picked?.trim() || '',
      });
      return;
    }

    if ((req?.type !== 'generateNextInput' && req?.type !== 'previewNextInput') || !req.kind) {
      return;
    }

    try {
      const plan = await buildNextInputPlan(
        sourceLogPath,
        summary,
        req.kind,
        Number.isFinite(req.frameIndex) ? Number(req.frameIndex) : 0,
        req.solvent,
      );

      const skipPreview = context.workspaceState.get<boolean>('chemAssist.nextPreviewDisabled', false);
      if (req.type === 'previewNextInput' && !skipPreview) {
        const kindLabelMap: Record<'ts' | 'ts-read' | 'sol' | 'irc', string> = {
          ts: 'TS（当前帧坐标）',
          'ts-read': 'TS（readfc）',
          sol: 'Sol（SMD）',
          irc: 'IRC',
        };
        const detail = [
          `目标文件: ${plan.outputPath}`,
          `%chk: ${plan.chkName}`,
          `%oldchk: ${plan.oldChkValue ?? '(无)'}`,
          `Route: ${plan.route}`,
          '',
          '可选：点“生成并不再显示”可跳过后续预览。',
        ].join('\n');

        const choice = await vscode.window.showInformationMessage(
          `即将生成 ${kindLabelMap[req.kind]} 输入文件，是否继续？`,
          { modal: true, detail },
          '生成',
          '生成并不再显示',
        );
        if (choice === '生成并不再显示') {
          await context.workspaceState.update('chemAssist.nextPreviewDisabled', true);
        } else if (choice !== '生成') {
          return;
        }
      }

      const outputPath = await writeNextInputFile(plan);
      const doc = await vscode.workspace.openTextDocument(outputPath);
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.window.showInformationMessage(`已生成输入文件：${path.basename(outputPath)}`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`生成输入文件失败：${messageText}`);
    }
  });

  panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gaussian 可视化</title>
  <style>
    :root {
      --gc-accent: #21c7a8;
      --gc-surface: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, #0b1320);
      --gc-border: color-mix(in srgb, var(--vscode-panel-border) 76%, #89f0dd);
      --gc-text-soft: color-mix(in srgb, var(--vscode-descriptionForeground) 90%, #b8fff2);
      --gc-shadow: 0 16px 30px rgba(0, 0, 0, 0.22);
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Avenir Next', 'SF Pro Display', 'Segoe UI', sans-serif;
      padding: 14px;
      margin: 0;
      color: var(--vscode-editor-foreground);
      background:
        radial-gradient(1200px 580px at -10% -20%, rgba(36, 188, 157, 0.25), transparent 55%),
        radial-gradient(1000px 520px at 110% 115%, rgba(56, 136, 212, 0.20), transparent 60%),
        var(--vscode-editor-background);
      min-height: 100vh;
    }
    .stage {
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 10px;
      height: calc(100vh - 28px);
      min-height: 680px;
    }
    .card {
      border: 1px solid var(--gc-border);
      border-radius: 14px;
      padding: 12px;
      background: linear-gradient(170deg, color-mix(in srgb, var(--gc-surface) 94%, #205568), color-mix(in srgb, var(--gc-surface) 88%, #111922));
      box-shadow: var(--gc-shadow);
      backdrop-filter: blur(8px);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      background: linear-gradient(130deg, rgba(12, 28, 38, 0.50), rgba(32, 76, 94, 0.62));
      border: 1px solid color-mix(in srgb, var(--gc-border) 64%, transparent);
      border-radius: 10px;
      min-height: 48px;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .toolbar-spacer {
      flex: 1;
      min-width: 12px;
    }
    .toolbar-brand {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: inherit;
      white-space: nowrap;
      margin-left: auto;
      margin-right: 6px;
      padding: 0;
      border-radius: 0;
      background: transparent;
      border: 0;
    }
    .toolbar-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid color-mix(in srgb, var(--gc-border) 68%, transparent);
      background: rgba(35, 96, 93, 0.34);
      color: var(--gc-text-soft);
      border-radius: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
      min-height: 42px;
      min-width: 60px;
      flex-grow: 0;
      flex-shrink: 0;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .toolbar-btn:hover {
      background: rgba(35, 96, 93, 0.56);
      border-color: var(--gc-border);
    }
    .toolbar-btn.active {
      background: rgba(21, 177, 163, 0.45);
      border-color: var(--gc-accent);
      color: #d5fff5;
    }
    .toolbar-btn-icon {
      font-size: 18px;
      font-weight: 600;
    }
    .toolbar-btn-label {
      font-size: 10px;
      white-space: nowrap;
    }
    .toolbar-sep {
      width: 1px;
      height: 32px;
      background: color-mix(in srgb, var(--gc-border) 52%, transparent);
      flex-shrink: 0;
    }
    .floating-panel {
      position: absolute;
      top: 70px;
      left: 10px;
      width: min(320px, calc(100% - 20px));
      max-height: calc(100% - 80px);
      overflow-y: auto;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--gc-border) 86%, transparent);
      background: linear-gradient(170deg, rgba(10, 28, 38, 0.94), rgba(13, 32, 46, 0.88));
      backdrop-filter: blur(8px);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3);
      z-index: 10;
      display: none;
    }
    .floating-panel.open {
      display: block;
      animation: slideDown 0.18s ease-out;
    }
    .info-drawer-curve {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid color-mix(in srgb, var(--gc-border) 52%, transparent);
    }
    #curve {
      width: 100%;
      height: 200px;
    }
    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .panel-title {
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--gc-text-soft);
      margin-bottom: 10px;
    }
    .panel-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
    }
    .panel-field label {
      font-size: 11px;
      color: var(--gc-text-soft);
      font-weight: 500;
    }
    .panel-field select,
    .panel-field input[type='color'],
    .panel-field input[type='range'],
    .panel-field input[type='checkbox'] {
      font-size: 11px;
    }
    .panel-field select {
      height: 28px;
      padding: 4px 20px 4px 8px;
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      background: color-mix(in srgb, var(--vscode-dropdown-background) 74%, #153245);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-dropdown-border, var(--gc-border)) 70%, transparent);
      border-radius: 6px;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--vscode-foreground) 50%),
        linear-gradient(135deg, var(--vscode-foreground) 50%, transparent 50%);
      background-position: calc(100% - 10px) 10px, calc(100% - 6px) 10px;
      background-size: 4px 4px, 4px 4px;
      background-repeat: no-repeat;
    }
    .panel-field input[type='color'] {
      height: 32px;
      border: 1px solid color-mix(in srgb, var(--gc-border) 68%, transparent);
      border-radius: 6px;
      cursor: pointer;
    }
    .panel-range-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .panel-field input[type='range'] {
      flex: 1;
      height: 4px;
      accent-color: var(--gc-accent);
    }
    .panel-spinner {
      font-size: 11px;
      color: var(--gc-text-soft);
      min-width: 36px;
      text-align: center;
    }
    .panel-field input[type='checkbox'] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--vscode-checkbox-selectBackground);
    }
    .panel-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .panel-btn {
      flex: 1;
      min-width: 80px;
      padding: 6px 10px;
      border: 1px solid color-mix(in srgb, var(--gc-border) 82%, transparent);
      background: linear-gradient(160deg, rgba(35, 96, 93, 0.56), rgba(26, 64, 91, 0.54));
      color: color-mix(in srgb, var(--vscode-button-foreground, #ffffff) 95%, #d6fff8);
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      transition: filter 0.12s ease;
    }
    .panel-btn:hover {
      filter: brightness(1.08);
    }
    .viewer-stage {
      position: relative;
      min-height: 0;
      border: 1px solid color-mix(in srgb, var(--gc-border) 84%, transparent);
      border-radius: 12px;
      overflow: hidden;
      background: linear-gradient(170deg, rgba(9, 20, 34, 0.34), rgba(9, 17, 26, 0.15));
    }
    .viewer-head {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      color: var(--gc-text-soft);
      font-size: 11px;
      letter-spacing: 0.02em;
      text-transform: none;
    }
    .viewer-wrap {
      width: 100%;
      height: 100%;
      min-height: 390px;
      overflow: hidden;
      box-sizing: border-box;
      padding: 0;
      margin: 0;
      background: #ffffff;
    }
    #viewer { width: 100%; height: 100%; display: block; margin: 0; padding: 0; position: relative; }
    #viewer canvas { width: 100% !important; height: 100% !important; display: block; }
    .info-drawer {
      position: absolute;
      top: 10px;
      right: 10px;
      width: min(360px, calc(100% - 24px));
      max-height: calc(100% - 20px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 6;
      transition: transform 0.2s ease, opacity 0.2s ease;
      border: 1px solid color-mix(in srgb, var(--gc-border) 86%, transparent);
      border-radius: 12px;
      background: linear-gradient(170deg, rgba(10, 28, 38, 0.92), rgba(13, 32, 46, 0.88));
      backdrop-filter: blur(8px);
    }
    .info-drawer-content {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
      overflow: hidden;
    }
    .info-drawer-tabs {
      flex-shrink: 0;
      padding: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--gc-border) 52%, transparent);
    }
    .info-drawer-panels {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .info-drawer-curve {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid color-mix(in srgb, var(--gc-border) 52%, transparent);
    }
    .info-drawer.collapsed {
      transform: translateX(calc(100% + 18px));
      opacity: 0;
      pointer-events: none;
    }
    .curve-card {
      padding: 8px;
    }
    .control-section {
      border: 1px solid color-mix(in srgb, var(--gc-border) 88%, transparent);
      border-radius: 10px;
      padding: 8px;
      background: linear-gradient(160deg, rgba(22, 47, 61, 0.50), rgba(11, 24, 37, 0.40));
    }
    .control-title {
      font-weight: 700;
      margin-bottom: 8px;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--gc-text-soft);
    }
    .form-grid-1 { display: grid; grid-template-columns: 1fr; gap: 8px; }
    .field {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 26px;
    }
    .field label {
      width: 54px;
      font-size: 12px;
      color: var(--gc-text-soft);
      flex: 0 0 auto;
    }
    .field select,
    .field input[type="range"] {
      flex: 1;
      min-width: 90px;
    }
    .field select {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      background: color-mix(in srgb, var(--vscode-dropdown-background) 74%, #153245);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-dropdown-border, var(--gc-border)) 74%, transparent);
      border-radius: 6px;
      height: 26px;
      padding: 0 26px 0 8px;
      outline: none;
      box-sizing: border-box;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--vscode-foreground) 50%),
        linear-gradient(135deg, var(--vscode-foreground) 50%, transparent 50%);
      background-position:
        calc(100% - 14px) 10px,
        calc(100% - 9px) 10px;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    .field select:focus {
      border-color: var(--vscode-focusBorder);
    }
    .field input[type="range"] {
      max-width: 130px;
      height: 4px;
      accent-color: var(--gc-accent);
    }
    .field input[type="checkbox"] {
      width: 14px;
      height: 14px;
      accent-color: var(--vscode-checkbox-selectBackground);
    }
    .field span {
      min-width: 28px;
      text-align: right;
      font-size: 12px;
      color: color-mix(in srgb, var(--vscode-foreground) 92%, #d5fff5);
    }
    .action-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .action-row button {
      border: 1px solid color-mix(in srgb, var(--gc-border) 82%, transparent);
      background: linear-gradient(160deg, rgba(35, 96, 93, 0.56), rgba(26, 64, 91, 0.54));
      color: color-mix(in srgb, var(--vscode-button-foreground, #ffffff) 95%, #d6fff8);
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      transition: transform 0.12s ease, filter 0.12s ease;
    }
    .action-row button:hover {
      filter: brightness(1.08);
      transform: translateY(-1px);
    }
    #mode { min-width: 0; }
    .section-title { font-weight: 600; margin-top: 8px; margin-bottom: 4px; }
    .hint { opacity: 0.8; font-size: 12px; color: var(--gc-text-soft); }
    .tabs { display: flex; gap: 8px; margin-bottom: 8px; }
    .tab-btn { border: 1px solid color-mix(in srgb, var(--gc-border) 82%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 5px 11px; cursor: pointer; }
    .tab-btn.active { background: linear-gradient(160deg, rgba(30, 108, 98, 0.62), rgba(20, 72, 98, 0.58)); color: #dffff6; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .kv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .kv-table td { border-bottom: 1px solid color-mix(in srgb, var(--gc-border) 72%, transparent); padding: 5px 6px; vertical-align: top; }
    .kv-table td:first-child { width: 52%; opacity: 0.95; }
    .solvent-select {
      flex: 1;
      min-width: 220px;
      border: 1px solid color-mix(in srgb, var(--gc-border) 82%, transparent);
      border-radius: 6px;
      padding: 4px 8px;
      background: color-mix(in srgb, var(--vscode-dropdown-background) 74%, #153245);
      color: var(--vscode-dropdown-foreground);
    }
    @media (max-width: 1200px) {
      .toolbar {
        gap: 6px;
        padding: 6px;
      }
      .toolbar-btn {
        padding: 5px 10px;
        min-height: 40px;
        font-size: 12px;
      }
      .toolbar-btn-icon {
        font-size: 16px;
      }
    }
    @media (max-width: 900px) {
      .toolbar {
        gap: 5px;
        padding: 5px;
      }
      .toolbar-btn {
        padding: 4px 8px;
        min-height: 38px;
        min-width: 50px;
        font-size: 11px;
      }
      .toolbar-btn-icon {
        font-size: 14px;
      }
      .toolbar-btn-label {
        font-size: 9px;
      }
      .toolbar-sep {
        height: 28px;
      }
    }
    @media (max-width: 760px) {
      .viewer-head {
        display: none;
      }
      .stage {
        grid-template-rows: auto minmax(300px, 1fr);
        height: calc(100vh - 18px);
        min-height: 540px;
      }
      .toolbar {
        height: 34px;
        gap: 4px;
        padding: 4px 5px;
      }
      .toolbar-brand {
        font-size: 12px;
        padding: 3px 6px;
      }
      .toolbar-icon-btn {
        width: 24px;
        height: 24px;
        font-size: 10px;
      }
      .toolbar-divider {
        height: 16px;
        margin: 0 2px;
      }
      #curve {
        height: 160px;
      }
    }
  </style>
</head>
<body>
  <div class="card stage">
    <!-- 简化工具栏：只有主要按钮 -->
    <div class="toolbar">
      <button id="styleBtn" class="toolbar-btn" title="渲染样式与参数">
        <span class="toolbar-btn-icon">⚙</span>
        <span class="toolbar-btn-label">样式</span>
      </button>

      <button id="frameBtn" class="toolbar-btn" title="结构轨迹与循环">
        <span class="toolbar-btn-icon">⏯</span>
        <span class="toolbar-btn-label">轨迹</span>
      </button>

      <button id="vibrationBtn" class="toolbar-btn" title="振动模式与参数">
        <span class="toolbar-btn-icon">≈</span>
        <span class="toolbar-btn-label">振动</span>
      </button>

      <div class="toolbar-sep"></div>

      <button id="infoToggleBtn" class="toolbar-btn" title="显示/隐藏右侧信息">
        <span class="toolbar-btn-icon">ⓘ</span>
        <span class="toolbar-btn-label">信息</span>
      </button>

      <div class="toolbar-spacer"></div>
      <div class="toolbar-brand">Gaussian Copilot</div>
    </div>

    <!-- 浮动面板：样式 -->
    <div id="stylePanel" class="floating-panel">
      <div class="panel-title">渲染样式 & 参数</div>

      <div class="panel-field">
        <label>样式</label>
        <select id="renderStyle">
          <option value="ballStick">ball+stick</option>
          <option value="cpkBallStick">CPK ball+stick</option>
          <option value="stick">stick</option>
          <option value="licorice">licorice</option>
          <option value="sphere">sphere</option>
          <option value="spacefill">spacefill</option>
          <option value="line">line</option>
        </select>
      </div>

      <div class="panel-field">
        <label>背景色</label>
        <input id="bgColor" type="color" value="#ffffff" />
      </div>

      <div class="panel-field">
        <label>棒半径</label>
        <div class="panel-range-group">
          <input id="stickRadius" type="range" min="0.08" max="0.45" step="0.01" value="0.18" />
          <span id="stickRadiusLabel" class="panel-spinner">0.18</span>
        </div>
      </div>

      <div class="panel-field">
        <label>球缩放</label>
        <div class="panel-range-group">
          <input id="sphereScale" type="range" min="0.1" max="0.7" step="0.01" value="0.25" />
          <span id="sphereScaleLabel" class="panel-spinner">0.25</span>
        </div>
      </div>
    </div>

    <!-- 浮动面板：轨迹控制 -->
    <div id="framePanel" class="floating-panel">
      <div class="panel-title">结构轨迹</div>

      <div class="panel-field">
        <label>轨迹</label>
        <div class="panel-range-group">
          <input id="frame" type="range" min="0" max="0" value="0" />
          <span id="frameLabel" class="panel-spinner">0</span>
        </div>
      </div>

      <div class="panel-field">
        <label style="display: flex; align-items: center; gap: 6px;">
          <input id="loopPlay" type="checkbox" />
          循环播放
        </label>
      </div>

      <div class="panel-buttons">
        <button id="loopPlayBtn" class="panel-btn">开始播放</button>
        <button id="loopStopBtn" class="panel-btn">停止播放</button>
      </div>
    </div>

    <!-- 浮动面板：振动控制 -->
    <div id="vibrationPanel" class="floating-panel">
      <div class="panel-title">振动模式</div>

      <div class="panel-field">
        <label>模式</label>
        <select id="mode"></select>
      </div>

      <div class="panel-field">
        <label>振幅</label>
        <div class="panel-range-group">
          <input id="amp" type="range" min="0.1" max="3" step="0.1" value="1" />
          <span id="ampLabel" class="panel-spinner">1.0</span>
        </div>
      </div>

      <div class="panel-buttons" style="margin-top: 12px;">
        <button id="vibToggleBtn" class="panel-btn">播放</button>
      </div>
    </div>

    <!-- 3D查看器 -->
    <div class="viewer-stage">
      <div class="viewer-wrap"><div id="viewer"></div></div>

      <div id="measurementInfo" class="viewer-head" style="position:absolute; left:12px; bottom:10px; z-index:4; background: rgba(8, 16, 24, 0.45); border: 1px solid rgba(120, 208, 186, 0.24); border-radius: 7px; padding: 6px 8px;">
        <span>测量：点击原子进行选择</span>
        <span>2个原子=键长，3个=键角，4个=二面角</span>
      </div>

      <div id="infoDrawer" class="card info-drawer">
        <div class="info-drawer-content">
          <div class="info-drawer-tabs">
            <button id="tabOverviewBtn" class="tab-btn active">Overview</button>
            <button id="tabThermoBtn" class="tab-btn">Thermo</button>
            <button id="tabNextBtn" class="tab-btn">Next</button>
          </div>
          <div class="info-drawer-panels">
            <div id="tabOverview" class="tab-panel active">
              <table class="kv-table" id="overviewTable"></table>
              <div class="info-drawer-curve">
                <div id="curve" style="height: 180px;"></div>
              </div>
            </div>
            <div id="tabThermo" class="tab-panel">
              <table class="kv-table" id="thermoTable"></table>
            </div>
            <div id="tabNext" class="tab-panel">
              <div class="action-row" style="margin-top:0;">
                <button id="nextTsBtn">从当前帧进行TS过渡态搜索</button>
              </div>
              <div class="action-row">
                <button id="nextTsReadBtn">从当前帧进行TS过渡态搜索（read方法/更快）</button>
              </div>
              <div class="action-row">
                <select id="nextSolvent" class="solvent-select">
                  <option value="water">Water</option>
                  <option value="DMSO">DMSO</option>
                  <option value="nitro-methane">Nitro-methane</option>
                  <option value="acetonitrile">Acetonitrile</option>
                  <option value="methanol">Methanol</option>
                  <option value="ethanol">Ethanol</option>
                  <option value="acetone">Acetone</option>
                  <option value="dichloromethane">Dichloromethane</option>
                  <option value="dichloroethane">Dichloroethane</option>
                  <option value="THF">THF</option>
                  <option value="aniline">Aniline</option>
                  <option value="chlorobenzene">Chlorobenzene</option>
                  <option value="chloroform">Chloroform</option>
                  <option value="diethyl ether">Diethyl ether</option>
                  <option value="toluene">Toluene</option>
                  <option value="benzene">Benzene</option>
                  <option value="CCl4">CCl4</option>
                  <option value="cyclohexane">Cyclohexane</option>
                  <option value="heptane">Heptane</option>
                  <option value="__custom__">自定义...</option>
                </select>
                <button id="nextSolBtn">进行Sol溶剂化</button>
              </div>
              <div class="action-row">
                <button id="nextIrcBtn">进行IRC路径验证</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${threeJsUri}"></script>
  <script nonce="${nonce}" src="${echartsUri}"></script>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const data = ${payload};
    const viewerCfg = Object.assign({
      backgroundColor: 'white',
      style: 'ballStick',
      stickRadius: 0.18,
      sphereScale: 0.25,
      vibrationFps: 60,
      maxDisplayedFrequencies: 180,
      autoZoomOnFrameChange: true,
    }, data.viewer || {});
    const viewer = $3Dmol.createViewer('viewer', {
      backgroundColor: viewerCfg.backgroundColor || 'white'
    });
    const frameSlider = document.getElementById('frame');
    const viewerElement = document.getElementById('viewer');
    const frameLabel = document.getElementById('frameLabel');
    const modeSelect = document.getElementById('mode');
    const ampSlider = document.getElementById('amp');
    const ampLabel = document.getElementById('ampLabel');
    const stylePanel = document.getElementById('stylePanel');
    const framePanel = document.getElementById('framePanel');
    const vibrationPanel = document.getElementById('vibrationPanel');
    const styleBtn = document.getElementById('styleBtn');
    const frameBtn = document.getElementById('frameBtn');
    const vibrationBtn = document.getElementById('vibrationBtn');
    const vibToggleBtn = document.getElementById('vibToggleBtn');
    const infoToggleBtn = document.getElementById('infoToggleBtn');
    const loopPlayBtn = document.getElementById('loopPlayBtn');
    const loopStopBtn = document.getElementById('loopStopBtn');
    const loopPlayCheckbox = document.getElementById('loopPlay');
    const infoDrawer = document.getElementById('infoDrawer');
    const tabOverviewBtn = document.getElementById('tabOverviewBtn');
    const tabThermoBtn = document.getElementById('tabThermoBtn');
    const tabNextBtn = document.getElementById('tabNextBtn');
    const tabOverview = document.getElementById('tabOverview');
    const tabThermo = document.getElementById('tabThermo');
    const tabNext = document.getElementById('tabNext');
    const overviewTable = document.getElementById('overviewTable');
    const thermoTable = document.getElementById('thermoTable');
    const nextTsBtn = document.getElementById('nextTsBtn');
    const nextTsReadBtn = document.getElementById('nextTsReadBtn');
    const nextSolBtn = document.getElementById('nextSolBtn');
    const nextIrcBtn = document.getElementById('nextIrcBtn');
    const nextSolvent = document.getElementById('nextSolvent');
    const renderStyle = document.getElementById('renderStyle');
    const bgColor = document.getElementById('bgColor');
    const stickRadius = document.getElementById('stickRadius');
    const sphereScale = document.getElementById('sphereScale');
    const stickRadiusLabel = document.getElementById('stickRadiusLabel');
    const sphereScaleLabel = document.getElementById('sphereScaleLabel');
    const measurementInfo = document.getElementById('measurementInfo');
    const initialFrameIndex = Math.max(data.frameXyz.length - 1, 0);
    frameSlider.max = String(initialFrameIndex);
    frameSlider.value = String(initialFrameIndex);
    frameLabel.textContent = String(initialFrameIndex);
    let vibTimer = null;
    let frameRenderScheduled = false;
    let pendingFrameIndex = 0;
    let currentFrameIndex = initialFrameIndex;
    let customSolvent = '';
    let resizeTimer = null;
    let lastRenderedXyz = '';
    let currentModel = null;
    let styleDirty = true;
    let infoCollapsed = true;
    let loopPlayingFrames = false;
    let currentLoopIndex = 0;
    let pickedAtoms = [];
    let lastAtomPickAt = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let draggingView = false;
    let suppressClearOnNextClick = false;
    let vibrationCacheKey = '';
    let vibrationCacheCycle = [];

    function atomKey(atom) {
      if (atom && Number.isFinite(atom.index)) {
        return 'index:' + atom.index;
      }
      if (atom && Number.isFinite(atom.serial)) {
        return 'serial:' + atom.serial;
      }
      return 'coord:' + Number(atom.x || 0).toFixed(5) + ',' + Number(atom.y || 0).toFixed(5) + ',' + Number(atom.z || 0).toFixed(5);
    }

    function atomName(atom) {
      const elem = String(atom?.elem || 'X');
      const idx = Number.isFinite(atom?.index) ? atom.index + 1 : (Number.isFinite(atom?.serial) ? atom.serial : '?');
      return elem + idx;
    }

    function renderPickedAtomLabels() {
      viewer.removeAllLabels();
      for (const atom of pickedAtoms) {
        if (!atom || !Number.isFinite(atom.x) || !Number.isFinite(atom.y) || !Number.isFinite(atom.z)) {
          continue;
        }
        viewer.addLabel(atomName(atom), {
          position: { x: Number(atom.x), y: Number(atom.y), z: Number(atom.z) },
          fontSize: 12,
          fontColor: '#d6fffa',
          backgroundColor: '#0c3c4a',
          backgroundOpacity: 0.68,
          borderColor: '#22d3ee',
          borderThickness: 1,
          inFront: true,
          showBackground: true,
        });
      }
    }

    function distanceBetween(a, b) {
      const dx = Number(a.x) - Number(b.x);
      const dy = Number(a.y) - Number(b.y);
      const dz = Number(a.z) - Number(b.z);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function angleByThreeAtoms(a, b, c) {
      const bax = Number(a.x) - Number(b.x);
      const bay = Number(a.y) - Number(b.y);
      const baz = Number(a.z) - Number(b.z);
      const bcx = Number(c.x) - Number(b.x);
      const bcy = Number(c.y) - Number(b.y);
      const bcz = Number(c.z) - Number(b.z);
      const dot = bax * bcx + bay * bcy + baz * bcz;
      const n1 = Math.sqrt(bax * bax + bay * bay + baz * baz);
      const n2 = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
      if (!n1 || !n2) {
        return 0;
      }
      const cosValue = Math.max(-1, Math.min(1, dot / (n1 * n2)));
      return Math.acos(cosValue) * 180 / Math.PI;
    }

    function dihedralByFourAtoms(a, b, c, d) {
      const b0 = { x: Number(b.x) - Number(a.x), y: Number(b.y) - Number(a.y), z: Number(b.z) - Number(a.z) };
      const b1 = { x: Number(c.x) - Number(b.x), y: Number(c.y) - Number(b.y), z: Number(c.z) - Number(b.z) };
      const b2 = { x: Number(d.x) - Number(c.x), y: Number(d.y) - Number(c.y), z: Number(d.z) - Number(c.z) };

      const cross = (u, v) => ({
        x: u.y * v.z - u.z * v.y,
        y: u.z * v.x - u.x * v.z,
        z: u.x * v.y - u.y * v.x,
      });
      const dot = (u, v) => (u.x * v.x + u.y * v.y + u.z * v.z);
      const norm = (u) => Math.sqrt(dot(u, u));
      const normalize = (u) => {
        const n = norm(u) || 1;
        return { x: u.x / n, y: u.y / n, z: u.z / n };
      };

      const n1 = normalize(cross(b0, b1));
      const n2 = normalize(cross(b1, b2));
      const m1 = cross(n1, normalize(b1));
      const x = dot(n1, n2);
      const y = dot(m1, n2);
      return Math.atan2(y, x) * 180 / Math.PI;
    }

    function updateMeasurementInfo() {
      const tips = '2个原子=键长，3个=键角，4个=二面角';
      if (!pickedAtoms.length) {
        measurementInfo.innerHTML = '<span>测量：点击原子进行选择</span><span>' + tips + '</span>';
        return;
      }
      if (pickedAtoms.length === 1) {
        measurementInfo.innerHTML = '<span>已选：' + atomName(pickedAtoms[0]) + '</span><span>' + tips + '</span>';
        return;
      }
      if (pickedAtoms.length === 2) {
        const value = distanceBetween(pickedAtoms[0], pickedAtoms[1]);
        measurementInfo.innerHTML = '<span>键长 ' + atomName(pickedAtoms[0]) + '-' + atomName(pickedAtoms[1]) + '</span><span>' + value.toFixed(4) + ' Å</span>';
        return;
      }
      if (pickedAtoms.length === 3) {
        const value = angleByThreeAtoms(pickedAtoms[0], pickedAtoms[1], pickedAtoms[2]);
        measurementInfo.innerHTML = '<span>键角 ' + atomName(pickedAtoms[0]) + '-' + atomName(pickedAtoms[1]) + '-' + atomName(pickedAtoms[2]) + '</span><span>' + value.toFixed(2) + '°</span>';
        return;
      }
      const lastFour = pickedAtoms.slice(-4);
      const value = dihedralByFourAtoms(lastFour[0], lastFour[1], lastFour[2], lastFour[3]);
      measurementInfo.innerHTML = '<span>二面角 ' + atomName(lastFour[0]) + '-' + atomName(lastFour[1]) + '-' + atomName(lastFour[2]) + '-' + atomName(lastFour[3]) + '</span><span>' + value.toFixed(2) + '°</span>';
    }

    function resetPickedAtoms() {
      pickedAtoms = [];
      updateMeasurementInfo();
      viewer.removeAllLabels();
    }

    function togglePickedAtom(atom) {
      if (!atom) {
        return;
      }
      lastAtomPickAt = Date.now();
      const key = atomKey(atom);
      const foundIndex = pickedAtoms.findIndex((item) => atomKey(item) === key);
      if (foundIndex >= 0) {
        pickedAtoms.splice(foundIndex, 1);
      } else {
        pickedAtoms.push(atom);
        if (pickedAtoms.length > 4) {
          pickedAtoms = pickedAtoms.slice(-4);
        }
      }
      updateMeasurementInfo();
      applyCurrentRenderStyle();
      viewer.render();
    }

    viewerElement.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }
      draggingView = false;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
    });

    viewerElement.addEventListener('mousemove', (event) => {
      const dx = Math.abs(event.clientX - dragStartX);
      const dy = Math.abs(event.clientY - dragStartY);
      if (dx > 4 || dy > 4) {
        draggingView = true;
      }
    });

    viewerElement.addEventListener('mouseup', (event) => {
      if (event.button !== 0) {
        return;
      }
      if (draggingView) {
        suppressClearOnNextClick = true;
      }
    });

    viewerElement.addEventListener('click', () => {
      if (suppressClearOnNextClick) {
        suppressClearOnNextClick = false;
        return;
      }
      if (!pickedAtoms.length) {
        return;
      }
      // 原子点击会同步触发viewer click，这里短时间内忽略以防止刚选中就被清空。
      if (Date.now() - lastAtomPickAt < 120) {
        return;
      }
      resetPickedAtoms();
      applyCurrentRenderStyle();
      viewer.render();
    });

    function setVibrationToggleUi(isPlaying) {
      vibToggleBtn.textContent = isPlaying ? '暂停' : '播放';
      vibToggleBtn.title = isPlaying ? '暂停振动' : '播放振动';
    }

    function xyzFromAtoms(atoms) {
      if (!atoms || !atoms.length) {
        return '0\\nempty\\n';
      }
      const lines = atoms.map((atom) => {
        const symbol = ['','H','He','Li','Be','B','C','N','O','F','Ne','Na','Mg','Al','Si','P','S','Cl','Ar','K','Ca','Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr','Rb','Sr','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe','Cs','Ba','La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg'][atom.atomicNumber] || 'X';
        return symbol + ' ' + atom.x + ' ' + atom.y + ' ' + atom.z;
      });
      return atoms.length + '\\nanimated\\n' + lines.join('\\n') + '\\n';
    }

    function applyCurrentRenderStyle() {
      const style = viewerCfg.style || 'ballStick';
      const stickR = Number(viewerCfg.stickRadius ?? 0.18);
      const sphereS = Number(viewerCfg.sphereScale ?? 0.25);
      if (style === 'stick') {
        viewer.setStyle({}, { stick: { radius: stickR } });
      } else if (style === 'licorice') {
        viewer.setStyle({}, { stick: { radius: Math.max(stickR, 0.28), colorscheme: 'Jmol' } });
      } else if (style === 'sphere') {
        viewer.setStyle({}, { sphere: { scale: sphereS } });
      } else if (style === 'spacefill') {
        viewer.setStyle({}, { sphere: { scale: Math.max(sphereS, 0.58), colorscheme: 'Jmol' } });
      } else if (style === 'line') {
        viewer.setStyle({}, { line: { linewidth: 1.2 } });
      } else if (style === 'cpkBallStick') {
        viewer.setStyle({}, {
          stick: { radius: stickR, colorscheme: 'Jmol' },
          sphere: { scale: Math.max(sphereS, 0.28), colorscheme: 'Jmol' }
        });
      } else {
        viewer.setStyle({}, { stick: { radius: stickR }, sphere: { scale: sphereS } });
      }

      if (pickedAtoms.length) {
        const highlightColor = '#22d3ee';
        let highlightStyle;
        if (style === 'stick' || style === 'licorice') {
          highlightStyle = { stick: { radius: stickR, color: highlightColor } };
        } else if (style === 'sphere' || style === 'spacefill') {
          highlightStyle = { sphere: { scale: sphereS, color: highlightColor } };
        } else if (style === 'line') {
          highlightStyle = { line: { linewidth: 1.2, color: highlightColor } };
        } else {
          highlightStyle = {
            stick: { radius: stickR, color: highlightColor },
            sphere: { scale: sphereS, color: highlightColor },
          };
        }
        for (const atom of pickedAtoms) {
          if (Number.isFinite(atom?.index)) {
            viewer.setStyle({ index: atom.index }, highlightStyle);
          } else if (Number.isFinite(atom?.serial)) {
            viewer.setStyle({ serial: atom.serial }, highlightStyle);
          }
        }
      }
      renderPickedAtomLabels();
    }

    function renderXyz(xyz, options) {
      const opts = Object.assign({ keepView: false, forceRebuild: false }, options || {});
      if (opts.forceRebuild || xyz !== lastRenderedXyz) {
        viewer.removeAllModels();
        currentModel = viewer.addModel(xyz, 'xyz');
        viewer.setClickable({}, true, function(atom) {
          togglePickedAtom(atom);
        });
        lastRenderedXyz = xyz;
        styleDirty = true;
        resetPickedAtoms();
      }

      if (styleDirty) {
        applyCurrentRenderStyle();
        styleDirty = false;
      }

      if (!opts.keepView && viewerCfg.autoZoomOnFrameChange !== false) {
        viewer.zoomTo();
      }
      viewer.render();
    }

    function parseCssColorToHex(input) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return '#ffffff';
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillStyle = input || '#ffffff';
      const normalized = ctx.fillStyle;
      if (typeof normalized === 'string' && normalized.startsWith('#')) {
        if (normalized.length === 4) {
          return '#' + normalized.slice(1).split('').map((x) => x + x).join('');
        }
        return normalized;
      }
      return '#ffffff';
    }

    function syncStyleControlsFromConfig() {
      renderStyle.value = viewerCfg.style || 'ballStick';
      bgColor.value = parseCssColorToHex(viewerCfg.backgroundColor || 'white');
      stickRadius.value = String(viewerCfg.stickRadius ?? 0.18);
      sphereScale.value = String(viewerCfg.sphereScale ?? 0.25);
      stickRadiusLabel.textContent = Number(stickRadius.value).toFixed(2);
      sphereScaleLabel.textContent = Number(sphereScale.value).toFixed(2);
    }

    function applyStyleChangesFromControls() {
      viewerCfg.style = renderStyle.value;
      viewerCfg.backgroundColor = bgColor.value;
      viewerCfg.stickRadius = Number(stickRadius.value);
      viewerCfg.sphereScale = Number(sphereScale.value);
      viewer.setBackgroundColor(viewerCfg.backgroundColor || 'white');
      stopVibration();
      styleDirty = true;
      renderXyz(lastRenderedXyz || (data.frameXyz[currentFrameIndex] || '0\\nempty\\n'), { keepView: true });
    }

    function formatValue(value, unit) {
      if (value === undefined || value === null || value === '') {
        return '--';
      }
      return unit ? String(value) + ' ' + unit : String(value);
    }

    function tableRow(label, value, unit) {
      return '<tr><td>' + label + '</td><td>' + formatValue(value, unit) + '</td></tr>';
    }

    function renderOverview() {
      const o = data.overview || {};
      const fileType = String(${JSON.stringify(title)}).toLowerCase().endsWith('.out') ? '.out' : '.log';
      const basisShown = o.basisSet || data.basis;
      overviewTable.innerHTML = [
        tableRow('File Type', fileType),
        tableRow('Calculation Type', o.calculationType),
        tableRow('Calculation Method', o.method),
        tableRow('Basis Set', basisShown),
        tableRow('Charge', o.charge),
        tableRow('Spin', o.multiplicity === 1 ? 'Singlet' : (o.multiplicity === 2 ? 'Doublet' : (o.multiplicity === 3 ? 'Triplet' : o.multiplicity))),
        tableRow('E(SCF)', o.electronicEnergy, 'Hartree'),
        tableRow('Imaginary Freq', o.imaginaryFreqCount),
        tableRow('Dipole Moment', o.dipoleMoment, 'Debye'),
        tableRow('Polarizability', o.polarizability, 'Bohr^3'),
        tableRow('Point Group', o.pointGroup),
        tableRow('Job cpu time', o.jobCpuTime),
        tableRow('Termination', data.normalTermination ? 'Normal termination' : 'Not normal termination')
      ].join('');
    }

    function renderThermo() {
      const t = data.thermo || {};
      thermoTable.innerHTML = [
        tableRow('Temperature', t.temperatureK, 'K'),
        tableRow('Pressure', t.pressureAtm, 'atm'),
        tableRow('Zero-point Energy Correction', t.zeroPointCorrection, 'Hartree'),
        tableRow('Thermal Correction to Energy', t.thermalCorrectionToEnergy, 'Hartree'),
        tableRow('Thermal Correction to Enthalpy', t.thermalCorrectionToEnthalpy, 'Hartree'),
        tableRow('Thermal Correction to Free Energy', t.thermalCorrectionToGibbs, 'Hartree'),
        tableRow('EE + Zero-point Energy', t.sumElectronicAndZeroPoint, 'Hartree'),
        tableRow('EE + Thermal Energy', t.sumElectronicAndThermalEnergy, 'Hartree'),
        tableRow('EE + Thermal Enthalpy', t.sumElectronicAndThermalEnthalpy, 'Hartree'),
        tableRow('EE + Thermal Free Energy', t.sumElectronicAndThermalFreeEnergy, 'Hartree'),
        tableRow('E (Thermal)', t.eThermalKcalMol, 'kcal/mol'),
        tableRow('Heat Capacity (Cv)', t.heatCapacityCv, 'cal/mol-K'),
        tableRow('Entropy (S)', t.entropyS, 'cal/mol-K')
      ].join('');
    }

    function switchTab(target) {
      const overviewActive = target === 'overview';
      const thermoActive = target === 'thermo';
      const nextActive = target === 'next';
      tabOverviewBtn.classList.toggle('active', overviewActive);
      tabThermoBtn.classList.toggle('active', thermoActive);
      tabNextBtn.classList.toggle('active', nextActive);
      tabOverview.classList.toggle('active', overviewActive);
      tabThermo.classList.toggle('active', thermoActive);
      tabNext.classList.toggle('active', nextActive);
    }

    function renderFrame(index) {
      currentFrameIndex = index;
      frameSlider.value = String(index);
      const xyz = data.frameXyz[index] || '0\\nempty\\n';
      renderXyz(xyz, { keepView: false });
      frameLabel.textContent = String(index);
    }

    function requestRenderFrame(index) {
      pendingFrameIndex = index;
      if (frameRenderScheduled) {
        return;
      }
      frameRenderScheduled = true;
      requestAnimationFrame(() => {
        frameRenderScheduled = false;
        renderFrame(pendingFrameIndex);
      });
    }

    frameSlider.addEventListener('input', () => {
      stopVibration();
      requestRenderFrame(Number(frameSlider.value));
    });

    ampSlider.addEventListener('input', () => {
      ampLabel.textContent = Number(ampSlider.value).toFixed(1);
    });

    renderStyle.addEventListener('change', applyStyleChangesFromControls);
    bgColor.addEventListener('input', applyStyleChangesFromControls);
    stickRadius.addEventListener('input', () => {
      stickRadiusLabel.textContent = Number(stickRadius.value).toFixed(2);
      applyStyleChangesFromControls();
    });
    sphereScale.addEventListener('input', () => {
      sphereScaleLabel.textContent = Number(sphereScale.value).toFixed(2);
      applyStyleChangesFromControls();
    });

    function updateLayoutToggleUi() {
      infoDrawer.classList.toggle('collapsed', infoCollapsed);
      infoToggleBtn.classList.toggle('active', !infoCollapsed);
    }

    function closePanels() {
      stylePanel.classList.remove('open');
      framePanel.classList.remove('open');
      vibrationPanel.classList.remove('open');
    }

    styleBtn.addEventListener('click', () => {
      if (stylePanel.classList.contains('open')) {
        stylePanel.classList.remove('open');
      } else {
        closePanels();
        stylePanel.classList.add('open');
      }
    });

    frameBtn.addEventListener('click', () => {
      if (framePanel.classList.contains('open')) {
        framePanel.classList.remove('open');
      } else {
        closePanels();
        framePanel.classList.add('open');
      }
    });

    vibrationBtn.addEventListener('click', () => {
      if (vibrationPanel.classList.contains('open')) {
        vibrationPanel.classList.remove('open');
      } else {
        closePanels();
        vibrationPanel.classList.add('open');
      }
    });

    infoToggleBtn.addEventListener('click', () => {
      infoCollapsed = !infoCollapsed;
      updateLayoutToggleUi();
      scheduleViewportRefresh(0);
    });

    // 移除工具栏图标按钮的事件处理，因为所有功能已在工具栏中

    function stopVibration() {
      if (vibTimer) {
        cancelAnimationFrame(vibTimer);
        vibTimer = null;
      }
      setVibrationToggleUi(false);
    }

    function buildVibrationCycle(mode, amplitude, baseAtoms, phaseCount) {
      const cycle = [];
      for (let i = 0; i < phaseCount; i += 1) {
        const p = (i / phaseCount) * Math.PI * 2;
        const scale = Math.sin(p) * amplitude;
        const moved = baseAtoms.map((atom, idx) => {
          const vec = mode.vectors[idx] || { x: 0, y: 0, z: 0 };
          return {
            atomicNumber: atom.atomicNumber,
            x: atom.x + vec.x * scale,
            y: atom.y + vec.y * scale,
            z: atom.z + vec.z * scale,
          };
        });
        cycle.push(moved);
      }
      return cycle;
    }

    function startVibration() {
      stopVibration();
      const modeIndex = Number(modeSelect.value);
      const mode = data.frequencies[modeIndex];
      if (!mode || !mode.vectors || !mode.vectors.length || !data.baseAtoms || !data.baseAtoms.length) {
        return false;
      }

      const amplitude = Number(ampSlider.value);
      const baseAtoms = data.baseAtoms;
      const fps = Math.max(10, Number(viewerCfg.vibrationFps || 60));
      const intervalMs = Math.max(16, Math.round(1000 / fps));
      const cycleKey = String(modeIndex) + '|' + amplitude.toFixed(3) + '|' + baseAtoms.length;
      if (cycleKey !== vibrationCacheKey || !vibrationCacheCycle.length) {
        const phaseCount = Math.max(24, Math.min(72, fps));
        vibrationCacheCycle = buildVibrationCycle(mode, amplitude, baseAtoms, phaseCount);
        vibrationCacheKey = cycleKey;
      }
      const cycle = vibrationCacheCycle;
      let cycleIndex = 0;
      let lastTs = 0;
      const tick = (ts) => {
        if (!vibTimer) {
          return;
        }
        if (ts - lastTs >= intervalMs) {
          lastTs = ts;
          const frameAtoms = cycle[cycleIndex];
          let updatedInPlace = false;
          if (currentModel && typeof currentModel.selectedAtoms === 'function') {
            const modelAtoms = currentModel.selectedAtoms({});
            if (modelAtoms && modelAtoms.length === frameAtoms.length) {
              for (let i = 0; i < modelAtoms.length; i += 1) {
                modelAtoms[i].x = frameAtoms[i].x;
                modelAtoms[i].y = frameAtoms[i].y;
                modelAtoms[i].z = frameAtoms[i].z;
              }
              // 通知3Dmol重建该模型几何体，但避免remove/addModel整套开销。
              currentModel.molObj = null;
              viewer.render();
              updatedInPlace = true;
            }
          }
          if (!updatedInPlace) {
            renderXyz(xyzFromAtoms(frameAtoms), { keepView: true, forceRebuild: true });
          }
          cycleIndex = (cycleIndex + 1) % cycle.length;
        }
        vibTimer = requestAnimationFrame(tick);
      };
      vibTimer = requestAnimationFrame(tick);
      setVibrationToggleUi(true);
      return true;
    }

    vibToggleBtn.addEventListener('click', () => {
      if (vibTimer) {
        stopVibration();
        renderFrame(Number(frameSlider.value));
        return;
      }
      startVibration();
    });

    function startLoopPlayFrames() {
      const frameCount = data.frameXyz.length;
      if (frameCount <= 1) return;
      const shouldLoop = Boolean(loopPlayCheckbox.checked);
      loopPlayingFrames = true;
      currentLoopIndex = Math.max(0, Math.min(frameCount - 1, Number(frameSlider.value) || 0));
      if (!shouldLoop && currentLoopIndex >= frameCount - 1) {
        // 未勾选循环且当前已在末帧时，从头开始播放，避免看起来“无反应”。
        currentLoopIndex = 0;
      }
      loopPlayBtn.textContent = '播放中...';
      loopPlayBtn.disabled = true;

      const playNextFrame = () => {
        if (!loopPlayingFrames) return;
        renderFrame(currentLoopIndex);
        const nextIndex = currentLoopIndex + 1;
        if (nextIndex >= frameCount) {
          if (shouldLoop) {
            currentLoopIndex = 0;
          } else {
            stopLoopPlayFrames();
            return;
          }
        } else {
          currentLoopIndex = nextIndex;
        }
        setTimeout(playNextFrame, 100);
      };
      playNextFrame();
    }

    function stopLoopPlayFrames() {
      loopPlayingFrames = false;
      loopPlayBtn.textContent = '开始播放';
      loopPlayBtn.disabled = false;
    }

    loopPlayBtn.addEventListener('click', startLoopPlayFrames);
    loopStopBtn.addEventListener('click', stopLoopPlayFrames);

    renderOverview();
    renderThermo();

    // 右侧面板默认隐藏，但Overview标签默认active（展开时直接看到PES）
    tabOverview.classList.add('active');
    tabOverviewBtn.classList.add('active');
    tabThermo.classList.remove('active');
    tabThermoBtn.classList.remove('active');

    tabOverviewBtn.addEventListener('click', () => switchTab('overview'));
    tabThermoBtn.addEventListener('click', () => switchTab('thermo'));
    tabNextBtn.addEventListener('click', () => switchTab('next'));

    nextTsBtn.addEventListener('click', () => {
      const frameIndex = Number(frameSlider.value);
      vscodeApi.postMessage({
        type: 'previewNextInput',
        kind: 'ts',
        frameIndex,
      });
    });

    nextTsReadBtn.addEventListener('click', () => {
      vscodeApi.postMessage({
        type: 'previewNextInput',
        kind: 'ts-read',
        frameIndex: Number(frameSlider.value),
      });
    });

    nextSolvent.addEventListener('change', () => {
      if (String(nextSolvent.value || '') !== '__custom__') {
        return;
      }
      vscodeApi.postMessage({
        type: 'requestCustomSolvent',
        currentValue: customSolvent,
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== 'setCustomSolvent') {
        return;
      }

      const trimmed = String(msg.value || '').trim();
      if (!trimmed) {
        nextSolvent.value = 'water';
        return;
      }

      customSolvent = trimmed;
      const customOption = nextSolvent.querySelector('option[value="__custom__"]');
      if (customOption) {
        customOption.textContent = '自定义: ' + customSolvent;
      }
      nextSolvent.value = '__custom__';
    });

    nextSolBtn.addEventListener('click', () => {
      const selected = String(nextSolvent.value || 'water').trim() || 'water';
      const solvent = selected === '__custom__' ? (customSolvent || 'water') : selected;
      vscodeApi.postMessage({
        type: 'previewNextInput',
        kind: 'sol',
        frameIndex: Number(frameSlider.value),
        solvent,
      });
    });

    nextIrcBtn.addEventListener('click', () => {
      vscodeApi.postMessage({
        type: 'previewNextInput',
        kind: 'irc',
        frameIndex: Number(frameSlider.value),
      });
    });

    const maxFreq = Math.max(20, Number(viewerCfg.maxDisplayedFrequencies || 180));
    modeSelect.innerHTML = (data.frequencies || []).slice(0, maxFreq)
      .map((f, idx) => '<option value="' + idx + '">mode ' + idx + ' (' + f.value + ' cm⁻¹)</option>')
      .join('');

    if (!modeSelect.innerHTML) {
      modeSelect.innerHTML = '<option value="">无可用模式</option>';
      vibToggleBtn.disabled = true;
      setVibrationToggleUi(false);
    } else {
      vibToggleBtn.disabled = false;
      setVibrationToggleUi(false);
      modeSelect.addEventListener('change', () => {
        stopVibration();
      });
    }

    const chart = echarts.init(document.getElementById('curve'));
    const style = getComputedStyle(document.body);
    const fg = (style.getPropertyValue('--vscode-editor-foreground') || '#d4d4d4').trim();
    const muted = (style.getPropertyValue('--vscode-descriptionForeground') || '#9ca3af').trim();
    const border = (style.getPropertyValue('--vscode-panel-border') || '#4b5563').trim();
    const tooltipBg = (style.getPropertyValue('--vscode-editorWidget-background') || '#111827').trim();
    const opt = data.curves.filter(p => p.type === 'opt');
    const minEnergy = opt.length ? Math.min(...opt.map(p => p.energy)) : 0;
    function samplePoints(points, maxCount) {
      if (points.length <= maxCount) {
        return points.map((point, sourceIndex) => ({ point, sourceIndex }));
      }
      const result = [];
      const stride = (points.length - 1) / (maxCount - 1);
      for (let i = 0; i < maxCount; i += 1) {
        const sourceIndex = Math.round(i * stride);
        result.push({ point: points[sourceIndex], sourceIndex });
      }
      return result;
    }

    const sampled = samplePoints(opt, 600);
    const relativeData = sampled.map((item) => ({
      value: [item.point.index, (item.point.energy - minEnergy) * 627.509],
      absEnergy: item.point.energy,
      sourceIndex: item.sourceIndex,
    }));

    chart.setOption({
      textStyle: { color: fg },
      title: { text: 'PES', left: 'center', top: 6, textStyle: { color: fg, fontSize: 20, fontWeight: 600 } },
      tooltip: {
        trigger: 'item',
        backgroundColor: tooltipBg,
        borderColor: border,
        textStyle: { color: fg },
        formatter: (params) => {
          const p = params.data || {};
          const idx = p.value ? p.value[0] : '--';
          const de = p.value ? p.value[1] : '--';
          const abs = p.absEnergy != null ? p.absEnergy : '--';
          return 'Step: ' + idx + '<br/>ΔE (kcal/mol): ' + de + '<br/>E (Hartree): ' + abs;
        }
      },
      grid: {
        left: 52,
        right: 36,
        top: 50,
        bottom: 42,
        containLabel: false,
      },
      xAxis: {
        type: 'value',
        name: 'Point',
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLabel: { color: fg, fontSize: 11 },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.45 } },
      },
      yAxis: {
        type: 'value',
        name: 'ΔE (kcal/mol)',
        scale: true,
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLabel: { color: fg, fontSize: 11 },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.45 } },
      },
      animation: false,
      progressive: 400,
      hoverLayerThreshold: 3000,
      series: [
        { name: 'Energy', type: 'line', smooth: false, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.6, color: '#39d0ba' }, data: relativeData }
      ]
    });

    chart.on('click', (params) => {
      if (!params || typeof params.dataIndex !== 'number') {
        return;
      }

      const curveCount = opt.length;
      const frameCount = data.frameXyz.length;
      if (!curveCount || !frameCount) {
        return;
      }

      const sourceIndex = params.data && typeof params.data.sourceIndex === 'number'
        ? params.data.sourceIndex
        : params.dataIndex;
      const ratio = curveCount > 1 ? (sourceIndex / (curveCount - 1)) : 0;
      const frameIndex = Math.max(0, Math.min(frameCount - 1, Math.round(ratio * (frameCount - 1))));
      stopVibration();
      frameSlider.value = String(frameIndex);
      requestRenderFrame(frameIndex);
    });

    function refreshViewerViewport() {
      viewer.resize();
      viewer.zoomTo();
      viewer.render();
      chart.resize();
    }

    function scheduleViewportRefresh(delayMs) {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        refreshViewerViewport();
      }, delayMs);
    }

    syncStyleControlsFromConfig();
    updateLayoutToggleUi();
    closePanels();
    requestRenderFrame(initialFrameIndex);
    scheduleViewportRefresh(0);
    scheduleViewportRefresh(120);

    window.addEventListener('resize', () => {
      scheduleViewportRefresh(80);
    });

    window.addEventListener('beforeunload', () => {
      stopVibration();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    });
  </script>
</body>
</html>`;
}
