import type { App } from '../editor/app';
import { Instance, isPart, getCF, getSize, getColor, getNum, getShape, setSize } from '../core/instance';
import { Value, c3ToHex, hexToC3u8, eulerToMatrix, matrixToEuler, cf } from '../core/types';
import { MATERIALS } from '../editor/materials';
import { isScript } from '../core/instance';

const HIDE = new Set(['Name', 'CFrame', 'size', 'Size', 'Color3uint8', 'Color', 'BrickColor', 'Material', 'shape', 'Shape', 'Transparency', 'Anchored', 'CanCollide', 'Source', 'Reflectance', 'CastShadow', 'Locked']);
const SHAPES = ['Ball', 'Block', 'Cylinder'];

export class Properties {
  private raf = 0;
  constructor(private app: App, private el: HTMLElement) {
    el.addEventListener('change', e => this.onChange(e));
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-open-script]');
      if (b && this.app.primary) this.app.scriptEditor.open(this.app.primary);
    });
  }

  /** light=true: only refresh numeric fields (during gizmo drags) */
  render(light = false) {
    if (light) { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.refreshValues()); return; }
    const i = this.app.primary;
    if (!i) { this.el.innerHTML = `<div class="empty-hint">Select an object in the 3D view or Explorer to edit its properties.</div>`; return; }
    const rows: string[] = [];
    const group = (title: string) => rows.push(`<div class="pgroup">${title}</div>`);
    const row = (label: string, input: string) => rows.push(`<label class="prow"><span>${label}</span>${input}</label>`);
    const ro = this.app.play !== null;
    const dis = ro ? 'disabled' : '';
    group('Data');
    row('Name', `<input data-p="Name" value="${attr(i.name)}" ${i.isService || ro ? 'disabled' : ''}/>`);
    row('ClassName', `<input value="${attr(i.className)}" disabled/>`);
    row('Parent', `<input value="${attr(i.parent?.name ?? 'nil')}" disabled/>`);
    if (isScript(i)) rows.push(`<button class="wide" data-open-script="1">Edit Script</button>`);
    if (isPart(i)) {
      const c = getCF(i), s = getSize(i), o = matrixToEuler(c.r);
      group('Transform');
      row('Position', vec('Position', c.p, dis));
      row('Orientation', vec('Orientation', o, dis));
      row('Size', vec('Size', [s.x, s.y, s.z], dis));
      group('Appearance');
      const [r, g, b] = getColor(i);
      row('Color', `<input type="color" data-p="Color" value="${c3ToHex({ t: 'Color3', r, g, b })}" ${dis}/>`);
      const mat = getNum(i, 'Material', 256);
      row('Material', `<select data-p="Material" ${dis}>${MATERIALS.map(([n, v]) => `<option value="${v}" ${v === mat ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
      if (i.className === 'Part' || i.className === 'SpawnLocation') {
        const sh = getShape(i);
        row('Shape', `<select data-p="Shape" ${dis}>${SHAPES.map((n, k) => `<option value="${k}" ${k === sh ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
      }
      row('Transparency', `<input type="number" step="0.1" min="0" max="1" data-p="Transparency" value="${fmt(getNum(i, 'Transparency', 0))}" ${dis}/>`);
      row('Reflectance', `<input type="number" step="0.1" min="0" max="1" data-p="Reflectance" value="${fmt(getNum(i, 'Reflectance', 0))}" ${dis}/>`);
      row('CastShadow', check('CastShadow', i, true, dis));
      group('Behavior');
      row('Anchored', check('Anchored', i, false, dis));
      row('CanCollide', check('CanCollide', i, true, dis));
      row('Locked', check('Locked', i, false, dis));
    }
    const other = [...i.props.entries()].filter(([k]) => !HIDE.has(k)).sort((a, b) => a[0].localeCompare(b[0]));
    if (other.length) {
      group(isPart(i) ? 'Other' : 'Properties');
      for (const [k, v] of other) row(k, editorFor(k, v, dis));
    }
    this.el.innerHTML = rows.join('');
  }

  private refreshValues() {
    const i = this.app.primary;
    if (!i || !isPart(i)) return;
    const c = getCF(i), s = getSize(i), o = matrixToEuler(c.r);
    const set = (p: string, v: number[]) => v.forEach((n, k) => { const el = this.el.querySelector<HTMLInputElement>(`[data-p="${p}"][data-k="${k}"]`); if (el && document.activeElement !== el) el.value = fmt(n); });
    set('Position', c.p); set('Orientation', o); set('Size', [s.x, s.y, s.z]);
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    const p = t.dataset.p;
    const i = this.app.primary;
    if (!p || !i) return;
    const apply = (inst: Instance) => this.applyTo(inst, p, t);
    // apply to all selected objects of a compatible kind
    for (const s of this.app.selection) if (s === i || (isPart(s) && isPart(i)) || s.className === i.className) apply(s);
    this.app.commit();
    this.app.attachGizmo();
    if (p === 'Name') this.app.explorer.render();
  }

  private applyTo(i: Instance, p: string, t: HTMLInputElement) {
    const vecVal = () => [0, 1, 2].map(k => Number(this.el.querySelector<HTMLInputElement>(`[data-p="${p}"][data-k="${k}"]`)?.value) || 0) as [number, number, number];
    switch (p) {
      case 'Name': i.name = t.value; return;
      case 'Position': { const c = getCF(i); const v = vecVal(); i.set('CFrame', cf(v[0], v[1], v[2], c.r)); return; }
      case 'Orientation': { const c = getCF(i); const v = vecVal(); i.set('CFrame', cf(c.p[0], c.p[1], c.p[2], eulerToMatrix(v[0], v[1], v[2]))); return; }
      case 'Size': { const v = vecVal().map(n => Math.max(0.05, n)); setSize(i, { t: 'Vector3', x: v[0], y: v[1], z: v[2] }); return; }
      case 'Color': i.props.delete('BrickColor'); i.props.delete('Color'); i.set('Color3uint8', hexToC3u8(t.value)); return;
      case 'Material': i.set('Material', { t: 'Enum', v: Number(t.value) }); return;
      case 'Shape': i.props.delete('Shape'); i.set('shape', { t: 'Enum', v: Number(t.value) }); return;
      case 'Transparency': case 'Reflectance': i.set(p, { t: 'Float32', v: Math.max(0, Math.min(1, Number(t.value) || 0)) }); return;
      case 'Anchored': case 'CanCollide': case 'CastShadow': case 'Locked': i.set(p, { t: 'Bool', v: t.checked }); return;
    }
    // generic
    const old = i.get(p);
    if (!old) return;
    const k = t.dataset.k;
    const nv = genericValue(old, t, k, this.el, p);
    if (nv) i.set(p, nv);
  }
}

function genericValue(old: Value, t: HTMLInputElement, k: string | undefined, root: HTMLElement, p: string): Value | null {
  const n = Number(t.value);
  switch (old.t) {
    case 'String': return { t: 'String', v: t.value };
    case 'Bool': return { t: 'Bool', v: t.checked };
    case 'Int32': return { t: 'Int32', v: Math.trunc(n) || 0 };
    case 'Int64': return { t: 'Int64', v: BigInt(Math.trunc(n) || 0) };
    case 'Float32': case 'Float64': return { t: old.t, v: n || 0 };
    case 'Enum': return { t: 'Enum', v: Math.max(0, Math.trunc(n) || 0) };
    case 'BrickColor': return { t: 'BrickColor', v: Math.trunc(n) || 194 };
    case 'Color3': { const c = hexToC3u8(t.value); return { t: 'Color3', r: c.r / 255, g: c.g / 255, b: c.b / 255 }; }
    case 'Color3uint8': return hexToC3u8(t.value);
    case 'Vector3': {
      void k;
      const v = [0, 1, 2].map(j => Number(root.querySelector<HTMLInputElement>(`[data-p="${p}"][data-k="${j}"]`)?.value) || 0);
      return { t: 'Vector3', x: v[0], y: v[1], z: v[2] };
    }
  }
  return null;
}

function editorFor(k: string, v: Value, dis: string): string {
  switch (v.t) {
    case 'String': return v.v.length > 60 || v.v.includes('\n') ? `<textarea data-p="${attr(k)}" rows="3" ${dis}>${esc(v.v)}</textarea>` : `<input data-p="${attr(k)}" value="${attr(v.v)}" ${dis}/>`;
    case 'Bool': return `<input type="checkbox" data-p="${attr(k)}" ${v.v ? 'checked' : ''} ${dis}/>`;
    case 'Int32': case 'Float32': case 'Float64': case 'Enum': case 'BrickColor': return `<input type="number" step="any" data-p="${attr(k)}" value="${fmt(v.v)}" ${dis}/>`;
    case 'Int64': return `<input type="number" data-p="${attr(k)}" value="${v.v}" ${dis}/>`;
    case 'Color3': case 'Color3uint8': return `<input type="color" data-p="${attr(k)}" value="${c3ToHex(v)}" ${dis}/>`;
    case 'Vector3': return vec(k, [v.x, v.y, v.z], dis);
    case 'Ref': return `<input value="${v.id == null ? 'nil' : 'Ref'}" disabled/>`;
    case 'CFrame': return `<input value="${v.p.map(fmt).join(', ')}" disabled/>`;
    default: return `<input value="${attr(v.t)}" disabled/>`;
  }
}

function vec(p: string, v: number[], dis: string) {
  return `<span class="vec">${v.map((n, k) => `<input type="number" step="any" data-p="${attr(p)}" data-k="${k}" value="${fmt(n)}" ${dis}/>`).join('')}</span>`;
}
function check(p: string, i: Instance, d: boolean, dis: string) {
  const v = i.get(p);
  const on = v && v.t === 'Bool' ? v.v : d;
  return `<input type="checkbox" data-p="${p}" ${on ? 'checked' : ''} ${dis}/>`;
}
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
