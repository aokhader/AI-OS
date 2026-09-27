import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ObservationView } from '../conditions/predicate.js';
import {
  type AppProfile,
  AppProfileSchema,
  type Capability,
  CapabilitySchema,
} from '../schema/index.js';
import { applyVariant, detectVariants, matchFingerprint } from './apply.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const profile: AppProfile = AppProfileSchema.parse(
  JSON.parse(readFileSync(path.join(repoRoot, 'data/app-profiles/acme-coreteller.json'), 'utf8')),
);
const capability: Capability = CapabilitySchema.parse(
  JSON.parse(
    readFileSync(
      path.join(repoRoot, 'data/capabilities/get-member-savings-balance/v4.json'),
      'utf8',
    ),
  ),
);

function page(title: string, texts: string[] = [], url = 'http://x/'): ObservationView {
  return {
    url,
    title,
    frames: [{ framePath: ['main'], url, title }],
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

describe('fingerprints (D-037)', () => {
  it('matches the title of the top document or of any frame', () => {
    expect(detectVariants(profile, page('First Example Credit Union - ACME CoreTeller'))).toEqual([
      'first-example-cu',
    ]);
    const framed: ObservationView = {
      ...page('x'),
      frames: [
        { framePath: ['nav'], url: 'http://x/nav', title: 'Sample Federal Credit Union - nav' },
      ],
    };
    expect(detectVariants(profile, framed)).toEqual(['sample-federal-cu']);
    expect(detectVariants(profile, page('Some Other Bank'))).toEqual([]);
  });

  it('requires every clause', () => {
    const obs = page('Acme', ['CoreTeller 7.6.0', 'Member Lookup'], 'http://x/members');
    expect(matchFingerprint({ titleIncludes: 'Acme', textPresent: ['Member Lookup'] }, obs)).toBe(
      true,
    );
    expect(matchFingerprint({ titleIncludes: 'Acme', textPresent: ['Wire Room'] }, obs)).toBe(
      false,
    );
    expect(matchFingerprint({ versionBanner: '7.6.0', urlPattern: '/members' }, obs)).toBe(true);
    expect(matchFingerprint({ versionBanner: '7.4.2' }, obs)).toBe(false);
  });
});

describe('applyVariant (01 §14, D-037)', () => {
  it('leaves the base variant untouched', () => {
    const a = applyVariant(capability, profile, 'first-example-cu');
    expect(a.counts).toEqual({ labels: 0, routes: 0, frames: 0, steps: 0, detectors: 0 });
    expect(a.capability).toEqual(capability);
  });

  it('rewrites labels, columns and frame names for variant B, in every locator', () => {
    const b = applyVariant(capability, profile, 'sample-federal-cu');
    expect(b.counts.frames).toBeGreaterThan(0);
    expect(b.counts.labels).toBeGreaterThan(0);
    const text = JSON.stringify(b.capability);
    expect(text).not.toContain('"framePath":["main"]');
    expect(text).toContain('"framePath":["content"]');
    expect(text).not.toContain('"Member #"');
    expect(text).not.toContain('"name":"Search"');
    expect(text).not.toContain('"name":"View"');
    const s1 = b.capability.steps[0];
    expect(s1?.target?.strategies[0]).toMatchObject({ anchor: 'Member Number' });
    expect(s1?.postcondition.when.element?.strategies[0]).toMatchObject({
      anchor: 'Member Number',
    });
    expect(b.capability.steps[1]?.target?.strategies[0]).toMatchObject({ name: 'Find' });
    expect(b.capability.steps[2]?.target?.strategies[0]).toMatchObject({ name: 'Open' });
    // unmapped text and structural paths stay as they are
    expect(b.capability.steps[1]?.postcondition.when.textPresent).toEqual(['Search Results']);
    expect(b.capability.outputs[0]?.source).toMatchObject({ framePath: ['content'] });
    expect(CapabilitySchema.safeParse(b.capability).success).toBe(true);
  });

  it("applies routes, detectors and the capability's own step overrides after the profile", () => {
    const withOverrides: AppProfile = {
      ...profile,
      variants: {
        ...profile.variants,
        'sample-federal-cu': {
          ...profile.variants['sample-federal-cu']!,
          overrides: {
            ...profile.variants['sample-federal-cu']!.overrides,
            routes: { '/members/:memberId': '/member/view/:memberId' },
            detectors: [
              {
                id: 'b-maintenance',
                role: 'detector',
                class: 'fail',
                code: 'APP_ERROR',
                when: { textPresent: ['Maintenance window'] },
              },
            ],
          },
        },
      },
    };
    const replacement = {
      strategies: [{ kind: 'role' as const, role: 'link', name: 'Open member' }],
      framePath: ['content'],
    };
    const own: Capability = {
      ...capability,
      variants: {
        'sample-federal-cu': {
          steps: { s3: { target: replacement } },
          detectors: [
            {
              id: 'b-locked',
              role: 'detector',
              class: 'outcome',
              code: 'MEMBER_LOCKED',
              when: { textPresent: ['Membership locked'] },
            },
          ],
        },
      },
    };
    const b = applyVariant(own, withOverrides, 'sample-federal-cu');
    expect(b.counts.routes).toBeGreaterThan(0);
    expect(b.counts.steps).toBe(1);
    expect(b.counts.detectors).toBe(2);
    expect(b.capability.steps[2]?.target).toEqual(replacement);
    expect(b.capability.steps[2]?.action).toMatchObject({ target: { spec: replacement } });
    expect(b.capability.steps[2]?.postcondition.when.url).toBe('/member/view/:memberId');
    expect(b.capability.success.when.url).toBe('/member/view/:memberId');
    expect(b.capability.detectors.map((d) => d.id)).toEqual([
      'member-not-found',
      'b-maintenance',
      'b-locked',
    ]);
  });

  it('refuses an unknown variant', () => {
    expect(() => applyVariant(capability, profile, 'nope')).toThrow(/no variant nope/);
  });
});
