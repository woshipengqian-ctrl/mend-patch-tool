// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Move edits that succeeded, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
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

/* ---------- files as lines (SPEC.md section 3) ---------- */

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinFile(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

/* ---------- matching lines (SPEC.md section 5) ---------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** One entry of N: a new line (ctx < 0) or a context line (ctx: its index in O). */
interface NLine {
  text: string;
  ctx: number;
}

function occurrences(lines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const ps = occurrences(lines, O, t, from, eofOnly);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

/** Replace the O.length lines at pos by N, per section 5 (context lines are the file's own; tier 2 re-indents). */
function applyMatch(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const F = leadWs(lines[pos]!);
  const P = leadWs(O[0]!);
  for (const n of N) {
    if (n.ctx >= 0) out.push(lines[pos + n.ctx]!);
    else if (tier === 2 && !/^[ \t]*$/.test(n.text) && n.text.startsWith(P)) out.push(F + n.text.slice(P.length));
    else out.push(n.text);
  }
  for (let i = pos + O.length; i < lines.length; i++) out.push(lines[i]!);
  return out;
}

/** Split tagged body lines (' ', '-', '+') into O and N. */
function onOf(body: { tag: string; text: string }[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.tag === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.tag === '-') O.push(b.text);
    else if (b.tag === '+') N.push({ text: b.text, ctx: -1 });
  }
  return { O, N };
}

/* ---------- format detection (SPEC.md section 4) ---------- */

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

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface UBodyLine {
  tag: string;
  text: string;
  emptyLine: boolean;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  diffOld: string | null;
  diffNew: string | null;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newMode: boolean;
  delMode: boolean;
  hunks: UHunk[];
}

/** True when a hunk body ends without a final line break: a `\` line follows its last context or `+` line. */
function hunkNoBreak(body: UBodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const t = body[k]!.tag;
    if (t === ' ' || t === '+') return k + 1 < body.length && body[k + 1]!.tag === '\\';
  }
  return false;
}

function applyUnifiedHunks(fl: FileLines, hunks: UHunk[], strict: boolean, path: string): FileLines {
  let lines = fl.lines;
  let fin = fl.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = onOf(h.body);
    const noBreak = hunkNoBreak(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      const texts = N.map((n) => n.text);
      lines = [...lines.slice(0, at), ...texts, ...lines.slice(at)];
      if (atEnd) fin = !noBreak;
      d += texts.length;
    } else {
      const f = findTier(lines, O, strict);
      if (f === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = f.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of f.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const runsToEnd = pos + O.length === lines.length;
      lines = applyMatch(lines, pos, O, N, f.tier);
      if (runsToEnd) fin = !noBreak;
      d += N.length - O.length;
    }
  }
  return { br: fl.br, lines, final: fin };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.hdrOld !== undefined) {
    oldP = sec.hdrOld;
    newP = sec.hdrNew!;
  } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
    oldP = sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    newP = sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  } else {
    oldP = sec.diffOld;
    newP = sec.diffNew;
  }
  const creation = oldP === null || sec.newMode;
  const deletion = !creation && (newP === null || sec.delMode);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (creation) {
      const np = newP !== null ? newP : oldP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const clines: string[] = [];
      let lastPlus: { body: UBodyLine[]; idx: number } | null = null;
      for (const h of sec.hunks) {
        h.body.forEach((b, idx) => {
          if (b.tag === '+') {
            clines.push(b.text);
            lastPlus = { body: h.body, idx };
          }
        });
      }
      let fin = true;
      if (lastPlus !== null) {
        const lp: { body: UBodyLine[]; idx: number } = lastPlus;
        fin = !(lp.idx + 1 < lp.body.length && lp.body[lp.idx + 1]!.tag === '\\');
      }
      tree.now.set(np, joinFile({ br: '\n', lines: clines, final: fin }));
      return;
    }
    if (deletion) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    const src = tree.get(op);
    if (src === null) throw new Fail('missing', op);
    if (np !== op && tree.get(np) !== null) throw new Fail('exists', np);
    const out = applyUnifiedHunks(splitFile(src), sec.hunks, strict, op);
    tree.now.set(np, joinFile(out));
    if (np !== op) {
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: USection | null = null;
  let phase: 'header' | 'hunks' = 'header';
  const newSec = (): USection => ({
    diffOld: null,
    diffNew: null,
    hdrOld: undefined,
    hdrNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newMode: false,
    delMode: false,
    hunks: [],
  });
  const flush = (): void => {
    if (sec !== null) {
      edits.push(unifiedEdit(sec, strict));
      sec = null;
    }
  };
  const hdrPath = (l: string): string | null => {
    let rest = l.slice(4);
    const tab = rest.indexOf('\t');
    if (tab >= 0) rest = rest.slice(0, tab);
    const p = rest.trim();
    if (p === '/dev/null') return null;
    return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  };
  const isPair = (i: number): boolean => (lines[i] ?? '').startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      sec = newSec();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      phase = 'header';
      i++;
      continue;
    }
    if (L.startsWith('--- ')) {
      if (sec !== null && phase === 'header' && sec.hdrOld === undefined) {
        if (!isPair(i)) throw new Exit2(`error: parse ${i + 2}`);
        sec.hdrOld = hdrPath(L);
        sec.hdrNew = hdrPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (isPair(i)) {
        flush();
        sec = newSec();
        sec.hdrOld = hdrPath(L);
        sec.hdrNew = hdrPath(lines[i + 1]!);
        phase = 'header';
        i += 2;
        continue;
      }
      if (sec !== null && phase === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec !== null && phase === 'header' && !L.startsWith('@@')) {
      if (L.startsWith('rename from ')) sec.renameFrom = L.slice(12);
      else if (L.startsWith('rename to ')) sec.renameTo = L.slice(10);
      else if (L.startsWith('new file mode')) sec.newMode = true;
      else if (L.startsWith('deleted file mode')) sec.delMode = true;
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      phase = 'hunks';
      const body: UBodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (isPair(j)) break;
        if (bl === '') {
          body.push({ tag: ' ', text: '', emptyLine: true });
          j++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ tag: c, text: bl.slice(1), emptyLine: false });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyLine) body.pop();
      sec.hunks.push({ a: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    i++;
  }
  flush();
  return edits;
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

interface SRBlock {
  path: string;
  oldL: string[];
  newL: string[];
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  const p = b.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldL.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ br: '\n', lines: b.newL, final: true }));
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const fl = splitFile(text);
    const f = findTier(fl.lines, b.oldL, strict);
    if (f === null) throw new Fail('no-match', p);
    if (f.positions.length > 1) throw new Fail('ambiguous', p);
    const N: NLine[] = b.newL.map((t) => ({ text: t, ctx: -1 }));
    const out = applyMatch(fl.lines, f.positions[0]!, b.oldL, N, f.tier);
    tree.now.set(p, joinFile({ br: fl.br, lines: out, final: fl.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = i + 1;
    const oldL: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      oldL.push(lines[k]!);
      k++;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    k++;
    const newL: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newL.push(lines[k]!);
      k++;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldL, newL });
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { tag: string; text: string }[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | undefined;
  chunks: VChunk[];
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  const p = s.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ br: '\n', lines: s.addLines, final: true }));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const np = s.moveTo;
    if (np !== undefined && !safe(np)) throw new Fail('unsafe', np);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (np !== undefined && tree.get(np) !== null) throw new Fail('exists', np);
    const fl = splitFile(text);
    let lines = fl.lines;
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let pos = -1;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && pos < 0; t++) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(lines[k]!, ch.anchor, t)) {
              pos = k;
              break;
            }
          }
        }
        if (pos < 0) throw new Fail('no-match', p);
        cursor = pos + 1;
      }
      const { O, N } = onOf(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        const texts = N.map((n) => n.text);
        lines = [...lines.slice(0, at), ...texts, ...lines.slice(at)];
        cursor = at + texts.length;
      } else {
        const f = findTier(lines, O, strict, cursor, ch.eof);
        if (f === null) throw new Fail('no-match', p);
        const pos = f.positions[0]!;
        lines = applyMatch(lines, pos, O, N, f.tier);
        cursor = pos + N.length;
      }
    }
    const out = joinFile({ br: fl.br, lines, final: fl.final });
    if (np !== undefined) {
      tree.now.set(np, out);
      tree.now.set(p, null);
      tree.moves.push([p, np]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i++;
      continue;
    }
    const kind = secStart(L);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const marker = kind === 'add' ? '*** Add File:' : kind === 'del' ? '*** Delete File:' : '*** Update File:';
    const path = L.slice(marker.length).trim();
    const secLine = i + 1;
    let j = i + 1;
    const bodyIdx: number[] = [];
    while (j < last && secStart(lines[j]!) === null) {
      bodyIdx.push(j);
      j++;
    }
    while (bodyIdx.length > 0 && blank(lines[bodyIdx[bodyIdx.length - 1]!]!)) bodyIdx.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const bi of bodyIdx) {
        const bl = lines[bi]!;
        if (bl.startsWith('+')) addLines.push(bl.slice(1));
        else if (bl === '') addLines.push('');
        else throw new Exit2(`error: parse ${bi + 1}`);
      }
      sections.push({ kind, path, line: secLine, addLines, moveTo: undefined, chunks: [] });
    } else if (kind === 'del') {
      if (bodyIdx.length > 0) throw new Exit2(`error: parse ${bodyIdx[0]! + 1}`);
      sections.push({ kind, path, line: secLine, addLines: [], moveTo: undefined, chunks: [] });
    } else {
      let moveTo: string | undefined;
      let start = 0;
      if (bodyIdx.length > 0 && lines[bodyIdx[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[bodyIdx[0]!]!.slice('*** Move to:'.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = start; k < bodyIdx.length; k++) {
        const bi = bodyIdx[k]!;
        const bl = lines[bi]!;
        if (bl.startsWith('@@')) {
          cur = { anchor: bl.slice(2).trim() || null, eof: false, body: [] };
          chunks.push(cur);
        } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ tag: bl === '' ? ' ' : bl[0]!, text: bl === '' ? '' : bl.slice(1) });
        } else if (bl.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else cur.eof = true;
        } else {
          throw new Exit2(`error: parse ${bi + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine}`);
      sections.push({ kind, path, line: secLine, addLines: [], moveTo, chunks });
    }
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

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

/* ---------- the run (SPEC.md sections 1, 2 and 10) ---------- */

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mlen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = mlen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const p of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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
