import * as THREE from 'three';
import { DataModel, Instance, isPart, getSize, getCF, getColor, getNum, getShape, getBool } from '../core/instance';
import { materialLook } from './materials';

/** Binds a DataModel to a three.js scene: one mesh per BasePart, kept in sync via change events. */
export class SceneView {
  scene = new THREE.Scene();
  meshes = new Map<number, THREE.Mesh>();
  lights = new Map<number, THREE.Light>();
  model: DataModel | null = null;
  private unsub: (() => void) | null = null;
  private dirty = new Set<Instance>();
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  grid: THREE.GridHelper;

  constructor() {
    this.scene.background = new THREE.Color(0x9fd3ff);
    this.scene.fog = new THREE.Fog(0x9fd3ff, 400, 1600);
    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x6a6a72, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(80, 160, 60);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 500;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    this.grid = new THREE.GridHelper(512, 128, 0x000000, 0x000000);
    (this.grid.material as THREE.Material).opacity = 0.12;
    (this.grid.material as THREE.Material).transparent = true;
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
    this.buildSky();
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(1800, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d8bff) }, bottom: { value: new THREE.Color(0xd8ecff) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y*1.6+0.15,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0);}',
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -1;
    sky.name = '__sky';
    this.scene.add(sky);
  }

  bind(model: DataModel) {
    this.unbind();
    this.model = model;
    model.walk(i => this.add(i));
    this.unsub = model.on((kind, inst) => {
      if (kind === 'added') this.add(inst);
      else if (kind === 'removed') this.remove(inst);
      else this.dirty.add(inst);
    });
    this.applyLighting();
  }

  unbind() {
    this.unsub?.();
    this.unsub = null;
    for (const m of this.meshes.values()) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    for (const l of this.lights.values()) this.scene.remove(l);
    this.meshes.clear();
    this.lights.clear();
    this.model = null;
  }

  /** Called each frame: apply batched property changes. */
  flush() {
    if (!this.dirty.size) return;
    for (const i of this.dirty) {
      if (this.meshes.has(i.id)) this.updateMesh(i);
      else if (this.lights.has(i.id)) this.updateLight(i);
      else if (i.className === 'Lighting') this.applyLighting();
      else if (isPart(i) && i.model) this.add(i);
    }
    this.dirty.clear();
  }

  private inWorkspace(i: Instance) {
    let p = i.parent;
    while (p) { if (p.className === 'Workspace') return true; p = p.parent; }
    return false;
  }

  private add(i: Instance) {
    if (isPart(i) && this.inWorkspace(i) && !this.meshes.has(i.id)) {
      const mesh = new THREE.Mesh(geometryFor(i), new THREE.MeshStandardMaterial());
      mesh.userData.instId = i.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.meshes.set(i.id, mesh);
      this.updateMesh(i);
    } else if (/^(Point|Spot|Surface)Light$/.test(i.className) && i.parent && isPart(i.parent)) {
      const l = i.className === 'SpotLight' ? new THREE.SpotLight(0xffffff, 1, 16, Math.PI / 4) : new THREE.PointLight(0xffffff, 1, 16);
      this.lights.set(i.id, l);
      this.scene.add(l);
      this.updateLight(i);
    }
  }

  private remove(i: Instance) {
    const m = this.meshes.get(i.id);
    if (m) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); this.meshes.delete(i.id); }
    const l = this.lights.get(i.id);
    if (l) { this.scene.remove(l); this.lights.delete(i.id); }
  }

  updateMesh(i: Instance) {
    const mesh = this.meshes.get(i.id);
    if (!mesh) return;
    if (!this.inWorkspace(i)) { this.remove(i); return; }
    const shape = getShape(i);
    if (mesh.userData.shape !== shape) {
      mesh.geometry.dispose();
      mesh.geometry = geometryFor(i);
      mesh.userData.shape = shape;
    }
    applyTransform(mesh, i);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const [r, g, b] = getColor(i);
    const look = materialLook(getNum(i, 'Material', 256));
    mat.color.setRGB(r, g, b, THREE.SRGBColorSpace);
    mat.roughness = look.roughness;
    mat.metalness = look.metalness;
    if (look.map) {
      if (!mat.map || mat.map.source !== look.map.source) { mat.map?.dispose(); mat.map = look.map.clone(); }
      const s = getSize(i);
      const dims = [s.x, s.y, s.z].sort((a, b) => b - a);
      mat.map.repeat.set(Math.max(1, dims[0] / 6), Math.max(1, dims[1] / 6));
    } else if (mat.map) { mat.map.dispose(); mat.map = null; }
    mat.emissive.setRGB(look.neon ? r : 0, look.neon ? g : 0, look.neon ? b : 0, THREE.SRGBColorSpace);
    mat.emissiveIntensity = look.neon ? 1.4 : 0;
    const tr = Math.max(getNum(i, 'Transparency', 0), look.glass ? 0.45 : 0);
    mat.transparent = tr > 0;
    mat.opacity = 1 - tr;
    mat.depthWrite = tr < 0.5;
    mat.wireframe = look.forcefield;
    mat.needsUpdate = true;
    mesh.visible = tr < 1 || mesh.userData.forceVisible;
    mesh.castShadow = getBool(i, 'CastShadow', true) && tr < 0.9;
    for (const c of i.children) if (this.lights.has(c.id)) this.updateLight(c);
  }

  private updateLight(i: Instance) {
    const l = this.lights.get(i.id);
    if (!l || !i.parent) return;
    const c = i.get('Color');
    if (c?.t === 'Color3') l.color.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace);
    l.intensity = getNum(i, 'Brightness', 1) * 30;
    (l as THREE.PointLight).distance = getNum(i, 'Range', 16);
    l.visible = getBool(i, 'Enabled', true);
    const cfr = getCF(i.parent);
    l.position.set(cfr.p[0], cfr.p[1], cfr.p[2]);
  }

  applyLighting() {
    const L = this.model?.children.find(c => c.className === 'Lighting');
    if (!L) return;
    const t = getNum(L, 'ClockTime', 14);
    const ang = ((t - 6) / 12) * Math.PI; // 6 => sunrise, 18 => sunset
    const up = Math.sin(ang);
    this.sun.position.set(Math.cos(ang) * 160, Math.max(up, 0.05) * 180, 70);
    const day = Math.max(0, Math.min(1, up * 2 + 0.3));
    this.sun.intensity = 0.3 + 2.2 * day * (getNum(L, 'Brightness', 2) / 2);
    this.hemi.intensity = 0.35 + 0.8 * day;
    const amb = L.get('Ambient');
    if (amb?.t === 'Color3') this.hemi.groundColor.setRGB(0.25 + amb.r, 0.25 + amb.g, 0.25 + amb.b);
    const sky = this.scene.getObjectByName('__sky') as THREE.Mesh;
    const u = (sky.material as THREE.ShaderMaterial).uniforms;
    u.top.value.setRGB(0.24 * day + 0.02, 0.54 * day + 0.03, 1.0 * day + 0.1);
    u.bottom.value.setRGB(0.85 * day + 0.08, 0.92 * day + 0.08, 1.0 * day + 0.15);
    (this.scene.background as THREE.Color).copy(u.bottom.value);
    (this.scene.fog as THREE.Fog).color.copy(u.bottom.value);
  }

  pick(raycaster: THREE.Raycaster): { inst: Instance; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const hits = raycaster.intersectObjects([...this.meshes.values()].filter(m => m.visible || m.userData.forceVisible), false);
    for (const h of hits) {
      const inst = this.model?.byId(h.object.userData.instId);
      if (inst) {
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        return { inst, point: h.point, normal: n };
      }
    }
    return null;
  }
}

export function applyTransform(obj: THREE.Object3D, i: Instance) {
  const c = getCF(i), s = getSize(i), r = c.r;
  const m = new THREE.Matrix4().set(
    r[0], r[1], r[2], c.p[0],
    r[3], r[4], r[5], c.p[1],
    r[6], r[7], r[8], c.p[2],
    0, 0, 0, 1);
  m.decompose(obj.position, obj.quaternion, obj.scale);
  obj.scale.set(s.x, s.y, s.z);
}

// Unit-size geometries scaled by the part's Size.
const geoCache = new Map<number, THREE.BufferGeometry>();
export function geometryFor(i: Instance): THREE.BufferGeometry {
  const shape = getShape(i);
  const g = geoCache.get(shape);
  if (g) return g.clone();
  let geo: THREE.BufferGeometry;
  if (shape === 0) geo = new THREE.SphereGeometry(0.5, 32, 20);
  else if (shape === 2) { geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); geo.rotateZ(Math.PI / 2); } // cylinder axis = X
  else if (shape === 3) geo = wedgeGeometry();
  else if (shape === 4) geo = cornerWedgeGeometry();
  else geo = new THREE.BoxGeometry(1, 1, 1);
  geoCache.set(shape, geo);
  return geo.clone();
}

export function wedgeGeometry() {
  // slope rises toward -Z (front), like a classic ramp wedge
  const v = [
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5, // bottom 0-3
    -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, // top back edge 4-5
  ];
  const idx = [0, 1, 2, 0, 2, 3, /*back*/ 3, 2, 5, 3, 5, 4, /*slope*/ 0, 4, 5, 0, 5, 1, /*left*/ 0, 3, 4, /*right*/ 1, 5, 2];
  return flatGeometry(v, idx);
}
function cornerWedgeGeometry() {
  const v = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, -0.5];
  const idx = [0, 1, 2, 0, 2, 3, 0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0];
  return flatGeometry(v, idx);
}
function flatGeometry(v: number[], idx: number[]) {
  const pos: number[] = [];
  for (const k of idx) pos.push(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const uv: number[] = [];
  for (let k = 0; k < pos.length / 3; k++) uv.push(pos[k * 3] + 0.5, pos[k * 3 + 2] + 0.5);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}
