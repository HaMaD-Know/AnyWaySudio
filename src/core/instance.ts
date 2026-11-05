import { Value, cloneValue, v3, cf, c3u8, str, bool, f32, en, CF, Vec3 } from './types';

let nextId = 1;

export type ChangeKind = 'prop' | 'added' | 'removed';
export type Listener = (kind: ChangeKind, inst: Instance, prop?: string) => void;

export class Instance {
  id = nextId++;
  className: string;
  props: Map<string, Value> = new Map();
  children: Instance[] = [];
  parent: Instance | null = null;
  model: DataModel | null = null;
  isService = false;

  constructor(className: string, name?: string) {
    this.className = className;
    this.props.set('Name', str(name ?? className));
  }

  get name(): string {
    const n = this.props.get('Name');
    return n && n.t === 'String' ? n.v : this.className;
  }
  set name(v: string) { this.set('Name', str(v)); }

  get(prop: string): Value | undefined { return this.props.get(prop); }

  set(prop: string, value: Value) {
    this.props.set(prop, value);
    this.model?.emit('prop', this, prop);
  }

  setParent(p: Instance | null) {
    if (p === this.parent) return;
    if (p && (p === this || p.isDescendantOf(this))) throw new Error('Cannot parent an instance to itself or a descendant');
    const oldModel = this.model;
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    if (oldModel) oldModel.emitTree('removed', this);
    this.parent = p;
    if (p) {
      p.children.push(this);
      const m = p.model;
      this.walk(d => { d.model = m; });
      if (m) m.emitTree('added', this);
    } else {
      this.walk(d => { d.model = null; });
    }
  }

  destroy() { this.setParent(null); }

  isDescendantOf(a: Instance): boolean {
    let p = this.parent;
    while (p) { if (p === a) return true; p = p.parent; }
    return false;
  }

  walk(fn: (i: Instance) => void) {
    fn(this);
    for (const c of this.children.slice()) c.walk(fn);
  }

  descendants(): Instance[] {
    const out: Instance[] = [];
    for (const c of this.children) c.walk(d => out.push(d));
    return out;
  }

  findFirstChild(name: string): Instance | undefined {
    return this.children.find(c => c.name === name);
  }

  fullName(): string {
    const parts: string[] = [];
    let p: Instance | null = this;
    while (p && p.className !== 'DataModel') { parts.unshift(p.name); p = p.parent; }
    return parts.join('.');
  }

  /** Deep clone (not parented). Ref properties pointing inside the clone are remapped. */
  clone(): Instance {
    const map = new Map<Instance, Instance>();
    const copy = (src: Instance): Instance => {
      const c = new Instance(src.className);
      c.isService = src.isService;
      for (const [k, v] of src.props) c.props.set(k, cloneValue(v));
      map.set(src, c);
      for (const ch of src.children) {
        const cc = copy(ch);
        cc.parent = c;
        c.children.push(cc);
      }
      return c;
    };
    const root = copy(this);
    const byOldId = new Map<number, Instance>();
    for (const [o, n] of map) byOldId.set(o.id, n);
    root.walk(i => {
      for (const [k, v] of i.props) {
        if (v.t === 'Ref' && v.id != null) {
          const n = byOldId.get(v.id);
          if (n) i.props.set(k, { t: 'Ref', id: n.id });
        }
      }
    });
    return root;
  }

  isA(cls: string): boolean { return isA(this.className, cls); }
}

export class DataModel extends Instance {
  listeners = new Set<Listener>();
  constructor() {
    super('DataModel', 'Game');
    this.model = this;
  }
  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind: ChangeKind, inst: Instance, prop?: string) {
    for (const l of this.listeners) l(kind, inst, prop);
  }
  emitTree(kind: ChangeKind, inst: Instance) {
    inst.walk(d => this.emit(kind, d));
  }
  service(name: string): Instance {
    let s = this.children.find(c => c.className === name);
    if (!s) {
      s = new Instance(name);
      s.isService = true;
      s.setParent(this);
    }
    return s;
  }
  get workspace() { return this.service('Workspace'); }
  byId(id: number): Instance | undefined {
    let found: Instance | undefined;
    this.walk(i => { if (i.id === id) found = i; });
    return found;
  }
  /** Clone the whole place into a fresh DataModel (used for play-testing & undo). */
  cloneModel(): DataModel {
    const dm = new DataModel();
    for (const c of this.children) {
      const cc = c.clone();
      cc.parent = dm;
      dm.children.push(cc);
    }
    dm.walk(i => { i.model = dm; });
    return dm;
  }
}

// ---------- class hierarchy (subset) ----------
const SUPER: Record<string, string> = {
  Part: 'FormFactorPart', WedgePart: 'FormFactorPart', CornerWedgePart: 'BasePart', TrussPart: 'BasePart',
  FormFactorPart: 'BasePart', SpawnLocation: 'Part', Seat: 'Part', VehicleSeat: 'BasePart', SkateboardPlatform: 'Part',
  MeshPart: 'TriangleMeshPart', UnionOperation: 'PartOperation', NegateOperation: 'PartOperation', PartOperation: 'TriangleMeshPart',
  TriangleMeshPart: 'BasePart', BasePart: 'PVInstance', Model: 'PVInstance', Workspace: 'Model', PVInstance: 'Instance',
  Script: 'BaseScript', LocalScript: 'Script', BaseScript: 'LuaSourceContainer', ModuleScript: 'LuaSourceContainer', LuaSourceContainer: 'Instance',
  IntValue: 'ValueBase', NumberValue: 'ValueBase', StringValue: 'ValueBase', BoolValue: 'ValueBase', ObjectValue: 'ValueBase', ValueBase: 'Instance',
  PointLight: 'Light', SpotLight: 'Light', SurfaceLight: 'Light', Light: 'Instance',
  Decal: 'FaceInstance', Texture: 'Decal', FaceInstance: 'Instance',
  Folder: 'Instance', Humanoid: 'Instance', ClickDetector: 'Instance', Configuration: 'Instance',
};
export function isA(cls: string, target: string): boolean {
  let c: string | undefined = cls;
  while (c) { if (c === target) return true; c = SUPER[c]; }
  return target === 'Instance';
}

export const PART_CLASSES = ['Part', 'SpawnLocation', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'Seat', 'VehicleSeat', 'MeshPart', 'UnionOperation', 'SkateboardPlatform'];
export const isPart = (i: Instance) => isA(i.className, 'BasePart');
export const isScript = (i: Instance) => isA(i.className, 'LuaSourceContainer');

// ---------- Part helpers (handles both serialized & canonical names) ----------
export function getSize(i: Instance): Vec3 {
  const s = i.get('size') ?? i.get('Size');
  return s && s.t === 'Vector3' ? s : v3(4, 1, 2);
}
export function setSize(i: Instance, s: Vec3) {
  i.props.delete('Size');
  i.set('size', s);
}
export function getCF(i: Instance): CF {
  const c = i.get('CFrame');
  return c && c.t === 'CFrame' ? c : cf(0, 0, 0);
}
export function getColor(i: Instance): [number, number, number] {
  const c = i.get('Color3uint8') ?? i.get('Color');
  if (c?.t === 'Color3uint8') return [c.r / 255, c.g / 255, c.b / 255];
  if (c?.t === 'Color3') return [c.r, c.g, c.b];
  const b = i.get('BrickColor');
  if (b?.t === 'BrickColor' || b?.t === 'Int32') return brickToRGB(b.v);
  return [163 / 255, 162 / 255, 165 / 255];
}
export function getNum(i: Instance, p: string, d = 0): number {
  const v = i.get(p);
  if (!v) return d;
  if (v.t === 'Float32' || v.t === 'Float64' || v.t === 'Int32' || v.t === 'Enum') return v.v;
  if (v.t === 'Int64') return Number(v.v);
  return d;
}
export function getBool(i: Instance, p: string, d = false): boolean {
  const v = i.get(p);
  return v && v.t === 'Bool' ? v.v : d;
}
export function getStr(i: Instance, p: string, d = ''): string {
  const v = i.get(p);
  if (!v) return d;
  if (v.t === 'String') return v.v;
  if (v.t === 'Bytes' || v.t === 'SharedString') return new TextDecoder().decode(v.v);
  return d;
}
export function getShape(i: Instance): number {
  if (i.className === 'WedgePart') return 3;
  if (i.className === 'CornerWedgePart') return 4;
  return getNum(i, 'shape', getNum(i, 'Shape', 1));
}

const BRICK: Record<number, [number, number, number]> = {
  1: [242, 243, 243], 5: [215, 197, 154], 21: [196, 40, 28], 23: [13, 105, 172], 24: [245, 205, 48], 26: [27, 42, 53],
  28: [40, 127, 71], 37: [75, 151, 75], 194: [163, 162, 165], 199: [99, 95, 98], 1001: [248, 248, 248], 1003: [17, 17, 17],
  1004: [255, 0, 0], 1009: [255, 255, 0], 1010: [0, 0, 255], 1020: [0, 255, 0], 1032: [255, 0, 191], 192: [105, 64, 40], 106: [218, 133, 65],
};
export function brickToRGB(n: number): [number, number, number] {
  const c = BRICK[n] ?? BRICK[194];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

// ---------- factory with sensible defaults ----------
export function createInstance(className: string): Instance {
  const i = new Instance(className);
  if (isA(className, 'BasePart')) {
    i.props.set('Anchored', bool(false));
    i.props.set('CanCollide', bool(true));
    i.props.set('CFrame', cf(0, 0.5, 0));
    i.props.set('size', className === 'SpawnLocation' ? v3(12, 1, 12) : className === 'Seat' ? v3(2, 1, 2) : v3(4, 1, 2));
    i.props.set('Color3uint8', className === 'SpawnLocation' ? c3u8(70, 70, 70) : c3u8(163, 162, 165));
    i.props.set('Material', en(256));
    i.props.set('Transparency', f32(0));
    i.props.set('Reflectance', f32(0));
    i.props.set('Locked', bool(false));
    i.props.set('CastShadow', bool(true));
    if (className === 'Part' || className === 'SpawnLocation' || className === 'Seat') i.props.set('shape', en(1));
    if (className === 'SpawnLocation') {
      i.props.set('Anchored', bool(true));
      i.props.set('Duration', { t: 'Int32', v: 0 });
    }
  } else if (isA(className, 'LuaSourceContainer')) {
    const src = className === 'ModuleScript'
      ? 'local module = {}\n\nreturn module\n'
      : 'print("Hello world!")\n';
    i.props.set('Source', str(src));
    if (className !== 'ModuleScript') i.props.set('Disabled', bool(false));
  } else if (className === 'IntValue') i.props.set('Value', { t: 'Int64', v: 0n });
  else if (className === 'NumberValue') i.props.set('Value', { t: 'Float64', v: 0 });
  else if (className === 'StringValue') i.props.set('Value', str(''));
  else if (className === 'BoolValue') i.props.set('Value', bool(false));
  else if (className === 'PointLight' || className === 'SpotLight' || className === 'SurfaceLight') {
    i.props.set('Brightness', f32(1));
    i.props.set('Range', f32(16));
    i.props.set('Color', { t: 'Color3', r: 1, g: 1, b: 1 });
    i.props.set('Enabled', bool(true));
  } else if (className === 'Humanoid') {
    i.props.set('Health', f32(100));
    i.props.set('MaxHealth', f32(100));
    i.props.set('WalkSpeed', f32(16));
    i.props.set('JumpPower', f32(50));
  } else if (className === 'ClickDetector') {
    i.props.set('MaxActivationDistance', f32(32));
  }
  return i;
}

export const SERVICES = ['Workspace', 'Players', 'Lighting', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Teams', 'SoundService'];

export function newPlace(template: 'baseplate' | 'flat' | 'obby' = 'baseplate'): DataModel {
  const dm = new DataModel();
  for (const s of SERVICES) dm.service(s);
  const ws = dm.workspace;
  const light = dm.service('Lighting');
  light.props.set('Ambient', { t: 'Color3', r: 0.27, g: 0.27, b: 0.3 });
  light.props.set('ClockTime', f32(14));
  light.props.set('Brightness', f32(2));
  const sp = dm.service('StarterPlayer');
  sp.props.set('CharacterWalkSpeed', f32(16));
  sp.props.set('CharacterJumpPower', f32(50));

  const base = createInstance('Part');
  base.name = 'Baseplate';
  base.props.set('Anchored', bool(true));
  base.props.set('Locked', bool(true));
  base.props.set('size', v3(512, 16, 512));
  base.props.set('CFrame', cf(0, -8, 0));
  base.props.set('Color3uint8', template === 'flat' ? c3u8(75, 151, 75) : c3u8(91, 93, 105));
  if (template === 'flat') base.props.set('Material', en(1280));
  base.setParent(ws);

  const spawn = createInstance('SpawnLocation');
  spawn.props.set('CFrame', cf(0, 0.5, 0));
  spawn.setParent(ws);

  if (template === 'obby') {
    const colors: [number, number, number][] = [[255, 89, 89], [255, 176, 0], [255, 255, 0], [0, 255, 120], [0, 170, 255], [170, 85, 255]];
    for (let k = 0; k < 8; k++) {
      const p = createInstance('Part');
      p.name = 'Stage' + (k + 1);
      p.props.set('Anchored', bool(true));
      p.props.set('size', v3(6, 1, 6));
      p.props.set('CFrame', cf(0, 2 + k * 2.5, -14 - k * 10));
      const c = colors[k % colors.length];
      p.props.set('Color3uint8', c3u8(c[0], c[1], c[2]));
      p.setParent(ws);
    }
    const lava = createInstance('Part');
    lava.name = 'KillBrick';
    lava.props.set('Anchored', bool(true));
    lava.props.set('size', v3(30, 1, 90));
    lava.props.set('CFrame', cf(0, 0.6, -50));
    lava.props.set('Color3uint8', c3u8(255, 60, 0));
    lava.props.set('Material', en(288));
    lava.setParent(ws);
    const s = createInstance('Script');
    s.props.set('Source', str(KILL_SCRIPT));
    s.setParent(lava);
  }
  return dm;
}

export const KILL_SCRIPT = `-- Touching this part resets the player
local part = script.Parent

part.Touched:Connect(function(hit)
\tlocal humanoid = hit.Parent:FindFirstChild("Humanoid")
\tif humanoid then
\t\thumanoid.Health = 0
\tend
end)
`;

export type { CF, Vec3 };
