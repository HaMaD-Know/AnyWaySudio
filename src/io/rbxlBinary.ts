// Reader / writer for the binary place format (.rbxl / .rbxm).
// Layout: 32-byte header, then chunks (META, SSTR, INST, PROP, PRNT, END).
import { decompress as zstdDecompress } from 'fzstd';
import { lz4Compress, lz4Decompress } from './lz4';
import { DataModel, Instance } from '../core/instance';
import { Value, CF } from '../core/types';

const MAGIC = [0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a];
const te = new TextEncoder();
const td = new TextDecoder();

export function isBinaryPlace(buf: Uint8Array) {
  return MAGIC.every((b, i) => buf[i] === b);
}

// ------------------------------------------------------------------ reading
class Reader {
  o = 0;
  dv: DataView;
  constructor(public b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str() { return td.decode(this.bytes(this.u32())); }
  rawStr() { return this.bytes(this.u32()).slice(); }
  eof() { return this.o >= this.b.length; }
  /** interleaved big-endian u32s */
  il32(n: number): Uint32Array {
    const src = this.bytes(n * 4), out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = ((src[i] << 24) | (src[n + i] << 16) | (src[2 * n + i] << 8) | src[3 * n + i]) >>> 0;
    return out;
  }
  ilI32(n: number): number[] { return Array.from(this.il32(n), u => (u >>> 1) ^ -(u & 1)); }
  ilF32(n: number): number[] {
    const u = this.il32(n), tmp = new DataView(new ArrayBuffer(4));
    return Array.from(u, x => { tmp.setUint32(0, ((x >>> 1) | (x << 31)) >>> 0); return tmp.getFloat32(0); });
  }
  ilI64(n: number): bigint[] {
    const src = this.bytes(n * 8), out: bigint[] = [];
    for (let i = 0; i < n; i++) {
      let u = 0n;
      for (let k = 0; k < 8; k++) u = (u << 8n) | BigInt(src[k * n + i]);
      out.push((u >> 1n) ^ -(u & 1n));
    }
    return out;
  }
  refs(n: number): number[] {
    const d = this.ilI32(n);
    for (let i = 1; i < n; i++) d[i] += d[i - 1];
    return d;
  }
}

function readCFrames(r: Reader, n: number): CF[] {
  const rots: number[][] = [];
  for (let i = 0; i < n; i++) {
    const id = r.u8();
    if (id === 0) { const m: number[] = []; for (let k = 0; k < 9; k++) m.push(r.f32()); rots.push(m); }
    else rots.push(specialRotation(id));
  }
  const x = r.ilF32(n), y = r.ilF32(n), z = r.ilF32(n);
  return rots.map((rot, i) => ({ t: 'CFrame', p: [x[i], y[i], z[i]], r: rot }));
}

const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
function specialRotation(id: number): number[] {
  const a = NORMALS[Math.floor((id - 1) / 6)] ?? NORMALS[0];
  const b = NORMALS[(id - 1) % 6] ?? NORMALS[1];
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // a, b, c are the columns of the matrix; return row-major
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

export type LoadReport = { warnings: string[]; instanceCount: number };

export function readBinaryPlace(buf: Uint8Array): { model: DataModel; report: LoadReport } {
  if (!isBinaryPlace(buf)) throw new Error('Not a binary place file');
  const h = new Reader(buf);
  h.o = 14;
  h.u16(); // version
  h.u32(); // class count
  h.u32(); // instance count
  h.o = 32;
  const warnings = new Set<string>();
  const classes = new Map<number, { name: string; refs: number[]; service: boolean }>();
  const insts = new Map<number, Instance>();
  const sstr: Uint8Array[] = [];
  const pendingRefs: { inst: Instance; prop: string; ref: number }[] = [];
  let parents: [number, number][] = [];

  while (!h.eof()) {
    const name = td.decode(h.bytes(4)).replace(/\0/g, '');
    const clen = h.u32(), ulen = h.u32();
    h.u32();
    let data: Uint8Array;
    if (clen === 0) data = h.bytes(ulen);
    else {
      const raw = h.bytes(clen);
      if (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) data = zstdDecompress(raw);
      else data = lz4Decompress(raw, ulen);
    }
    const r = new Reader(data);
    if (name === 'END') break;
    if (name === 'META' || name === 'SIGN') continue;
    if (name === 'SSTR') {
      r.u32();
      const count = r.u32();
      for (let i = 0; i < count; i++) { r.bytes(16); sstr.push(r.rawStr()); }
    } else if (name === 'INST') {
      const cid = r.u32();
      const cname = r.str();
      const fmt = r.u8();
      const count = r.u32();
      const refs = r.refs(count);
      classes.set(cid, { name: cname, refs, service: fmt === 1 });
      for (const ref of refs) {
        const inst = new Instance(cname);
        inst.props.clear();
        inst.isService = fmt === 1;
        insts.set(ref, inst);
      }
    } else if (name === 'PROP') {
      const cid = r.u32();
      const pname = r.str();
      const type = r.u8();
      const cls = classes.get(cid);
      if (!cls) continue;
      const n = cls.refs.length;
      let vals: (Value | null)[];
      try {
        vals = readValues(r, type, n, sstr);
      } catch (e) {
        warnings.add(`Skipped property ${cls.name}.${pname} (type 0x${type.toString(16)})`);
        continue;
      }
      vals.forEach((v, i) => {
        const inst = insts.get(cls.refs[i])!;
        if (!v) return;
        if (v.t === 'Ref' && v.id != null) pendingRefs.push({ inst, prop: pname, ref: v.id });
        inst.props.set(pname, v);
      });
    } else if (name === 'PRNT') {
      r.u8();
      const count = r.u32();
      const ch = r.refs(count), pa = r.refs(count);
      parents = ch.map((c, i) => [c, pa[i]]);
    }
  }

  const model = new DataModel();
  for (const [c, p] of parents) {
    const child = insts.get(c);
    if (!child) continue;
    const parent = p === -1 ? model : insts.get(p);
    if (!parent) continue;
    child.parent = parent;
    parent.children.push(child);
  }
  model.walk(i => { i.model = model; });
  for (const pr of pendingRefs) {
    const target = insts.get(pr.ref);
    pr.inst.props.set(pr.prop, { t: 'Ref', id: target ? target.id : null });
  }
  for (const inst of insts.values()) if (!inst.props.has('Name')) inst.props.set('Name', { t: 'String', v: inst.className });
  return { model, report: { warnings: [...warnings], instanceCount: insts.size } };
}

function readValues(r: Reader, type: number, n: number, sstr: Uint8Array[]): (Value | null)[] {
  const out: (Value | null)[] = [];
  switch (type) {
    case 0x01: for (let i = 0; i < n; i++) {
      const raw = r.rawStr();
      const s = td.decode(raw);
      // keep binary blobs (e.g. Tags, AttributesSerialize) lossless
      out.push(te.encode(s).length === raw.length && !s.includes('�') ? { t: 'String', v: s } : { t: 'Bytes', v: raw });
    } return out;
    case 0x02: for (let i = 0; i < n; i++) out.push({ t: 'Bool', v: r.u8() !== 0 }); return out;
    case 0x03: return r.ilI32(n).map(v => ({ t: 'Int32', v }));
    case 0x04: return r.ilF32(n).map(v => ({ t: 'Float32', v }));
    case 0x05: for (let i = 0; i < n; i++) out.push({ t: 'Float64', v: r.f64() }); return out;
    case 0x06: { const s = r.ilF32(n), o = r.ilI32(n); return s.map((v, i) => ({ t: 'UDim', s: v, o: o[i] })); }
    case 0x07: { const xs = r.ilF32(n), ys = r.ilF32(n), xo = r.ilI32(n), yo = r.ilI32(n); return xs.map((v, i) => ({ t: 'UDim2', xs: v, ys: ys[i], xo: xo[i], yo: yo[i] })); }
    case 0x09: for (let i = 0; i < n; i++) out.push({ t: 'Faces', v: r.u8() }); return out;
    case 0x0a: for (let i = 0; i < n; i++) out.push({ t: 'Axes', v: r.u8() }); return out;
    case 0x0b: return Array.from(r.il32(n), v => ({ t: 'BrickColor', v }));
    case 0x0c: { const a = r.ilF32(n), b = r.ilF32(n), c = r.ilF32(n); return a.map((v, i) => ({ t: 'Color3', r: v, g: b[i], b: c[i] })); }
    case 0x0d: { const a = r.ilF32(n), b = r.ilF32(n); return a.map((v, i) => ({ t: 'Vector2', x: v, y: b[i] })); }
    case 0x0e: { const a = r.ilF32(n), b = r.ilF32(n), c = r.ilF32(n); return a.map((v, i) => ({ t: 'Vector3', x: v, y: b[i], z: c[i] })); }
    case 0x10: return readCFrames(r, n);
    case 0x12: return Array.from(r.il32(n), v => ({ t: 'Enum', v }));
    case 0x13: return r.refs(n).map(v => ({ t: 'Ref', id: v === -1 ? null : v }));
    case 0x14: for (let i = 0; i < n; i++) { const dv = r.dv; const x = dv.getInt16(r.o, true), y = dv.getInt16(r.o + 2, true), z = dv.getInt16(r.o + 4, true); r.o += 6; out.push({ t: 'Vector3int16', x, y, z }); } return out;
    case 0x0f: for (let i = 0; i < n; i++) { const dv = r.dv; const x = dv.getInt16(r.o, true), y = dv.getInt16(r.o + 2, true); r.o += 4; out.push({ t: 'Vector2int16', x, y }); } return out;
    case 0x15: for (let i = 0; i < n; i++) { const c = r.u32(); const k: [number, number, number][] = []; for (let j = 0; j < c; j++) k.push([r.f32(), r.f32(), r.f32()]); out.push({ t: 'NumberSequence', k }); } return out;
    case 0x16: for (let i = 0; i < n; i++) { const c = r.u32(); const k: [number, number, number, number, number][] = []; for (let j = 0; j < c; j++) k.push([r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]); out.push({ t: 'ColorSequence', k }); } return out;
    case 0x17: for (let i = 0; i < n; i++) out.push({ t: 'NumberRange', min: r.f32(), max: r.f32() }); return out;
    case 0x18: { const a = r.ilF32(n), b = r.ilF32(n), c = r.ilF32(n), d = r.ilF32(n); return a.map((v, i) => ({ t: 'Rect', x0: v, y0: b[i], x1: c[i], y1: d[i] })); }
    case 0x19: for (let i = 0; i < n; i++) {
      const f = r.u8();
      if (f & 1) { const d = r.f32(), fr = r.f32(), e = r.f32(), fw = r.f32(), ew = r.f32(); if (f & 2) r.f32(); out.push({ t: 'PhysicalProperties', custom: true, d, f: fr, e, fw, ew }); }
      else out.push({ t: 'PhysicalProperties', custom: false });
    } return out;
    case 0x1a: { const a = r.bytes(n).slice(), b = r.bytes(n).slice(), c = r.bytes(n).slice(); for (let i = 0; i < n; i++) out.push({ t: 'Color3uint8', r: a[i], g: b[i], b: c[i] }); return out; }
    case 0x1b: return r.ilI64(n).map(v => ({ t: 'Int64', v }));
    case 0x1c: return Array.from(r.il32(n), v => ({ t: 'SharedString', v: sstr[v] ?? new Uint8Array() }));
    case 0x1d: for (let i = 0; i < n; i++) out.push({ t: 'String', v: td.decode(r.rawStr()) }); return out;
    case 0x1e: {
      const inner = r.u8();
      const cfs = inner === 0x10 ? readCFrames(r, n) : [];
      r.u8(); // bool type marker
      for (let i = 0; i < n; i++) { const has = r.u8() !== 0; out.push({ t: 'OptionalCFrame', v: has ? cfs[i] : null }); }
      return out;
    }
    case 0x1f: {
      const src = r.bytes(n * 16);
      for (let i = 0; i < n; i++) { let hex = ''; for (let k = 0; k < 16; k++) hex += src[k * n + i].toString(16).padStart(2, '0'); out.push({ t: 'UniqueId', hex }); }
      return out;
    }
    case 0x20: for (let i = 0; i < n; i++) { const family = r.str(); const weight = r.u16(); const style = r.u8(); const cached = r.str(); out.push({ t: 'Font', family, weight, style, cached }); } return out;
    case 0x21: return r.ilI64(n).map(v => ({ t: 'SecurityCapabilities', v }));
    default: throw new Error('unsupported type ' + type);
  }
}

// ------------------------------------------------------------------ writing
class Writer {
  parts: Uint8Array[] = [];
  len = 0;
  push(b: Uint8Array) { this.parts.push(b); this.len += b.length; }
  u8(v: number) { this.push(Uint8Array.of(v)); }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  i16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, true); this.push(b); }
  f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.push(b); }
  f64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.push(b); }
  str(s: string) { this.raw(te.encode(s)); }
  raw(b: Uint8Array) { this.u32(b.length); this.push(b); }
  il32(vals: ArrayLike<number>) {
    const n = vals.length, b = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { const v = vals[i] >>> 0; b[i] = v >>> 24; b[n + i] = (v >>> 16) & 255; b[2 * n + i] = (v >>> 8) & 255; b[3 * n + i] = v & 255; }
    this.push(b);
  }
  ilI32(vals: number[]) { this.il32(vals.map(v => ((v << 1) ^ (v >> 31)) >>> 0)); }
  ilF32(vals: number[]) {
    const tmp = new DataView(new ArrayBuffer(4));
    this.il32(vals.map(v => { tmp.setFloat32(0, v); const x = tmp.getUint32(0); return ((x << 1) | (x >>> 31)) >>> 0; }));
  }
  ilI64(vals: bigint[]) {
    const n = vals.length, b = new Uint8Array(n * 8);
    vals.forEach((v, i) => {
      let u = BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
      for (let k = 7; k >= 0; k--) { b[k * n + i] = Number(u & 255n); u >>= 8n; }
    });
    this.push(b);
  }
  refs(vals: number[]) { const d = vals.map((v, i) => (i === 0 ? v : v - vals[i - 1])); this.ilI32(d); }
  done() { const o = new Uint8Array(this.len); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}

const TYPE_ID: Partial<Record<Value['t'], number>> = {
  String: 0x01, Bytes: 0x01, Bool: 0x02, Int32: 0x03, Float32: 0x04, Float64: 0x05, UDim: 0x06, UDim2: 0x07, Faces: 0x09, Axes: 0x0a,
  BrickColor: 0x0b, Color3: 0x0c, Vector2: 0x0d, Vector3: 0x0e, Vector2int16: 0x0f, CFrame: 0x10, Enum: 0x12, Ref: 0x13, Vector3int16: 0x14,
  NumberSequence: 0x15, ColorSequence: 0x16, NumberRange: 0x17, Rect: 0x18, PhysicalProperties: 0x19, Color3uint8: 0x1a, Int64: 0x1b,
  SharedString: 0x1c, OptionalCFrame: 0x1e, UniqueId: 0x1f, Font: 0x20, SecurityCapabilities: 0x21,
};

function defaultFor(t: Value['t']): Value {
  switch (t) {
    case 'String': return { t, v: '' };
    case 'Bytes': return { t, v: new Uint8Array() };
    case 'Bool': return { t, v: false };
    case 'Int32': case 'Float32': case 'Float64': case 'Enum': case 'BrickColor': case 'Faces': case 'Axes': return { t, v: t === 'BrickColor' ? 194 : 0 } as Value;
    case 'Int64': case 'SecurityCapabilities': return { t, v: 0n } as Value;
    case 'Vector3': case 'Vector3int16': return { t, x: 0, y: 0, z: 0 } as Value;
    case 'Vector2': case 'Vector2int16': return { t, x: 0, y: 0 } as Value;
    case 'Color3': return { t, r: 0, g: 0, b: 0 };
    case 'Color3uint8': return { t, r: 0, g: 0, b: 0 };
    case 'CFrame': return { t, p: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    case 'Ref': return { t, id: null };
    case 'UDim': return { t, s: 0, o: 0 };
    case 'UDim2': return { t, xs: 0, xo: 0, ys: 0, yo: 0 };
    case 'NumberSequence': return { t, k: [[0, 0, 0], [1, 0, 0]] };
    case 'ColorSequence': return { t, k: [[0, 1, 1, 1, 0], [1, 1, 1, 1, 0]] };
    case 'NumberRange': return { t, min: 0, max: 0 };
    case 'Rect': return { t, x0: 0, y0: 0, x1: 0, y1: 0 };
    case 'PhysicalProperties': return { t, custom: false };
    case 'SharedString': return { t, v: new Uint8Array() };
    case 'OptionalCFrame': return { t, v: null };
    case 'UniqueId': return { t, hex: '0'.repeat(32) };
    case 'Font': return { t, family: 'rbxasset://fonts/families/SourceSansPro.json', weight: 400, style: 0, cached: '' };
  }
}

function writeCFrames(w: Writer, vals: CF[]) {
  for (const c of vals) { w.u8(0); for (let k = 0; k < 9; k++) w.f32(c.r[k]); }
  w.ilF32(vals.map(c => c.p[0])); w.ilF32(vals.map(c => c.p[1])); w.ilF32(vals.map(c => c.p[2]));
}

function writeValues(w: Writer, type: Value['t'], vals: Value[], refOf: (id: number | null) => number, sstrIndex: (b: Uint8Array) => number) {
  const V = vals as any[];
  switch (type) {
    case 'String': for (const v of V) w.str(v.v); break;
    case 'Bytes': for (const v of V) w.raw(v.v); break;
    case 'Bool': for (const v of V) w.u8(v.v ? 1 : 0); break;
    case 'Int32': w.ilI32(V.map(v => v.v | 0)); break;
    case 'Float32': w.ilF32(V.map(v => v.v)); break;
    case 'Float64': for (const v of V) w.f64(v.v); break;
    case 'UDim': w.ilF32(V.map(v => v.s)); w.ilI32(V.map(v => v.o | 0)); break;
    case 'UDim2': w.ilF32(V.map(v => v.xs)); w.ilF32(V.map(v => v.ys)); w.ilI32(V.map(v => v.xo | 0)); w.ilI32(V.map(v => v.yo | 0)); break;
    case 'Faces': case 'Axes': for (const v of V) w.u8(v.v); break;
    case 'BrickColor': case 'Enum': w.il32(V.map(v => v.v)); break;
    case 'Color3': w.ilF32(V.map(v => v.r)); w.ilF32(V.map(v => v.g)); w.ilF32(V.map(v => v.b)); break;
    case 'Vector2': w.ilF32(V.map(v => v.x)); w.ilF32(V.map(v => v.y)); break;
    case 'Vector3': w.ilF32(V.map(v => v.x)); w.ilF32(V.map(v => v.y)); w.ilF32(V.map(v => v.z)); break;
    case 'Vector2int16': for (const v of V) { w.i16(v.x); w.i16(v.y); } break;
    case 'Vector3int16': for (const v of V) { w.i16(v.x); w.i16(v.y); w.i16(v.z); } break;
    case 'CFrame': writeCFrames(w, V); break;
    case 'Ref': w.refs(V.map(v => refOf(v.id))); break;
    case 'NumberSequence': for (const v of V) { w.u32(v.k.length); for (const k of v.k) k.forEach((x: number) => w.f32(x)); } break;
    case 'ColorSequence': for (const v of V) { w.u32(v.k.length); for (const k of v.k) k.forEach((x: number) => w.f32(x)); } break;
    case 'NumberRange': for (const v of V) { w.f32(v.min); w.f32(v.max); } break;
    case 'Rect': w.ilF32(V.map(v => v.x0)); w.ilF32(V.map(v => v.y0)); w.ilF32(V.map(v => v.x1)); w.ilF32(V.map(v => v.y1)); break;
    case 'PhysicalProperties': for (const v of V) { if (v.custom) { w.u8(1); w.f32(v.d); w.f32(v.f); w.f32(v.e); w.f32(v.fw); w.f32(v.ew); } else w.u8(0); } break;
    case 'Color3uint8': w.push(Uint8Array.from(V.map(v => v.r))); w.push(Uint8Array.from(V.map(v => v.g))); w.push(Uint8Array.from(V.map(v => v.b))); break;
    case 'Int64': case 'SecurityCapabilities': w.ilI64(V.map(v => v.v)); break;
    case 'SharedString': w.il32(V.map(v => sstrIndex(v.v))); break;
    case 'OptionalCFrame': {
      w.u8(0x10);
      writeCFrames(w, V.map(v => v.v ?? defaultFor('CFrame')));
      w.u8(0x02);
      for (const v of V) w.u8(v.v ? 1 : 0);
      break;
    }
    case 'UniqueId': {
      const n = V.length, b = new Uint8Array(n * 16);
      V.forEach((v, i) => { for (let k = 0; k < 16; k++) b[k * n + i] = parseInt(v.hex.substr(k * 2, 2), 16) || 0; });
      w.push(b); break;
    }
    case 'Font': for (const v of V) { w.str(v.family); w.u16(v.weight); w.u8(v.style); w.str(v.cached); } break;
  }
}

export function writeBinaryPlace(model: Instance, opts: { compress?: boolean } = {}): Uint8Array {
  const compress = opts.compress ?? true;
  const all: Instance[] = [];
  for (const c of model.children) c.walk(i => all.push(i));
  const refOfInst = new Map<number, number>();
  all.forEach((inst, i) => refOfInst.set(inst.id, i));
  const refOf = (id: number | null) => (id != null && refOfInst.has(id) ? refOfInst.get(id)! : -1);

  // group by class
  const byClass = new Map<string, Instance[]>();
  for (const inst of all) {
    if (!byClass.has(inst.className)) byClass.set(inst.className, []);
    byClass.get(inst.className)!.push(inst);
  }
  const classNames = [...byClass.keys()].sort();

  const sstrs: Uint8Array[] = [];
  const sstrIndex = (b: Uint8Array) => {
    const key = td.decode(b);
    let i = sstrs.findIndex(s => s.length === b.length && td.decode(s) === key);
    if (i < 0) { i = sstrs.length; sstrs.push(b); }
    return i;
  };

  const chunks: { name: string; data: Uint8Array; raw?: boolean }[] = [];
  const meta = new Writer();
  meta.u32(1); meta.str('ExplicitAutoJoints'); meta.str('true');
  chunks.push({ name: 'META', data: meta.done() });

  const instChunks: { name: string; data: Uint8Array }[] = [];
  const propChunks: { name: string; data: Uint8Array }[] = [];
  classNames.forEach((cname, cid) => {
    const list = byClass.get(cname)!;
    const w = new Writer();
    w.u32(cid); w.str(cname);
    const service = list.some(i => i.isService);
    w.u8(service ? 1 : 0);
    w.u32(list.length);
    w.refs(list.map(i => refOfInst.get(i.id)!));
    if (service) for (const _ of list) w.u8(1);
    instChunks.push({ name: 'INST', data: w.done() });

    // union of property names & types
    const propTypes = new Map<string, Value['t']>();
    for (const inst of list) for (const [k, v] of inst.props) {
      if (!TYPE_ID[v.t]) continue;
      if (!propTypes.has(k)) propTypes.set(k, v.t);
    }
    for (const [pname, t] of propTypes) {
      const vals = list.map(inst => {
        const v = inst.props.get(pname);
        if (v && v.t === t) return v;
        if (v && (t === 'String' || t === 'Bytes') && (v.t === 'String' || v.t === 'Bytes')) return v.t === 'String' ? (t === 'Bytes' ? { t: 'Bytes', v: te.encode(v.v) } as Value : v) : ({ t: 'String', v: td.decode(v.v) } as Value);
        return defaultFor(t);
      });
      const pw = new Writer();
      pw.u32(cid); pw.str(pname); pw.u8(TYPE_ID[t]!);
      writeValues(pw, t, vals, refOf, sstrIndex);
      propChunks.push({ name: 'PROP', data: pw.done() });
    }
  });

  if (sstrs.length) {
    const sw = new Writer();
    sw.u32(0); sw.u32(sstrs.length);
    for (const s of sstrs) { sw.push(new Uint8Array(16)); sw.raw(s); }
    chunks.push({ name: 'SSTR', data: sw.done() });
  }
  chunks.push(...instChunks, ...propChunks);

  const pw = new Writer();
  pw.u8(0); pw.u32(all.length);
  pw.refs(all.map(i => refOfInst.get(i.id)!));
  pw.refs(all.map(i => (i.parent && refOfInst.has(i.parent.id) ? refOfInst.get(i.parent.id)! : -1)));
  chunks.push({ name: 'PRNT', data: pw.done() });
  chunks.push({ name: 'END\0', data: te.encode('</roblox>'), raw: true });

  const out = new Writer();
  out.push(Uint8Array.from(MAGIC));
  out.u16(0); out.u32(classNames.length); out.u32(all.length); out.push(new Uint8Array(8));
  for (const c of chunks) {
    const nm = new Uint8Array(4); nm.set(te.encode(c.name).subarray(0, 4));
    out.push(nm);
    if (compress && !c.raw) {
      const comp = lz4Compress(c.data);
      out.u32(comp.length); out.u32(c.data.length); out.u32(0); out.push(comp);
    } else {
      out.u32(0); out.u32(c.data.length); out.u32(0); out.push(c.data);
    }
  }
  return out.done();
}
