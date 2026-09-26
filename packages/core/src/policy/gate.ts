import {
  type ObservationView,
  observedUrls,
  pathnameOf,
  urlPatternToRegex,
} from '../conditions/predicate.js';
import { MissingParamError, resolveValue } from '../engine/values.js';
import { BLOCKED_NAVIGATION_TEXT, type ParamValues } from '../ports/surface.js';
import {
  type A11yNode,
  type Action,
  ActionKindSchema,
  type Condition,
  type Confirm,
  type Policy,
  type Risk,
  type Verdict,
} from '../schema/index.js';

export type Phase = 'discovery' | 'replay';

/** What the artifact (or the app profile, for bootstrap steps) says about the step. */
export interface RecordedRisk {
  risk: Risk;
  confirm: Confirm;
  /** Capability approved by a reviewer; profile steps and entry navigations count as approved. */
  approved: boolean;
}

export interface GateInput {
  action: Action;
  /** The live element the action targets, when it has one. */
  node?: A11yNode | undefined;
  observation: ObservationView;
  phase: Phase;
  baseUrl: string;
  values: ParamValues;
  /** Replay only. Absent at discovery. */
  recorded?: RecordedRisk | undefined;
}

export interface GateResult {
  verdict: Verdict;
  /** Risk classified from the live observation alone. */
  liveRisk: Risk;
  /** Replay: the recorded risk disagrees with the live one (D-015). */
  mismatch: boolean;
}

/** Why an action is risky. */
interface RiskMatch {
  rule: string;
  reason: string;
}

export const RECORDED_SAFE_APPROVED: RecordedRisk = {
  risk: 'safe',
  confirm: 'none',
  approved: true,
};

/**
 * Detectors the runtime itself provides, on top of the app profile's: the page a surface serves
 * when it blocks a navigation at the network layer (D-034).
 */
export const RUNTIME_DETECTORS: Condition[] = [
  {
    id: 'policy-blocked-navigation',
    role: 'detector',
    class: 'fail',
    code: 'POLICY_BLOCKED',
    message: 'The surface blocked a navigation to an origin outside policy.allowedOrigins',
    when: { textPresent: [BLOCKED_NAVIGATION_TEXT] },
  },
];

/**
 * The policy an engine runs under when the caller supplies none: locked to the target origin,
 * everything else open and nothing risky. The CLI always supplies config/policy.json; this exists
 * for library callers and tests.
 */
export function permissivePolicy(baseUrl: string): Policy {
  return {
    allowedOrigins: [new URL(baseUrl).origin],
    allowedRoutes: ['/**'],
    deniedRoutes: [],
    allowedActions: [...ActionKindSchema.options],
    riskyPatterns: { buttonText: [], formAction: [], routes: [] },
    riskyMode: { discovery: 'escalate', replay: 'require_approved' },
    escalationTimeoutMs: 600_000,
    budgets: { recoveriesPerStep: 2, rebootstrapsPerRun: 1 },
    assistedFallback: { enabled: false, maxPerRun: 0 },
  };
}

function block(rule: string, reason: string, liveRisk: Risk = 'safe'): GateResult {
  return { verdict: { kind: 'block', rule, reason }, liveRisk, mismatch: false };
}

function textPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

function routeMatches(pattern: string, pathname: string): boolean {
  return urlPatternToRegex(pattern).test(pathname);
}

/** The absolute URL a navigate action goes to, or undefined when a parameter is missing. */
export function navigationUrl(
  action: Action,
  values: ParamValues,
  baseUrl: string,
): URL | undefined {
  if (action.kind !== 'navigate') return undefined;
  try {
    return new URL(resolveValue(action.url, values), baseUrl);
  } catch (err) {
    if (err instanceof MissingParamError) return undefined;
    throw err;
  }
}

function currentPathnames(obs: ObservationView): string[] {
  return observedUrls(obs).map(pathnameOf);
}

/** Live risk classification (D-015): button text, form action, current or target route. */
export function classifyRisk(policy: Policy, input: GateInput): RiskMatch | undefined {
  const { action, node, observation } = input;
  const { buttonText, formAction, routes } = policy.riskyPatterns;
  switch (action.kind) {
    case 'click': {
      if (node) {
        const name = node.name.trim();
        for (const [i, p] of buttonText.entries()) {
          if (name !== '' && textPattern(p).test(name)) {
            return {
              rule: `riskyPatterns.buttonText[${i}]`,
              reason: `the ${node.role} "${name}" matches the risky pattern /${p}/i`,
            };
          }
        }
        if (node.formAction) {
          const path = pathnameOf(node.formAction);
          for (const [i, p] of formAction.entries()) {
            if (routeMatches(p, path)) {
              return {
                rule: `riskyPatterns.formAction[${i}]`,
                reason: `the ${node.role} "${name}" belongs to a form posting to ${path}, which matches the risky pattern ${p}`,
              };
            }
          }
        }
      }
      return onRiskyRoute(routes, currentPathnames(observation), 'a click');
    }
    case 'press':
      return onRiskyRoute(routes, currentPathnames(observation), `pressing ${action.key}`);
    case 'navigate': {
      const url = navigationUrl(action, input.values, input.baseUrl);
      if (!url) return undefined;
      for (const [i, p] of routes.entries()) {
        if (routeMatches(p, url.pathname)) {
          return {
            rule: `riskyPatterns.routes[${i}]`,
            reason: `navigating to ${url.pathname} matches the risky route ${p}`,
          };
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function onRiskyRoute(routes: string[], pathnames: string[], what: string): RiskMatch | undefined {
  for (const [i, p] of routes.entries()) {
    const hit = pathnames.find((path) => routeMatches(p, path));
    if (hit !== undefined) {
      return {
        rule: `riskyPatterns.routes[${i}]`,
        reason: `${what} on ${hit}, which matches the risky route ${p}`,
      };
    }
  }
  return undefined;
}

/**
 * The one enforcement point (01 §12, D-015, D-034): action allowlist, origin and route allowlist
 * for navigations, then live risk. At replay the effective risk is the higher of the recorded and
 * the live risk; a step recorded safe that is risky live needs an operator whatever the approval.
 */
export function checkPolicy(policy: Policy, input: GateInput): GateResult {
  const { action, phase } = input;
  if (!policy.allowedActions.includes(action.kind)) {
    return block('allowedActions', `action ${action.kind} is not in policy.allowedActions`);
  }
  if (action.kind === 'navigate') {
    const url = navigationUrl(action, input.values, input.baseUrl);
    if (!url) {
      return block(
        'allowedOrigins',
        'the navigation URL could not be resolved (missing parameter), so it cannot be checked',
      );
    }
    const origins = policy.allowedOrigins.map((o) => new URL(o).origin);
    if (!origins.includes(url.origin)) {
      return block('allowedOrigins', `origin ${url.origin} is not in policy.allowedOrigins`);
    }
    const denied = policy.deniedRoutes.find((p) => routeMatches(p, url.pathname));
    if (denied !== undefined) {
      return block('deniedRoutes', `route ${url.pathname} matches denied route ${denied}`);
    }
    if (!policy.allowedRoutes.some((p) => routeMatches(p, url.pathname))) {
      return block(
        'allowedRoutes',
        `route ${url.pathname} matches no route in policy.allowedRoutes`,
      );
    }
  }

  const risky = classifyRisk(policy, input);
  const liveRisk: Risk = risky ? 'risky' : 'safe';

  if (phase === 'discovery') {
    if (!risky) return { verdict: { kind: 'allow', risk: 'safe' }, liveRisk, mismatch: false };
    if (policy.riskyMode.discovery === 'block') {
      return block(risky.rule, `${risky.reason}; policy.riskyMode.discovery is block`, liveRisk);
    }
    return {
      verdict: { kind: 'confirm', rule: risky.rule, reason: risky.reason },
      liveRisk,
      mismatch: false,
    };
  }

  const recorded = input.recorded ?? RECORDED_SAFE_APPROVED;
  const mismatch = recorded.risk !== liveRisk;
  if (recorded.risk === 'safe' && liveRisk === 'safe') {
    return { verdict: { kind: 'allow', risk: 'safe' }, liveRisk, mismatch };
  }
  const rule = risky?.rule ?? 'step.risk';
  const reason = risky?.reason ?? 'the step is recorded as risky';
  if (recorded.risk === 'safe') {
    return {
      verdict: {
        kind: 'confirm',
        rule,
        reason: `${reason}; the step is recorded safe, so approval does not cover it`,
      },
      liveRisk,
      mismatch,
    };
  }
  if (!recorded.approved) {
    return {
      verdict: {
        kind: 'block',
        rule: 'riskyMode.replay',
        reason: `${reason}; the capability is not approved (policy.riskyMode.replay is require_approved)`,
      },
      liveRisk,
      mismatch,
    };
  }
  if (recorded.confirm === 'operator') {
    return {
      verdict: {
        kind: 'confirm',
        rule,
        reason: `${reason}; the step requires operator confirmation`,
      },
      liveRisk,
      mismatch,
    };
  }
  return { verdict: { kind: 'allow', risk: 'risky' }, liveRisk, mismatch };
}
