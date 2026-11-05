// Lightweight source transform so common Luau syntax runs on the Lua 5.3 VM.
// Handles: compound assignment (+= -= *= /= %= ^= ..=), `continue`, string
// interpolation with backticks, `!=`-free type annotations on locals/params/returns.

export function luauToLua(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let usesContinue = false;
  let inBlockComment = false;
  for (let line of lines) {
    if (inBlockComment) { out.push(line); if (line.includes(']]')) inBlockComment = false; continue; }
    if (/--\[(=*)\[/.test(line) && !line.includes(']]')) { inBlockComment = true; out.push(line); continue; }
    const { code, comment } = splitComment(line);
    let c = code;
    // string interpolation  `Hello {name}!`
    c = c.replace(/`([^`]*)`/g, (_m, body: string) => {
      const parts: string[] = [];
      let last = 0;
      body.replace(/\{([^}]*)\}/g, (m: string, expr: string, idx: number) => {
        if (idx > last) parts.push(JSON.stringify(body.slice(last, idx)));
        parts.push(`tostring(${expr})`);
        last = idx + m.length;
        return m;
      });
      if (last < body.length) parts.push(JSON.stringify(body.slice(last)));
      return parts.length ? '(' + parts.join(' .. ') + ')' : '""';
    });
    // compound assignment
    c = c.replace(/^(\s*)([A-Za-z_][\w.:\[\]"']*)\s*(\.\.|\/\/|[+\-*/%^])=\s*(.+?)\s*;?\s*$/, (_m, ind, lhs, op, rhs) => `${ind}${lhs} = ${lhs} ${op} (${rhs})`);
    // type annotations on locals:  local x: number = 1
    c = c.replace(/\blocal\s+([A-Za-z_]\w*(?:\s*:\s*[\w.?{}|<>\[\] ]+?)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*:\s*[\w.?{}|<>\[\] ]+?)?)*)\s*(=|$)/, (m, names: string, eq: string) => {
      if (!names.includes(':')) return m;
      return 'local ' + names.split(',').map(n => n.split(':')[0].trim()).join(', ') + (eq ? ' =' : '');
    });
    // function params and return type
    c = c.replace(/\bfunction(\s*[\w.:]*)\s*\(([^)]*)\)(\s*:\s*[\w.?{}|<>\[\]() ]+?)?(?=\s|$)/g, (_m, nm: string, params: string) => {
      const p = params.split(',').map(x => x.split(':')[0].trim()).filter(Boolean).join(', ');
      return `function${nm}(${p})`;
    });
    // type declarations
    if (/^\s*(export\s+)?type\s+\w+.*=/.test(c)) c = '-- ' + c;
    // continue -> goto
    if (/\bcontinue\b/.test(c)) { usesContinue = true; c = c.replace(/\bcontinue\b/g, 'goto __continue'); }
    out.push(c + comment);
  }
  let result = out.join('\n');
  if (usesContinue) result = insertContinueLabels(result);
  return result;
}

function splitComment(line: string): { code: string; comment: string } {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '-' && line[i + 1] === '-') return { code: line.slice(0, i), comment: line.slice(i) };
  }
  return { code: line, comment: '' };
}

/** Put `::__continue::` before the `end`/`until` that closes each loop containing a `goto __continue`. */
function insertContinueLabels(src: string): string {
  const tokens = /\b(function|do|then|elseif|repeat|end|until|goto __continue|for|while)\b/g;
  type Frame = { kind: 'loop' | 'block' | 'repeat'; hasContinue: boolean };
  const stack: Frame[] = [];
  let pendingLoop = false;
  let skipThen = false;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(src))) {
    const t = m[1];
    if (t === 'for' || t === 'while') { pendingLoop = true; continue; }
    if (t === 'elseif') { skipThen = true; continue; }
    if (t === 'then' && skipThen) { skipThen = false; continue; }
    if (t === 'do') { stack.push({ kind: pendingLoop ? 'loop' : 'block', hasContinue: false }); pendingLoop = false; }
    else if (t === 'then' || t === 'function') stack.push({ kind: 'block', hasContinue: false });
    else if (t === 'repeat') stack.push({ kind: 'repeat', hasContinue: false });
    else if (t === 'goto __continue') { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind !== 'block') { stack[k].hasContinue = true; break; } }
    else if (t === 'end' || t === 'until') {
      const f = stack.pop();
      if (f && f.kind !== 'block' && f.hasContinue) {
        out += src.slice(last, m.index) + '::__continue:: ';
        last = m.index;
      }
    }
  }
  return out + src.slice(last);
}
