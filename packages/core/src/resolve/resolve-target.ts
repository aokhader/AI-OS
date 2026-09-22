import type { A11yNode, Strategy, TargetSpec } from '../schema/index.js';

/**
 * Target resolution: a pure function over an observation's nodes. Walks the strategies in order
 * and succeeds only when exactly one candidate matches. Reports which strategy resolved and how
 * many candidates it saw so replay can compare with the discovery baseline (D-016).
 */
export type Resolution =
  | { found: true; ref: string; node: A11yNode; resolvedBy: number; candidateCount: number }
  | {
      found: false;
      tried: Array<{ index: number; candidateCount: number }>;
      nearest: A11yNode[];
    };

export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'searchbox',
  'spinbutton',
]);

const TEXTUAL_ROLES = new Set([
  'cell',
  'columnheader',
  'rowheader',
  'text',
  'heading',
  'link',
  'button',
  'label',
]);

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function inFrame(node: A11yNode, framePath: string[]): boolean {
  return (
    node.framePath.length === framePath.length && node.framePath.every((p, i) => p === framePath[i])
  );
}

const SEG = /^(\w+)\[(\d+)\]$/;

export interface CellPosition {
  tablePath: string;
  rowPath: string;
  row: number;
  col: number;
  cellPath: string;
}

/** Table coordinates of a node from its structural path: the innermost cell, row and table. */
export function cellPosition(path: string): CellPosition | undefined {
  const segs = path.split('/');
  let cellIdx = -1;
  let rowIdx = -1;
  let tableIdx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    const m = SEG.exec(segs[i] ?? '');
    if (!m) continue;
    const tag = m[1];
    if (cellIdx < 0) {
      if (tag === 'td' || tag === 'th') cellIdx = i;
      continue;
    }
    if (rowIdx < 0) {
      if (tag === 'tr') rowIdx = i;
      continue;
    }
    if (tag === 'table') {
      tableIdx = i;
      break;
    }
  }
  if (cellIdx < 0 || rowIdx < 0 || tableIdx < 0) return undefined;
  const col = Number(SEG.exec(segs[cellIdx] ?? '')?.[2]);
  const row = Number(SEG.exec(segs[rowIdx] ?? '')?.[2]);
  return {
    tablePath: segs.slice(0, tableIdx + 1).join('/'),
    rowPath: segs.slice(0, rowIdx + 1).join('/'),
    row,
    col,
    cellPath: segs.slice(0, cellIdx + 1).join('/'),
  };
}

function isTarget(node: A11yNode, role: string | undefined): boolean {
  return role ? node.role === role : INTERACTIVE_ROLES.has(node.role);
}

function withinCell(nodes: A11yNode[], cellPath: string, role: string | undefined): A11yNode[] {
  return nodes.filter((n) => n.path.startsWith(`${cellPath}/`) && isTarget(n, role));
}

export function cellAt(nodes: A11yNode[], rowPath: string, col: number): A11yNode | undefined {
  return nodes.find(
    (n) => n.path === `${rowPath}/td[${col}]` || n.path === `${rowPath}/th[${col}]`,
  );
}

function overlaps(p: number, pl: number, q: number, ql: number): boolean {
  return p < q + ql && q < p + pl;
}

function geometric(
  nodes: A11yNode[],
  anchor: A11yNode,
  direction: 'right-of' | 'below',
  role: string | undefined,
): A11yNode[] {
  const a = anchor.bbox;
  const candidates = nodes.filter(
    (n) =>
      n.ref !== anchor.ref &&
      isTarget(n, role) &&
      (direction === 'right-of'
        ? n.bbox.x >= a.x + a.w - 2 && overlaps(n.bbox.y, n.bbox.h, a.y, a.h)
        : n.bbox.y >= a.y + a.h - 2 && overlaps(n.bbox.x, n.bbox.w, a.x, a.w)),
  );
  if (candidates.length === 0) return [];
  const distance = (n: A11yNode) =>
    direction === 'right-of' ? n.bbox.x - (a.x + a.w) : n.bbox.y - (a.y + a.h);
  candidates.sort((p, q) => distance(p) - distance(q));
  const first = candidates[0];
  return first ? [first] : [];
}

function anchorsFor(nodes: A11yNode[], anchor: string): A11yNode[] {
  const want = normalizeText(anchor);
  const exact = nodes.filter((n) => TEXTUAL_ROLES.has(n.role) && normalizeText(n.name) === want);
  if (exact.length > 0) return exact;
  return nodes.filter((n) => TEXTUAL_ROLES.has(n.role) && normalizeText(n.name).includes(want));
}

function anchoredFrom(
  nodes: A11yNode[],
  anchor: A11yNode,
  s: Extract<Strategy, { kind: 'anchored' }>,
): A11yNode[] {
  switch (s.relation) {
    case 'labels': {
      const pos = cellPosition(anchor.path);
      if (pos) {
        for (let c = pos.col + 1; c <= pos.col + 2; c++) {
          const cell = cellAt(nodes, pos.rowPath, c);
          if (!cell) break;
          const found = withinCell(nodes, cell.path, s.role);
          if (found.length > 0) return found;
        }
      }
      const right = geometric(nodes, anchor, 'right-of', s.role);
      return right.length > 0 ? right : geometric(nodes, anchor, 'below', s.role);
    }
    case 'same-row-column': {
      const pos = cellPosition(anchor.path);
      if (!pos || !s.column) return [];
      const want = normalizeText(s.column);
      const headers = nodes
        .filter(
          (n) => (n.role === 'cell' || n.role === 'columnheader') && normalizeText(n.name) === want,
        )
        .map((n) => ({ n, p: cellPosition(n.path) }))
        .filter((h): h is { n: A11yNode; p: CellPosition } => h.p?.tablePath === pos.tablePath)
        .sort((a, b) => a.p.row - b.p.row);
      const header = headers[0];
      if (!header) return [];
      const cell = cellAt(nodes, pos.rowPath, header.p.col);
      if (!cell) return [];
      return s.role ? withinCell(nodes, cell.path, s.role) : [cell];
    }
    case 'right-of':
      return geometric(nodes, anchor, 'right-of', s.role);
    case 'below':
      return geometric(nodes, anchor, 'below', s.role);
  }
}

/** Candidates for one strategy among the nodes of one frame. */
export function candidatesFor(nodes: A11yNode[], s: Strategy): A11yNode[] {
  switch (s.kind) {
    case 'role': {
      const want = normalizeText(s.name);
      const exact = nodes.filter((n) => n.role === s.role && normalizeText(n.name) === want);
      if (exact.length > 0 || s.exact) return exact;
      return nodes.filter((n) => n.role === s.role && normalizeText(n.name).includes(want));
    }
    case 'structural': {
      const want = s.path
        .split(/\s*>\s*|\//)
        .map((t) => t.trim())
        .filter(Boolean);
      return nodes.filter((n) => {
        const segs = n.path.split('/');
        if (segs.length < want.length) return false;
        const off = segs.length - want.length;
        return want.every((w, i) => segs[off + i] === w);
      });
    }
    case 'anchored': {
      const out: A11yNode[] = [];
      for (const anchor of anchorsFor(nodes, s.anchor)) {
        for (const c of anchoredFrom(nodes, anchor, s)) {
          if (!out.includes(c)) out.push(c);
        }
      }
      return out;
    }
  }
}

export function resolveTarget(nodes: A11yNode[], spec: TargetSpec): Resolution {
  const scoped = nodes.filter((n) => inFrame(n, spec.framePath));
  const tried: Array<{ index: number; candidateCount: number }> = [];
  for (const [index, strategy] of spec.strategies.entries()) {
    const candidates = candidatesFor(scoped, strategy);
    tried.push({ index, candidateCount: candidates.length });
    const only = candidates[0];
    if (candidates.length === 1 && only) {
      return { found: true, ref: only.ref, node: only, resolvedBy: index, candidateCount: 1 };
    }
  }
  const first = spec.strategies[0];
  const nearest = first
    ? scoped
        .filter((n) =>
          first.kind === 'role'
            ? n.role === first.role
            : first.kind === 'anchored'
              ? anchorsFor(scoped, first.anchor).includes(n) || isTarget(n, first.role)
              : true,
        )
        .slice(0, 5)
    : [];
  return { found: false, tried, nearest };
}

export function describeStrategy(s: Strategy): string {
  switch (s.kind) {
    case 'role':
      return `role ${s.role} "${s.name}"`;
    case 'anchored':
      return `${s.role ?? 'control'} ${s.relation} "${s.anchor}"${s.column ? ` in column "${s.column}"` : ''}`;
    case 'structural':
      return `path ${s.path}`;
  }
}

export function describeTarget(spec: TargetSpec): string {
  const frame = spec.framePath.length > 0 ? ` in frame ${spec.framePath.join('/')}` : '';
  return spec.strategies.map(describeStrategy).join(' | ') + frame;
}
