import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DataModel, Instance, createInstance, isPart, isScript, newPlace, getCF, getSize, setSize } from '../core/instance';
import { cf, v3, str, en } from '../core/types';
import { SceneView } from './sceneView';
import { History } from './history';
import { Explorer } from '../ui/explorer';
import { Properties } from '../ui/properties';
import { ScriptEditor } from '../ui/scriptEditor';
import { Learn } from '../ui/learn';
import { ICON } from '../ui/icons';
import { PlayTest } from '../play/playtest';
import { loadPlace, pickFile, savePlace, kvGet, kvSet } from '../io/files';
import { writeBinaryPlace } from '../io/rbxlBinary';

export type Tool = 'select' | 'move' | 'scale' | 'rotate';

export const INSERTABLE: { label: string; cls: string; shape?: number; group: string }[] = [
  { label: 'Block', cls: 'Part', shape: 1, group: 'Parts' },
  { label: 'Sphere', cls: 'Part', shape: 0, group: 'Parts' },
  { label: 'Cylinder', cls: 'Part', shape: 2, group: 'Parts' },
  { label: 'Wedge', cls: 'WedgePart', group: 'Parts' },
  { label: 'Corner Wedge', cls: 'CornerWedgePart', group: 'Parts' },
  { label: 'Spawn Location', cls: 'SpawnLocation', group: 'Parts' },
  { label: 'Seat', cls: 'Seat', group: 'Parts' },
  { label: 'Script', cls: 'Script', group: 'Scripting' },
  { label: 'LocalScript', cls: 'LocalScript', group: 'Scripting' },
  { label: 'ModuleScript', cls: 'ModuleScript', group: 'Scripting' },
  { label: 'Model', cls: 'Model', group: 'Containers' },
  { label: 'Folder', cls: 'Folder', group: 'Containers' },
  { label: 'PointLight', cls: 'PointLight', group: 'Effects' },
  { label: 'SpotLight', cls: 'SpotLight', group: 'Effects' },
  { label: 'ClickDetector', cls: 'ClickDetector', group: 'Interaction' },
  { label: 'IntValue', cls: 'IntValue', group: 'Values' },
  { label: 'NumberValue', cls: 'NumberValue', group: 'Values' },
  { label: 'StringValue', cls: 'StringValue', group: 'Values' },
  { label: 'BoolValue', cls: 'BoolValue', group: 'Values' },
];

export class App {
  model: DataModel = newPlace();
  view = new SceneView();
  history = new History();
  renderer: THREE.WebGLRenderer;
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 5000);
  orbit: OrbitControls;
  gizmo: TransformControls;
  gizmoTarget = new THREE.Object3D();
  selBox = new THREE.Box3Helper(new THREE.Box3(), 0x2d9cff);
  selection: Instance[] = [];
  tool: Tool = 'move';
  snap = true;
  fileName = 'Place';
  play: PlayTest | null = null;
  editModel: DataModel | null = null;
  clipboard: Instance[] = [];
  explorer: Explorer;
  props: Properties;
  scriptEditor: ScriptEditor;
  learn: Learn;
  el: Record<string, HTMLElement> = {};
  private autosaveTimer = 0;
  private flyKeys = new Set<string>();

  constructor(root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach(e => (this.el[e.dataset.el!] = e));
    root.querySelectorAll<HTMLElement>('[data-icon]').forEach(e => e.insertAdjacentHTML('afterbegin', (ICON as any)[e.dataset.icon!] ?? ''));

    const canvas = this.el.canvas as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera.position.set(30, 24, 30);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.maxDistance = 1500;
    this.orbit.screenSpacePanning = true;
    this.orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.orbit.target.set(0, 0, 0);

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(1.25);
    this.gizmo.addEventListener('dragging-changed', (e: any) => {
      this.orbit.enabled = !e.value;
      if (!e.value) this.commit();
      else this.beginGizmoDrag();
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.view.scene.add(this.gizmo.getHelper());
    this.view.scene.add(this.gizmoTarget);
    this.view.scene.add(this.selBox);
    this.selBox.visible = false;

    this.explorer = new Explorer(this, this.el.explorer);
    this.props = new Properties(this, this.el.properties);
    this.scriptEditor = new ScriptEditor(this, this.el.scripteditor);
    this.learn = new Learn(this, this.el.learn);

    this.bindUI();
    this.bindViewport(canvas);
    this.setModel(this.model);
    this.setTool('move');
    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(this.el.viewport);
    this.resize();
    this.loop();
    this.log('Welcome to AnyWay Studio! Insert parts, write scripts and press Play to test.', 'info');
    this.tryRestore();
  }

  // ------------------------------------------------------------------ model
  setModel(m: DataModel, resetHistory = true) {
    this.model = m;
    this.view.bind(m);
    this.selection = [];
    m.on((kind, _i, prop) => { if (kind !== 'prop' || prop === 'Name') this.explorer.scheduleRender(); this.scheduleAutosave(); });
    if (resetHistory) this.history.reset(m);
    this.select([]);
    this.explorer.render();
  }

  commit() {
    if (this.play) return;
    this.history.commit(this.model);
    this.props.render();
    this.updateUndoButtons();
  }

  undo() { this.restoreSnapshot(this.history.undo()); }
  redo() { this.restoreSnapshot(this.history.redo()); }
  private restoreSnapshot(m: DataModel | null) {
    if (!m || this.play) return;
    const selNames = this.selection.map(s => s.fullName());
    this.setModel(m, false);
    const sel: Instance[] = [];
    m.walk(i => { if (selNames.includes(i.fullName())) sel.push(i); });
    this.select(sel);
    this.updateUndoButtons();
  }
  updateUndoButtons() {
    (this.el.undo as HTMLButtonElement).disabled = !this.history.canUndo();
    (this.el.redo as HTMLButtonElement).disabled = !this.history.canRedo();
  }

  // ------------------------------------------------------------------ selection
  select(list: Instance[], additive = false) {
    if (additive) {
      const s = new Set(this.selection);
      for (const i of list) s.has(i) ? s.delete(i) : s.add(i);
      this.selection = [...s];
    } else this.selection = list;
    this.attachGizmo();
    this.explorer.render();
    this.props.render();
  }
  get primary(): Instance | null { return this.selection[this.selection.length - 1] ?? null; }

  /** Parts affected by the gizmo (a selected Model moves all its parts). */
  private movableParts(): Instance[] {
    const out = new Set<Instance>();
    for (const s of this.selection) {
      if (isPart(s)) out.add(s);
      else if (s.className === 'Model' || s.className === 'Folder') s.descendants().filter(isPart).forEach(p => out.add(p));
    }
    return [...out];
  }

  private gizmoStart: { parts: { i: Instance; cf: number[]; size: [number, number, number] }[]; pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;

  attachGizmo() {
    const parts = this.movableParts();
    if (!parts.length || this.play || this.tool === 'select') {
      this.gizmo.detach();
    } else {
      this.placeGizmoTarget(parts);
      this.gizmo.attach(this.gizmoTarget);
    }
    this.updateSelBox();
  }

  private placeGizmoTarget(parts: Instance[]) {
    const p = this.primary;
    const single = parts.length === 1 && p && isPart(p);
    if (single) {
      const c = getCF(p!);
      const m = new THREE.Matrix4().set(c.r[0], c.r[1], c.r[2], c.p[0], c.r[3], c.r[4], c.r[5], c.p[1], c.r[6], c.r[7], c.r[8], c.p[2], 0, 0, 0, 1);
      m.decompose(this.gizmoTarget.position, this.gizmoTarget.quaternion, new THREE.Vector3());
      const s = getSize(p!);
      this.gizmoTarget.scale.set(s.x, s.y, s.z);
    } else {
      const box = this.boundsOf(parts);
      box.getCenter(this.gizmoTarget.position);
      this.gizmoTarget.quaternion.identity();
      this.gizmoTarget.scale.set(1, 1, 1);
    }
    this.gizmoTarget.updateMatrixWorld();
  }

  boundsOf(parts: Instance[]) {
    const box = new THREE.Box3();
    for (const p of parts) { const m = this.view.meshes.get(p.id); if (m) box.expandByObject(m); }
    return box;
  }

  updateSelBox() {
    const parts = this.movableParts();
    if (!parts.length || this.play) { this.selBox.visible = false; return; }
    this.selBox.box.copy(this.boundsOf(parts)).expandByScalar(0.05);
    this.selBox.visible = true;
  }

  private beginGizmoDrag() {
    const parts = this.movableParts();
    this.gizmoStart = {
      parts: parts.map(i => { const c = getCF(i); const s = getSize(i); return { i, cf: [...c.p, ...c.r], size: [s.x, s.y, s.z] }; }),
      pos: this.gizmoTarget.position.clone(),
      quat: this.gizmoTarget.quaternion.clone(),
    };
  }

  private onGizmoChange() {
    const st = this.gizmoStart;
    if (!st) return;
    const t = this.gizmoTarget;
    if (this.tool === 'scale') {
      const one = st.parts.length === 1 ? st.parts[0] : null;
      if (one) {
        const sx = Math.max(0.05, t.scale.x), sy = Math.max(0.05, t.scale.y), sz = Math.max(0.05, t.scale.z);
        const r = (n: number) => (this.snap ? Math.max(1, Math.round(n)) : Math.round(n * 1000) / 1000);
        setSize(one.i, v3(r(sx), r(sy), r(sz)));
        t.scale.set(r(sx), r(sy), r(sz));
      }
    } else {
      const dq = t.quaternion.clone().multiply(st.quat.clone().invert());
      const dm = new THREE.Matrix4().makeRotationFromQuaternion(dq);
      for (const p of st.parts) {
        const rel = new THREE.Vector3(p.cf[0], p.cf[1], p.cf[2]).sub(st.pos).applyMatrix4(dm);
        const pos = rel.add(t.position);
        const rm = new THREE.Matrix4().set(p.cf[3], p.cf[4], p.cf[5], 0, p.cf[6], p.cf[7], p.cf[8], 0, p.cf[9], p.cf[10], p.cf[11], 0, 0, 0, 0, 1);
        const nr = dm.clone().multiply(rm).elements;
        const rot = [nr[0], nr[4], nr[8], nr[1], nr[5], nr[9], nr[2], nr[6], nr[10]].map(x => (Math.abs(x) < 1e-7 ? 0 : x));
        const R = (n: number) => Math.round(n * 1000) / 1000;
        p.i.set('CFrame', cf(R(pos.x), R(pos.y), R(pos.z), rot));
      }
    }
    this.view.flush();
    this.updateSelBox();
    this.props.render(true);
  }

  setTool(t: Tool) {
    this.tool = t;
    for (const b of ['select', 'move', 'scale', 'rotate']) this.el['tool_' + b]?.classList.toggle('active', b === t);
    if (t !== 'select') this.gizmo.setMode(t === 'move' ? 'translate' : t);
    this.gizmo.setSpace(t === 'move' ? 'world' : 'local');
    this.applySnap();
    this.attachGizmo();
  }
  applySnap() {
    this.gizmo.setTranslationSnap(this.snap ? 1 : null);
    this.gizmo.setRotationSnap(this.snap ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(this.snap ? 0.25 : null);
    this.el.snap.classList.toggle('active', this.snap);
  }

  // ------------------------------------------------------------------ editing ops
  insert(cls: string, shape?: number) {
    if (this.play) return;
    const inst = createInstance(cls);
    if (shape !== undefined && cls === 'Part') inst.props.set('shape', en(shape));
    if (cls === 'Part' && shape === 0) inst.props.set('size', v3(2, 2, 2));
    if (cls === 'Part' && shape === 2) inst.props.set('size', v3(2, 2, 2));
    if (cls === 'Model' || cls === 'Folder') inst.props.delete('Anchored');
    const sel = this.primary;
    let parent: Instance = this.model.workspace;
    if (isPart(inst)) {
      if (sel && (sel.className === 'Model' || sel.className === 'Folder') && sel.isDescendantOf(this.model.workspace)) parent = sel;
      // drop it in front of the camera, on top of whatever is there
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const hit = this.view.pick(ray);
      const s = getSize(inst);
      let pos = this.orbit.target.clone();
      if (hit) pos = hit.point.clone();
      pos.y = Math.max(pos.y, 0) + s.y / 2;
      pos.set(Math.round(pos.x), Math.round(pos.y * 2) / 2, Math.round(pos.z));
      inst.props.set('CFrame', cf(pos.x, pos.y, pos.z));
      if (cls !== 'SpawnLocation') inst.props.set('Anchored', { t: 'Bool', v: true });
    } else if (isScript(inst)) {
      if (sel && !sel.isService) parent = sel;
      else parent = cls === 'LocalScript' ? this.model.service('StarterPlayer').findFirstChild('StarterPlayerScripts') ?? this.ensureStarterScripts() : cls === 'ModuleScript' ? this.model.service('ReplicatedStorage') : this.model.service('ServerScriptService');
    } else if (sel && (/Light$/.test(cls) || cls === 'ClickDetector' ? isPart(sel) : true)) parent = sel;
    inst.setParent(parent);
    this.select([inst]);
    this.commit();
    if (isScript(inst)) this.scriptEditor.open(inst);
    return inst;
  }

  private ensureStarterScripts() {
    const sp = this.model.service('StarterPlayer');
    let f = sp.findFirstChild('StarterPlayerScripts');
    if (!f) { f = new Instance('StarterPlayerScripts'); f.isService = false; f.setParent(sp); }
    return f;
  }

  deleteSelection() {
    const del = this.selection.filter(i => !i.isService && i.className !== 'DataModel');
    if (!del.length) return;
    for (const i of del) i.destroy();
    this.select([]);
    this.commit();
  }

  duplicate() {
    const out: Instance[] = [];
    for (const i of this.selection) {
      if (i.isService || !i.parent) continue;
      const c = i.clone();
      c.setParent(i.parent);
      out.push(c);
    }
    if (out.length) { this.select(out); this.commit(); }
  }

  copy() { this.clipboard = this.selection.filter(i => !i.isService).map(i => i.clone()); this.toast(`Copied ${this.clipboard.length} item(s)`); }
  cut() { this.copy(); this.deleteSelection(); }
  paste(into?: Instance) {
    if (!this.clipboard.length) return;
    const target = into ?? (this.primary && !isPart(this.primary) ? this.primary : this.model.workspace);
    const out = this.clipboard.map(c => { const n = c.clone(); n.setParent(target); return n; });
    this.select(out);
    this.commit();
  }

  group() {
    const items = this.selection.filter(i => !i.isService && i.parent);
    if (!items.length) return;
    const m = createInstance('Model');
    m.props.delete('Anchored');
    m.setParent(items[0].parent);
    for (const i of items) i.setParent(m);
    this.select([m]);
    this.commit();
  }
  ungroup() {
    const out: Instance[] = [];
    for (const g of this.selection) {
      if ((g.className !== 'Model' && g.className !== 'Folder') || !g.parent) continue;
      for (const c of g.children.slice()) { c.setParent(g.parent); out.push(c); }
      g.destroy();
    }
    if (out.length) { this.select(out); this.commit(); }
  }

  focusSelection() {
    const parts = this.movableParts();
    if (!parts.length) return;
    const box = this.boundsOf(parts);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() || 4;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(Math.max(8, r * 1.4)));
  }

  // ------------------------------------------------------------------ files
  async newPlace(template: 'baseplate' | 'flat' | 'obby') {
    if (this.play) this.stopPlay();
    this.fileName = template === 'obby' ? 'Obby' : 'Place';
    this.setModel(newPlace(template));
    this.camera.position.set(30, 24, 30);
    this.orbit.target.set(0, 0, 0);
    this.log(`New ${template} place created`, 'info');
  }

  async openFile() {
    const f = await pickFile();
    if (!f) return;
    this.openBytes(f.bytes, f.name);
  }

  openBytes(bytes: Uint8Array, name: string) {
    try {
      if (this.play) this.stopPlay();
      const { model, warnings, format } = loadPlace(bytes);
      for (const s of ['Workspace', 'Lighting', 'ReplicatedStorage', 'ServerScriptService', 'StarterPlayer', 'Players']) model.service(s);
      this.fileName = name.replace(/\.(rbxlx?|rbxmx?)$/i, '');
      this.setModel(model);
      const count = model.descendants().length;
      this.log(`Opened ${name} (${format}, ${count} instances)`, 'info');
      if (warnings.length) this.log(`${warnings.length} unsupported propert${warnings.length === 1 ? 'y was' : 'ies were'} skipped: ${warnings.slice(0, 4).join('; ')}${warnings.length > 4 ? '…' : ''}`, 'warn');
      this.frameAll();
    } catch (e: any) {
      this.log('Could not open file: ' + (e?.message ?? e), 'error');
      this.toast('Could not open that file');
    }
  }

  frameAll() {
    const parts = this.model.workspace.descendants().filter(p => isPart(p) && p.name !== 'Baseplate');
    if (!parts.length) return;
    const box = this.boundsOf(parts);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.min(400, box.getSize(new THREE.Vector3()).length());
    this.orbit.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(0.7, 0.55, 0.7).normalize().multiplyScalar(Math.max(20, r)));
  }

  async save(format: 'rbxl' | 'rbxlx') {
    const m = this.editModel ?? this.model;
    try {
      const msg = await savePlace(m, this.fileName, format);
      this.log(msg, 'info');
      this.toast(msg);
    } catch (e: any) {
      this.log('Save failed: ' + (e?.message ?? e), 'error');
    }
  }

  private scheduleAutosave() {
    if (this.play) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try { kvSet('autosave', { name: this.fileName, bytes: writeBinaryPlace(this.model), at: Date.now() }); } catch { /* ignore */ }
    }, 1500);
  }
  private async tryRestore() {
    const a = await kvGet<{ name: string; bytes: Uint8Array; at: number }>('autosave');
    if (!a?.bytes) return;
    const when = new Date(a.at).toLocaleString();
    this.toast(`Restore “${a.name}” from ${when}?`, [{ label: 'Restore', fn: () => this.openBytes(a.bytes, a.name + '.rbxl') }], 9000);
  }

  // ------------------------------------------------------------------ play test
  startPlay() {
    if (this.play) return;
    this.scriptEditor.close();
    this.editModel = this.model;
    this.editCam = { pos: this.camera.position.clone(), target: this.orbit.target.clone() };
    const playModel = this.model.cloneModel();
    this.model = playModel;
    this.view.bind(playModel);
    this.selection = [];
    this.gizmo.detach();
    this.selBox.visible = false;
    this.view.grid.visible = false;
    this.orbit.enabled = false;
    document.body.classList.add('playing');
    this.el.output.classList.add('open');
    this.play = new PlayTest(playModel, this.view, this.camera, (m, k) => this.log(m, k), this.el.hud);
    playModel.on((kind, _i, prop) => { if (kind !== 'prop' || prop === 'Name') this.explorer.scheduleRender(); });
    this.explorer.render();
    this.props.render();
  }
  private editCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  stopPlay() {
    if (!this.play || !this.editModel) return;
    this.play.stop();
    this.play = null;
    document.body.classList.remove('playing');
    this.model = this.editModel;
    this.editModel = null;
    this.view.bind(this.model);
    this.view.grid.visible = true;
    this.orbit.enabled = true;
    if (this.editCam) { this.camera.position.copy(this.editCam.pos); this.orbit.target.copy(this.editCam.target); }
    this.select([]);
    this.log('Play stopped — changes made during play were discarded', 'info');
  }

  // ------------------------------------------------------------------ output / toast
  log(msg: string, kind: 'info' | 'warn' | 'error') {
    const line = document.createElement('div');
    line.className = 'log ' + kind;
    const t = new Date();
    line.textContent = `${t.toTimeString().slice(0, 8)}  ${msg}`;
    const out = this.el.outputlog;
    out.appendChild(line);
    while (out.children.length > 500) out.firstChild!.remove();
    out.scrollTop = out.scrollHeight;
    if (kind === 'error') this.el.output.classList.add('open');
  }

  toast(msg: string, actions: { label: string; fn: () => void }[] = [], ms = 3500) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.onclick = () => { a.fn(); t.remove(); };
      t.appendChild(b);
    }
    this.el.toasts.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ------------------------------------------------------------------ UI wiring
  private bindUI() {
    const on = (name: string, fn: () => void) => this.el[name]?.addEventListener('click', fn);
    on('undo', () => this.undo());
    on('redo', () => this.redo());
    on('tool_select', () => this.setTool('select'));
    on('tool_move', () => this.setTool('move'));
    on('tool_scale', () => this.setTool('scale'));
    on('tool_rotate', () => this.setTool('rotate'));
    on('snap', () => { this.snap = !this.snap; this.applySnap(); });
    on('focus', () => this.focusSelection());
    on('play', () => (this.play ? this.stopPlay() : this.startPlay()));
    on('stopbtn', () => this.stopPlay());
    on('btn_learn', () => this.learn.toggle());
    on('btn_panels', () => document.body.classList.toggle('panels-open'));
    on('btn_output', () => this.el.output.classList.toggle('open'));
    on('clearlog', () => (this.el.outputlog.innerHTML = ''));
    on('btn_script', () => this.insert('Script'));
    on('btn_part', () => this.showMenu(this.el.btn_part, INSERTABLE.filter(i => i.group === 'Parts').map(i => ({ label: i.label, fn: () => this.insert(i.cls, i.shape) }))));
    on('btn_insert', () => this.showInsertMenu(this.el.btn_insert));
    on('btn_file', () => this.showMenu(this.el.btn_file, [
      { label: 'New Baseplate', fn: () => this.newPlace('baseplate') },
      { label: 'New Flat Terrain', fn: () => this.newPlace('flat') },
      { label: 'New Obby Template', fn: () => this.newPlace('obby') },
      { sep: true },
      { label: 'Open .rbxl / .rbxlx…', fn: () => this.openFile() },
      { sep: true },
      { label: 'Download as .rbxl', fn: () => this.save('rbxl') },
      { label: 'Download as .rbxlx (XML)', fn: () => this.save('rbxlx') },
    ]));
    on('btn_group', () => this.showMenu(this.el.btn_group, [
      { label: 'Group (Model)', fn: () => this.group() },
      { label: 'Ungroup', fn: () => this.ungroup() },
      { label: 'Duplicate', fn: () => this.duplicate() },
      { label: 'Copy', fn: () => this.copy() },
      { label: 'Cut', fn: () => this.cut() },
      { label: 'Paste', fn: () => this.paste() },
      { label: 'Paste Into Selection', fn: () => this.paste(this.primary ?? undefined) },
      { label: 'Delete', fn: () => this.deleteSelection() },
    ]));

    window.addEventListener('keydown', e => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (this.play) { if (k === 'escape' || (k === 'f5' && e.shiftKey)) { e.preventDefault(); this.stopPlay(); } return; }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && k === 'y') { e.preventDefault(); this.redo(); }
      else if (mod && k === 'd') { e.preventDefault(); this.duplicate(); }
      else if (mod && k === 'g') { e.preventDefault(); e.shiftKey ? this.ungroup() : this.group(); }
      else if (mod && k === 'c') this.copy();
      else if (mod && k === 'x') this.cut();
      else if (mod && k === 'v') this.paste();
      else if (k === 'delete' || k === 'backspace') this.deleteSelection();
      else if (k === 'f5') { e.preventDefault(); this.startPlay(); }
      else if (k === 'f') this.focusSelection();
      else if (mod && k === '1') this.setTool('select');
      else if (mod && k === '2') this.setTool('move');
      else if (mod && k === '3') this.setTool('scale');
      else if (mod && k === '4') this.setTool('rotate');
      else if (!mod && 'wasdqe'.includes(k)) this.flyKeys.add(k);
    });
    window.addEventListener('keyup', e => this.flyKeys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.flyKeys.clear());

    // drag & drop files onto the window (desktop / iPad)
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) this.openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    });
    this.bindPlayHud();
  }

  showInsertMenu(anchor: HTMLElement) {
    const groups = [...new Set(INSERTABLE.map(i => i.group))];
    const items: MenuItem[] = [];
    for (const g of groups) {
      items.push({ header: g });
      for (const i of INSERTABLE.filter(x => x.group === g)) items.push({ label: i.label, fn: () => this.insert(i.cls, i.shape) });
    }
    this.showMenu(anchor, items);
  }

  showMenu(anchor: HTMLElement, items: MenuItem[]) {
    document.querySelectorAll('.menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'menu';
    for (const it of items) {
      if ('sep' in it) { menu.appendChild(document.createElement('hr')); continue; }
      if ('header' in it) { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = it.header; menu.appendChild(h); continue; }
      const b = document.createElement('button');
      b.textContent = it.label;
      b.onclick = () => { menu.remove(); it.fn(); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left)) + 'px';
    menu.style.top = Math.min(window.innerHeight - mh - 8, r.bottom + 4) + 'px';
    const close = (e: Event) => { if (!menu.contains(e.target as Node)) { menu.remove(); window.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => window.addEventListener('pointerdown', close, true));
  }

  // ------------------------------------------------------------------ viewport input
  private bindViewport(canvas: HTMLCanvasElement) {
    let down: { x: number; y: number; t: number; id: number } | null = null;
    let pointers = 0;
    canvas.addEventListener('pointerdown', e => {
      pointers++;
      down = pointers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
    });
    const up = (e: PointerEvent) => {
      pointers = Math.max(0, pointers - 1);
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved > 8 || !quick || this.gizmo.dragging) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      if (this.play) { this.play.click(ray); return; }
      if ((this.gizmo as any).axis) return; // tapped on gizmo handle
      const hit = this.view.pick(ray);
      let target = hit?.inst ?? null;
      if (target && (target.get('Locked') as any)?.v) target = null;
      // clicking a part inside a Model selects the top-level model (like most editors); tap again to pick the part
      if (target) {
        let top: Instance = target;
        while (top.parent && top.parent.className === 'Model' && top.parent !== this.model.workspace) top = top.parent;
        if (top !== target && !this.selection.includes(top) && !this.selection.includes(target)) target = top;
      }
      this.select(target ? [target] : [], e.shiftKey || e.metaKey || e.ctrlKey);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => { pointers = Math.max(0, pointers - 1); down = null; });
  }

  private bindPlayHud() {
    const stick = this.el.stick, knob = this.el.knob;
    let stickId: number | null = null;
    let origin = { x: 0, y: 0 };
    stick.addEventListener('pointerdown', e => {
      stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      e.stopPropagation();
    });
    stick.addEventListener('pointermove', e => {
      if (e.pointerId !== stickId || !this.play) return;
      let dx = e.clientX - origin.x, dy = e.clientY - origin.y;
      const max = 46, len = Math.hypot(dx, dy);
      if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.play.input.x = dx / max;
      this.play.input.z = dy / max;
    });
    const release = () => {
      stickId = null;
      knob.style.transform = '';
      if (this.play) { this.play.input.x = 0; this.play.input.z = 0; }
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
    const jump = this.el.jump;
    jump.addEventListener('pointerdown', e => { e.stopPropagation(); if (this.play) this.play.input.jump = true; });
    const jr = () => { if (this.play) this.play.input.jump = false; };
    jump.addEventListener('pointerup', jr);
    jump.addEventListener('pointercancel', jr);
    jump.addEventListener('pointerleave', jr);

    // camera orbit while playing: drag anywhere else on the viewport, pinch / wheel to zoom
    const canvas = this.el.canvas;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    canvas.addEventListener('pointerdown', e => { if (this.play) { touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); } });
    canvas.addEventListener('pointermove', e => {
      if (!this.play || !touches.has(e.pointerId)) return;
      const prev = touches.get(e.pointerId)!;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 1) {
        this.play.camYaw -= (e.clientX - prev.x) * 0.008;
        this.play.camPitch = Math.max(-1.4, Math.min(0.6, this.play.camPitch - (e.clientY - prev.y) * 0.006));
      } else if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.play.camDist = Math.max(4, Math.min(80, this.play.camDist * (pinch / d)));
        pinch = d;
      }
    });
    const end = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = 0; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', e => { if (this.play) { this.play.camDist = Math.max(4, Math.min(80, this.play.camDist * (1 + e.deltaY * 0.001))); e.preventDefault(); } }, { passive: false });
  }

  resize() {
    const r = this.el.viewport.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  private last = performance.now();
  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.play) this.play.update();
    else {
      if (this.flyKeys.size) {
        const fwd = new THREE.Vector3();
        this.camera.getWorldDirection(fwd);
        const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
        const mv = new THREE.Vector3();
        if (this.flyKeys.has('w')) mv.add(fwd);
        if (this.flyKeys.has('s')) mv.sub(fwd);
        if (this.flyKeys.has('d')) mv.add(right);
        if (this.flyKeys.has('a')) mv.sub(right);
        if (this.flyKeys.has('e')) mv.y += 1;
        if (this.flyKeys.has('q')) mv.y -= 1;
        mv.multiplyScalar(40 * dt);
        this.camera.position.add(mv);
        this.orbit.target.add(mv);
      }
      this.orbit.update();
    }
    this.view.flush();
    this.renderer.render(this.view.scene, this.camera);
  };
}

type MenuItem = { label: string; fn: () => void } | { sep: true } | { header: string };

const TEMPLATE = /* html */ `
<header class="ribbon">
  <div class="brand"><img src="./logo.svg" alt="" /><span>AnyWay Studio</span></div>
  <div class="tools">
    <button data-el="btn_file" data-icon="file" title="File"><span>File</span></button>
    <span class="sep"></span>
    <button data-el="undo" data-icon="undo" title="Undo (Ctrl+Z)"></button>
    <button data-el="redo" data-icon="redo" title="Redo (Ctrl+Y)"></button>
    <span class="sep"></span>
    <div class="seg">
      <button data-el="tool_select" data-icon="select" title="Select"><span>Select</span></button>
      <button data-el="tool_move" data-icon="move" title="Move"><span>Move</span></button>
      <button data-el="tool_scale" data-icon="scale" title="Scale"><span>Scale</span></button>
      <button data-el="tool_rotate" data-icon="rotate" title="Rotate"><span>Rotate</span></button>
    </div>
    <button data-el="snap" data-icon="magnet" title="Snap to grid"></button>
    <button data-el="focus" data-icon="focus" title="Focus selection (F)"></button>
    <span class="sep"></span>
    <button data-el="btn_part" data-icon="part" title="Insert part"><span>Part</span></button>
    <button data-el="btn_script" data-icon="script" title="Insert script"><span>Script</span></button>
    <button data-el="btn_insert" data-icon="plus" title="Insert object"><span>Insert</span></button>
    <button data-el="btn_group" data-icon="group" title="Edit"><span>Edit</span></button>
    <span class="sep"></span>
    <button data-el="play" class="playbtn" title="Play test (F5)"><span class="pi">${ICON.play}</span><span class="si">${ICON.stop}</span><span class="pl">Play</span></button>
    <span class="grow"></span>
    <button data-el="btn_learn" data-icon="learn" title="Tutorials & videos"><span>Learn</span></button>
    <button data-el="btn_output" data-icon="output" title="Output"></button>
    <button data-el="btn_panels" data-icon="panel" class="phone-only" title="Explorer & Properties"></button>
  </div>
</header>
<main class="main">
  <div class="viewport" data-el="viewport">
    <canvas data-el="canvas"></canvas>
    <div class="hud" data-el="hud">
      <div class="stick" data-el="stick"><div class="knob" data-el="knob"></div></div>
      <button class="jump" data-el="jump">Jump</button>
      <button class="stopbtn" data-el="stopbtn" data-icon="stop"><span>Stop</span></button>
    </div>
    <div class="toasts" data-el="toasts"></div>
  </div>
  <aside class="side">
    <section class="panel explorer-panel"><h3>Explorer</h3><div data-el="explorer" class="explorer"></div></section>
    <section class="panel props-panel"><h3>Properties</h3><div data-el="properties" class="properties"></div></section>
  </aside>
</main>
<footer class="output" data-el="output">
  <div class="output-head"><b>Output</b><button data-el="clearlog">Clear</button></div>
  <div class="output-log" data-el="outputlog"></div>
</footer>
<div data-el="scripteditor" class="script-editor"></div>
<div data-el="learn" class="learn"></div>
`;
