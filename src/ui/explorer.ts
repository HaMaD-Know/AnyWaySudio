import type { App } from '../editor/app';
import { Instance, isScript } from '../core/instance';
import { classBadge, ICON } from './icons';

const HIDDEN_ROOT = new Set(['Camera']);
const SERVICE_ORDER = ['Workspace', 'Players', 'Lighting', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Teams', 'SoundService'];

export class Explorer {
  expanded = new Set<string>(['Workspace']);
  private pending = false;
  private dragging: Instance | null = null;

  constructor(private app: App, private el: HTMLElement) {
    el.addEventListener('click', e => this.onClick(e));
    el.addEventListener('dblclick', e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
      const inst = row && this.find(row);
      if (inst && isScript(inst)) this.app.scriptEditor.open(inst);
      else if (inst) this.app.focusSelection();
    });
    // drag & drop reparenting (mouse / pencil / long-press drag)
    el.addEventListener('dragstart', e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
      this.dragging = row ? this.find(row) ?? null : null;
      e.dataTransfer?.setData('text/plain', 'inst');
    });
    el.addEventListener('dragover', e => { if (this.dragging) e.preventDefault(); });
    el.addEventListener('drop', e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
      const target = row ? this.find(row) : null;
      const d = this.dragging;
      this.dragging = null;
      if (!d || !target || d === target || d.isService || target.isDescendantOf(d)) return;
      e.preventDefault();
      d.setParent(target);
      this.app.commit();
    });
  }

  private key(i: Instance) { return i.fullName() + '#' + i.className; }

  scheduleRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }

  render() {
    const m = this.app.model;
    const sel = new Set(this.app.selection);
    // auto-expand ancestors of selection
    for (const s of sel) { let p = s.parent; while (p && p !== m) { this.expanded.add(this.key(p)); p = p.parent; } }
    const rows: string[] = [];
    const roots = m.children.filter(c => !HIDDEN_ROOT.has(c.className))
      .sort((a, b) => (SERVICE_ORDER.indexOf(a.className) + 1 || 99) - (SERVICE_ORDER.indexOf(b.className) + 1 || 99));
    const walk = (i: Instance, depth: number) => {
      if (rows.length > 3000) return;
      const k = this.key(i);
      const open = this.expanded.has(k);
      const kids = i.children.filter(c => !(depth === 1 && c.className === 'Camera') && c.className !== 'Terrain');
      rows.push(`<div class="row${sel.has(i) ? ' sel' : ''}" data-id="${i.id}" draggable="${!i.isService}" style="--d:${depth}">
        <span class="tw${kids.length ? '' : ' empty'}${open ? ' open' : ''}" data-tw="1">${kids.length ? ICON.chevron : ''}</span>
        ${classBadge(i.className)}<span class="nm">${esc(i.name)}</span></div>`);
      if (open) for (const c of kids) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    const scrollTop = this.el.scrollTop;
    this.el.innerHTML = rows.join('') + `<div class="explorer-actions">
      <button data-act="insert">${ICON.plus}<span>Insert</span></button>
      <button data-act="dup">${ICON.copy}<span>Duplicate</span></button>
      <button data-act="group">${ICON.group}<span>Group</span></button>
      <button data-act="del">${ICON.trash}<span>Delete</span></button>
      <label class="multi"><input type="checkbox" data-act="multi" ${this.multi ? 'checked' : ''}/> Multi-select</label>
    </div>`;
    this.el.scrollTop = scrollTop;
  }
  multi = false;

  private find(row: HTMLElement): Instance | undefined {
    const id = Number(row.dataset.id);
    let found: Instance | undefined;
    this.app.model.walk(i => { if (i.id === id) found = i; });
    return found;
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act) {
      if (act === 'insert') this.app.showInsertMenu(t.closest('button')!);
      else if (act === 'dup') this.app.duplicate();
      else if (act === 'group') this.app.group();
      else if (act === 'del') this.app.deleteSelection();
      else if (act === 'multi') this.multi = (t as HTMLInputElement).checked;
      return;
    }
    const row = t.closest<HTMLElement>('.row');
    if (!row) return;
    const inst = this.find(row);
    if (!inst) return;
    if (t.closest('[data-tw]')) {
      const k = this.key(inst);
      this.expanded.has(k) ? this.expanded.delete(k) : this.expanded.add(k);
      this.render();
      return;
    }
    this.app.select([inst], this.multi || e.shiftKey || e.metaKey || e.ctrlKey);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
