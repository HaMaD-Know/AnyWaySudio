// Open / save place files in the browser and inside the native iOS shell.
import { Capacitor } from '@capacitor/core';
import { DataModel } from '../core/instance';
import { isBinaryPlace, readBinaryPlace, writeBinaryPlace } from './rbxlBinary';
import { readXmlPlace, writeXmlPlace } from './rbxlXml';

export function loadPlace(bytes: Uint8Array): { model: DataModel; warnings: string[]; format: 'binary' | 'xml' } {
  if (isBinaryPlace(bytes)) {
    const { model, report } = readBinaryPlace(bytes);
    return { model, warnings: report.warnings, format: 'binary' };
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trimStart().startsWith('<roblox')) {
    const { model, warnings } = readXmlPlace(text);
    return { model, warnings, format: 'xml' };
  }
  throw new Error('This file is not a .rbxl / .rbxlx place file.');
}

export function pickFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    // iOS greys out files whose type it doesn't know if we restrict `accept`, so leave it open.
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.click();
  });
}

function toBase64(b: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  return btoa(s);
}

export async function savePlace(model: DataModel, baseName: string, format: 'rbxl' | 'rbxlx'): Promise<string> {
  const name = (baseName.replace(/\.(rbxlx?|rbxmx?)$/i, '') || 'Place') + '.' + format;
  const bytes = format === 'rbxl' ? writeBinaryPlace(model) : new TextEncoder().encode(writeXmlPlace(model));
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const res = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Documents, recursive: true });
    try {
      await Share.share({ title: name, files: [res.uri], dialogTitle: 'Export place file' });
    } catch { /* user dismissed share sheet; file is still saved in Documents */ }
    return `Saved ${name} to Files › On My iPhone › AnyWay Studio`;
  }
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return `Downloaded ${name}`;
}

export async function openExternal(url: string) {
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else window.open(url, '_blank', 'noopener');
}

// ---------- autosave (IndexedDB) ----------
const DB = 'anyway-studio';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kvSet(key: string, value: unknown) {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  } catch { /* storage unavailable */ }
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T | undefined>((res, rej) => { const tx = d.transaction('kv', 'readonly'); const g = tx.objectStore('kv').get(key); g.onsuccess = () => res(g.result as T); g.onerror = () => rej(g.error); });
  } catch { return undefined; }
}
