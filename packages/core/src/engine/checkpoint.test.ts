import { describe, expect, it } from 'vitest';
import type { ObservationView } from '../conditions/predicate.js';
import type { Condition } from '../schema/index.js';
import { scanCheckpoints } from './checkpoint.js';

function post(id: string, when: Condition['when']): Condition {
  return { id: `${id}-post`, role: 'postcondition', when };
}

const steps = [
  { id: 's1', postcondition: post('s1', { textPresent: ['Member Lookup'] }) },
  {
    id: 's2',
    postcondition: post('s2', { url: '/members/search', textPresent: ['Search Results'] }),
  },
  {
    id: 's3',
    postcondition: post('s3', { url: '/members/:memberId', textPresent: ['Member Detail'] }),
  },
  { id: 's4', postcondition: post('s4', { textPresent: ['Balance'] }) },
];

function page(url: string, texts: string[]): ObservationView {
  return {
    url,
    title: '',
    frames: [{ framePath: ['main'], url, title: '' }],
    nodes: texts.map((t, i) => ({
      ref: `e${i}`,
      role: 'text',
      name: t,
      states: [],
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      framePath: ['main'],
      path: `p[${i + 1}]`,
    })),
    dialogs: [],
  };
}

describe('checkpoint scan (01 §11)', () => {
  it('resumes after the last following step whose postcondition holds', () => {
    const scan = scanCheckpoints(
      steps,
      page('http://x/members/10001', ['Member Detail', 'Balance']),
      1,
    );
    expect(scan.satisfied).toEqual(['s3', 's4']);
    expect(scan.resumeAt).toBe(4);
    expect(scan.checks.map((c) => [c.stepId, c.matched])).toEqual([
      ['s2', false],
      ['s3', true],
      ['s4', true],
    ]);
  });

  it('re-runs the current step when nothing holds', () => {
    const scan = scanCheckpoints(steps, page('http://x/members', ['Member Lookup']), 1);
    expect(scan.resumeAt).toBe(1);
    expect(scan.satisfied).toEqual([]);
  });

  it('never looks at steps that already ran', () => {
    const scan = scanCheckpoints(steps, page('http://x/members', ['Member Lookup']), 2);
    expect(scan.checks.map((c) => c.stepId)).toEqual(['s3', 's4']);
    expect(scan.resumeAt).toBe(2);
  });

  it('continues at the current step when only it holds', () => {
    const scan = scanCheckpoints(steps, page('http://x/members/search', ['Search Results']), 1);
    expect(scan.satisfied).toEqual(['s2']);
    expect(scan.resumeAt).toBe(2);
  });
});
