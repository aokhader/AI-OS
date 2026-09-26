import { describe, expect, it } from 'vitest';
import type { SurfaceObservation } from './ports/surface.js';
import {
  hashValue,
  maskOutputs,
  redactJson,
  redactObservation,
  redactText,
  shouldMask,
} from './redact.js';
import type { OutputSpec } from './schema/index.js';

const sensitive = [{ name: 'memberId', value: '10001' }];

describe('redactText (D-035)', () => {
  it('uses the bare parameter name for what the model sees', () => {
    expect(redactText('Member 10001 — Ada', sensitive)).toBe('Member «memberId» — Ada');
  });

  it('carries a sha256 prefix for what is persisted', () => {
    const out = redactText('/members/10001', sensitive, { hash: true });
    expect(out).toBe(`/members/«memberId#${hashValue('10001')}»`);
    expect(out).toMatch(/«memberId#sha256:[0-9a-f]{12}»/);
  });

  it('replaces longer values first and skips values under three characters', () => {
    const two = [
      { name: 'a', value: '10001' },
      { name: 'b', value: '1000' },
      { name: 'c', value: '1' },
    ];
    expect(redactText('10001 1000 1', two)).toBe('«a» «b» 1');
  });
});

describe('redactJson and redactObservation', () => {
  const obs: SurfaceObservation = {
    at: '2026-09-25T00:00:00.000Z',
    url: 'http://localhost:4100/members/10001',
    title: 'Member 10001',
    frames: [
      { framePath: ['main'], url: 'http://localhost:4100/members/10001', title: 'Member 10001' },
    ],
    nodes: [
      {
        ref: 'e1',
        role: 'textbox',
        name: 'Member #',
        value: '10001',
        states: [],
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        framePath: ['main'],
        path: 'input[1]',
        formAction: 'http://localhost:4100/members/search?m=10001',
      },
      {
        ref: 'e2',
        role: 'cell',
        name: '1,250.75',
        states: [],
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        framePath: ['main'],
        path: 'td[1]',
      },
    ],
    dialogs: [{ kind: 'alert', text: 'Member 10001 saved' }],
  };

  it('redacts every field of an observation without hashes', () => {
    const r = redactObservation(obs, sensitive);
    expect(JSON.stringify(r)).not.toContain('10001');
    expect(JSON.stringify(r)).not.toContain('sha256');
    expect(r.nodes[0]?.value).toBe('«memberId»');
    expect(r.nodes[0]?.formAction).toContain('«memberId»');
    expect(r.dialogs[0]?.text).toBe('Member «memberId» saved');
  });

  it('hashes inside any persisted JSON', () => {
    const r = redactJson({ run: { entry: 'http://x/members/10001' } }, sensitive);
    expect(r.run.entry).toBe(`http://x/members/«memberId#${hashValue('10001')}»`);
  });

  it('returns the input untouched when nothing is sensitive', () => {
    expect(redactJson(obs, [])).toBe(obs);
    expect(redactObservation(obs, [])).toBe(obs);
  });
});

describe('shouldMask', () => {
  it('flags nodes whose name or value shows a sensitive value', () => {
    expect(shouldMask({ name: 'Member #', value: '10001' }, sensitive)).toBe(true);
    expect(shouldMask({ name: 'Member 10001 — Ada' }, sensitive)).toBe(true);
    expect(shouldMask({ name: 'Savings', value: '1,250.75' }, sensitive)).toBe(false);
    expect(shouldMask({ name: 'x1' }, [{ name: 'k', value: '1' }])).toBe(false);
  });
});

describe('maskOutputs', () => {
  const specs: OutputSpec[] = [
    {
      name: 'savingsBalance',
      type: 'number',
      parser: 'currency',
      description: 'd',
      source: { urlParam: 'x' },
      atStep: 's1',
      required: true,
      sensitivity: 'sensitive',
    },
    {
      name: 'branch',
      type: 'string',
      description: 'd',
      source: { urlParam: 'x' },
      atStep: 's1',
      required: false,
      sensitivity: 'internal',
    },
  ];

  it('replaces sensitive outputs with hashed placeholders and leaves the rest', () => {
    const masked = maskOutputs({ savingsBalance: 1250.75, branch: 'Main St' }, specs);
    expect(masked).toEqual({
      savingsBalance: `«savingsBalance#${hashValue('1250.75')}»`,
      branch: 'Main St',
    });
  });
});
