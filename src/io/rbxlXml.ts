// Reader / writer for the XML place format (.rbxlx / .rbxmx).
import { DataModel, Instance } from '../core/instance';
import { Value, CF } from '../core/types';

const CF_KEYS = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];

function kids(el: Element, tag?: string): Element[] {
  return Array.from(el.children).filter(c => !tag || c.tagName === tag);
}
function num(el: Element, tag: string, d = 0): number {
  const c = kids(el, tag)[0];
  return c ? parseFloat(c.textContent || '0') : d;
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function parseCF(el: Element): CF {
  const v = CF_KEYS.map(k => num(el, k, k[0] === 'R' && k[1] === k[2] ? 1 : 0));
  return { t: 'CFrame', p: [v[0], v[1], v[2]], r: v.slice(3) };
}

function parseProp(el: Element, sstr: Map<string, Uint8Array>): Value | null {
  const txt = el.textContent ?? '';
  switch (el.tagName) {
    case 'string': case 'ProtectedString': case 'Content': case 'ContentId': return { t: 'String', v: kids(el, 'url')[0]?.textContent ?? txt };
    case 'BinaryString': return { t: 'Bytes', v: b64ToBytes(txt) };
    case 'bool': return { t: 'Bool', v: txt.trim() === 'true' };
    case 'int': return { t: 'Int32', v: parseInt(txt) | 0 };
    case 'int64': return { t: 'Int64', v: BigInt(txt.trim() || '0') };
    case 'float': return { t: 'Float32', v: parseFloat(txt) };
    case 'double': return { t: 'Float64', v: parseFloat(txt) };
    case 'token': return { t: 'Enum', v: parseInt(txt) >>> 0 };
    case 'BrickColor': return { t: 'BrickColor', v: parseInt(txt) };
    case 'Vector3': return { t: 'Vector3', x: num(el, 'X'), y: num(el, 'Y'), z: num(el, 'Z') };
    case 'Vector2': return { t: 'Vector2', x: num(el, 'X'), y: num(el, 'Y') };
    case 'Vector3int16': return { t: 'Vector3int16', x: num(el, 'X'), y: num(el, 'Y'), z: num(el, 'Z') };
    case 'Color3': return kids(el).length ? { t: 'Color3', r: num(el, 'R'), g: num(el, 'G'), b: num(el, 'B') } : (() => { const n = parseInt(txt) >>> 0; return { t: 'Color3', r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 } as Value; })();
    case 'Color3uint8': { const n = parseInt(txt) >>> 0; return { t: 'Color3uint8', r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
    case 'CoordinateFrame': return parseCF(el);
    case 'OptionalCoordinateFrame': { const c = kids(el, 'CFrame')[0]; return { t: 'OptionalCFrame', v: c ? parseCF(c) : null }; }
    case 'UDim': return { t: 'UDim', s: num(el, 'S'), o: num(el, 'O') };
    case 'UDim2': return { t: 'UDim2', xs: num(el, 'XS'), xo: num(el, 'XO'), ys: num(el, 'YS'), yo: num(el, 'YO') };
    case 'NumberRange': { const [a, b] = txt.trim().split(/\s+/).map(Number); return { t: 'NumberRange', min: a || 0, max: b || 0 }; }
    case 'NumberSequence': { const n = txt.trim().split(/\s+/).map(Number); const k: [number, number, number][] = []; for (let i = 0; i + 2 < n.length; i += 3) k.push([n[i], n[i + 1], n[i + 2]]); return { t: 'NumberSequence', k }; }
    case 'ColorSequence': { const n = txt.trim().split(/\s+/).map(Number); const k: [number, number, number, number, number][] = []; for (let i = 0; i + 4 < n.length; i += 5) k.push([n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4]]); return { t: 'ColorSequence', k }; }
    case 'Rect2D': { const mn = kids(el, 'min')[0], mx = kids(el, 'max')[0]; return { t: 'Rect', x0: mn ? num(mn, 'X') : 0, y0: mn ? num(mn, 'Y') : 0, x1: mx ? num(mx, 'X') : 0, y1: mx ? num(mx, 'Y') : 0 }; }
    case 'Faces': return { t: 'Faces', v: parseInt(kids(el, 'faces')[0]?.textContent ?? '0') };
    case 'Axes': return { t: 'Axes', v: parseInt(kids(el, 'axes')[0]?.textContent ?? '0') };
    case 'PhysicalProperties': {
      const custom = kids(el, 'CustomPhysics')[0]?.textContent === 'true';
      return custom ? { t: 'PhysicalProperties', custom, d: num(el, 'Density'), f: num(el, 'Friction'), e: num(el, 'Elasticity'), fw: num(el, 'FrictionWeight'), ew: num(el, 'ElasticityWeight') } : { t: 'PhysicalProperties', custom: false };
    }
    case 'SharedString': return { t: 'SharedString', v: sstr.get(txt.trim()) ?? new Uint8Array() };
    case 'UniqueId': return { t: 'UniqueId', hex: txt.trim() };
    case 'Font': return { t: 'Font', family: kids(el, 'Family')[0]?.textContent?.trim() ?? '', weight: num(el, 'Weight', 400), style: kids(el, 'Style')[0]?.textContent === 'Italic' ? 1 : 0, cached: kids(el, 'CachedFaceId')[0]?.textContent?.trim() ?? '' };
    case 'Ref': return { t: 'Ref', id: null }; // resolved later
    case 'SecurityCapabilities': return { t: 'SecurityCapabilities', v: BigInt(txt.trim() || '0') };
    default: return null;
  }
}

export function readXmlPlace(text: string): { model: DataModel; warnings: string[] } {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'roblox') throw new Error('Not an XML place file');
  const warnings = new Set<string>();
  const sstr = new Map<string, Uint8Array>();
  for (const ss of Array.from(root.getElementsByTagName('SharedString'))) {
    if (ss.parentElement?.tagName === 'SharedStrings') sstr.set(ss.getAttribute('md5') ?? '', b64ToBytes(ss.textContent ?? ''));
  }
  const byRef = new Map<string, Instance>();
  const pending: { inst: Instance; prop: string; ref: string }[] = [];
  const model = new DataModel();

  const build = (el: Element, parent: Instance) => {
    const inst = new Instance(el.getAttribute('class') ?? 'Folder');
    inst.props.clear();
    const ref = el.getAttribute('referent');
    if (ref) byRef.set(ref, inst);
    const props = kids(el, 'Properties')[0];
    if (props) for (const p of kids(props)) {
      const name = p.getAttribute('name');
      if (!name) continue;
      const v = parseProp(p, sstr);
      if (!v) { warnings.add(`Skipped ${inst.className}.${name} (${p.tagName})`); continue; }
      if (p.tagName === 'Ref') { const r = (p.textContent ?? '').trim(); if (r && r !== 'null') pending.push({ inst, prop: name, ref: r }); }
      inst.props.set(name, v);
    }
    if (!inst.props.has('Name')) inst.props.set('Name', { t: 'String', v: inst.className });
    if (parent === model && SERVICE_SET.has(inst.className)) inst.isService = true;
    inst.parent = parent;
    parent.children.push(inst);
    for (const c of kids(el, 'Item')) build(c, inst);
  };
  for (const item of kids(root, 'Item')) build(item, model);
  model.walk(i => { i.model = model; });
  for (const p of pending) { const t = byRef.get(p.ref); p.inst.props.set(p.prop, { t: 'Ref', id: t ? t.id : null }); }
  return { model, warnings: [...warnings] };
}
const SERVICE_SET = new Set(['Workspace', 'Players', 'Lighting', 'ReplicatedStorage', 'ReplicatedFirst', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Teams', 'SoundService', 'Chat', 'TextChatService', 'MaterialService', 'LocalizationService', 'TestService', 'HttpService', 'InsertService', 'CollectionService', 'PhysicsService', 'VoiceChatService']);

// ------------------------------------------------------------ writing
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n: number) => (Number.isFinite(n) ? String(Math.fround(n) === n ? n : +n.toPrecision(9)) : '0');

function cfXml(c: CF) {
  const v = [...c.p, ...c.r];
  return CF_KEYS.map((k, i) => `<${k}>${fmt(v[i])}</${k}>`).join('');
}

function propXml(name: string, v: Value, refName: (id: number | null) => string, sstrs: Map<string, string>): string | null {
  const n = `name="${esc(name)}"`;
  switch (v.t) {
    case 'String': return name === 'Source' ? `<ProtectedString ${n}><![CDATA[${v.v.replace(/]]>/g, ']]]]><![CDATA[>')}]]></ProtectedString>` : `<string ${n}>${esc(v.v)}</string>`;
    case 'Bytes': return `<BinaryString ${n}>${bytesToB64(v.v)}</BinaryString>`;
    case 'Bool': return `<bool ${n}>${v.v}</bool>`;
    case 'Int32': return `<int ${n}>${v.v}</int>`;
    case 'Int64': return `<int64 ${n}>${v.v}</int64>`;
    case 'Float32': return `<float ${n}>${fmt(v.v)}</float>`;
    case 'Float64': return `<double ${n}>${fmt(v.v)}</double>`;
    case 'Enum': return `<token ${n}>${v.v}</token>`;
    case 'BrickColor': return `<int ${n}>${v.v}</int>`;
    case 'Vector3': return `<Vector3 ${n}><X>${fmt(v.x)}</X><Y>${fmt(v.y)}</Y><Z>${fmt(v.z)}</Z></Vector3>`;
    case 'Vector2': return `<Vector2 ${n}><X>${fmt(v.x)}</X><Y>${fmt(v.y)}</Y></Vector2>`;
    case 'Vector3int16': return `<Vector3int16 ${n}><X>${v.x}</X><Y>${v.y}</Y><Z>${v.z}</Z></Vector3int16>`;
    case 'Color3': return `<Color3 ${n}><R>${fmt(v.r)}</R><G>${fmt(v.g)}</G><B>${fmt(v.b)}</B></Color3>`;
    case 'Color3uint8': return `<Color3uint8 ${n}>${(0xff000000 | (v.r << 16) | (v.g << 8) | v.b) >>> 0}</Color3uint8>`;
    case 'CFrame': return `<CoordinateFrame ${n}>${cfXml(v)}</CoordinateFrame>`;
    case 'OptionalCFrame': return `<OptionalCoordinateFrame ${n}>${v.v ? `<CFrame>${cfXml(v.v)}</CFrame>` : ''}</OptionalCoordinateFrame>`;
    case 'Ref': return `<Ref ${n}>${refName(v.id)}</Ref>`;
    case 'UDim': return `<UDim ${n}><S>${fmt(v.s)}</S><O>${v.o}</O></UDim>`;
    case 'UDim2': return `<UDim2 ${n}><XS>${fmt(v.xs)}</XS><XO>${v.xo}</XO><YS>${fmt(v.ys)}</YS><YO>${v.yo}</YO></UDim2>`;
    case 'NumberRange': return `<NumberRange ${n}>${fmt(v.min)} ${fmt(v.max)} </NumberRange>`;
    case 'NumberSequence': return `<NumberSequence ${n}>${v.k.flat().map(fmt).join(' ')} </NumberSequence>`;
    case 'ColorSequence': return `<ColorSequence ${n}>${v.k.flat().map(fmt).join(' ')} </ColorSequence>`;
    case 'Rect': return `<Rect2D ${n}><min><X>${fmt(v.x0)}</X><Y>${fmt(v.y0)}</Y></min><max><X>${fmt(v.x1)}</X><Y>${fmt(v.y1)}</Y></max></Rect2D>`;
    case 'Faces': return `<Faces ${n}><faces>${v.v}</faces></Faces>`;
    case 'Axes': return `<Axes ${n}><axes>${v.v}</axes></Axes>`;
    case 'PhysicalProperties': return v.custom
      ? `<PhysicalProperties ${n}><CustomPhysics>true</CustomPhysics><Density>${fmt(v.d)}</Density><Friction>${fmt(v.f)}</Friction><Elasticity>${fmt(v.e)}</Elasticity><FrictionWeight>${fmt(v.fw)}</FrictionWeight><ElasticityWeight>${fmt(v.ew)}</ElasticityWeight></PhysicalProperties>`
      : `<PhysicalProperties ${n}><CustomPhysics>false</CustomPhysics></PhysicalProperties>`;
    case 'SharedString': { const b64 = bytesToB64(v.v); const key = 'ss' + simpleHash(b64); sstrs.set(key, b64); return `<SharedString ${n}>${key}</SharedString>`; }
    case 'UniqueId': return `<UniqueId ${n}>${v.hex}</UniqueId>`;
    case 'Font': return `<Font ${n}><Family><url>${esc(v.family)}</url></Family><Weight>${v.weight}</Weight><Style>${v.style ? 'Italic' : 'Normal'}</Style></Font>`;
    case 'SecurityCapabilities': return `<SecurityCapabilities ${n}>${v.v}</SecurityCapabilities>`;
    default: return null;
  }
}
function simpleHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export function writeXmlPlace(model: Instance): string {
  const refs = new Map<number, string>();
  let k = 0;
  model.walk(i => { refs.set(i.id, 'RBX' + (k++).toString(16).toUpperCase().padStart(8, '0')); });
  const refName = (id: number | null) => (id != null && refs.has(id) ? refs.get(id)! : 'null');
  const sstrs = new Map<string, string>();
  const out: string[] = [];
  const emit = (i: Instance, depth: number) => {
    const pad = '\t'.repeat(depth);
    out.push(`${pad}<Item class="${esc(i.className)}" referent="${refs.get(i.id)}">`);
    out.push(`${pad}\t<Properties>`);
    for (const [name, v] of i.props) { const x = propXml(name, v, refName, sstrs); if (x) out.push(`${pad}\t\t${x}`); }
    out.push(`${pad}\t</Properties>`);
    for (const c of i.children) emit(c, depth + 1);
    out.push(`${pad}</Item>`);
  };
  for (const c of model.children) emit(c, 1);
  const ss = sstrs.size ? `\t<SharedStrings>\n${[...sstrs].map(([key, b]) => `\t\t<SharedString md5="${key}">${b}</SharedString>`).join('\n')}\n\t</SharedStrings>\n` : '';
  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n\t<External>null</External>\n\t<External>nil</External>\n${out.join('\n')}\n${ss}</roblox>\n`;
}
