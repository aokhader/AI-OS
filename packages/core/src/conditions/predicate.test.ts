import { describe, expect, it } from 'vitest';
import type { A11yNode } from '../schema/index.js';
import { classify } from './classify.js';
import {
  evaluatePredicate,
  matchUrl,
  type ObservationView,
  urlPatternToRegex,
} from './predicate.js';

function text(ref: string, name: string, framePath: string[] = ['main']): A11yNode {
  return {
    ref,
    role: 'text',
    name,
    states: [],
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    framePath,
    path: 'div[1]',
  };
}

const obs: ObservationView = {
  url: 'http://localhost:4100/',
  title: 'First Example Credit Union - ACME CoreTeller',
  frames: [
    {
      framePath: [],
      url: 'http://localhost:4100/',
      title: 'First Example Credit Union - ACME CoreTeller',
    },
    { framePath: ['nav'], url: 'http://localhost:4100/nav', title: 'Navigation' },
    { framePath: ['main'], url: 'http://localhost:4100/members/10001', title: 'Member Detail' },
  ],
  nodes: [
    text('e1', 'Member Detail'),
    text('e2', 'Savings'),
    text('e3', 'No matching member for number 99999.'),
  ],
  dialogs: [],
};

describe('urlPatternToRegex', () => {
  it('matches :param segments, single and double globs', () => {
    expect(urlPatternToRegex('/members/:memberId').test('/members/10001')).toBe(true);
    expect(urlPatternToRegex('/members/:memberId').test('/members/10001/accounts')).toBe(false);
    expect(urlPatternToRegex('/members/**').test('/members/10001/accounts/open')).toBe(true);
    expect(urlPatternToRegex('/members/*/accounts/open').test('/members/10001/accounts/open')).toBe(
      true,
    );
    expect(urlPatternToRegex('/').test('/')).toBe(true);
    expect(urlPatternToRegex('/').test('/login')).toBe(false);
  });

  it('captures named params', () => {
    const m = matchUrl('/members/:memberId', obs);
    expect(m?.params).toEqual({ memberId: '10001' });
  });
});

describe('evaluatePredicate', () => {
  it('matches a url against any frame, not only the top document', () => {
    expect(evaluatePredicate({ url: '/members/:memberId' }, obs).matched).toBe(true);
    expect(evaluatePredicate({ url: '/accounts' }, obs).matched).toBe(false);
  });

  it('checks text presence and absence across nodes', () => {
    expect(evaluatePredicate({ textPresent: ['Member Detail', 'Savings'] }, obs).matched).toBe(
      true,
    );
    expect(evaluatePredicate({ textPresent: ['Checking'] }, obs).matched).toBe(false);
    expect(evaluatePredicate({ textAbsent: ['Checking'] }, obs).matched).toBe(true);
    const r = evaluatePredicate({ textAbsent: ['Savings'] }, obs);
    expect(r.matched).toBe(false);
    expect(r.detail).toContain('present');
  });

  it('checks dialogs and frame titles', () => {
    expect(evaluatePredicate({ dialog: false }, obs).matched).toBe(true);
    expect(evaluatePredicate({ dialog: true }, obs).matched).toBe(false);
    expect(evaluatePredicate({ frameTitle: 'Member Detail' }, obs).matched).toBe(true);
  });
});

describe('classify', () => {
  const notFound = {
    id: 'member-not-found',
    role: 'detector' as const,
    class: 'outcome' as const,
    code: 'MEMBER_NOT_FOUND',
    message: 'No member matches',
    when: { textPresent: ['No matching member'] },
    atSteps: ['s2'],
  };
  const sessionExpired = {
    id: 'session-expired',
    role: 'detector' as const,
    class: 'recover' as const,
    code: 'SESSION_EXPIRED',
    when: { textPresent: ['Your session has expired'] },
    recovery: { kind: 'rebootstrap' as const },
  };
  const errorPage = {
    id: 'app-error',
    role: 'detector' as const,
    class: 'fail' as const,
    code: 'APP_ERROR',
    when: { textPresent: ['Application error'] },
  };
  const post = {
    condition: {
      id: 'p',
      role: 'postcondition' as const,
      when: { textPresent: ['Search Results'] },
    },
    met: true,
    detail: 'ok',
  };

  it('returns a business outcome ahead of a satisfied postcondition, only at its steps', () => {
    const c = classify(obs, { stepId: 's2', detectors: [notFound], postcondition: post });
    expect(c.kind).toBe('outcome');
    const elsewhere = classify(obs, { stepId: 's3', detectors: [notFound], postcondition: post });
    expect(elsewhere.kind).toBe('proceed');
  });

  it('ranks session-level and fatal conditions above outcomes', () => {
    const expired: ObservationView = {
      ...obs,
      nodes: [...obs.nodes, text('e4', 'Your session has expired')],
    };
    const c = classify(expired, { stepId: 's2', detectors: [notFound, sessionExpired] });
    expect(c.kind).toBe('recover');
    const broken: ObservationView = {
      ...obs,
      nodes: [...obs.nodes, text('e5', 'Application error')],
    };
    const f = classify(broken, { stepId: 's2', detectors: [notFound, errorPage] });
    expect(f).toMatchObject({ kind: 'fail', failure: 'APP_ERROR' });
  });

  it('fails the checkpoint when nothing explains an unmet postcondition', () => {
    const c = classify(obs, {
      stepId: 's1',
      detectors: [notFound],
      postcondition: { ...post, met: false, detail: 'text "Search Results" not found' },
    });
    expect(c).toMatchObject({ kind: 'fail', failure: 'CHECKPOINT_FAILED' });
  });
});
