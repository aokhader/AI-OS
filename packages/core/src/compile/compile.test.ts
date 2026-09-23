import { describe, expect, it } from 'vitest';
import type { SurfaceObservation } from '../ports/surface.js';
import type { A11yNode } from '../schema/index.js';
import { compileCapability } from './compile.js';
import {
  canonicalizePath,
  derivePostcondition,
  firstNewSalientText,
} from './derive-postcondition.js';
import { deriveTargetSpec, looksLikeData } from './derive-target.js';

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

function observation(nodes: A11yNode[], mainUrl: string): SurfaceObservation {
  return {
    at: '2026-09-21T00:00:00.000Z',
    url: 'http://localhost:4100/',
    title: 'First Example Credit Union - ACME CoreTeller',
    frames: [
      {
        framePath: [],
        url: 'http://localhost:4100/',
        title: 'First Example Credit Union - ACME CoreTeller',
      },
      { framePath: ['main'], url: mainUrl, title: 'x' },
    ],
    nodes,
    dialogs: [],
  };
}

const lookupNodes: A11yNode[] = [
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
];

const resultsNodes: A11yNode[] = [
  node(
    'e1',
    'cell',
    'First Example Credit Union | ACME CoreTeller 7.4.2',
    'table[1]/tr[1]/td[1]',
    [0, 0, 1000, 24],
  ),
  node('e2', 'text', 'Search Results', 'div[1]', [8, 40, 200, 18]),
  node('e3', 'cell', 'Member #', 'table[2]/tr[1]/td[1]', [8, 70, 80, 20]),
  node('e4', 'cell', 'Name', 'table[2]/tr[1]/td[2]', [90, 70, 120, 20]),
  node('e5', 'cell', 'Status', 'table[2]/tr[1]/td[3]', [212, 70, 60, 20]),
  node('e6', 'cell', 'Action', 'table[2]/tr[1]/td[4]', [274, 70, 60, 20]),
  node('e7', 'cell', '10001', 'table[2]/tr[2]/td[1]', [8, 92, 80, 20]),
  node('e8', 'cell', 'Alex Rivera', 'table[2]/tr[2]/td[2]', [90, 92, 120, 20]),
  node('e9', 'cell', 'Active', 'table[2]/tr[2]/td[3]', [212, 92, 60, 20]),
  node('e10', 'cell', '', 'table[2]/tr[2]/td[4]', [274, 92, 60, 20]),
  node('e11', 'link', 'View', 'table[2]/tr[2]/td[4]/a[1]', [278, 94, 30, 16]),
];

const detailNodes: A11yNode[] = [
  node('d0', 'text', 'Member Detail', 'div[1]', [8, 40, 200, 18]),
  node('d1', 'text', 'Accounts', 'div[2]', [8, 200, 100, 18]),
  node('d2', 'cell', 'Type', 'table[3]/tr[1]/td[1]', [8, 220, 80, 20]),
  node('d3', 'cell', 'Number', 'table[3]/tr[1]/td[2]', [90, 220, 100, 20]),
  node('d4', 'cell', 'Balance', 'table[3]/tr[1]/td[3]', [192, 220, 90, 20]),
  node('d6', 'cell', 'Savings', 'table[3]/tr[2]/td[1]', [8, 242, 80, 20]),
  node('d7', 'cell', '10001-S01', 'table[3]/tr[2]/td[2]', [90, 242, 100, 20]),
  node('d8', 'cell', '$1,250.75', 'table[3]/tr[2]/td[3]', [192, 242, 90, 20]),
  node('d10', 'cell', 'Checking', 'table[3]/tr[3]/td[1]', [8, 264, 80, 20]),
  node('d12', 'cell', '$310.20', 'table[3]/tr[3]/td[3]', [192, 264, 90, 20]),
];

const values = { memberId: '10001' };

describe('looksLikeData', () => {
  it('recognises money, numbers, dates and ids', () => {
    for (const t of ['$1,250.75', '10001', '2014-03-11', '10001-S01', '(12.00)', '']) {
      expect(looksLikeData(t), t).toBe(true);
    }
    for (const t of ['Member #', 'Search', 'Savings', 'View'])
      expect(looksLikeData(t), t).toBe(false);
  });
});

describe('deriveTargetSpec', () => {
  it('labels a nameless legacy input by the cell beside it, then falls back to structure', () => {
    const spec = deriveTargetSpec(lookupNodes[5]!, lookupNodes, ['10001']);
    expect(spec.framePath).toEqual(['main']);
    expect(spec.strategies[0]).toEqual({
      kind: 'anchored',
      anchor: 'Member #',
      relation: 'labels',
      role: 'textbox',
    });
    expect(spec.strategies.at(-1)?.kind).toBe('structural');
    expect(spec.strategies.some((s) => s.kind === 'role')).toBe(false);
  });

  it('puts role and name first for a named control', () => {
    const spec = deriveTargetSpec(lookupNodes[7]!, lookupNodes);
    expect(spec.strategies[0]).toEqual({ kind: 'role', role: 'button', name: 'Search' });
    expect(spec.strategies.length).toBeLessThanOrEqual(3);
  });

  it('never anchors on a parameter value or on data-looking text', () => {
    const view = resultsNodes[10]!;
    const spec = deriveTargetSpec(view, resultsNodes, ['10001']);
    const text = JSON.stringify(spec);
    expect(text).not.toContain('10001');
    expect(spec.strategies[0]).toEqual({ kind: 'role', role: 'link', name: 'View' });
    const balance = deriveTargetSpec(detailNodes[7]!, detailNodes, ['10001']);
    expect(balance.strategies[0]).toEqual({
      kind: 'anchored',
      anchor: 'Savings',
      relation: 'same-row-column',
      column: 'Balance',
    });
    expect(balance.strategies.some((s) => s.kind === 'role')).toBe(false);
  });
});

describe('derivePostcondition', () => {
  const before = observation(lookupNodes, 'http://localhost:4100/members');
  const results = observation(resultsNodes, 'http://localhost:4100/members/search');
  const detail = observation(detailNodes, 'http://localhost:4100/members/10001');

  it('canonicalises paths by whole segment only', () => {
    expect(canonicalizePath('/members/10001', values)).toEqual({
      pattern: '/members/:memberId',
      params: ['memberId'],
    });
    expect(canonicalizePath('/members/100011', values).params).toEqual([]);
    expect(canonicalizePath('/', values).pattern).toBe('/');
  });

  it('uses a route pattern with a binding when the frame URL changed', () => {
    const p = derivePostcondition('s3', results, detail, undefined, values);
    expect(p.condition.when.url).toBe('/members/:memberId');
    expect(p.condition.when.textPresent).toEqual(['Member Detail']);
    expect(p.bindings).toEqual([{ param: 'memberId', field: 'postcondition.url', inferred: true }]);
  });

  it('uses newly visible text when only the page content changed', () => {
    const p = derivePostcondition(
      's2',
      before,
      { ...results, frames: before.frames },
      undefined,
      values,
    );
    expect(p.condition.when).toEqual({ textPresent: ['Search Results'], timeoutMs: 10_000 });
    expect(firstNewSalientText(before, results, values)).toBe('Search Results');
  });

  it('falls back to the step target resolving when nothing observable changed', () => {
    const target = deriveTargetSpec(lookupNodes[5]!, lookupNodes);
    const p = derivePostcondition('s1', before, before, target, values);
    expect(p.condition.when.element).toEqual(target);
  });
});

describe('compileCapability', () => {
  it('produces a valid artifact with extract steps for the outputs', () => {
    const lookup = observation(lookupNodes, 'http://localhost:4100/members');
    const results = observation(resultsNodes, 'http://localhost:4100/members/search');
    const detail = observation(detailNodes, 'http://localhost:4100/members/10001');
    const textbox = deriveTargetSpec(lookupNodes[5]!, lookupNodes, ['10001']);
    const search = deriveTargetSpec(lookupNodes[7]!, lookupNodes, ['10001']);
    const view = deriveTargetSpec(resultsNodes[10]!, resultsNodes, ['10001']);
    const cap = compileCapability({
      id: 'get-member-savings-balance',
      name: 'Get member savings balance',
      description: 'test',
      version: 2,
      vendorProductId: 'acme-coreteller',
      surfaceKind: 'legacy-web',
      entryRoute: '/',
      requiresAuth: true,
      inputs: [
        {
          name: 'memberId',
          type: 'string',
          description: 'Member number',
          sensitivity: 'sensitive',
          required: true,
        },
      ],
      values,
      steps: [
        {
          intent: 'Enter the member number',
          action: {
            kind: 'type',
            target: { spec: textbox },
            value: { param: 'memberId' },
            clear: true,
          },
          target: textbox,
          baseline: { resolvedBy: 0, candidateCount: 1 },
          before: lookup,
          after: lookup,
        },
        {
          intent: 'Search',
          action: { kind: 'wait', reason: 'let the page settle' },
          before: lookup,
          after: lookup,
        },
        {
          intent: 'Search',
          action: { kind: 'click', target: { spec: search } },
          target: search,
          baseline: { resolvedBy: 0, candidateCount: 1 },
          before: lookup,
          after: results,
        },
        {
          intent: 'Open the member',
          action: { kind: 'click', target: { spec: view } },
          target: view,
          baseline: { resolvedBy: 0, candidateCount: 1 },
          before: results,
          after: detail,
        },
      ],
      outputs: [{ name: 'savingsBalance', node: detailNodes[7]!, raw: '$1,250.75' }],
      finalObservation: detail,
      firstObservation: lookup,
      outcomes: [{ code: 'MEMBER_NOT_FOUND', text: 'No matching member' }],
      outputSensitivity: 'sensitive',
      provenance: {
        runId: 'run_20260921_120000_abcd',
        model: 'scripted',
        recordedAt: '2026-09-21T12:00:00.000Z',
        compiler: 'test',
      },
    });
    expect(cap.supersedes).toBe(1);
    expect(cap.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(cap.steps.map((s) => s.action.kind)).toEqual(['type', 'click', 'click', 'extract']);
    expect(cap.steps[2]?.bindings).toEqual([
      { param: 'memberId', field: 'postcondition.url', inferred: true },
    ]);
    expect(cap.outputs[0]).toMatchObject({
      name: 'savingsBalance',
      parser: 'currency',
      atStep: 's4',
    });
    expect(cap.success.when).toEqual({ url: '/members/:memberId', textPresent: ['Member Detail'] });
    expect(cap.entry.preconditions[0]?.when.textPresent).toEqual(['Member Lookup']);
    expect(JSON.stringify(cap)).not.toContain('10001');
  });
});
