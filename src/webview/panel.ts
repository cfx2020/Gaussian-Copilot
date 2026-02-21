import * as vscode from 'vscode';
import { GaussianSummary } from '../parser/types';

export interface ViewerRenderOptions {
  backgroundColor: string;
  style: 'ballStick' | 'stick' | 'sphere' | 'line';
  stickRadius: number;
  sphereScale: number;
  vibrationFps: number;
  maxDisplayedFrequencies: number;
  autoZoomOnFrameChange: boolean;
}

const symbols = ['', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg'];

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

  panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gaussian 可视化</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 12px; margin: 0; box-sizing: border-box; color: var(--vscode-editor-foreground); }
    .grid { display: grid; grid-template-columns: 300px minmax(520px, 1fr) minmax(260px, 28%); gap: 12px; align-items: stretch; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 12px; }
    .left-panel, .center-panel, .right-panel { min-height: 500px; }
    .left-panel { display: grid; align-content: start; gap: 10px; background: var(--vscode-sideBar-background); }
    .center-panel { display: flex; align-items: stretch; }
    .right-panel { display: grid; align-content: start; }
    .viewer-wrap { width: 100%; height: 100%; min-height: 474px; overflow: hidden; border: 1px solid #3f3f46; border-radius: 6px; box-sizing: border-box; padding: 0; margin: 0; background: #ffffff; }
    #viewer { width: 100%; height: 100%; display: block; margin: 0; padding: 0; position: relative; }
    #viewer canvas { width: 100% !important; height: 100% !important; display: block; }
    #curve { width: 100%; height: 220px; }
    .stat { margin-bottom: 6px; }
    .controls { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
    .control-section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 8px;
      background: var(--vscode-editorWidget-background);
    }
    .control-title {
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .form-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .form-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
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
      color: var(--vscode-descriptionForeground);
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
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
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
      color: var(--vscode-foreground);
    }
    .action-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .action-row button {
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
    }
    .action-row button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .freq-list { max-height: 120px; overflow: auto; font-size: 12px; line-height: 1.45; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; }
    #mode { min-width: 0; }
    .section-title { font-weight: 600; margin-top: 8px; margin-bottom: 4px; }
    .hint { opacity: 0.8; font-size: 12px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 8px; }
    .tab-btn { border: 1px solid var(--vscode-panel-border); background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
    .tab-btn.active { background: var(--vscode-button-secondaryBackground); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .kv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .kv-table td { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; vertical-align: top; }
    .kv-table td:first-child { width: 52%; opacity: 0.95; }
    @media (max-width: 1200px) {
      .grid { grid-template-columns: 1fr; }
      .left-panel, .center-panel, .right-panel { min-height: auto; }
      .viewer-wrap { min-height: 420px; }
    }
  </style>
</head>
<body>
  <h2>Gaussian Copilot 日志可视化</h2>
  <div class="grid">
    <div class="card left-panel">
      <div class="control-section">
        <div class="control-title">渲染样式</div>
        <div class="form-grid-1">
          <div class="field">
            <label>样式</label>
            <select id="renderStyle">
              <option value="ballStick">ball+stick</option>
              <option value="stick">stick</option>
              <option value="sphere">sphere</option>
              <option value="line">line</option>
            </select>
          </div>
          <div class="field">
            <label>背景</label>
            <input id="bgColor" type="color" value="#ffffff" />
          </div>
          <div class="field">
            <label>自动缩放</label>
            <input id="autoZoom" type="checkbox" checked />
          </div>
          <div class="field">
            <label>棒半径</label>
            <input id="stickRadius" type="range" min="0.08" max="0.45" step="0.01" value="0.18" />
            <span id="stickRadiusLabel">0.18</span>
          </div>
          <div class="field">
            <label>球缩放</label>
            <input id="sphereScale" type="range" min="0.1" max="0.7" step="0.01" value="0.25" />
            <span id="sphereScaleLabel">0.25</span>
          </div>
        </div>
      </div>

      <div class="control-section">
        <div class="control-title">结构控制</div>
        <div class="field">
          <label>帧</label>
          <input id="frame" type="range" min="0" max="0" value="0" />
          <span id="frameLabel">0</span>
        </div>
        <div class="hint">提示：点击下方能量曲线的点可跳转到对应结构帧。</div>
      </div>

      <div class="control-section">
        <div class="control-title">振动控制</div>
        <div class="form-grid-1">
          <div class="field">
            <label>模式</label>
            <select id="mode"></select>
          </div>
          <div class="field">
            <label>振幅</label>
            <input id="amp" type="range" min="0.1" max="3" step="0.1" value="1" />
            <span id="ampLabel">1.0</span>
          </div>
        </div>
        <div class="action-row">
          <button id="vibStart">播放振动</button>
          <button id="vibStop">停止振动</button>
        </div>
      </div>
    </div>

    <div class="card center-panel">
      <div class="viewer-wrap"><div id="viewer"></div></div>
    </div>

    <div class="card right-panel">
      <div class="tabs">
        <button id="tabOverviewBtn" class="tab-btn active">Overview</button>
        <button id="tabThermoBtn" class="tab-btn">Thermo</button>
      </div>
      <div id="tabOverview" class="tab-panel active">
        <table class="kv-table" id="overviewTable"></table>
      </div>
      <div id="tabThermo" class="tab-panel">
        <table class="kv-table" id="thermoTable"></table>
      </div>
      <div class="section-title">频率</div>
      <div id="freqList" class="freq-list"></div>
    </div>
  </div>
  <div class="card" style="margin-top: 8px; padding: 8px;">
    <div id="curve"></div>
  </div>

  <script nonce="${nonce}" src="${threeJsUri}"></script>
  <script nonce="${nonce}" src="${echartsUri}"></script>
  <script nonce="${nonce}">
    const data = ${payload};
    const viewerCfg = Object.assign({
      backgroundColor: 'white',
      style: 'ballStick',
      stickRadius: 0.18,
      sphereScale: 0.25,
      vibrationFps: 10,
      maxDisplayedFrequencies: 180,
      autoZoomOnFrameChange: true,
    }, data.viewer || {});
    const viewer = $3Dmol.createViewer('viewer', {
      backgroundColor: viewerCfg.backgroundColor || 'white'
    });
    const frameSlider = document.getElementById('frame');
    const frameLabel = document.getElementById('frameLabel');
    const modeSelect = document.getElementById('mode');
    const ampSlider = document.getElementById('amp');
    const ampLabel = document.getElementById('ampLabel');
    const vibStart = document.getElementById('vibStart');
    const vibStop = document.getElementById('vibStop');
    const tabOverviewBtn = document.getElementById('tabOverviewBtn');
    const tabThermoBtn = document.getElementById('tabThermoBtn');
    const tabOverview = document.getElementById('tabOverview');
    const tabThermo = document.getElementById('tabThermo');
    const overviewTable = document.getElementById('overviewTable');
    const thermoTable = document.getElementById('thermoTable');
    const renderStyle = document.getElementById('renderStyle');
    const bgColor = document.getElementById('bgColor');
    const autoZoom = document.getElementById('autoZoom');
    const stickRadius = document.getElementById('stickRadius');
    const sphereScale = document.getElementById('sphereScale');
    const stickRadiusLabel = document.getElementById('stickRadiusLabel');
    const sphereScaleLabel = document.getElementById('sphereScaleLabel');
    frameSlider.max = String(Math.max(data.frameXyz.length - 1, 0));
    let vibTimer = null;
    let phase = 0;
    let frameRenderScheduled = false;
    let pendingFrameIndex = 0;

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

    function renderXyz(xyz, keepView) {
      viewer.clear();
      viewer.addModel(xyz, 'xyz');
      const style = viewerCfg.style || 'ballStick';
      const stickRadius = Number(viewerCfg.stickRadius ?? 0.18);
      const sphereScale = Number(viewerCfg.sphereScale ?? 0.25);
      if (style === 'stick') {
        viewer.setStyle({}, { stick: { radius: stickRadius } });
      } else if (style === 'sphere') {
        viewer.setStyle({}, { sphere: { scale: sphereScale } });
      } else if (style === 'line') {
        viewer.setStyle({}, { line: { linewidth: 1.2 } });
      } else {
        viewer.setStyle({}, { stick: { radius: stickRadius }, sphere: { scale: sphereScale } });
      }

      if (!keepView && viewerCfg.autoZoomOnFrameChange !== false) {
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
      autoZoom.checked = viewerCfg.autoZoomOnFrameChange !== false;
      stickRadius.value = String(viewerCfg.stickRadius ?? 0.18);
      sphereScale.value = String(viewerCfg.sphereScale ?? 0.25);
      stickRadiusLabel.textContent = Number(stickRadius.value).toFixed(2);
      sphereScaleLabel.textContent = Number(sphereScale.value).toFixed(2);
    }

    function applyStyleChangesFromControls() {
      viewerCfg.style = renderStyle.value;
      viewerCfg.backgroundColor = bgColor.value;
      viewerCfg.autoZoomOnFrameChange = autoZoom.checked;
      viewerCfg.stickRadius = Number(stickRadius.value);
      viewerCfg.sphereScale = Number(sphereScale.value);
      viewer.setBackgroundColor(viewerCfg.backgroundColor || 'white');
      stopVibration();
      requestRenderFrame(Number(frameSlider.value));
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
      tabOverviewBtn.classList.toggle('active', overviewActive);
      tabThermoBtn.classList.toggle('active', !overviewActive);
      tabOverview.classList.toggle('active', overviewActive);
      tabThermo.classList.toggle('active', !overviewActive);
    }

    function renderFrame(index) {
      const xyz = data.frameXyz[index] || '0\\nempty\\n';
      renderXyz(xyz, false);
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
    autoZoom.addEventListener('change', applyStyleChangesFromControls);
    stickRadius.addEventListener('input', () => {
      stickRadiusLabel.textContent = Number(stickRadius.value).toFixed(2);
      applyStyleChangesFromControls();
    });
    sphereScale.addEventListener('input', () => {
      sphereScaleLabel.textContent = Number(sphereScale.value).toFixed(2);
      applyStyleChangesFromControls();
    });

    function stopVibration() {
      if (vibTimer) {
        clearInterval(vibTimer);
        vibTimer = null;
      }
    }

    function startVibration() {
      stopVibration();
      const modeIndex = Number(modeSelect.value);
      const mode = data.frequencies[modeIndex];
      if (!mode || !mode.vectors || !mode.vectors.length || !data.baseAtoms || !data.baseAtoms.length) {
        return;
      }

      const amplitude = Number(ampSlider.value);
      const baseAtoms = data.baseAtoms;
      phase = 0;
      const fps = Math.max(2, Number(viewerCfg.vibrationFps || 10));
      const intervalMs = Math.round(1000 / fps);
      vibTimer = setInterval(() => {
        phase += 0.2;
        const scale = Math.sin(phase) * amplitude;
        const moved = baseAtoms.map((atom, idx) => {
          const vec = mode.vectors[idx] || { x: 0, y: 0, z: 0 };
          return {
            atomicNumber: atom.atomicNumber,
            x: atom.x + vec.x * scale,
            y: atom.y + vec.y * scale,
            z: atom.z + vec.z * scale,
          };
        });
        renderXyz(xyzFromAtoms(moved), true);
      }, intervalMs);
    }

    vibStart.addEventListener('click', startVibration);
    vibStop.addEventListener('click', () => {
      stopVibration();
      renderFrame(Number(frameSlider.value));
    });

    renderOverview();
    renderThermo();

    tabOverviewBtn.addEventListener('click', () => switchTab('overview'));
    tabThermoBtn.addEventListener('click', () => switchTab('thermo'));

    const maxFreq = Math.max(20, Number(viewerCfg.maxDisplayedFrequencies || 180));
    document.getElementById('freqList').innerHTML = (data.frequencies || []).slice(0, maxFreq)
      .map((f, idx) => '<div>mode ' + idx + ': ' + f.value + ' cm⁻¹</div>')
      .join('') || '未解析到频率';

    modeSelect.innerHTML = (data.frequencies || []).slice(0, maxFreq)
      .map((f, idx) => '<option value="' + idx + '">mode ' + idx + ' (' + f.value + ' cm⁻¹)</option>')
      .join('');

    if (!modeSelect.innerHTML) {
      modeSelect.innerHTML = '<option value="">无可用模式</option>';
      vibStart.disabled = true;
      vibStop.disabled = true;
    } else {
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

    const sampled = samplePoints(opt, 900);
    const relativeData = sampled.map((item) => ({
      value: [item.point.index, (item.point.energy - minEnergy) * 627.509],
      absEnergy: item.point.energy,
      sourceIndex: item.sourceIndex,
    }));

    chart.setOption({
      textStyle: { color: fg },
      title: { text: '能量变化曲线', left: 'center', top: 6, textStyle: { color: fg, fontSize: 20, fontWeight: 600 } },
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
      series: [
        { name: 'Energy', type: 'line', smooth: false, showSymbol: true, symbolSize: 3, data: relativeData }
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

    syncStyleControlsFromConfig();
    requestRenderFrame(0);
    setTimeout(() => {
      viewer.resize();
      viewer.zoomTo();
      viewer.render();
    }, 0);

    setTimeout(() => {
      viewer.resize();
      viewer.zoomTo();
      viewer.render();
    }, 120);

    window.addEventListener('resize', () => {
      viewer.resize();
      viewer.zoomTo();
      viewer.render();
    });

    window.addEventListener('beforeunload', () => {
      stopVibration();
    });
  </script>
</body>
</html>`;
}
