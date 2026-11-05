import type { App } from '../editor/app';
import type { Instance } from '../core/instance';
import { ICON } from './icons';
import { luauToLua } from '../play/luau';
import * as fengari from 'fengari';

const { lauxlib, lua, to_luastring } = fengari as any;

const KW = /\b(and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while|continue)\b/g;
const GLOBALS = /\b(game|workspace|script|wait|task|print|warn|Instance|Vector3|CFrame|Color3|BrickColor|Enum|math|string|table|pairs|ipairs|require|tick|typeof|TweenInfo|UDim2|Vector2|spawn|delay|tostring|tonumber|pcall|error|select|type|setmetatable|getmetatable)\b/g;

export class ScriptEditor {
  inst: Instance | null = null;
  ta!: HTMLTextAreaElement;
  hl!: HTMLElement;
  gutter!: HTMLElement;
  status!: HTMLElement;

  constructor(private app: App, private el: HTMLElement) {
    el.innerHTML = `
      <div class="se-head">
        <span class="se-title"></span>
        <span class="se-status"></span>
        <span class="grow"></span>
        <button data-se="check">${ICON.check}<span>Check</span></button>
        <button data-se="snip">${ICON.plus}<span>Snippet</span></button>
        <button data-se="close">${ICON.close}<span>Close</span></button>
      </div>
      <div class="se-body">
        <pre class="se-gutter"></pre>
        <div class="se-code">
          <pre class="se-hl" aria-hidden="true"></pre>
          <textarea spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea>
        </div>
      </div>
      <div class="se-keys">
        ${['\t', '(', ')', '"', '=', '.', ':', '[', ']', '{', '}', '-', '+', '~', '#', 'end'].map(k => `<button data-key="${k === '"' ? '&quot;' : k}">${k === '\t' ? 'Tab' : k}</button>`).join('')}
      </div>`;
    this.ta = el.querySelector('textarea')!;
    this.hl = el.querySelector('.se-hl')!;
    this.gutter = el.querySelector('.se-gutter')!;
    this.status = el.querySelector('.se-status')!;
    this.ta.addEventListener('input', () => this.sync());
    this.ta.addEventListener('scroll', () => { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; this.gutter.scrollTop = this.ta.scrollTop; });
    this.ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); this.insertText('\t'); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const v = this.ta.value, p = this.ta.selectionStart;
        const lineStart = v.lastIndexOf('\n', p - 1) + 1;
        const line = v.slice(lineStart, p);
        let indent = line.match(/^\s*/)![0];
        if (/\b(then|do|function\b.*\)|else|repeat)\s*$/.test(line) || /\{\s*$/.test(line)) indent += '\t';
        this.insertText('\n' + indent);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); this.save(); }
      else if (e.key === 'Escape') this.close();
    });
    this.ta.addEventListener('blur', () => this.save());
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!b) return;
      if (b.dataset.key) { this.insertText(b.dataset.key); this.ta.focus(); }
      else if (b.dataset.se === 'close') this.close();
      else if (b.dataset.se === 'check') this.check(true);
      else if (b.dataset.se === 'snip') this.app.showMenu(b, SNIPPETS.map(s => ({ label: s.name, fn: () => { this.insertText(s.code); this.ta.focus(); } })));
    });
  }

  open(inst: Instance) {
    this.save();
    this.inst = inst;
    const s = inst.get('Source');
    this.ta.value = s?.t === 'String' ? s.v : '';
    this.el.querySelector('.se-title')!.textContent = `${inst.name}  ·  ${inst.className}`;
    this.el.classList.add('open');
    this.ta.readOnly = this.app.play !== null;
    this.sync();
    this.check(false);
    setTimeout(() => this.ta.focus({ preventScroll: true }), 50);
  }

  close() {
    this.save();
    this.inst = null;
    this.el.classList.remove('open');
  }

  save() {
    if (!this.inst || this.app.play) return;
    const cur = this.inst.get('Source');
    if (cur?.t === 'String' && cur.v === this.ta.value) return;
    this.inst.set('Source', { t: 'String', v: this.ta.value });
    this.app.commit();
  }

  private insertText(t: string) {
    const ta = this.ta;
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.setRangeText(t, a, b, 'end');
    this.sync();
  }

  private syncTimer = 0;
  private sync() {
    const v = this.ta.value;
    this.hl.innerHTML = highlight(v) + '\n';
    const n = v.split('\n').length;
    let g = '';
    for (let k = 1; k <= n; k++) g += k + '\n';
    this.gutter.textContent = g;
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.check(false), 600);
  }

  /** Compile the script to report syntax errors without running it. */
  check(verbose: boolean) {
    const L = lauxlib.luaL_newstate();
    const res = lauxlib.luaL_loadbuffer(L, to_luastring(luauToLua(this.ta.value)), null, to_luastring('=' + (this.inst?.name ?? 'Script')));
    if (res !== 0) {
      const msg = lua.lua_tojsstring(L, -1);
      this.status.textContent = '⚠ ' + msg;
      this.status.className = 'se-status err';
      if (verbose) this.app.log(msg, 'error');
    } else {
      this.status.textContent = 'No syntax errors';
      this.status.className = 'se-status ok';
      if (verbose) this.app.toast('No syntax errors');
    }
  }
}

function esc(s: string) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

export function highlight(src: string): string {
  // tokenise strings & comments first so keywords inside them aren't coloured
  const out: string[] = [];
  const re = /(--\[\[[\s\S]*?\]\]|--[^\n]*)|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`[^`]*`?|\[\[[\s\S]*?\]\])|(\b\d+(?:\.\d+)?\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const code = (s: string) => esc(s).replace(KW, '<b class="k">$1</b>').replace(GLOBALS, '<b class="g">$1</b>').replace(/\b([A-Za-z_]\w*)(?=\s*\()/g, '<i class="f">$1</i>');
  while ((m = re.exec(src))) {
    out.push(code(src.slice(last, m.index)));
    if (m[1]) out.push(`<i class="c">${esc(m[1])}</i>`);
    else if (m[2]) out.push(`<i class="s">${esc(m[2])}</i>`);
    else out.push(`<i class="n">${m[3]}</i>`);
    last = m.index + m[0].length;
  }
  out.push(code(src.slice(last)));
  return out.join('');
}

export const SNIPPETS = [
  { name: 'Touched event', code: 'script.Parent.Touched:Connect(function(hit)\n\tlocal humanoid = hit.Parent:FindFirstChild("Humanoid")\n\tif humanoid then\n\t\tprint(hit.Parent.Name .. " touched me")\n\tend\nend)\n' },
  { name: 'Kill brick', code: 'script.Parent.Touched:Connect(function(hit)\n\tlocal humanoid = hit.Parent:FindFirstChild("Humanoid")\n\tif humanoid then\n\t\thumanoid.Health = 0\n\tend\nend)\n' },
  { name: 'Loop forever', code: 'while true do\n\t\n\ttask.wait(1)\nend\n' },
  { name: 'Leaderstats', code: 'game.Players.PlayerAdded:Connect(function(player)\n\tlocal leaderstats = Instance.new("Folder")\n\tleaderstats.Name = "leaderstats"\n\tleaderstats.Parent = player\n\n\tlocal coins = Instance.new("IntValue")\n\tcoins.Name = "Coins"\n\tcoins.Value = 0\n\tcoins.Parent = leaderstats\nend)\n' },
  { name: 'Click detector', code: 'local detector = Instance.new("ClickDetector")\ndetector.Parent = script.Parent\n\ndetector.MouseClick:Connect(function(player)\n\tscript.Parent.BrickColor = BrickColor.Random()\nend)\n' },
  { name: 'Tween a part', code: 'local TweenService = game:GetService("TweenService")\nlocal part = script.Parent\nlocal info = TweenInfo.new(2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true)\nlocal tween = TweenService:Create(part, info, { Position = part.Position + Vector3.new(0, 10, 0) })\ntween:Play()\n' },
  { name: 'Spin a part', code: 'local part = script.Parent\nwhile true do\n\tpart.CFrame = part.CFrame * CFrame.Angles(0, math.rad(3), 0)\n\ttask.wait()\nend\n' },
  { name: 'Color cycle', code: 'local part = script.Parent\nlocal hue = 0\nwhile true do\n\thue = (hue + 0.01) % 1\n\tpart.Color = Color3.fromHSV(hue, 1, 1)\n\ttask.wait(0.03)\nend\n' },
  { name: 'Speed boost pad', code: 'local pad = script.Parent\npad.Touched:Connect(function(hit)\n\tlocal humanoid = hit.Parent:FindFirstChild("Humanoid")\n\tif humanoid then\n\t\thumanoid.WalkSpeed = 40\n\t\ttask.wait(3)\n\t\thumanoid.WalkSpeed = 16\n\tend\nend)\n' },
];
