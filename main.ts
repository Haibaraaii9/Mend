// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its line break and whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in `file` at `tier`, at or after `from`. */
function occurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function matchesAt(file: string[], o: string[], at: number, tier: number): boolean {
  if (at < 0 || at + o.length > file.length) return false;
  for (let j = 0; j < o.length; j++) {
    if (!lineEq(file[at + j]!, o[j]!, tier)) return false;
  }
  return true;
}

/** The first tier (0, 1, 2) at which O occurs in `file` at or after `from`, or -1. */
function findTier(file: string[], o: string[], strict: boolean, from = 0): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(file, o, t, from).length > 0) return t;
  }
  return -1;
}

/** Re-indent one line of N at tier 2 (SPEC.md section 5); other tiers write the line as it is. */
function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]*$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One body line of a hunk or a V4A chunk: context, old, new, or a backslash line. */
type BodyItem = { kind: ' ' | '-' | '+' | '\\'; text: string };

/** O (context and old lines) and N (context and new lines) of a body, each context line of N naming its index in O. */
function splitBody(body: BodyItem[]): { o: string[]; n: { text: string; ctx: number }[] } {
  const o: string[] = [];
  const n: { text: string; ctx: number }[] = [];
  for (const it of body) {
    if (it.kind === ' ') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === '-') {
      o.push(it.text);
    } else if (it.kind === '+') {
      n.push({ text: it.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const it = body[i]!;
    if (it.kind === ' ' || it.kind === '+') {
      return body[i + 1] !== undefined && body[i + 1]!.kind === '\\';
    }
  }
  return false;
}

/** N with context lines taken from the file's own matched lines and the rest re-indented at tier 2. */
function buildN(n: { text: string; ctx: number }[], file: string[], at: number, tier: number, p: string): string[] {
  const f = leadWs(file[at] ?? '');
  return n.map((it) => (it.ctx >= 0 ? file[at + it.ctx]! : reindent(it.text, tier, f, p)));
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  c: number;
  body: BodyItem[];
  oLen: number;
  nLen: number;
}

interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  headerOld: string | null | undefined;
  headerNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseDiffPath(s: string): string {
  return s.split('\t')[0]!.trim();
}

function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function applyUnifiedHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { o, n } = splitBody(h.body);
  if (o.length > 0) {
    const tier = findTier(state.lines, o, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(state.lines, o, tier);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    for (const pos of occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const replacement = buildN(n, state.lines, best, tier, leadWs(o[0]!));
    const touchesEnd = best + o.length === state.lines.length;
    const lines = [...state.lines.slice(0, best), ...replacement, ...state.lines.slice(best + o.length)];
    return { br: state.br, lines, final: touchesEnd ? !backslashAfterLast(h.body) : state.final };
  }
  const pos = Math.min(h.a + d, state.lines.length);
  const touchesEnd = pos === state.lines.length;
  const lines = [...state.lines.slice(0, pos), ...n.map((it) => it.text), ...state.lines.slice(pos)];
  return { br: state.br, lines, final: touchesEnd ? !backslashAfterLast(h.body) : state.final };
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  if (s.headerOld !== undefined || s.headerNew !== undefined) {
    oldPath = s.headerOld;
    newPath = s.headerNew;
  } else if (s.renameFrom !== undefined || s.renameTo !== undefined) {
    oldPath = s.renameFrom;
    newPath = s.renameTo;
  } else {
    oldPath = s.diffOld;
    newPath = s.diffNew;
  }
  return (tree) => {
    const isCreation = s.newFile || oldPath === null;
    const isDeletion = s.deletedFile || newPath === null;
    if (isCreation) {
      const p = newPath;
      if (typeof p !== 'string') throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastBackslash = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const it = h.body[k]!;
          if (it.kind === '+') {
            plus.push(it.text);
            lastBackslash = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastBackslash ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = oldPath;
      if (typeof p !== 'string') throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (typeof oldPath !== 'string' || typeof newPath !== 'string') throw new Fail('unsafe', '');
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let state = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      state = applyUnifiedHunk(state, h, d, strict, oldPath);
      d += h.nLen - h.oLen;
    }
    const content = joinFile(state);
    if (isMove) {
      tree.now.set(newPath, content);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, content);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  let hasHeaderPair = false;
  let hasHunk = false;

  const endHunk = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') curHunk.body.pop();
        else break;
      }
      curHunk = null;
    }
  };
  const newSection = (): Section => {
    const s: Section = {
      diffOld: undefined,
      diffNew: undefined,
      headerOld: undefined,
      headerNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      const next = lines[i + 1];
      const continues =
        line === '' ||
        line.startsWith(' ') ||
        line.startsWith('+') ||
        line.startsWith('\\') ||
        (line.startsWith('-') && !(line.startsWith('--- ') && (next ?? '').startsWith('+++ ')));
      if (continues) {
        if (line === '') curHunk.body.push({ kind: ' ', text: '' });
        else if (line.startsWith('\\')) curHunk.body.push({ kind: '\\', text: line.slice(1) });
        else curHunk.body.push({ kind: line[0] as ' ' | '-' | '+', text: line.slice(1) });
        i++;
        continue;
      }
      endHunk();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!.trim();
      hasHeaderPair = false;
      hasHunk = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !hasHunk && !hasHeaderPair) {
        cur.headerOld = stripAB(parseDiffPath(line.slice(4)));
        cur.headerNew = stripAB(parseDiffPath(lines[i + 1]!.slice(4)));
        hasHeaderPair = true;
      } else {
        cur = newSection();
        cur.headerOld = stripAB(parseDiffPath(line.slice(4)));
        cur.headerNew = stripAB(parseDiffPath(lines[i + 1]!.slice(4)));
        hasHeaderPair = true;
        hasHunk = false;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1]!, 10), c: parseInt(m[3]!, 10), body: [], oLen: 0, nLen: 0 };
      cur.hunks.push(h);
      curHunk = h;
      hasHunk = true;
      i++;
      continue;
    }
    if (cur !== null && !hasHunk) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  endHunk();
  for (const s of sections) {
    for (const h of s.hunks) {
      const { o, n } = splitBody(h.body);
      h.oLen = o.length;
      h.nLen = n.length;
    }
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const tier = findTier(f.lines, oldLines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(f.lines, oldLines, tier);
    if (occ.length !== 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const replacement = newLines.map((l) => reindent(l, tier, leadWs(f.lines[pos]!), leadWs(oldLines[0]!)));
    const lines = [...f.lines.slice(0, pos), ...replacement, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: f.br, lines, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyV4aChunk(state: FileState, ch: V4aChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  const { o, n } = splitBody(ch.body);
  let cur = cursor;
  if (ch.anchor !== null && ch.anchor !== '') {
    let found = -1;
    const max = strict ? 0 : 2;
    for (let t = 0; t <= max && found < 0; t++) {
      for (let i = cur; i < state.lines.length; i++) {
        if (lineEq(state.lines[i]!, ch.anchor, t)) {
          found = i;
          break;
        }
      }
    }
    if (found < 0) throw new Fail('no-match', path);
    cur = found + 1;
  }
  if (o.length === 0) {
    const pos = ch.eof ? state.lines.length : cur;
    const lines = [...state.lines.slice(0, pos), ...n.map((it) => it.text), ...state.lines.slice(pos)];
    return { state: { br: state.br, lines, final: state.final }, cursor: pos + n.length };
  }
  let tier = -1;
  let pos = -1;
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (ch.eof) {
      const cand = state.lines.length - o.length;
      if (cand >= cur && matchesAt(state.lines, o, cand, t)) {
        tier = t;
        pos = cand;
        break;
      }
    } else {
      const occ = occurrences(state.lines, o, t, cur);
      if (occ.length > 0) {
        tier = t;
        pos = occ[0]!;
        break;
      }
    }
  }
  if (tier < 0 || pos < 0) throw new Fail('no-match', path);
  const replacement = buildN(n, state.lines, pos, tier, leadWs(o[0]!));
  const lines = [...state.lines.slice(0, pos), ...replacement, ...state.lines.slice(pos + o.length)];
  return { state: { br: state.br, lines, final: state.final }, cursor: pos + replacement.length };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(state, ch, cursor, strict, path);
      state = r.state;
      cursor = r.cursor;
    }
    const content = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(moveTo, content);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let m = /^\*\*\* Add File:(.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      i++;
      const raw: { no: number; text: string }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    m = /^\*\*\* Delete File:(.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      i++;
      const raw: { no: number; text: string }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    m = /^\*\*\* Update File:(.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      const updNo = i + 1;
      i++;
      const raw: { no: number; text: string }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      while (k < raw.length && raw[k]!.text === '') k++;
      if (k < raw.length) {
        const mm = /^\*\*\* Move to:(.*)$/.exec(raw[k]!.text);
        if (mm !== null) {
          moveTo = mm[1]!.trim();
          raw.splice(0, k + 1);
        }
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      for (const r of raw) {
        const l = r.text;
        if (l.startsWith('@@')) {
          closeChunk();
          curChunk = { anchor: l.slice(2).trim(), body: [], eof: false };
        } else if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${r.no}`);
          curChunk.eof = true;
          closeChunk();
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            curChunk = { anchor: null, body: [], eof: false };
          }
          curChunk.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: the command line, output and the write         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : undefined;
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : undefined;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && nowNew !== undefined) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
