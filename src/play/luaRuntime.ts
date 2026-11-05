// JS half of the scripting runtime, built on the fengari Lua VM.
import * as fengari from 'fengari';
import { PRELUDE } from './prelude';
import { DataModel, Instance, createInstance, isA, isPart, getCF, getSize, getColor, getNum, getShape, setSize, isScript } from '../core/instance';
import { Value, c3u8, eulerToMatrix, matrixToEuler, mul3 } from '../core/types';
import { MATERIALS, materialName } from '../editor/materials';
import { luauToLua } from './luau';

const { lua, lauxlib, lualib, to_luastring } = fengari as any;

export type JsVal = number | string | boolean | null | undefined | Instance
  | { v3: [number, number, number] } | { c3: [number, number, number] } | { cf: number[] }
  | { en: [string, string, number] } | { v2: [number, number] } | { arr: JsVal[] } | { tbl: Record<string, JsVal> };

export interface RuntimeHost {
  log(msg: string, kind: 'info' | 'warn' | 'error'): void;
  /** physics hooks */
  getVelocity(i: Instance): [number, number, number];
  setVelocity(i: Instance, v: [number, number, number]): void;
  applyImpulse(i: Instance, v: [number, number, number]): void;
  propChanged(i: Instance, prop: string): void;
  players(): Instance[];
  playerFromCharacter(c: Instance): Instance | null;
  loadCharacter(player: Instance): void;
}

const PARTTYPE = ['Ball', 'Block', 'Cylinder', 'Wedge', 'CornerWedge'];
const CREATABLE = new Set(['Part', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'SpawnLocation', 'Seat', 'Model', 'Folder', 'Script', 'LocalScript', 'ModuleScript',
  'IntValue', 'NumberValue', 'StringValue', 'BoolValue', 'ObjectValue', 'Vector3Value', 'Color3Value', 'CFrameValue', 'PointLight', 'SpotLight', 'SurfaceLight', 'Humanoid',
  'ClickDetector', 'Configuration', 'Attachment', 'Sound', 'Fire', 'Smoke', 'Sparkles', 'ParticleEmitter', 'Decal', 'Texture', 'BillboardGui', 'ScreenGui', 'Frame', 'TextLabel',
  'TextButton', 'ImageLabel', 'SurfaceGui', 'Highlight', 'SelectionBox', 'Weld', 'WeldConstraint', 'Motor6D', 'BodyVelocity', 'BodyPosition', 'Explosion', 'Tool', 'ProximityPrompt',
  'Message', 'Hint', 'Team', 'MeshPart']);

export class LuaRuntime {
  L: any;
  objs = new Map<number, Instance>();
  constructor(public model: DataModel, public host: RuntimeHost) {
    const L = this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const reg = (name: string, fn: (L: any) => number) => lua.lua_register(L, to_luastring(name), (L: any) => {
      let r: number;
      try { r = fn(L); } catch (e: any) { if (e instanceof Error) return lauxlib.luaL_error(L, to_luastring(e.message)); throw e; }
      return r;
    });
    reg('__now', L => { lua.lua_pushnumber(L, performance.now() / 1000); return 1; });
    reg('__print', L => { this.host.log(lua.lua_tojsstring(L, 1) ?? '', (lua.lua_tojsstring(L, 2) ?? 'info') as any); return 0; });
    reg('__new', L => {
      const cls = lua.lua_tojsstring(L, 1);
      if (!CREATABLE.has(cls)) { lua.lua_pushnil(L); return 1; }
      const inst = createInstance(cls);
      if (cls === 'Model' || cls === 'Folder') inst.props.delete('Anchored');
      this.track(inst);
      lua.lua_pushinteger(L, inst.id);
      return 1;
    });
    reg('__get', L => {
      const inst = this.objs.get(lua.lua_tointeger(L, 1)) ?? this.find(lua.lua_tointeger(L, 1));
      const key = lua.lua_tojsstring(L, 2);
      if (!inst) { lua.lua_pushboolean(L, false); return 1; }
      const r = this.getProp(inst, key);
      if (r === NOT_FOUND) {
        const child = inst.findFirstChild(key);
        if (child) { lua.lua_pushboolean(L, true); this.push(L, child); return 2; }
        lua.lua_pushboolean(L, false);
        return 1;
      }
      lua.lua_pushboolean(L, true);
      this.push(L, r as JsVal);
      return 2;
    });
    reg('__set', L => {
      const inst = this.find(lua.lua_tointeger(L, 1));
      const key = lua.lua_tojsstring(L, 2);
      if (!inst) { lua.lua_pushboolean(L, false); lua.lua_pushliteral(L, 'Instance no longer exists'); return 2; }
      const val = this.read(L, 3);
      try {
        this.setProp(inst, key, val);
        lua.lua_pushboolean(L, true);
        return 1;
      } catch (e: any) {
        lua.lua_pushboolean(L, false);
        lua.lua_pushliteral(L, String(e.message ?? e));
        return 2;
      }
    });
    reg('__call', L => {
      const n = lua.lua_gettop(L);
      const inst = this.find(lua.lua_tointeger(L, 1));
      const m = lua.lua_tojsstring(L, 2);
      const args: JsVal[] = [];
      for (let k = 3; k <= n; k++) args.push(this.read(L, k));
      if (!inst) return 0;
      const res = this.call(inst, m, args);
      if (Array.isArray(res)) { for (const r of res) this.push(L, r); return res.length; }
      this.push(L, res);
      return 1;
    });
    this.track(model);
    model.walk(i => this.track(i));
    model.on((kind, inst) => { if (kind === 'added') inst.walk(d => this.track(d)); });
    const g = (name: string, v: number) => { lua.lua_pushinteger(L, v); lua.lua_setglobal(L, to_luastring(name)); };
    g('__GAME', model.id);
    g('__WORKSPACE', model.workspace.id);
    const matTable = '{' + MATERIALS.map(([n, v]) => `${n}=${v}`).join(',') + '}';
    this.exec(PRELUDE.replace('__ENUM_MATERIAL', matTable), '=prelude');
  }

  private track(i: Instance) { this.objs.set(i.id, i); }
  private find(id: number) { const i = this.objs.get(id); return i; }

  exec(src: string, chunk: string) {
    const L = this.L;
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring(chunk)) !== 0) {
      this.host.log(lua.lua_tojsstring(L, -1), 'error'); lua.lua_pop(L, 1); return;
    }
    if (lua.lua_pcall(L, 0, 0, 0) !== 0) { this.host.log(lua.lua_tojsstring(L, -1), 'error'); lua.lua_pop(L, 1); }
  }

  private callGlobal(name: string, args: JsVal[]) {
    const L = this.L;
    lua.lua_getglobal(L, to_luastring(name));
    for (const a of args) this.push(L, a);
    if (lua.lua_pcall(L, args.length, 0, 0) !== 0) { this.host.log(String(lua.lua_tojsstring(L, -1)), 'error'); lua.lua_pop(L, 1); }
  }

  runScript(s: Instance) {
    const src = s.get('Source');
    const text = src?.t === 'String' ? src.v : '';
    const L = this.L;
    lua.lua_getglobal(L, to_luastring('__run'));
    lua.lua_pushinteger(L, s.id);
    lua.lua_pushstring(L, to_luastring(luauToLua(text)));
    lua.lua_pushstring(L, to_luastring(s.fullName()));
    if (lua.lua_pcall(L, 3, 0, 0) !== 0) { this.host.log(String(lua.lua_tojsstring(L, -1)), 'error'); lua.lua_pop(L, 1); }
  }

  step() { this.callGlobal('__step', []); }
  fire(i: Instance, event: string, ...args: JsVal[]) { this.callGlobal('__fire', [i.id, event, ...args]); }
  changed(i: Instance, prop: string) { this.callGlobal('__changed', [i.id, prop]); }

  // ----------------------------------------------------------- marshalling
  push(L: any, v: JsVal) {
    if (v === null || v === undefined) lua.lua_pushnil(L);
    else if (typeof v === 'number') { if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) lua.lua_pushinteger(L, v); else lua.lua_pushnumber(L, v); }
    else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
    else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
    else if (v instanceof Instance) { this.track(v); lua.lua_createtable(L, 0, 1); lua.lua_pushinteger(L, v.id); lua.lua_setfield(L, -2, to_luastring('__i')); }
    else {
      const arr = (tag: string, nums: (number | string)[]) => {
        lua.lua_createtable(L, nums.length, 1);
        lua.lua_pushliteral(L, tag); lua.lua_setfield(L, -2, to_luastring('__v'));
        nums.forEach((n, k) => { if (typeof n === 'string') lua.lua_pushstring(L, to_luastring(n)); else lua.lua_pushnumber(L, n); lua.lua_rawseti(L, -2, k + 1); });
      };
      if ('v3' in v) arr('V3', v.v3);
      else if ('c3' in v) arr('C3', v.c3);
      else if ('cf' in v) arr('CF', v.cf);
      else if ('v2' in v) arr('V2', v.v2);
      else if ('en' in v) arr('EN', v.en);
      else if ('arr' in v) {
        lua.lua_createtable(L, v.arr.length, 1);
        lua.lua_pushliteral(L, 'ARR'); lua.lua_setfield(L, -2, to_luastring('__v'));
        v.arr.forEach((x, k) => { this.push(L, x); lua.lua_rawseti(L, -2, k + 1); });
      } else if ('tbl' in v) {
        lua.lua_createtable(L, 0, 4);
        for (const [k, x] of Object.entries(v.tbl)) { this.push(L, x); lua.lua_setfield(L, -2, to_luastring(k)); }
      } else lua.lua_pushnil(L);
    }
  }

  read(L: any, idx: number): JsVal {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (t === lua.LUA_TSTRING) return lua.lua_tojsstring(L, idx);
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx);
    if (t !== lua.LUA_TTABLE) return null;
    idx = lua.lua_absindex(L, idx);
    lua.lua_getfield(L, idx, to_luastring('__i'));
    if (lua.lua_type(L, -1) === lua.LUA_TNUMBER) { const id = lua.lua_tointeger(L, -1); lua.lua_pop(L, 1); return this.find(id) ?? null; }
    lua.lua_pop(L, 1);
    lua.lua_getfield(L, idx, to_luastring('__v'));
    const tag = lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : null;
    lua.lua_pop(L, 1);
    const nums = (n: number) => { const o: any[] = []; for (let k = 1; k <= n; k++) { lua.lua_rawgeti(L, idx, k); o.push(lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : lua.lua_tonumber(L, -1)); lua.lua_pop(L, 1); } return o; };
    if (tag === 'V3') return { v3: nums(3) as any };
    if (tag === 'C3') return { c3: nums(3) as any };
    if (tag === 'CF') return { cf: nums(12) };
    if (tag === 'V2') return { v2: nums(2) as any };
    if (tag === 'EN') return { en: nums(3) as any };
    // plain table -> read fields generically (used for TweenInfo etc. not needed); treat as array
    const n = lua.lua_rawlen(L, idx);
    const arr: JsVal[] = [];
    for (let k = 1; k <= n; k++) { lua.lua_rawgeti(L, idx, k); arr.push(this.read(L, -1)); lua.lua_pop(L, 1); }
    return { arr };
  }

  // ----------------------------------------------------------- properties
  getProp(i: Instance, key: string): JsVal | typeof NOT_FOUND {
    switch (key) {
      case 'Name': return i.name;
      case 'ClassName': return i.className;
      case 'Parent': return i.parent;
    }
    if (i.className === 'DataModel') {
      if (key === 'Workspace') return this.model.workspace;
      if (key === 'PlaceId' || key === 'GameId' || key === 'CreatorId') return 0;
      if (key === 'JobId') return 'local';
    }
    if (i.className === 'Players' && key === 'LocalPlayer') return this.host.players()[0] ?? null;
    if (i.className === 'Workspace') {
      if (key === 'Gravity') return getNum(i, 'Gravity', 196.2);
      if (key === 'CurrentCamera') return null;
    }
    if (isPart(i)) {
      const c = getCF(i);
      switch (key) {
        case 'Size': return v3of(getSize(i));
        case 'Position': return { v3: [...c.p] as [number, number, number] };
        case 'CFrame': return { cf: [...c.p, ...c.r] };
        case 'Orientation': case 'Rotation': return { v3: matrixToEuler(c.r) };
        case 'Color': { const [r, g, b] = getColor(i); return { c3: [r, g, b] }; }
        case 'BrickColor': { const [r, g, b] = getColor(i); return { c3: [r, g, b] }; }
        case 'Material': { const v = getNum(i, 'Material', 256); return { en: ['Material', materialName(v), v] }; }
        case 'Shape': { const v = getShape(i); return { en: ['PartType', PARTTYPE[v] ?? 'Block', v] }; }
        case 'Velocity': case 'AssemblyLinearVelocity': return { v3: this.host.getVelocity(i) };
        case 'Mass': case 'AssemblyMass': { const s = getSize(i); return s.x * s.y * s.z * 0.7; }
        case 'CanTouch': case 'CanQuery': return true;
      }
    }
    if (i.className === 'Model' || i.className === 'Workspace') {
      if (key === 'PrimaryPart') { const v = i.get('PrimaryPart'); return v?.t === 'Ref' && v.id != null ? this.find(v.id) ?? null : null; }
      if (key === 'WorldPivot') return this.call(i, 'GetPivot', []) as JsVal;
    }
    if (isA(i.className, 'LuaSourceContainer') && key === 'Source') {
      const s = i.get('Source'); return s?.t === 'String' ? s.v : '';
    }
    const v = i.get(key) ?? (key === 'Size' ? i.get('size') : undefined);
    if (v) return valueToJs(v, this);
    // defaults for common read-only/derived props
    if (i.className === 'Humanoid') {
      const d: Record<string, JsVal> = { Health: 100, MaxHealth: 100, WalkSpeed: 16, JumpPower: 50, JumpHeight: 7.2, Sit: false, Jump: false, DisplayName: i.parent?.name ?? '' };
      if (key in d) return d[key];
      if (key === 'RootPart') return i.parent?.findFirstChild('HumanoidRootPart') ?? null;
    }
    if (i.className === 'Player') {
      if (key === 'Character') { const v = i.get('Character'); return v?.t === 'Ref' && v.id != null ? this.find(v.id) ?? null : null; }
      if (key === 'UserId') return 1;
      if (key === 'DisplayName') return i.name;
      if (key === 'Team') return null;
    }
    if (isA(i.className, 'ValueBase') && key === 'Value') return null;
    if (key === 'Archivable') return true;
    if (key === 'Disabled' || key === 'Enabled') return key === 'Enabled';
    return NOT_FOUND;
  }

  setProp(i: Instance, key: string, val: JsVal) {
    if (key === 'Parent') {
      if (val !== null && !(val instanceof Instance)) throw new Error('Parent must be an Instance or nil');
      if (i.isService || i === this.model) throw new Error('The Parent property of ' + i.name + ' is locked');
      i.setParent(val as Instance | null);
      return;
    }
    if (key === 'Name') { i.name = String(val ?? ''); return; }
    if (key === 'ClassName') throw new Error('ClassName is read-only');
    if (isPart(i)) {
      const c = getCF(i);
      switch (key) {
        case 'Size': { const v = vecOf(val); const sz = { t: 'Vector3' as const, x: Math.max(0.001, v[0]), y: Math.max(0.001, v[1]), z: Math.max(0.001, v[2]) }; setSize(i, sz); this.host.propChanged(i, 'size'); return; }
        case 'Position': { const v = vecOf(val); i.set('CFrame', { t: 'CFrame', p: v, r: c.r.slice() }); this.host.propChanged(i, 'CFrame'); return; }
        case 'CFrame': { if (!val || typeof val !== 'object' || !('cf' in val)) throw new Error('Expected CFrame'); const a = val.cf; i.set('CFrame', { t: 'CFrame', p: [a[0], a[1], a[2]], r: a.slice(3, 12) }); this.host.propChanged(i, 'CFrame'); return; }
        case 'Orientation': case 'Rotation': { const v = vecOf(val); i.set('CFrame', { t: 'CFrame', p: c.p, r: eulerToMatrix(v[0], v[1], v[2]) }); this.host.propChanged(i, 'CFrame'); return; }
        case 'Color': case 'BrickColor': { const v = colOf(val); i.props.delete('BrickColor'); i.props.delete('Color'); i.set('Color3uint8', c3u8(Math.round(v[0] * 255), Math.round(v[1] * 255), Math.round(v[2] * 255))); return; }
        case 'Material': { i.set('Material', { t: 'Enum', v: enumOf(val, 'Material') }); return; }
        case 'Shape': { i.props.delete('Shape'); i.set('shape', { t: 'Enum', v: enumOf(val, 'PartType') }); return; }
        case 'Velocity': case 'AssemblyLinearVelocity': this.host.setVelocity(i, vecOf(val)); return;
        case 'Anchored': case 'CanCollide': i.set(key, { t: 'Bool', v: !!val }); this.host.propChanged(i, key); return;
        case 'Transparency': case 'Reflectance': i.set(key, { t: 'Float32', v: Number(val) || 0 }); return;
      }
    }
    if ((i.className === 'Model') && key === 'PrimaryPart') { i.set('PrimaryPart', { t: 'Ref', id: val instanceof Instance ? val.id : null }); return; }
    if (i.className === 'Player' && key === 'Character') { i.set('Character', { t: 'Ref', id: val instanceof Instance ? val.id : null }); return; }
    if (isA(i.className, 'LuaSourceContainer') && key === 'Source') { i.set('Source', { t: 'String', v: String(val) }); return; }
    if (isA(i.className, 'ValueBase') && key === 'Value') {
      const old = i.get('Value');
      let nv: Value;
      if (i.className === 'IntValue') nv = { t: 'Int64', v: BigInt(Math.trunc(Number(val) || 0)) };
      else if (i.className === 'NumberValue') nv = { t: 'Float64', v: Number(val) || 0 };
      else if (i.className === 'StringValue') nv = { t: 'String', v: val == null ? '' : String(val) };
      else if (i.className === 'BoolValue') nv = { t: 'Bool', v: !!val };
      else if (i.className === 'ObjectValue') nv = { t: 'Ref', id: val instanceof Instance ? val.id : null };
      else nv = jsToValue(val, old);
      i.set('Value', nv);
      this.host.propChanged(i, 'Value');
      return;
    }
    if (i.className === 'Humanoid' && (key === 'Health' || key === 'MaxHealth' || key === 'WalkSpeed' || key === 'JumpPower' || key === 'JumpHeight')) {
      let n = Number(val) || 0;
      if (key === 'Health') n = Math.max(0, Math.min(n, getNum(i, 'MaxHealth', 100)));
      const was = getNum(i, 'Health', 100);
      i.set(key, { t: 'Float32', v: n });
      if (key === 'Health') {
        if (n !== was) this.fire(i, 'HealthChanged', n);
        this.host.propChanged(i, 'Health');
      }
      return;
    }
    const old = i.get(key);
    i.set(key, jsToValue(val, old));
    this.host.propChanged(i, key);
  }

  call(i: Instance, m: string, a: JsVal[]): JsVal | JsVal[] {
    const s = (k: number) => (a[k] == null ? '' : String(a[k]));
    switch (m) {
      case 'Destroy': if (!i.isService && i !== this.model) i.destroy(); return null;
      case 'Clone': { const c = i.clone(); c.walk(d => this.track(d)); return c; }
      case 'ClearAllChildren': for (const c of i.children.slice()) c.destroy(); return null;
      case 'GetChildren': return { arr: i.children.slice() };
      case 'GetDescendants': return { arr: i.descendants() };
      case 'FindFirstChild': return a[1] ? i.descendants().find(d => d.name === s(0)) ?? null : i.findFirstChild(s(0)) ?? null;
      case 'FindFirstChildOfClass': return i.children.find(c => c.className === s(0)) ?? null;
      case 'FindFirstChildWhichIsA': return (a[1] ? i.descendants() : i.children).find(c => c.isA(s(0))) ?? null;
      case 'FindFirstAncestor': { let p = i.parent; while (p && p.name !== s(0)) p = p.parent; return p; }
      case 'FindFirstAncestorOfClass': { let p = i.parent; while (p && p.className !== s(0)) p = p.parent; return p; }
      case 'FindFirstAncestorWhichIsA': { let p = i.parent; while (p && !p.isA(s(0))) p = p.parent; return p; }
      case 'IsA': return i.isA(s(0));
      case 'IsDescendantOf': return a[0] instanceof Instance ? i.isDescendantOf(a[0]) : false;
      case 'GetFullName': return i.fullName();
      case 'GetService': {
        if (i !== this.model) return null;
        const name = s(0);
        if (!/^[A-Z][A-Za-z]+$/.test(name)) return null;
        const svc = this.model.service(name);
        this.track(svc);
        return svc;
      }
      case 'GetPlayers': return { arr: this.host.players() };
      case 'GetPlayerFromCharacter': return a[0] instanceof Instance ? this.host.playerFromCharacter(a[0]) : null;
      case 'LoadCharacter': this.host.loadCharacter(i); return null;
      case 'Kick': return null;
      case 'GetPivot': {
        const pp = pivotPart(i);
        if (!pp) return { cf: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
        const c = getCF(pp);
        return { cf: [...c.p, ...c.r] };
      }
      case 'PivotTo': case 'MoveTo': {
        const pp = pivotPart(i);
        if (!pp) return null;
        const from = getCF(pp);
        let target: { p: number[]; r: number[] };
        if (m === 'MoveTo') { const v = vecOf(a[0]); target = { p: v, r: from.r }; }
        else { const c = (a[0] as any)?.cf as number[]; if (!c) return null; target = { p: c.slice(0, 3), r: c.slice(3) }; }
        // delta = target * from^-1
        const inv = [from.r[0], from.r[3], from.r[6], from.r[1], from.r[4], from.r[7], from.r[2], from.r[5], from.r[8]];
        const dr = mul3(target.r, inv);
        const parts = isPart(i) ? [i] : i.descendants().filter(isPart);
        for (const p of parts) {
          const c = getCF(p);
          const rel = [c.p[0] - from.p[0], c.p[1] - from.p[1], c.p[2] - from.p[2]];
          const np = [
            target.p[0] + dr[0] * rel[0] + dr[1] * rel[1] + dr[2] * rel[2],
            target.p[1] + dr[3] * rel[0] + dr[4] * rel[1] + dr[5] * rel[2],
            target.p[2] + dr[6] * rel[0] + dr[7] * rel[1] + dr[8] * rel[2],
          ] as [number, number, number];
          p.set('CFrame', { t: 'CFrame', p: np, r: mul3(dr, c.r) });
          this.host.propChanged(p, 'CFrame');
        }
        return null;
      }
      case 'ApplyImpulse': this.host.applyImpulse(i, vecOf(a[0])); return null;
      case '__source': {
        const src = i.get('Source');
        return [luauToLua(src?.t === 'String' ? src.v : ''), i.fullName()];
      }
    }
    throw new Error(m + ' is not a valid member of ' + i.className);
  }

  /** Start every enabled script in the run-able containers. */
  startScripts() {
    const roots = ['Workspace', 'ServerScriptService', 'ReplicatedFirst', 'StarterPlayer', 'StarterGui', 'StarterPack'];
    const scripts: Instance[] = [];
    for (const r of roots) {
      const svc = this.model.children.find(c => c.className === r);
      svc?.walk(d => {
        if (!isScript(d) || d.className === 'ModuleScript') return;
        if (d.get('Disabled')?.t === 'Bool' && (d.get('Disabled') as any).v) return;
        const en = d.get('Enabled');
        if (en?.t === 'Bool' && !en.v) return;
        // StarterCharacterScripts are run when the character is created
        if (d.parent?.className === 'StarterCharacterScripts') return;
        scripts.push(d);
      });
    }
    for (const s of scripts) this.runScript(s);
    return scripts.length;
  }
}

const NOT_FOUND = Symbol('notfound');

function pivotPart(i: Instance): Instance | null {
  if (isPart(i)) return i;
  const pp = i.get('PrimaryPart');
  if (pp?.t === 'Ref' && pp.id != null) { const f = i.descendants().find(d => d.id === pp.id); if (f) return f; }
  return i.descendants().find(isPart) ?? null;
}

function v3of(v: { x: number; y: number; z: number }): JsVal { return { v3: [v.x, v.y, v.z] }; }
function vecOf(v: JsVal): [number, number, number] {
  if (v && typeof v === 'object' && 'v3' in v) return v.v3;
  throw new Error('Expected Vector3');
}
function colOf(v: JsVal): [number, number, number] {
  if (v && typeof v === 'object' && 'c3' in v) return v.c3;
  throw new Error('Expected Color3');
}
function enumOf(v: JsVal, type: string): number {
  if (v && typeof v === 'object' && 'en' in v) return v.en[2];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (type === 'Material') { const m = MATERIALS.find(x => x[0] === v); if (m) return m[1]; }
    if (type === 'PartType') { const k = PARTTYPE.indexOf(v); if (k >= 0) return k; }
  }
  throw new Error('Expected Enum.' + type);
}

export function valueToJs(v: Value, rt?: LuaRuntime): JsVal {
  switch (v.t) {
    case 'String': return v.v;
    case 'Bool': return v.v;
    case 'Int32': case 'Float32': case 'Float64': case 'BrickColor': return v.v;
    case 'Int64': return Number(v.v);
    case 'Enum': return v.v;
    case 'Vector3': case 'Vector3int16': return { v3: [v.x, v.y, v.z] };
    case 'Vector2': case 'Vector2int16': return { v2: [v.x, v.y] };
    case 'Color3': return { c3: [v.r, v.g, v.b] };
    case 'Color3uint8': return { c3: [v.r / 255, v.g / 255, v.b / 255] };
    case 'CFrame': return { cf: [...v.p, ...v.r] };
    case 'Ref': return v.id != null && rt ? rt.objs.get(v.id) ?? null : null;
    default: return null;
  }
}
function jsToValue(val: JsVal, old?: Value): Value {
  if (typeof val === 'boolean') return { t: 'Bool', v: val };
  if (typeof val === 'string') return { t: 'String', v: val };
  if (typeof val === 'number') {
    if (old?.t === 'Int32' || old?.t === 'Int64') return old.t === 'Int64' ? { t: 'Int64', v: BigInt(Math.trunc(val)) } : { t: 'Int32', v: Math.trunc(val) };
    if (old?.t === 'Float64') return { t: 'Float64', v: val };
    return { t: 'Float32', v: val };
  }
  if (val instanceof Instance) return { t: 'Ref', id: val.id };
  if (val == null) return old?.t === 'Ref' ? { t: 'Ref', id: null } : { t: 'String', v: '' };
  if ('v3' in val) return { t: 'Vector3', x: val.v3[0], y: val.v3[1], z: val.v3[2] };
  if ('c3' in val) return old?.t === 'Color3uint8' ? c3u8(val.c3[0] * 255, val.c3[1] * 255, val.c3[2] * 255) : { t: 'Color3', r: val.c3[0], g: val.c3[1], b: val.c3[2] };
  if ('cf' in val) return { t: 'CFrame', p: [val.cf[0], val.cf[1], val.cf[2]], r: val.cf.slice(3) };
  if ('en' in val) return { t: 'Enum', v: val.en[2] };
  if ('v2' in val) return { t: 'Vector2', x: val.v2[0], y: val.v2[1] };
  return { t: 'String', v: '' };
}
