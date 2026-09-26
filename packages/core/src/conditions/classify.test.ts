import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  A11yNodeSchema,
  AppProfileSchema,
  type Condition,
  DialogInfoSchema,
  FrameInfoSchema,
} from '../schema/index.js';
import { classify } from './classify.js';
import type { ObservationView } from './predicate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real observations captured from the mock app under each injected condition (D-024), redacted
 * and saved as fixtures. The classifier is pure, so this is where its precedence and the shipped
 * detectors are tested without a browser (01 §9, brief §7).
 */
const FixtureSchema = z.object({
  url: z.string().optional(),
  title: z.string(),
  frames: z.array(FrameInfoSchema),
  nodes: z.array(A11yNodeSchema),
  dialogs: z.array(DialogInfoSchema),
});

function fixture(name: string): ObservationView {
  const raw = JSON.parse(readFileSync(path.join(here, 'fixtures', `${name}.json`), 'utf8'));
  return FixtureSchema.parse(raw);
}

const profile = AppProfileSchema.parse(
  JSON.parse(
    readFileSync(path.resolve(here, '../../../../data/app-profiles/acme-coreteller.json'), 'utf8'),
  ),
);

const memberNotFound: Condition = {
  id: 'member-not-found',
  role: 'detector',
  class: 'outcome',
  code: 'MEMBER_NOT_FOUND',
  message: 'No matching member',
  when: { textPresent: ['No matching member'] },
};

const detectors = [...profile.detectors, memberNotFound];

const postcondition: Condition = {
  id: 's2-post',
  role: 'postcondition',
  when: { url: '/members/search', textPresent: ['Search Results'] },
};

function withText(obs: ObservationView, text: string): ObservationView {
  const first = obs.nodes[0];
  if (!first) throw new Error('empty fixture');
  return { ...obs, nodes: [...obs.nodes, { ...first, ref: 'extra', role: 'text', name: text }] };
}

describe('classify over captured observations', () => {
  it('a missing member is a business outcome, even though the postcondition held', () => {
    const c = classify(fixture('member-not-found'), {
      stepId: 's2',
      detectors,
      postcondition: { condition: postcondition, met: true, detail: 'ok' },
    });
    expect(c).toMatchObject({ kind: 'outcome', code: 'MEMBER_NOT_FOUND' });
  });

  it('the sign-in page coming back is a session expiry that re-bootstraps', () => {
    const c = classify(fixture('session-expired'), { stepId: 's2', detectors });
    expect(c).toMatchObject({
      kind: 'recover',
      condition: { id: 'session-expired' },
      routine: { kind: 'rebootstrap' },
    });
  });

  it('a native System notice dialog is dismissed', () => {
    const obs = fixture('system-notice');
    expect(obs.dialogs).toHaveLength(1);
    const c = classify(obs, { stepId: 's2', detectors });
    expect(c).toMatchObject({
      kind: 'recover',
      condition: { id: 'system-notice' },
      routine: { kind: 'dismiss' },
    });
  });

  it('a busy page is waited out', () => {
    const c = classify(fixture('system-busy'), { stepId: 's2', detectors });
    expect(c).toMatchObject({
      kind: 'recover',
      condition: { id: 'system-busy' },
      routine: { kind: 'wait-retry', ms: 1500, maxAttempts: 3 },
    });
  });

  it('an application error page fails with APP_ERROR and the expected checkpoint', () => {
    const c = classify(fixture('app-error'), {
      stepId: 's2',
      detectors,
      postcondition: { condition: postcondition, met: false, detail: 'text not found' },
    });
    expect(c).toMatchObject({ kind: 'fail', failure: 'APP_ERROR', condition: { id: 'app-error' } });
    if (c.kind !== 'fail') return;
    expect(c.expected).toContain('Search Results');
    expect(c.observed).toContain('error page');
  });
});

describe('classify precedence and budgets (01 §9)', () => {
  it('session level beats fatal: an expired page that mentions an error is still an expiry', () => {
    const c = classify(withText(fixture('session-expired'), 'Application error'), {
      stepId: 's2',
      detectors,
    });
    expect(c).toMatchObject({ kind: 'recover', routine: { kind: 'rebootstrap' } });
  });

  it('fatal beats interstitial and outcome', () => {
    const c = classify(withText(withText(fixture('app-error'), 'No matching member'), 'x'), {
      stepId: 's2',
      detectors,
    });
    expect(c).toMatchObject({ kind: 'fail', failure: 'APP_ERROR' });
  });

  it('an interstitial beats an outcome on the same page', () => {
    const c = classify(withText(fixture('system-notice'), 'No matching member'), {
      stepId: 's2',
      detectors,
    });
    expect(c).toMatchObject({ kind: 'recover', routine: { kind: 'dismiss' } });
  });

  it('an outcome limited to other steps does not fire, and an unmet postcondition fails', () => {
    const limited = { ...memberNotFound, atSteps: ['s3'] };
    const c = classify(fixture('member-not-found'), {
      stepId: 's2',
      detectors: [...profile.detectors, limited],
      postcondition: { condition: postcondition, met: false, detail: 'text "x" not found' },
    });
    expect(c).toMatchObject({ kind: 'fail', failure: 'CHECKPOINT_FAILED' });
    if (c.kind !== 'fail') return;
    expect(c.expected).toContain('/members/search');
    expect(c.observed).toBe('text "x" not found');
  });

  it('proceeds when nothing matches and the postcondition is met', () => {
    const c = classify(fixture('system-busy'), {
      stepId: 's2',
      detectors: [memberNotFound],
      postcondition: { condition: postcondition, met: true, detail: 'ok' },
    });
    expect(c).toEqual({ kind: 'proceed' });
  });

  it('escalate-class detectors rank below outcomes', () => {
    const escalate: Condition = {
      id: 'unknown-state',
      role: 'detector',
      class: 'escalate',
      when: { textPresent: ['Search Results'] },
    };
    const c = classify(fixture('member-not-found'), {
      stepId: 's2',
      detectors: [escalate, memberNotFound],
    });
    expect(c).toMatchObject({ kind: 'outcome', code: 'MEMBER_NOT_FOUND' });
    const only = classify(fixture('member-not-found'), { stepId: 's2', detectors: [escalate] });
    expect(only).toMatchObject({ kind: 'escalate', condition: { id: 'unknown-state' } });
  });
});
