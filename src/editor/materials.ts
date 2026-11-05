import * as THREE from 'three';

/** Material enum values used by .rbxl files. */
export const MATERIALS: [string, number][] = [
  ['Plastic', 256], ['SmoothPlastic', 272], ['Neon', 288], ['Wood', 512], ['WoodPlanks', 528], ['Marble', 784], ['Slate', 800],
  ['Concrete', 816], ['Granite', 832], ['Brick', 848], ['Pebble', 864], ['Cobblestone', 880], ['Rock', 896], ['Sandstone', 912],
  ['CorrodedMetal', 1040], ['DiamondPlate', 1056], ['Foil', 1072], ['Metal', 1088], ['Grass', 1280], ['LeafyGrass', 1284],
  ['Sand', 1296], ['Fabric', 1312], ['Snow', 1328], ['Mud', 1344], ['Ground', 1360], ['Asphalt', 1376], ['Salt', 1392],
  ['Ice', 1536], ['Glacier', 1552], ['Glass', 1568], ['ForceField', 1584], ['Cardboard', 1600],
];
export const materialName = (v: number) => MATERIALS.find(m => m[1] === v)?.[0] ?? `Material(${v})`;

type Look = { roughness: number; metalness: number; neon?: boolean; glass?: boolean; forcefield: boolean; map?: THREE.Texture };
const cache = new Map<number, Look>();

function noiseTex(draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s, s);
  draw(g, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function speckle(g: CanvasRenderingContext2D, s: number, n: number, a: number, size = 2) {
  for (let i = 0; i < n; i++) {
    const v = Math.floor(255 - Math.random() * 90);
    g.fillStyle = `rgba(${v},${v},${v},${a})`;
    g.fillRect(Math.random() * s, Math.random() * s, size, size);
  }
}

export function materialLook(v: number): Look {
  const hit = cache.get(v);
  if (hit) return hit;
  const name = materialName(v);
  let look: Look = { roughness: 0.6, metalness: 0, forcefield: false };
  switch (name) {
    case 'SmoothPlastic': look.roughness = 0.35; break;
    case 'Neon': look = { roughness: 0.4, metalness: 0, neon: true, forcefield: false }; break;
    case 'Glass': look = { roughness: 0.05, metalness: 0.1, glass: true, forcefield: false }; break;
    case 'Ice': case 'Glacier': look.roughness = 0.1; break;
    case 'ForceField': look.forcefield = true; break;
    case 'Metal': case 'Foil': look = { roughness: 0.3, metalness: 0.85, forcefield: false }; break;
    case 'CorrodedMetal': look = { roughness: 0.8, metalness: 0.5, forcefield: false, map: noiseTex((g, s) => speckle(g, s, 900, 0.6, 3)) }; break;
    case 'DiamondPlate': look = { roughness: 0.35, metalness: 0.8, forcefield: false, map: noiseTex((g, s) => { g.strokeStyle = 'rgba(120,120,120,0.8)'; g.lineWidth = 3; for (let y = 0; y < s; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < s; x += 16) { g.beginPath(); g.moveTo(x, y + 2); g.lineTo(x + 6, y + 8); g.stroke(); } }) }; break;
    case 'Wood': case 'WoodPlanks': look.roughness = 0.75; look.map = noiseTex((g, s) => { for (let y = 0; y < s; y += 2) { const v = 200 + Math.sin(y * 0.35) * 30 + Math.random() * 20; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, s, 2); } if (name === 'WoodPlanks') { g.fillStyle = 'rgba(60,60,60,0.7)'; for (let y = 0; y < s; y += 32) g.fillRect(0, y, s, 2); } }); break;
    case 'Brick': look.roughness = 0.9; look.map = noiseTex((g, s) => { g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, s, s); g.fillStyle = '#fff'; for (let r = 0; r < 8; r++) for (let c = -1; c < 4; c++) g.fillRect(c * 36 + (r % 2) * 18 + 2, r * 16 + 2, 32, 12); }); break;
    case 'Cobblestone': case 'Pebble': case 'Rock': look.roughness = 0.95; look.map = noiseTex((g, s) => { for (let i = 0; i < 60; i++) { const v = 170 + Math.random() * 85; g.fillStyle = `rgb(${v},${v},${v})`; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 6 + Math.random() * 10, 0, 7); g.fill(); } }); break;
    case 'Grass': case 'LeafyGrass': case 'Sand': case 'Snow': case 'Ground': case 'Mud': case 'Concrete': case 'Granite': case 'Slate': case 'Asphalt': case 'Sandstone': case 'Salt':
      look.roughness = 0.95; look.map = noiseTex((g, s) => speckle(g, s, name === 'Grass' || name === 'LeafyGrass' ? 2200 : 1200, 0.55, name === 'Grass' ? 1 : 2)); break;
    case 'Fabric': case 'Cardboard': look.roughness = 1; look.map = noiseTex((g, s) => { g.strokeStyle = 'rgba(150,150,150,0.5)'; for (let i = 0; i < s; i += 3) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke(); } }); break;
    case 'Marble': look.roughness = 0.2; look.map = noiseTex((g, s) => { g.strokeStyle = 'rgba(140,140,140,0.5)'; for (let i = 0; i < 8; i++) { g.beginPath(); g.moveTo(0, Math.random() * s); g.bezierCurveTo(s / 3, Math.random() * s, (2 * s) / 3, Math.random() * s, s, Math.random() * s); g.stroke(); } }); break;
  }
  cache.set(v, look);
  return look;
}
