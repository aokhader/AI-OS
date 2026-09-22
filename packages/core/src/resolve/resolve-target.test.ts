import { describe, expect, it } from 'vitest';
import type { A11yNode } from '../schema/index.js';
import { cellPosition, resolveTarget } from './resolve-target.js';

function node(
  ref: string,
  role: string,
  name: string,
  path: string,
  bbox: [number, number, number, number],
  extra: Partial<A11yNode> = {},
): A11yNode {
  return {
    ref,
    role,
    name,
    states: [],
    bbox: { x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] },
    framePath: ['main'],
    path,
    ...extra,
  };
}

/** The member lookup page as the walker sees it, condensed. */
const lookup: A11yNode[] = [
  node(
    'e1',
    'cell',
    'First Example Credit Union | ACME CoreTeller 7.4.2',
    'table[1]/tr[1]/td[1]',
    [0, 0, 1000, 24],
  ),
  node('e2', 'text', 'Member Lookup', 'div[1]', [8, 40, 200, 18]),
  node('e3', 'cell', 'Find a member by number', 'form[1]/table[1]/tr[1]/td[1]', [8, 70, 300, 20]),
  node('e4', 'cell', 'Member #', 'form[1]/table[1]/tr[2]/td[1]', [8, 92, 70, 22]),
  node('e5', 'cell', '', 'form[1]/table[1]/tr[2]/td[2]', [80, 92, 130, 22]),
  node('e6', 'textbox', '', 'form[1]/table[1]/tr[2]/td[2]/input[1]', [84, 94, 120, 18], {
    value: '',
  }),
  node('e7', 'cell', '', 'form[1]/table[1]/tr[2]/td[3]', [212, 92, 80, 22]),
  node('e8', 'button', 'Search', 'form[1]/table[1]/tr[2]/td[3]/input[1]', [216, 94, 60, 18]),
  node(
    'e9',
    'text',
    'Enter the member number exactly as printed on the member card.',
    'p[1]/font[1]',
    [8, 130, 400, 14],
  ),
];

/** The accounts table on the member detail page. */
const detail: A11yNode[] = [
  node('d1', 'text', 'Accounts', 'div[2]', [8, 200, 100, 18]),
  node('d2', 'cell', 'Type', 'table[3]/tr[1]/td[1]', [8, 220, 80, 20]),
  node('d3', 'cell', 'Number', 'table[3]/tr[1]/td[2]', [90, 220, 100, 20]),
  node('d4', 'cell', 'Balance', 'table[3]/tr[1]/td[3]', [192, 220, 90, 20]),
  node('d5', 'cell', 'Opened', 'table[3]/tr[1]/td[4]', [284, 220, 90, 20]),
  node('d6', 'cell', 'Savings', 'table[3]/tr[2]/td[1]', [8, 242, 80, 20]),
  node('d7', 'cell', '10001-S01', 'table[3]/tr[2]/td[2]', [90, 242, 100, 20]),
  node('d8', 'cell', '$1,250.75', 'table[3]/tr[2]/td[3]', [192, 242, 90, 20]),
  node('d9', 'cell', '2014-03-11', 'table[3]/tr[2]/td[4]', [284, 242, 90, 20]),
  node('d10', 'cell', 'Checking', 'table[3]/tr[3]/td[1]', [8, 264, 80, 20]),
  node('d11', 'cell', '10001-C01', 'table[3]/tr[3]/td[2]', [90, 264, 100, 20]),
  node('d12', 'cell', '$310.20', 'table[3]/tr[3]/td[3]', [192, 264, 90, 20]),
  node('d13', 'cell', '2015-08-02', 'table[3]/tr[3]/td[4]', [284, 264, 90, 20]),
  node('d14', 'link', 'Open sub-account', 'table[4]/tr[1]/td[1]/a[1]', [8, 300, 120, 16]),
];

describe('cellPosition', () => {
  it('reads the innermost table, row and column from a path', () => {
    expect(cellPosition('form[1]/table[1]/tr[2]/td[2]/input[1]')).toEqual({
      tablePath: 'form[1]/table[1]',
      rowPath: 'form[1]/table[1]/tr[2]',
      row: 2,
      col: 2,
      cellPath: 'form[1]/table[1]/tr[2]/td[2]',
    });
    expect(cellPosition('div[1]')).toBeUndefined();
  });
});

describe('resolveTarget', () => {
  it('finds a control by the label text in the cell next to it', () => {
    const r = resolveTarget(lookup, {
      strategies: [{ kind: 'anchored', anchor: 'Member #', relation: 'labels', role: 'textbox' }],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'e6', resolvedBy: 0, candidateCount: 1 });
  });

  it('finds a button by role and accessible name', () => {
    const r = resolveTarget(lookup, {
      strategies: [{ kind: 'role', role: 'button', name: 'search' }],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'e8', resolvedBy: 0 });
  });

  it('finds a control to the right of an anchor geometrically', () => {
    const r = resolveTarget(lookup, {
      strategies: [{ kind: 'anchored', anchor: 'Member #', relation: 'right-of', role: 'button' }],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'e8' });
  });

  it('matches a structural path as a suffix, ignoring the form wrapper', () => {
    const r = resolveTarget(lookup, {
      strategies: [{ kind: 'structural', path: 'table[1] > tr[2] > td[3] > input[1]' }],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'e8' });
  });

  it('reads a cell by row anchor and column header', () => {
    const r = resolveTarget(detail, {
      strategies: [
        { kind: 'anchored', anchor: 'Savings', relation: 'same-row-column', column: 'Balance' },
      ],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'd8' });
    if (r.found) expect(r.node.name).toBe('$1,250.75');
    const checking = resolveTarget(detail, {
      strategies: [
        { kind: 'anchored', anchor: 'Checking', relation: 'same-row-column', column: 'Balance' },
      ],
      framePath: ['main'],
    });
    expect(checking).toMatchObject({ found: true, ref: 'd12' });
  });

  it('falls through to the next strategy when the first is ambiguous, and reports it', () => {
    const twoButtons = [
      ...lookup,
      node('e10', 'button', 'Search', 'form[2]/input[1]', [8, 400, 60, 18]),
    ];
    const r = resolveTarget(twoButtons, {
      strategies: [
        { kind: 'role', role: 'button', name: 'Search' },
        { kind: 'structural', path: 'table[1] > tr[2] > td[3] > input[1]' },
      ],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'e8', resolvedBy: 1, candidateCount: 1 });
  });

  it('reports what it tried and the nearest nodes when nothing resolves', () => {
    const r = resolveTarget(lookup, {
      strategies: [
        { kind: 'role', role: 'button', name: 'Find' },
        { kind: 'structural', path: 'table[9] > tr[1] > td[1]' },
      ],
      framePath: ['main'],
    });
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.tried).toEqual([
      { index: 0, candidateCount: 0 },
      { index: 1, candidateCount: 0 },
    ]);
    expect(r.nearest.map((n) => n.ref)).toEqual(['e8']);
  });

  it('scopes to the frame path', () => {
    const r = resolveTarget(lookup, {
      strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
      framePath: ['content'],
    });
    expect(r.found).toBe(false);
  });

  it('prefers an exact name over a substring match', () => {
    const nodes = [
      ...detail,
      node('d15', 'link', 'Open', 'table[4]/tr[1]/td[2]/a[1]', [140, 300, 40, 16]),
    ];
    const r = resolveTarget(nodes, {
      strategies: [{ kind: 'role', role: 'link', name: 'Open' }],
      framePath: ['main'],
    });
    expect(r).toMatchObject({ found: true, ref: 'd15', candidateCount: 1 });
  });
});
