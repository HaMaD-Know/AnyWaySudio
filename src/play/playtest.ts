// Play-test session: physics (cannon-es), a player character, camera and input, plus the Lua runtime.
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { DataModel, Instance, createInstance, isPart, getCF, getSize, getShape, getBool, getNum } from '../core/instance';
import { v3, cf, c3u8, str, f32, bool } from '../core/types';
import { LuaRuntime } from './luaRuntime';
import { SceneView } from '../editor/sceneView';

export type LogFn = (msg: string, kind: 'info' | 'warn' | 'error') => void;

const GRAVITY = 196.2;

export class PlayTest {
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  partMat = new CANNON.Material('part');
  charMat = new CANNON.Material('character');
  bodies = new Map<number, CANNON.Body>();
  bodyInst = new Map<CANNON.Body, Instance>();
  runtime: LuaRuntime;
  player: Instance;
  character: Instance | null = null;
  root: Instance | null = null;
  humanoid: Instance | null = null;
  charBody: CANNON.Body | null = null;
  charMesh = new THREE.Group();
  input = { x: 0, z: 0, jump: false };
  camYaw = 0;
  camPitch = -0.35;
  camDist = 18;
  grounded = false;
  dead = false;
  respawnAt = 0;
  private unsub: () => void;
  private lastTime = performance.now();
  private keys = new Set<string>();
  private dirtyPhys = new Map<Instance, boolean>(); // value: needs full rebuild
  leaderboard: HTMLElement;
  running = true;

  constructor(public model: DataModel, public view: SceneView, public camera: THREE.PerspectiveCamera, public log: LogFn, public hud: HTMLElement) {
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.addEventListener('beginContact', (e: any) => this.onContact('Touched', e.bodyA, e.bodyB));
    this.world.addEventListener('endContact', (e: any) => this.onContact('TouchEnded', e.bodyA, e.bodyB));
    (this.world.solver as CANNON.GSSolver).iterations = 10;
    this.world.defaultContactMaterial.friction = 0.4;
    this.world.defaultContactMaterial.restitution = 0;
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.partMat, this.partMat, { friction: 0.4, restitution: 0.05 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.charMat, this.partMat, { friction: 0, restitution: 0 }));
    const g = getNum(model.workspace, 'Gravity', GRAVITY);
    this.world.gravity.set(0, -g, 0);

    // Player object
    const players = model.service('Players');
    this.player = new Instance('Player', 'Player1');
    this.player.setParent(players);
    const ls = new Instance('Folder', 'PlayerGui');
    ls.setParent(this.player);
    new Instance('Backpack', 'Backpack').setParent(this.player);
    new Instance('PlayerScripts', 'PlayerScripts').setParent(this.player);

    model.workspace.walk(i => { if (isPart(i)) this.addBody(i); });
    this.unsub = model.on((kind, inst, prop) => {
      if (kind === 'added' && isPart(inst) && inst.isDescendantOf(model.workspace)) this.addBody(inst);
      else if (kind === 'removed') this.removeBody(inst);
      else if (kind === 'prop' && prop && isPart(inst) && (prop === 'CFrame' || prop === 'size' || prop === 'Anchored' || prop === 'CanCollide' || prop === 'shape')) this.markDirty(inst, prop !== 'CFrame');
      if (kind === 'prop' && inst.className === 'Humanoid' && inst === this.humanoid && prop === 'Health' && getNum(inst, 'Health', 100) <= 0) this.die();
      if ((kind === 'added' || kind === 'removed') && (inst.name === 'leaderstats' || inst.parent?.name === 'leaderstats' || inst.parent?.parent?.name === 'leaderstats')) this.renderLeaderboard();
      if (kind === 'prop' && inst.parent?.name === 'leaderstats') this.renderLeaderboard();
    });

    this.runtime = new LuaRuntime(model, {
      log: this.log,
      getVelocity: i => { const b = this.bodyFor(i); return b ? [b.velocity.x, b.velocity.y, b.velocity.z] : [0, 0, 0]; },
      setVelocity: (i, v) => { const b = this.bodyFor(i); if (b) { b.velocity.set(v[0], v[1], v[2]); b.wakeUp(); } },
      applyImpulse: (i, v) => { const b = this.bodyFor(i); if (b) { b.applyImpulse(new CANNON.Vec3(v[0], v[1], v[2])); b.wakeUp(); } },
      propChanged: (i, p) => { if (isPart(i)) this.markDirty(i, p !== 'CFrame' && p !== 'Transparency' && p !== 'Color'); if (p === 'Value' || p === 'Health') this.runtime?.changed(i, p); },
      players: () => [this.player],
      playerFromCharacter: c => (c === this.character ? this.player : null),
      loadCharacter: () => this.spawnCharacter(),
    });

    this.leaderboard = document.createElement('div');
    this.leaderboard.className = 'leaderboard';
    hud.appendChild(this.leaderboard);

    const n = this.runtime.startScripts();
    this.log(`Play started — ${n} script(s) running`, 'info');
    this.spawnCharacter();
    this.runtime.fire(players, 'PlayerAdded', this.player);
    this.bindKeys();
  }

  private markDirty(i: Instance, full: boolean) {
    this.dirtyPhys.set(i, (this.dirtyPhys.get(i) ?? false) || full);
  }

  private bodyFor(i: Instance) {
    if (i === this.root || i === this.character) return this.charBody;
    return this.bodies.get(i.id) ?? null;
  }

  // ------------------------------------------------------------ physics bodies
  private shapeFor(i: Instance): CANNON.Shape {
    const s = getSize(i);
    const shape = getShape(i);
    if (shape === 0) return new CANNON.Sphere(Math.min(s.x, s.y, s.z) / 2);
    if (shape === 3) return wedgeShape(s.x, s.y, s.z);
    if (shape === 2) {
      const c = new CANNON.Cylinder(Math.min(s.y, s.z) / 2, Math.min(s.y, s.z) / 2, s.x, 16);
      return c;
    }
    return new CANNON.Box(new CANNON.Vec3(s.x / 2, s.y / 2, s.z / 2));
  }

  private addBody(i: Instance, force = false) {
    if (this.bodies.has(i.id) || (!force && i.isDescendantOf(this.character ?? i))) return;
    const anchored = getBool(i, 'Anchored', false);
    const s = getSize(i);
    const body = new CANNON.Body({ mass: anchored ? 0 : Math.max(0.1, s.x * s.y * s.z * 0.7), type: anchored ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC });
    const shape = this.shapeFor(i);
    if (getShape(i) === 2) body.addShape(shape, new CANNON.Vec3(), new CANNON.Quaternion().setFromEuler(0, 0, Math.PI / 2));
    else body.addShape(shape);
    body.collisionResponse = getBool(i, 'CanCollide', true);
    body.material = this.partMat;
    body.linearDamping = 0.01;
    body.angularDamping = 0.05;
    this.syncBodyFromInst(body, i);
    this.world.addBody(body);
    this.bodies.set(i.id, body);
    this.bodyInst.set(body, i);
  }

  private removeBody(i: Instance) {
    const b = this.bodies.get(i.id);
    if (b) { this.world.removeBody(b); this.bodies.delete(i.id); this.bodyInst.delete(b); }
  }

  private syncBodyFromInst(body: CANNON.Body, i: Instance) {
    const c = getCF(i);
    body.position.set(c.p[0], c.p[1], c.p[2]);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(c.r[0], c.r[1], c.r[2], 0, c.r[3], c.r[4], c.r[5], 0, c.r[6], c.r[7], c.r[8], 0, 0, 0, 0, 1));
    body.quaternion.set(q.x, q.y, q.z, q.w);
  }

  private rebuildBody(i: Instance) {
    const b = this.bodies.get(i.id);
    if (!b) { if (isPart(i) && i.isDescendantOf(this.model.workspace)) this.addBody(i); return; }
    const anchored = getBool(i, 'Anchored', false);
    const s = getSize(i);
    if (b.shapes.length) b.removeShape(b.shapes[0]);
    const shape = this.shapeFor(i);
    if (getShape(i) === 2) b.addShape(shape, new CANNON.Vec3(), new CANNON.Quaternion().setFromEuler(0, 0, Math.PI / 2));
    else b.addShape(shape);
    b.type = anchored ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC;
    b.mass = anchored ? 0 : Math.max(0.1, s.x * s.y * s.z * 0.7);
    b.updateMassProperties();
    b.collisionResponse = getBool(i, 'CanCollide', true);
    if (anchored) { b.velocity.setZero(); b.angularVelocity.setZero(); }
    this.syncBodyFromInst(b, i);
    b.wakeUp();
  }

  // ------------------------------------------------------------ touches
  private touchQueue: [string, Instance, Instance][] = [];
  private onContact(kind: 'Touched' | 'TouchEnded', a: CANNON.Body, b: CANNON.Body) {
    const ia = a === this.charBody ? this.root : this.bodyInst.get(a);
    const ib = b === this.charBody ? this.root : this.bodyInst.get(b);
    if (!ia || !ib) return;
    this.touchQueue.push([kind, ia, ib]);
  }
  private flushTouches() {
    const q = this.touchQueue;
    this.touchQueue = [];
    for (const [kind, a, b] of q) { this.runtime.fire(a, kind, b); this.runtime.fire(b, kind, a); }
  }

  // ------------------------------------------------------------ character
  spawnCharacter() {
    if (this.character) this.character.destroy();
    if (this.charBody) { this.world.removeBody(this.charBody); this.charBody = null; }
    const spawns = this.model.workspace.descendants().filter(d => d.className === 'SpawnLocation');
    const sp = spawns[Math.floor(Math.random() * spawns.length)];
    let pos = [0, 10, 0];
    if (sp) { const c = getCF(sp); pos = [c.p[0], c.p[1] + getSize(sp).y / 2 + 3.2, c.p[2]]; }

    const char = createInstance('Model');
    char.props.delete('Anchored');
    char.name = this.player.name;
    const mk = (name: string, size: [number, number, number], off: [number, number, number], color: [number, number, number]) => {
      const p = createInstance('Part');
      p.name = name;
      p.props.set('size', v3(...size));
      p.props.set('CFrame', cf(pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]));
      p.props.set('Color3uint8', c3u8(...color));
      p.props.set('CanCollide', bool(false));
      p.setParent(char);
      return p;
    };
    const root = mk('HumanoidRootPart', [2, 2, 1], [0, 0, 0], [163, 162, 165]);
    root.props.set('Transparency', f32(1));
    mk('Head', [2, 1, 1], [0, 1.5, 0], [241, 196, 160]);
    mk('Torso', [2, 2, 1], [0, 0, 0], [255, 122, 47]);
    mk('Left Arm', [1, 2, 1], [-1.5, 0, 0], [241, 196, 160]);
    mk('Right Arm', [1, 2, 1], [1.5, 0, 0], [241, 196, 160]);
    mk('Left Leg', [1, 2, 1], [-0.5, -2, 0], [52, 58, 82]);
    mk('Right Leg', [1, 2, 1], [0.5, -2, 0], [52, 58, 82]);
    const hum = createInstance('Humanoid');
    const sp2 = this.model.children.find(c => c.className === 'StarterPlayer');
    if (sp2) {
      hum.props.set('WalkSpeed', f32(getNum(sp2, 'CharacterWalkSpeed', 16)));
      hum.props.set('JumpPower', f32(getNum(sp2, 'CharacterJumpPower', 50)));
    }
    hum.setParent(char);
    char.set('PrimaryPart', { t: 'Ref', id: root.id });
    this.character = char;
    this.root = root;
    this.humanoid = hum;
    this.dead = false;

    // capsule-ish body: two spheres
    const body = new CANNON.Body({ mass: 10, fixedRotation: true, linearDamping: 0 });
    body.addShape(new CANNON.Sphere(1), new CANNON.Vec3(0, -2, 0));
    body.addShape(new CANNON.Sphere(1), new CANNON.Vec3(0, 0.5, 0));
    body.position.set(pos[0], pos[1], pos[2]);
    body.material = this.charMat;
    body.collisionFilterGroup = 2;
    body.allowSleep = false;
    this.world.addBody(body);
    this.charBody = body;

    char.setParent(this.model.workspace);
    this.player.set('Character', { t: 'Ref', id: char.id });
    // StarterCharacterScripts
    const scs = sp2?.children.find(c => c.className === 'StarterCharacterScripts');
    for (const s of scs?.children ?? []) { const c = s.clone(); c.setParent(char); if (c.className !== 'ModuleScript') this.runtime.runScript(c); }
    this.runtime.fire(this.player, 'CharacterAdded', char);
    this.renderLeaderboard();
  }

  private die() {
    if (this.dead || !this.humanoid) return;
    this.dead = true;
    this.runtime.fire(this.humanoid, 'Died');
    this.respawnAt = performance.now() + 3000;
    // break apart: unanchored debris
    for (const p of this.character?.children.filter(isPart) ?? []) {
      if (p.name === 'HumanoidRootPart') continue;
      p.set('CanCollide', bool(true));
      this.addBody(p, true);
      const b = this.bodies.get(p.id);
      if (b) { b.velocity.set((Math.random() - 0.5) * 20, 15 + Math.random() * 10, (Math.random() - 0.5) * 20); b.angularVelocity.set(Math.random() * 6, Math.random() * 6, Math.random() * 6); }
    }
    if (this.charBody) { this.world.removeBody(this.charBody); this.charBody = null; }
    this.log('You died. Respawning…', 'warn');
  }

  // ------------------------------------------------------------ input
  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (e.type === 'keydown') this.keys.add(k); else this.keys.delete(k);
    if (k === ' ') e.preventDefault();
  };
  private bindKeys() {
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  /** Tap/click in the world (ClickDetector support). */
  click(ray: THREE.Raycaster) {
    const hit = this.view.pick(ray);
    if (!hit) return;
    let p: Instance | null = hit.inst;
    while (p) {
      const cd = p.children.find(c => c.className === 'ClickDetector');
      if (cd) {
        const c = getCF(hit.inst);
        const r = this.root ? getCF(this.root) : null;
        const dist = r ? Math.hypot(c.p[0] - r.p[0], c.p[1] - r.p[1], c.p[2] - r.p[2]) : 0;
        if (dist <= getNum(cd, 'MaxActivationDistance', 32) + 8) this.runtime.fire(cd, 'MouseClick', this.player);
        return;
      }
      p = p.parent;
    }
  }

  // ------------------------------------------------------------ frame
  update() {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(1 / 20, (now - this.lastTime) / 1000);
    this.lastTime = now;

    for (const [i, full] of this.dirtyPhys) {
      if (i === this.root && this.charBody) {
        const c = getCF(i);
        this.charBody.position.set(c.p[0], c.p[1], c.p[2]);
        this.charBody.velocity.setZero();
        continue;
      }
      if (i.isDescendantOf(this.character ?? i) && !this.bodies.has(i.id)) continue;
      const body = this.bodies.get(i.id);
      if (!full && body) { this.syncBodyFromInst(body, i); body.wakeUp(); }
      else this.rebuildBody(i);
    }
    this.dirtyPhys.clear();

    // character movement
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const kz = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
    const mx = this.input.x + kx, mz = this.input.z + kz;
    const b = this.charBody;
    if (b && this.humanoid && !this.dead) {
      const speed = getNum(this.humanoid, 'WalkSpeed', 16);
      const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
      let wx = mx * cos + mz * sin, wz = -mx * sin + mz * cos;
      const len = Math.hypot(wx, wz);
      if (len > 1) { wx /= len; wz /= len; }
      b.velocity.x = wx * speed;
      b.velocity.z = wz * speed;
      // ground check
      const from = new CANNON.Vec3(b.position.x, b.position.y - 2, b.position.z);
      const to = new CANNON.Vec3(b.position.x, b.position.y - 3.4, b.position.z);
      const res = new CANNON.RaycastResult();
      this.world.raycastClosest(from, to, { skipBackfaces: true, collisionFilterMask: 1 }, res);
      this.grounded = res.hasHit && !!res.body && res.body.collisionResponse && res.body !== b;
      if (this.grounded && (this.input.jump || this.keys.has(' ')) && b.velocity.y < 1) {
        b.velocity.y = getNum(this.humanoid, 'JumpPower', 50);
      }
      if (len > 0.05) this.facing = Math.atan2(-wx, -wz);
      if (b.position.y < getNum(this.model.workspace, 'FallenPartsDestroyHeight', -500) || b.position.y < -500) this.humanoid.set('Health', f32(0));
    }

    this.world.step(1 / 60, dt, 4);
    this.flushTouches();

    // write physics -> instances
    const q = new THREE.Quaternion(), m = new THREE.Matrix4();
    for (const [id, body] of this.bodies) {
      if (body.type === CANNON.Body.STATIC || body.sleepState === CANNON.Body.SLEEPING) continue;
      const inst = this.bodyInst.get(body)!;
      q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      m.makeRotationFromQuaternion(q);
      const e = m.elements; // column-major
      inst.props.set('CFrame', { t: 'CFrame', p: [body.position.x, body.position.y, body.position.z], r: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] });
      this.view.updateMesh(inst);
      void id;
    }
    if (b && this.character) this.poseCharacter(b);

    // character falling apart -> respawn
    if (this.dead && now > this.respawnAt) this.spawnCharacter();

    this.runtime.fire(this.model.service('RunService'), 'Stepped', now / 1000, dt);
    this.runtime.fire(this.model.service('RunService'), 'Heartbeat', dt);
    this.runtime.fire(this.model.service('RunService'), 'RenderStepped', dt);
    this.runtime.step();
    this.updateCamera();
  }

  facing = 0;
  private walkPhase = 0;
  private poseCharacter(b: CANNON.Body) {
    const ch = this.character!;
    const p = [b.position.x, b.position.y, b.position.z];
    const rot = new THREE.Matrix4().makeRotationY(this.facing).elements;
    const r = [rot[0], rot[4], rot[8], rot[1], rot[5], rot[9], rot[2], rot[6], rot[10]];
    const moving = Math.hypot(b.velocity.x, b.velocity.z) > 0.5;
    this.walkPhase += moving ? 0.25 : 0;
    const swing = moving && this.grounded ? Math.sin(this.walkPhase) * 0.8 : this.grounded ? 0 : 0.4;
    const offs: Record<string, [number, number, number, number]> = {
      HumanoidRootPart: [0, 0, 0, 0], Torso: [0, 0, 0, 0], Head: [0, 1.5, 0, 0],
      'Left Arm': [-1.5, 0, 0, swing], 'Right Arm': [1.5, 0, 0, -swing], 'Left Leg': [-0.5, -2, 0, -swing], 'Right Leg': [0.5, -2, 0, swing],
    };
    for (const part of ch.children) {
      const o = offs[part.name];
      if (!o) continue;
      // limb swing around the shoulder/hip (1 stud above center)
      const sw = new THREE.Matrix4().makeRotationX(o[3]).elements;
      const sr = [sw[0], sw[4], sw[8], sw[1], sw[5], sw[9], sw[2], sw[6], sw[10]];
      const lr = mulR(r, sr);
      const pivot = [o[0], o[1] + 1, o[2]];
      // position = p + R*pivot + LR*(0,-1,0)
      const wp = [
        p[0] + r[0] * pivot[0] + r[1] * pivot[1] + r[2] * pivot[2] - lr[1],
        p[1] + r[3] * pivot[0] + r[4] * pivot[1] + r[5] * pivot[2] - lr[4],
        p[2] + r[6] * pivot[0] + r[7] * pivot[1] + r[8] * pivot[2] - lr[7],
      ];
      part.props.set('CFrame', { t: 'CFrame', p: wp as [number, number, number], r: o[3] ? lr : r });
      this.view.updateMesh(part);
    }
  }

  private updateCamera() {
    const target = this.charBody ? new THREE.Vector3(this.charBody.position.x, this.charBody.position.y + 1.5, this.charBody.position.z)
      : this.root ? new THREE.Vector3(...getCF(this.root).p) : new THREE.Vector3();
    const d = this.camDist;
    const off = new THREE.Vector3(Math.sin(this.camYaw) * Math.cos(this.camPitch), -Math.sin(this.camPitch), Math.cos(this.camYaw) * Math.cos(this.camPitch)).multiplyScalar(d);
    this.camera.position.copy(target).add(off);
    this.camera.lookAt(target);
  }

  renderLeaderboard() {
    const ls = this.player.findFirstChild('leaderstats');
    if (!ls || !ls.children.length) { this.leaderboard.style.display = 'none'; return; }
    this.leaderboard.style.display = 'block';
    const stats = ls.children.filter(c => c.isA('ValueBase'));
    const val = (c: Instance) => { const v = c.get('Value'); if (!v) return ''; if (v.t === 'Int64') return String(v.v); if ('v' in v) return String((v as any).v); return ''; };
    this.leaderboard.innerHTML = `<table><tr><th>Player</th>${stats.map(s => `<th>${esc(s.name)}</th>`).join('')}</tr><tr><td>${esc(this.player.name)}</td>${stats.map(s => `<td>${esc(val(s))}</td>`).join('')}</tr></table>`;
  }

  stop() {
    this.running = false;
    this.unsub();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    this.leaderboard.remove();
  }
}

function mulR(a: number[], b: number[]) {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function wedgeShape(x: number, y: number, z: number) {
  const hx = x / 2, hy = y / 2, hz = z / 2;
  const verts = [
    new CANNON.Vec3(-hx, -hy, -hz), new CANNON.Vec3(hx, -hy, -hz), new CANNON.Vec3(hx, -hy, hz), new CANNON.Vec3(-hx, -hy, hz),
    new CANNON.Vec3(-hx, hy, hz), new CANNON.Vec3(hx, hy, hz),
  ];
  const faces = [[0, 1, 2, 3], [3, 2, 5, 4], [0, 4, 5, 1], [0, 3, 4], [1, 5, 2]];
  return new CANNON.ConvexPolyhedron({ vertices: verts, faces });
}

// silence unused imports in some builds
void str;
