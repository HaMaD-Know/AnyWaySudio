// Property value types used by the place data model.
// These mirror the value types found inside .rbxl / .rbxlx files.

export type Vec3 = { t: 'Vector3'; x: number; y: number; z: number };
export type Vec2 = { t: 'Vector2'; x: number; y: number };
export type Col3 = { t: 'Color3'; r: number; g: number; b: number }; // 0..1
export type Col3u8 = { t: 'Color3uint8'; r: number; g: number; b: number }; // 0..255
/** Position + row-major 3x3 rotation matrix (R00 R01 R02 R10 ... R22). */
export type CF = { t: 'CFrame'; p: [number, number, number]; r: number[] };
export type EnumV = { t: 'Enum'; v: number };
export type RefV = { t: 'Ref'; id: number | null };
export type UDimV = { t: 'UDim'; s: number; o: number };
export type UDim2V = { t: 'UDim2'; xs: number; xo: number; ys: number; yo: number };
export type BrickV = { t: 'BrickColor'; v: number };
export type I32 = { t: 'Int32'; v: number };
export type I64 = { t: 'Int64'; v: bigint };
export type F32 = { t: 'Float32'; v: number };
export type F64 = { t: 'Float64'; v: number };
export type Str = { t: 'String'; v: string };
export type Bytes = { t: 'Bytes'; v: Uint8Array };
export type Bool = { t: 'Bool'; v: boolean };
export type NumRange = { t: 'NumberRange'; min: number; max: number };
export type NumSeq = { t: 'NumberSequence'; k: [number, number, number][] };
export type ColSeq = { t: 'ColorSequence'; k: [number, number, number, number, number][] };
export type RectV = { t: 'Rect'; x0: number; y0: number; x1: number; y1: number };
export type FacesV = { t: 'Faces'; v: number };
export type AxesV = { t: 'Axes'; v: number };
export type PhysV = { t: 'PhysicalProperties'; custom: false } | { t: 'PhysicalProperties'; custom: true; d: number; f: number; e: number; fw: number; ew: number };
export type SharedStr = { t: 'SharedString'; v: Uint8Array };
export type FontV = { t: 'Font'; family: string; weight: number; style: number; cached: string };
export type UniqueIdV = { t: 'UniqueId'; hex: string };
export type OptCF = { t: 'OptionalCFrame'; v: CF | null };
export type V3i16 = { t: 'Vector3int16'; x: number; y: number; z: number };
export type V2i16 = { t: 'Vector2int16'; x: number; y: number };
export type SecCap = { t: 'SecurityCapabilities'; v: bigint };

export type Value =
  | Vec3 | Vec2 | Col3 | Col3u8 | CF | EnumV | RefV | UDimV | UDim2V | BrickV
  | I32 | I64 | F32 | F64 | Str | Bytes | Bool | NumRange | NumSeq | ColSeq | RectV
  | FacesV | AxesV | PhysV | SharedStr | FontV | UniqueIdV | OptCF | V3i16 | V2i16 | SecCap;

export const v3 = (x: number, y: number, z: number): Vec3 => ({ t: 'Vector3', x, y, z });
export const c3u8 = (r: number, g: number, b: number): Col3u8 => ({ t: 'Color3uint8', r, g, b });
export const str = (v: string): Str => ({ t: 'String', v });
export const bool = (v: boolean): Bool => ({ t: 'Bool', v });
export const f32 = (v: number): F32 => ({ t: 'Float32', v });
export const en = (v: number): EnumV => ({ t: 'Enum', v });
export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const cf = (x: number, y: number, z: number, r: number[] = IDENTITY): CF => ({ t: 'CFrame', p: [x, y, z], r: r.slice() });

export function cloneValue(v: Value): Value {
  switch (v.t) {
    case 'CFrame': return { t: 'CFrame', p: [...v.p] as [number, number, number], r: v.r.slice() };
    case 'NumberSequence': return { t: v.t, k: v.k.map(a => [...a] as [number, number, number]) };
    case 'ColorSequence': return { t: v.t, k: v.k.map(a => [...a] as [number, number, number, number, number]) };
    case 'Bytes': case 'SharedString': return { t: v.t, v: v.v.slice() } as Value;
    case 'OptionalCFrame': return { t: v.t, v: v.v ? (cloneValue(v.v) as CF) : null };
    default: return { ...v } as Value;
  }
}

// --- rotation helpers (Euler degrees, Roblox "Orientation" uses YXZ order) ---
const D2R = Math.PI / 180;
export function eulerToMatrix(rxDeg: number, ryDeg: number, rzDeg: number): number[] {
  // R = Ry * Rx * Rz  (matches Roblox Orientation convention)
  const x = rxDeg * D2R, y = ryDeg * D2R, z = rzDeg * D2R;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(mul3(Ry, Rx), Rz);
}
export function matrixToEuler(r: number[]): [number, number, number] {
  // inverse of Ry*Rx*Rz
  const m12 = r[5];
  const x = Math.asin(Math.max(-1, Math.min(1, -m12)));
  let y: number, z: number;
  if (Math.abs(m12) < 0.99999) {
    y = Math.atan2(r[2], r[8]);
    z = Math.atan2(r[3], r[4]);
  } else {
    y = Math.atan2(-r[6], r[0]);
    z = 0;
  }
  const R = (a: number) => Math.round((a / D2R) * 1000) / 1000;
  return [R(x), R(y), R(z)];
}
export function mul3(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
    o[i * 3 + j] = s;
  }
  return o;
}

export function hexToC3u8(hex: string): Col3u8 {
  const n = parseInt(hex.replace('#', ''), 16);
  return c3u8((n >> 16) & 255, (n >> 8) & 255, n & 255);
}
export function c3ToHex(c: Col3u8 | Col3): string {
  const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  if (c.t === 'Color3') return '#' + to(c.r * 255) + to(c.g * 255) + to(c.b * 255);
  return '#' + to(c.r) + to(c.g) + to(c.b);
}
