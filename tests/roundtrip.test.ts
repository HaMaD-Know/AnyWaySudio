// Round-trip tests for the binary place format.  Run: npm test [path/to/file.rbxl ...]
import { readFileSync } from 'node:fs';
import { readBinaryPlace, writeBinaryPlace } from '../src/io/rbxlBinary';
import { lz4Compress, lz4Decompress } from '../src/io/lz4';
import { newPlace, Instance } from '../src/core/instance';
import { luauToLua } from '../src/play/luau';

let failures = 0;
const check = (name: string, ok: boolean, info = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`); if (!ok) failures++; };

function signature(root: Instance): string[] {
  const out: string[] = [];
  const walk = (i: Instance, path: string) => {
    const p = path + '/' + i.className + ':' + i.name;
    const props = [...i.props.entries()].filter(([, v]) => v.t !== 'Ref').sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + '=' + JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Array.from(x) : typeof x === 'number' ? Math.fround(x) : x)));
    out.push(p + ' {' + props.join(',') + '}');
    for (const c of i.children) walk(c, p);
  };
  for (const c of root.children) walk(c, '');
  return out.sort();
}

// LZ4
{
  const data = new TextEncoder().encode('hello hello hello hello world world world '.repeat(200) + 'xyz');
  const c = lz4Compress(data);
  const d = lz4Decompress(c, data.length);
  check('lz4 round-trip', d.length === data.length && d.every((b, i) => b === data[i]), `${data.length} -> ${c.length} bytes`);
}

// generated place
{
  const dm = newPlace('obby');
  const bytes = writeBinaryPlace(dm);
  const { model } = readBinaryPlace(bytes);
  const a = signature(dm), b = signature(model);
  check('generated obby place round-trips', JSON.stringify(a) === JSON.stringify(b), `${a.length} instances, ${bytes.length} bytes`);
  const again = writeBinaryPlace(model);
  check('re-encoding is stable', again.length === bytes.length);
}

// real files
for (const f of process.argv.slice(2)) {
  const buf = new Uint8Array(readFileSync(f));
  const { model, report } = readBinaryPlace(buf);
  check(`read ${f.split('/').pop()}`, report.instanceCount > 0, `${report.instanceCount} instances, ${report.warnings.length} skipped props`);
  for (const w of report.warnings.slice(0, 5)) console.log('   - ' + w);
  const ws = model.children.find(c => c.className === 'Workspace');
  check('  has Workspace', !!ws);
  const out = writeBinaryPlace(model);
  const { model: m2 } = readBinaryPlace(out);
  const a = signature(model), b = signature(m2);
  const same = JSON.stringify(a) === JSON.stringify(b);
  check('  write -> read preserves every decoded property', same, `${out.length} bytes`);
  if (!same) for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { console.log('   first diff:\n   ' + a[k].slice(0, 300) + '\n   ' + (b[k] ?? '').slice(0, 300)); break; }
}

// Luau transform
{
  const src = 'local x: number = 1\nx += 2\nfor i = 1, 3 do\n\tif i == 2 then continue end\n\tprint(`v={i}`)\nend\nlocal function f(a: number, b: string): number return a end';
  const out = luauToLua(src);
  check('luau transform', out.includes('x = x + (2)') && out.includes('goto __continue') && out.includes('::__continue::') && out.includes('local x =') && out.includes('function f(a, b)'), '');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll tests passed');
