import { type Classification, classify } from '../conditions/classify.js';
import { describePredicate, evaluatePredicate } from '../conditions/predicate.js';
import { digestOf } from '../digest.js';
import type { RunHandle, Store } from '../ports/store.js';
import type { ParamValues, Surface, SurfaceObservation } from '../ports/surface.js';
import { redactJson, type SensitiveValue } from '../redact.js';
import { describeTarget, resolveTarget } from '../resolve/resolve-target.js';
import {
  type AppProfile,
  actionTarget,
  type BootstrapStep,
  type Condition,
  type FailureKind,
  type RunEvent,
  type SideEffects,
  type Step,
  type StepReport,
} from '../schema/index.js';
import { withRef } from './values.js';

/** Bad arguments are reported before any run folder exists. */
export class EngineArgumentError extends Error {
  override readonly name = 'EngineArgumentError';
}

export interface EngineDeps {
  surface: Surface;
  store: Store;
  profile: AppProfile;
  /** Where bootstrap credentials are read from. Defaults to process.env. */
  env?: Record<string, string | undefined> | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface EngineTimeouts {
  stepTimeoutMs?: number | undefined;
  runTimeoutMs?: number | undefined;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<RunEvent, 'at' | 'runId'>;

export type StopReason =
  | { kind: 'failure'; failure: FailureKind; expected: string; observed: string }
  | { kind: 'outcome'; code: string; message: string; data?: unknown }
  | { kind: 'stopped'; status: 'gave_up' | 'limit' | 'aborted'; reason: string };

/** Internal control flow only; never escapes an engine. */
export class Stop extends Error {
  constructor(
    readonly reason: StopReason,
    readonly atStep: string | undefined,
  ) {
    super(
      reason.kind === 'failure'
        ? `${reason.failure}: ${reason.observed}`
        : reason.kind === 'outcome'
          ? reason.code
          : `${reason.status}: ${reason.reason}`,
    );
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function credentialsFromEnv(
  profile: AppProfile,
  env: Record<string, string | undefined>,
): ParamValues {
  const values: ParamValues = {};
  for (const [name, { env: variable }] of Object.entries(profile.bootstrap.credentials)) {
    const value = env[variable];
    if (value === undefined || value === '') {
      throw new EngineArgumentError(
        `bootstrap credential "${name}" needs environment variable ${variable}`,
      );
    }
    values[name] = value;
  }
  return values;
}

/**
 * What discovery and replay share: the run folder, evidence recording, observation and waiting,
 * bootstrap, and the execution of one compiled step. Subclasses own their loop and their result.
 */
export abstract class EngineBase {
  protected run!: RunHandle;
  protected readonly now: () => Date;
  protected readonly stepTimeoutMs: number;
  protected readonly runTimeoutMs: number;
  protected readonly deadline: number;
  protected shots = 0;
  protected currentStep: string | undefined;
  protected lastObservation: SurfaceObservation | undefined;
  protected lastScreenshot: string | undefined;
  protected lastSnapshot: string | undefined;
  protected riskyExecuted = false;
  protected riskyConfirmed = false;
  protected readonly stepsRun: StepReport[] = [];
  protected readonly rawOutputs = new Map<string, string>();
  /** Values that must never be persisted in clear text. */
  protected sensitive: SensitiveValue[] = [];

  protected constructor(
    protected readonly deps: EngineDeps,
    protected readonly baseUrl: string,
    timeouts: EngineTimeouts,
    protected readonly credentials: ParamValues,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.stepTimeoutMs = timeouts.stepTimeoutMs ?? 15_000;
    this.runTimeoutMs = timeouts.runTimeoutMs ?? 600_000;
    this.deadline = Date.now() + this.runTimeoutMs;
  }

  // ---- phases ------------------------------------------------------------------------------

  protected async bootstrap(): Promise<void> {
    const b = this.deps.profile.bootstrap;
    this.currentStep = 'bootstrap';
    await this.navigate(b.entry, 'bootstrap');
    for (const step of b.steps) {
      await this.runStep(step, this.credentials, this.deps.profile.detectors, true);
    }
    const ok = await this.waitFor(b.success, this.stepTimeoutMs, 'bootstrap');
    if (!ok.matched) {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'CHECKPOINT_FAILED',
          expected: `after sign-in: ${describePredicate(b.success.when)}`,
          observed: ok.detail,
        },
        'bootstrap',
      );
    }
  }

  /** Executes one compiled step: preconditions, resolve, gate, act, postcondition, classify. */
  protected async runStep(
    step: Step | BootstrapStep,
    values: ParamValues,
    detectors: Condition[],
    isBootstrap: boolean,
  ): Promise<SurfaceObservation> {
    const stepId = step.id;
    this.currentStep = stepId;
    const started = Date.now();
    this.log(`step ${stepId}: ${step.intent}`);

    for (const pre of step.preconditions) {
      const w = await this.waitFor(pre, pre.when.timeoutMs ?? 2_000, stepId);
      if (!w.matched) {
        await this.snapshot(stepId, w.obs);
        this.raise(classify(w.obs, { stepId, detectors }), stepId);
        throw new Stop(
          {
            kind: 'failure',
            failure: 'UNEXPECTED_STATE',
            expected: `before ${stepId}: ${describePredicate(pre.when)}`,
            observed: w.detail,
          },
          stepId,
        );
      }
    }

    const before = await this.observe('before', stepId);
    const pre = classify(before, { stepId, detectors });
    if (pre.kind !== 'proceed') await this.snapshot(stepId, before);
    this.raise(pre, stepId);

    let action = step.action;
    let resolvedBy: number | undefined;
    let candidateCount: number | undefined;
    let drift = false;
    const targetRef = actionTarget(step.action);
    if (targetRef) {
      if (!('spec' in targetRef)) {
        throw new Stop(
          {
            kind: 'failure',
            failure: 'UNEXPECTED_STATE',
            expected: 'a compiled TargetSpec on the step',
            observed: 'a live ref inside the artifact',
          },
          stepId,
        );
      }
      await this.event({
        type: 'decision',
        actor: 'automation',
        stepId,
        decision: { kind: 'resolve', target: targetRef.spec },
        intent: step.intent,
      });
      const res = resolveTarget(before.nodes, targetRef.spec);
      if (!res.found) {
        await this.snapshot(stepId, before);
        const tried = res.tried
          .map((t) => `strategy ${t.index + 1}: ${t.candidateCount} candidate(s)`)
          .join(', ');
        const nearest = res.nearest.map((n) => `${n.role} "${n.name}"`).join(', ') || 'none';
        throw new Stop(
          {
            kind: 'failure',
            failure: 'TARGET_NOT_FOUND',
            expected: describeTarget(targetRef.spec),
            observed: `${tried}; nearest: ${nearest}`,
          },
          stepId,
        );
      }
      resolvedBy = res.resolvedBy;
      candidateCount = res.candidateCount;
      if ('baseline' in step) {
        drift = res.resolvedBy > step.baseline.resolvedBy;
        if (drift) {
          await this.event({
            type: 'drift',
            actor: 'automation',
            stepId,
            baseline: step.baseline,
            observed: { resolvedBy, candidateCount },
          });
        }
      }
      if (step.action.kind === 'extract') {
        this.rawOutputs.set(step.action.name, res.node.value ?? res.node.name);
      }
      action = withRef(step.action, res.ref);
    }

    // Policy gate: P5 replaces this with live risk classification (D-015).
    await this.event({
      type: 'policy_check',
      actor: 'automation',
      stepId,
      action: step.action,
      verdict: { kind: 'allow', risk: step.risk },
      liveRisk: step.risk,
      recordedRisk: step.risk,
      mismatch: false,
    });

    if (step.action.kind !== 'extract') {
      const r = await this.deps.surface.act(action, {
        actor: 'automation',
        values,
        baseUrl: this.baseUrl,
      });
      if (step.risk === 'risky') this.riskyExecuted = true;
      if (!r.ok) {
        await this.snapshot(stepId, before);
        throw new Stop(
          {
            kind: 'failure',
            failure: r.reason === 'NAVIGATION_FAILED' ? 'APP_ERROR' : 'UNEXPECTED_STATE',
            expected: `${step.action.kind} to succeed`,
            observed: `${r.reason}: ${r.detail}`,
          },
          stepId,
        );
      }
    }
    await this.event({
      type: 'action',
      actor: 'automation',
      stepId,
      action: step.action,
      ...(resolvedBy !== undefined ? { resolvedBy } : {}),
      ...(candidateCount !== undefined ? { candidateCount } : {}),
      durationMs: Date.now() - started,
    });

    const post = await this.waitFor(
      step.postcondition,
      step.postcondition.when.timeoutMs ?? this.stepTimeoutMs,
      stepId,
    );
    const after = await this.observe('after', stepId);
    const met = post.matched || evaluatePredicate(step.postcondition.when, after).matched;
    const c = classify(after, {
      stepId,
      detectors,
      postcondition: { condition: step.postcondition, met, detail: post.detail },
    });
    if (c.kind !== 'proceed') await this.snapshot(stepId, after);
    this.raise(c, stepId);
    if (step.risk === 'risky') this.riskyConfirmed = true;

    if (!isBootstrap) {
      this.stepsRun.push({
        stepId,
        attempts: 1,
        durationMs: Date.now() - started,
        drift,
        ...(resolvedBy !== undefined ? { resolvedBy } : {}),
        ...(candidateCount !== undefined ? { candidateCount } : {}),
      });
    }
    return after;
  }

  /** Turns a non-proceed classification into a Stop. Recoveries (P4) and escalation (P6) are not built yet. */
  protected raise(c: Classification, stepId: string): void {
    switch (c.kind) {
      case 'proceed':
        return;
      case 'outcome':
        throw new Stop({ kind: 'outcome', code: c.code, message: c.message }, stepId);
      case 'fail':
        throw new Stop(
          { kind: 'failure', failure: c.failure, expected: c.expected, observed: c.observed },
          stepId,
        );
      case 'recover':
        throw new Stop(
          {
            kind: 'failure',
            failure: 'UNEXPECTED_STATE',
            expected: 'no recoverable condition',
            observed: `condition ${c.condition.id} matched and needs recovery "${c.routine.kind}" (recovery routines arrive in P4)`,
          },
          stepId,
        );
      case 'escalate':
        throw new Stop(
          {
            kind: 'failure',
            failure: 'UNEXPECTED_STATE',
            expected: 'no escalation condition',
            observed: `condition ${c.condition.id} matched and requires an operator (escalation arrives in P6)`,
          },
          stepId,
        );
    }
  }

  // ---- surface helpers ---------------------------------------------------------------------

  protected async navigate(route: string, stepId: string): Promise<void> {
    const started = Date.now();
    const action = { kind: 'navigate' as const, url: { text: route } };
    const r = await this.deps.surface.act(action, {
      actor: 'automation',
      values: {},
      baseUrl: this.baseUrl,
    });
    await this.event({
      type: 'action',
      actor: 'automation',
      stepId,
      action,
      durationMs: Date.now() - started,
    });
    if (!r.ok) {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'APP_ERROR',
          expected: `navigation to ${route} to succeed`,
          observed: `${r.reason}: ${r.detail}`,
        },
        stepId,
      );
    }
  }

  protected async observe(label: string, stepId: string | undefined): Promise<SurfaceObservation> {
    const obs = await this.deps.surface.observe({ screenshot: true });
    let screenshot: string | undefined;
    if (obs.screenshotPng) {
      const name = `steps/${String(++this.shots).padStart(3, '0')}-${stepId ?? 'run'}-${label}.png`;
      screenshot = await this.run.putScreenshot(name, obs.screenshotPng);
      this.lastScreenshot = screenshot;
    }
    this.lastObservation = obs;
    await this.event({
      type: 'observation',
      actor: 'automation',
      ...(stepId ? { stepId } : {}),
      digest: digestOf(obs),
      url: obs.url,
      title: obs.title,
      nodeCount: obs.nodes.length,
      dialogCount: obs.dialogs.length,
      ...(screenshot ? { screenshot } : {}),
    });
    return obs;
  }

  protected async waitFor(
    condition: Condition,
    timeoutMs: number,
    stepId: string,
  ): Promise<{ matched: boolean; obs: SurfaceObservation; detail: string }> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let obs: SurfaceObservation;
    let r: { matched: boolean; detail: string };
    for (;;) {
      obs = await this.deps.surface.observe({ screenshot: false });
      r = evaluatePredicate(condition.when, obs);
      if (r.matched || Date.now() >= deadline) break;
      await sleep(250);
    }
    this.lastObservation = obs;
    await this.event({
      type: 'condition',
      actor: 'automation',
      stepId,
      conditionId: condition.id,
      role: condition.role,
      ...(condition.class ? { class: condition.class } : {}),
      matched: r.matched,
      ...(condition.code ? { code: condition.code } : {}),
    });
    return { matched: r.matched, obs, detail: r.detail };
  }

  /** Persists a redacted observation as evidence. */
  protected async snapshot(stepId: string, obs: SurfaceObservation): Promise<void> {
    this.lastSnapshot = await this.run.putJson(
      `snapshots/${stepId}.json`,
      redactJson(
        {
          at: obs.at,
          url: obs.url,
          title: obs.title,
          frames: obs.frames,
          nodes: obs.nodes,
          dialogs: obs.dialogs,
          digest: digestOf(obs),
        },
        this.sensitive,
      ),
    );
  }

  // ---- bookkeeping ---------------------------------------------------------------------------

  protected checkRunTimeout(): void {
    if (Date.now() > this.deadline) {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'TIMEOUT',
          expected: `the run to finish within ${this.runTimeoutMs} ms`,
          observed: 'run time limit exceeded',
        },
        this.currentStep,
      );
    }
  }

  protected sideEffects(): SideEffects {
    if (!this.riskyExecuted) return 'none';
    return this.riskyConfirmed ? 'committed' : 'possible';
  }

  protected evidence(includeFailingScreenshot: boolean) {
    return {
      runDir: this.run.dir,
      ...(includeFailingScreenshot && this.lastScreenshot
        ? { failingScreenshot: this.lastScreenshot }
        : {}),
      ...(this.lastSnapshot ? { lastObservation: this.lastSnapshot } : {}),
    };
  }

  protected async event(input: EventInput): Promise<void> {
    await this.run.appendEvent(
      redactJson(
        {
          at: this.now().toISOString(),
          runId: this.run.id,
          ...input,
        } as RunEvent,
        this.sensitive,
      ),
    );
  }

  protected log(line: string): void {
    this.deps.log?.(line);
  }
}
