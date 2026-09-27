import { type Classification, classify } from '../conditions/classify.js';
import { describePredicate, evaluatePredicate } from '../conditions/predicate.js';
import { digestOf } from '../digest.js';
import {
  checkPolicy,
  classifyRisk,
  type GateResult,
  type Phase,
  permissivePolicy,
  RECORDED_SAFE_APPROVED,
} from '../policy/gate.js';
import type { EscalationControls, Operator } from '../ports/operator.js';
import type { RecoveryPlanner } from '../ports/planner.js';
import type { RunHandle, Store } from '../ports/store.js';
import type {
  ActResult,
  HumanAction,
  ParamValues,
  Surface,
  SurfaceObservation,
} from '../ports/surface.js';
import {
  redactJson,
  redactObservation,
  redactText,
  type SensitiveValue,
  shouldMask,
} from '../redact.js';
import { describeTarget, resolveTarget } from '../resolve/resolve-target.js';
import {
  type A11yNode,
  type Action,
  type AppProfile,
  actionParams,
  actionTarget,
  type Baseline,
  type BootstrapStep,
  type CapabilityRef,
  type Condition,
  type ControlOwner,
  type Escalation,
  type EscalationBlock,
  type EscalationCause,
  type FailureKind,
  type HandBackKind,
  type Policy,
  type RecordedStep,
  type Recovery,
  type RecoveryRoutine,
  type Risk,
  type RunEvent,
  type SideEffects,
  type Step,
  type StepReport,
  type TargetSpec,
} from '../schema/index.js';
import { automationMayAct, type ControlEvent, transition } from './control.js';
import { humanStep, nodeForHuman } from './human.js';
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
  /** Answers `confirm` verdicts (D-034). Without one, replay stops before a risky step. */
  operator?: Operator | undefined;
  /** The only model on the replay path, behind policy.assistedFallback (01 §15, D-038). */
  recoveryPlanner?: RecoveryPlanner | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

/** Recovery budgets (01 §9); the defaults match config/policy.json. */
export interface EngineBudgets {
  recoveriesPerStep?: number | undefined;
  rebootstrapsPerRun?: number | undefined;
}

export interface EngineTimeouts {
  stepTimeoutMs?: number | undefined;
  runTimeoutMs?: number | undefined;
  /** Overrides `policy.budgets`. */
  budgets?: EngineBudgets | undefined;
  /** config/policy.json. Default: locked to the target origin, nothing risky (see permissivePolicy). */
  policy?: Policy | undefined;
}

export interface ResolvedBudgets {
  recoveriesPerStep: number;
  rebootstrapsPerRun: number;
}

export const DEFAULT_BUDGETS: ResolvedBudgets = {
  recoveriesPerStep: 2,
  rebootstrapsPerRun: 1,
};

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
    /** Set when the stop is one policy may turn into an escalation (D-036). */
    readonly escalationCause?: EscalationCause,
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

/**
 * A session-level condition (the sign-in page is back) needs the bootstrap routine to run again.
 * Raised from wherever the condition is seen and handled by the engine's outer loop (D-033).
 */
export class RebootstrapSignal extends Error {
  override readonly name = 'RebootstrapSignal';
  constructor(
    readonly condition: Condition,
    readonly stepId: string,
  ) {
    super(`rebootstrap: ${condition.id} at ${stepId}`);
  }
}

/**
 * An operator handed the session back with `resume` or `mark_complete` (D-036). Raised from
 * wherever the escalation happened and handled by the engine's outer loop: replay runs the
 * checkpoint scan or re-extracts outputs, discovery compiles what was recorded.
 */
export class HandBackSignal extends Error {
  override readonly name = 'HandBackSignal';
  constructor(
    readonly kind: 'resume' | 'mark_complete',
    readonly stepId: string,
    readonly escalation: Escalation,
  ) {
    super(`hand back: ${kind} at ${stepId}`);
  }
}

export interface EscalateInput {
  cause: EscalationCause;
  detail: string;
  stepId: string;
  stepIntent?: string | undefined;
  suggestedActions: HandBackKind[];
}

/** How an escalation ended: the operator's decision, or nobody came. */
export type HandBackOutcome =
  | { kind: HandBackKind; operatorId: string; humanActions: number }
  | { kind: 'abandoned'; humanActions: number };

/** A human step with the observations around it, for engines that record it (discovery). */
export interface HumanStepRecord {
  step: RecordedStep;
  target: TargetSpec;
  baseline: Baseline;
  before: SurfaceObservation;
  after: SurfaceObservation;
}

const RESOLUTIONS: Record<
  HandBackKind | 'abandoned',
  NonNullable<Escalation['resolution']>['kind']
> = {
  approve_step: 'approved',
  resume: 'resumed',
  mark_complete: 'completed_by_human',
  abort: 'aborted',
  abandoned: 'abandoned',
};

export interface WaitResult {
  matched: boolean;
  obs: SurfaceObservation;
  detail: string;
  /** A terminal classification met while waiting (outcome, fail or escalate); the caller raises it. */
  verdict?: Classification | undefined;
}

type RecoverClassification = Extract<Classification, { kind: 'recover' }>;

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
 * bootstrap, recovery routines with their budgets, and the execution of one compiled step.
 * Subclasses own their loop and their result.
 */
export abstract class EngineBase {
  protected run!: RunHandle;
  protected abstract readonly phase: Phase;
  protected readonly now: () => Date;
  protected readonly stepTimeoutMs: number;
  protected readonly runTimeoutMs: number;
  protected readonly policy: Policy;
  /** Replay: the capability's status is `approved`. Bootstrap and entry always count as approved. */
  protected approved = false;
  protected readonly budgets: ResolvedBudgets;
  protected readonly deadline: number;
  protected shots = 0;
  protected currentStep: string | undefined;
  protected lastObservation: SurfaceObservation | undefined;
  protected lastScreenshot: string | undefined;
  protected lastSnapshot: string | undefined;
  protected riskyExecuted = false;
  protected riskyConfirmed = false;
  protected readonly stepsRun: StepReport[] = [];
  protected readonly recoveries: Recovery[] = [];
  protected readonly rawOutputs = new Map<string, string>();
  /** Values that must never be persisted in clear text. */
  protected sensitive: SensitiveValue[] = [];
  /** Every parameter value, for anchor derivation of human steps. */
  protected allValues: string[] = [];
  private readonly recoveryCounts = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  protected rebootstraps = 0;
  /** Assisted proposals made this run, against policy.assistedFallback.maxPerRun. */
  protected assisted = 0;
  // ---- control transfer (01 §11) ----
  protected controlOwner: ControlOwner = 'automation';
  protected readonly humanActions: RecordedStep[] = [];
  protected lastEscalation: Escalation | undefined;
  private escalationCount = 0;
  private humanCount = 0;
  private humanChain: Promise<void> = Promise.resolve();
  /** The observation the previous human action was judged against, and when its after-observation started. */
  private humanBurst: { before: SurfaceObservation; afterStartedAt: string } | undefined;

  protected constructor(
    protected readonly deps: EngineDeps,
    protected readonly baseUrl: string,
    timeouts: EngineTimeouts,
    protected readonly credentials: ParamValues,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.stepTimeoutMs = timeouts.stepTimeoutMs ?? 15_000;
    this.runTimeoutMs = timeouts.runTimeoutMs ?? 600_000;
    this.policy = timeouts.policy ?? permissivePolicy(baseUrl);
    const origin = new URL(baseUrl).origin;
    if (!this.policy.allowedOrigins.some((o) => new URL(o).origin === origin)) {
      throw new EngineArgumentError(
        `target origin ${origin} is not in policy.allowedOrigins (${this.policy.allowedOrigins.join(', ')})`,
      );
    }
    this.budgets = {
      recoveriesPerStep:
        timeouts.budgets?.recoveriesPerStep ?? this.policy.budgets.recoveriesPerStep,
      rebootstrapsPerRun:
        timeouts.budgets?.rebootstrapsPerRun ?? this.policy.budgets.rebootstrapsPerRun,
    };
    this.deadline = Date.now() + this.runTimeoutMs;
  }

  // ---- phases ------------------------------------------------------------------------------

  protected async bootstrap(): Promise<void> {
    const b = this.deps.profile.bootstrap;
    // Session-level recoveries make no sense while signing in; everything else still applies.
    const detectors = this.deps.profile.detectors.filter((d) => d.recovery?.kind !== 'rebootstrap');
    this.currentStep = 'bootstrap';
    await this.navigate(b.entry, 'bootstrap');
    for (const step of b.steps) {
      await this.runStep(step, this.credentials, detectors, true);
    }
    const ok = await this.waitFor(b.success, this.stepTimeoutMs, 'bootstrap', detectors);
    if (ok.verdict) {
      await this.snapshot('bootstrap', ok.obs);
      await this.raise(ok.verdict, 'bootstrap');
    }
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

  /**
   * Signs in again after a session-level condition and lets the caller re-run the flow from its
   * entry (D-033). Refuses when a risky step has already executed: re-running could commit twice.
   */
  protected async rebootstrap(signal: RebootstrapSignal): Promise<void> {
    const { condition, stepId } = signal;
    const routine: RecoveryRoutine = { kind: 'rebootstrap' };
    const attempt = ++this.rebootstraps;
    const remaining = Math.max(0, this.budgets.rebootstrapsPerRun - attempt);
    if (attempt > this.budgets.rebootstrapsPerRun) {
      await this.recordRecovery(stepId, condition, routine, attempt, 'exhausted', 0);
      throw new Stop(
        {
          kind: 'failure',
          failure: 'UNEXPECTED_STATE',
          expected: 'the session to stay signed in for the rest of the run',
          observed: `condition ${condition.id} matched again at ${stepId}; re-bootstrap budget (${this.budgets.rebootstrapsPerRun} per run) exhausted`,
        },
        stepId,
      );
    }
    if (this.riskyExecuted) {
      await this.recordRecovery(stepId, condition, routine, attempt, 'failed', remaining);
      throw new Stop(
        {
          kind: 'failure',
          failure: 'UNEXPECTED_STATE',
          expected: 'no session loss after a risky step',
          observed: `condition ${condition.id} matched at ${stepId} after a risky step had executed; the flow is not re-run`,
        },
        stepId,
      );
    }
    this.log(
      `recovery: ${condition.id} at ${stepId} → sign in again and re-run the flow from its entry (attempt ${attempt})`,
    );
    try {
      await this.bootstrap();
    } catch (err) {
      await this.recordRecovery(stepId, condition, routine, attempt, 'failed', remaining);
      throw err;
    }
    await this.recordRecovery(stepId, condition, routine, attempt, 'recovered', remaining);
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
    const attempt = (this.attempts.get(stepId) ?? 0) + 1;
    this.attempts.set(stepId, attempt);
    this.log(`step ${stepId}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${step.intent}`);

    for (const pre of step.preconditions) {
      const w = await this.waitFor(pre, pre.when.timeoutMs ?? 2_000, stepId, detectors);
      if (w.verdict) {
        await this.snapshot(stepId, w.obs);
        await this.raise(w.verdict, stepId);
      }
      if (!w.matched) {
        await this.snapshot(stepId, w.obs);
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

    const before = await this.settled('before', stepId, detectors);

    let action = step.action;
    let node: A11yNode | undefined;
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
        const tried = res.tried
          .map((t) => `strategy ${t.index + 1}: ${t.candidateCount} candidate(s)`)
          .join(', ');
        const nearest = res.nearest.map((n) => `${n.role} "${n.name}"`).join(', ') || 'none';
        const expected = describeTarget(targetRef.spec);
        const observed = `${tried}; nearest: ${nearest}`;
        // Assisted fallback (01 §15): one proposed action may stand in for the step's own.
        const helped =
          'baseline' in step && step.action.kind !== 'extract'
            ? await this.assist({
                step,
                failure: 'TARGET_NOT_FOUND',
                expected,
                observed,
                obs: before,
                values,
                detectors,
              })
            : undefined;
        if (!helped) {
          await this.snapshot(stepId, before);
          throw new Stop(
            { kind: 'failure', failure: 'TARGET_NOT_FOUND', expected, observed },
            stepId,
          );
        }
        const after = await this.settled('after', stepId, detectors, {
          condition: step.postcondition,
          met: true,
          detail: 'met after an assisted recovery',
        });
        if (step.risk === 'risky') {
          this.riskyExecuted = true;
          this.riskyConfirmed = true;
        }
        if (!isBootstrap) {
          this.report({ stepId, attempts: attempt, durationMs: Date.now() - started, drift: true });
        }
        return after;
      }
      node = res.node;
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

    // The gate (D-015, D-034): action allowlist, origin and route of a navigation, live risk
    // against the recorded risk. Profile steps count as approved; capability steps need the review.
    const gate = checkPolicy(this.policy, {
      action,
      node,
      observation: before,
      phase: 'replay',
      baseUrl: this.baseUrl,
      values,
      recorded: { risk: step.risk, confirm: step.confirm, approved: isBootstrap || this.approved },
    });
    await this.event({
      type: 'policy_check',
      actor: 'automation',
      stepId,
      action: step.action,
      verdict: gate.verdict,
      liveRisk: gate.liveRisk,
      recordedRisk: step.risk,
      mismatch: gate.mismatch,
    });
    if (gate.mismatch) {
      this.log(`policy: ${stepId} is recorded ${step.risk} but classifies ${gate.liveRisk} live`);
    }
    // A refusal stops the run here: keep the page it was refused on as evidence.
    if (gate.verdict.kind !== 'allow') await this.snapshot(stepId, before);
    const risk = await this.enforce(gate, {
      stepId,
      intent: step.intent,
      action: step.action,
      ...(node ? { target: this.describeNode(node) } : {}),
    });

    if (step.action.kind !== 'extract') {
      const r = await this.act(action, values);
      if (risk === 'risky') this.riskyExecuted = true;
      if (!r.ok) {
        await this.snapshot(stepId, before);
        throw new Stop(
          {
            kind: 'failure',
            failure:
              r.reason === 'NAVIGATION_BLOCKED'
                ? 'POLICY_BLOCKED'
                : r.reason === 'NAVIGATION_FAILED'
                  ? 'APP_ERROR'
                  : 'UNEXPECTED_STATE',
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
      detectors,
    );
    if (post.verdict) {
      await this.snapshot(stepId, post.obs);
      await this.raise(post.verdict, stepId);
    }
    let met = post.matched;
    let detail = post.detail;
    if (!met && 'baseline' in step) {
      const helped = await this.assist({
        step,
        failure: 'CHECKPOINT_FAILED',
        expected: describePredicate(step.postcondition.when),
        observed: post.detail,
        obs: post.obs,
        values,
        detectors,
      });
      if (helped) {
        met = true;
        detail = 'met after an assisted recovery';
      }
    }
    const after = await this.settled('after', stepId, detectors, {
      condition: step.postcondition,
      met,
      detail,
    });
    if (risk === 'risky') this.riskyConfirmed = true;

    if (!isBootstrap) {
      this.report({
        stepId,
        attempts: attempt,
        durationMs: Date.now() - started,
        drift,
        ...(resolvedBy !== undefined ? { resolvedBy } : {}),
        ...(candidateCount !== undefined ? { candidateCount } : {}),
      });
    }
    return after;
  }

  /**
   * Observes and classifies until the observation is one the step can proceed from: recoverable
   * conditions are recovered (within budget) and the page observed again; anything else is raised.
   */
  private async settled(
    label: string,
    stepId: string,
    detectors: Condition[],
    post?: { condition: Condition; met: boolean; detail: string },
  ): Promise<SurfaceObservation> {
    for (;;) {
      const obs = await this.observe(label, stepId);
      const c = classify(obs, {
        stepId,
        detectors,
        ...(post
          ? {
              postcondition: {
                condition: post.condition,
                met: post.met || evaluatePredicate(post.condition.when, obs).matched,
                detail: post.detail,
              },
            }
          : {}),
      });
      if (c.kind === 'proceed') return obs;
      if (c.kind === 'recover') {
        if ((await this.recover(c, stepId, obs)) === 'recovered') continue;
        throw this.exhausted(c, stepId);
      }
      await this.snapshot(stepId, obs);
      await this.raise(c, stepId);
    }
  }

  /**
   * Turns a terminal classification into a Stop, or, for an escalate-class condition, into an
   * escalation whose hand-back decides: resume and mark_complete raise the signal for the outer
   * loop, abort and abandonment stop the run.
   */
  protected async raise(c: Classification, stepId: string): Promise<void> {
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
            observed: `condition ${c.condition.id} matched where recovery "${c.routine.kind}" cannot run`,
          },
          stepId,
        );
      case 'escalate': {
        const detail = `condition ${c.condition.id} matched${c.condition.message ? `: ${c.condition.message}` : ''}`;
        const hb = await this.escalate({
          cause: 'CONDITION_ESCALATE',
          detail,
          stepId,
          suggestedActions: ['resume', 'mark_complete', 'abort'],
        });
        if (hb.kind === 'resume' || hb.kind === 'mark_complete') {
          throw new HandBackSignal(hb.kind, stepId, this.lastEscalation as Escalation);
        }
        throw new Stop(
          {
            kind: 'failure',
            failure: hb.kind === 'abandoned' ? 'ESCALATION_ABANDONED' : 'UNEXPECTED_STATE',
            expected: `an operator to resolve ${c.condition.id} at ${stepId}`,
            observed:
              hb.kind === 'abandoned'
                ? `${detail}; nobody claimed the escalation`
                : `${detail}; operator ${hb.operatorId} aborted`,
          },
          stepId,
        );
      }
    }
  }

  // ---- control transfer and escalation (01 §11, D-036) --------------------------------------

  /** The only way the engines touch the surface's act: refused unless automation owns the session. */
  protected async act(action: Action, values: ParamValues): Promise<ActResult> {
    if (!automationMayAct(this.controlOwner)) {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'UNEXPECTED_STATE',
          expected: 'automation to own the session before acting',
          observed: `control owner is ${this.controlOwner}`,
        },
        this.currentStep,
      );
    }
    return this.deps.surface.act(action, { actor: 'automation', values, baseUrl: this.baseUrl });
  }

  /** What the escalation record says the run is doing: the capability or the goal. */
  protected abstract escalationSubject(): { capability?: CapabilityRef; goal?: string };

  /** Engines that record steps (discovery) keep the human's steps too. */
  protected onHumanStep(_record: HumanStepRecord): void {}

  /**
   * Writes the intervention request, moves the owner to awaiting_operator and waits for the
   * operator's hand-back through the controls, or for the abandonment timeout while nobody has
   * claimed. With no operator attached the escalation is abandoned at once.
   */
  protected async escalate(input: EscalateInput): Promise<HandBackOutcome> {
    const { cause, detail, stepId } = input;
    const obs = await this.observe('escalation', stepId);
    const id = `${this.run.id}-e${++this.escalationCount}`;
    await this.snapshot(stepId, obs, `${id.slice(this.run.id.length + 1)}-${stepId}`);
    const record: Escalation = {
      id,
      runId: this.run.id,
      phase: this.phase,
      ...this.escalationSubject(),
      cause,
      detail,
      atStep: stepId,
      ...(input.stepIntent ? { stepIntent: input.stepIntent } : {}),
      screenshot: this.lastScreenshot ?? 'none',
      snapshotDigest: digestOf(obs),
      suggestedActions: input.suggestedActions,
      requestedAt: this.now().toISOString(),
    };
    this.lastEscalation = record;
    await this.persistEscalation(record);
    await this.transfer({ type: 'escalate' }, { cause, escalationId: id, stepId });
    this.log(`escalation ${id}: ${cause} at ${stepId} (${detail})`);

    const operator = this.deps.operator;
    const mine: RecordedStep[] = [];
    if (!operator) {
      await this.resolveEscalation(record, 'abandoned', undefined, stepId, mine.length);
      return { kind: 'abandoned', humanActions: 0 };
    }

    let settle: (outcome: HandBackOutcome) => void = () => undefined;
    const done = new Promise<HandBackOutcome>((resolve) => {
      settle = resolve;
    });
    let claimedBy: string | undefined;
    let resolved = false;
    let detach: (() => void) | undefined;
    const listeners = new Set<(step: RecordedStep) => void>();
    const finish = async (outcome: HandBackOutcome, by: string | undefined) => {
      resolved = true;
      clearTimeout(timer);
      detach?.();
      await this.humanChain;
      await this.resolveEscalation(record, outcome.kind, by, stepId, mine.length);
      settle(outcome);
    };
    const timer = setTimeout(() => {
      if (!claimedBy && !resolved) {
        this.log(`escalation ${id}: nobody claimed within ${this.policy.escalationTimeoutMs} ms`);
        void finish({ kind: 'abandoned', humanActions: 0 }, undefined);
      }
    }, this.policy.escalationTimeoutMs);
    const claim = async (operatorId: string) => {
      if (resolved) throw new Error(`escalation ${id} is already resolved`);
      if (claimedBy === operatorId) return;
      if (claimedBy) throw new Error(`escalation ${id} is claimed by ${claimedBy}`);
      claimedBy = operatorId;
      clearTimeout(timer);
      record.claimedBy = operatorId;
      record.claimedAt = this.now().toISOString();
      await this.transfer({ type: 'claim' }, { operatorId, escalationId: id, stepId });
      await this.persistEscalation(record);
      detach = await this.deps.surface.captureHumanActions((action) => {
        this.humanChain = this.humanChain
          .then(async () => {
            const step = await this.recordHuman(action, stepId);
            mine.push(step);
            for (const l of listeners) l(step);
          })
          .catch((err: unknown) => {
            this.log(
              `human action not recorded: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      });
      this.log(`escalation ${id}: claimed by ${operatorId}; recording their actions`);
    };
    const controls: EscalationControls = {
      claim,
      handBack: async (kind, operatorId) => {
        if (resolved) throw new Error(`escalation ${id} is already resolved`);
        if (!claimedBy && kind !== 'abort') await claim(operatorId);
        await finish({ kind, operatorId, humanActions: mine.length }, operatorId);
      },
      current: () => record,
      humanActions: () => [...mine],
      onHumanAction: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      settled: done.then(() => record),
    };
    try {
      await operator.escalate(record, controls);
    } catch (err) {
      this.log(`operator failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!resolved) await finish({ kind: 'abandoned', humanActions: mine.length }, undefined);
    }
    const outcome = await done;
    if (outcome.kind !== 'abandoned') this.lastObservation = await this.observe('handback', stepId);
    return outcome;
  }

  private async resolveEscalation(
    record: Escalation,
    kind: HandBackKind | 'abandoned',
    by: string | undefined,
    stepId: string,
    humanActions: number,
  ): Promise<void> {
    record.resolution = {
      kind: RESOLUTIONS[kind],
      at: this.now().toISOString(),
      ...(by ? { by } : {}),
      humanActions,
    };
    const event: ControlEvent =
      kind === 'abandoned'
        ? { type: 'abandon' }
        : { type: 'hand_back', to: kind === 'abort' ? 'aborted' : 'automation' };
    await this.transfer(event, {
      ...(by ? { operatorId: by } : {}),
      escalationId: record.id,
      handBack: kind,
      stepId,
    });
    await this.persistEscalation(record);
    this.log(`escalation ${record.id}: ${record.resolution.kind}${by ? ` by ${by}` : ''}`);
  }

  private async persistEscalation(record: Escalation): Promise<void> {
    const redacted = redactJson(record, this.sensitive);
    await this.deps.store.escalations.put(redacted);
    await this.run.putJson('escalation.json', redacted);
  }

  /** One transition of the control-owner machine, recorded and mirrored into run.json. */
  private async transfer(
    event: ControlEvent,
    extra: {
      stepId: string;
      operatorId?: string | undefined;
      cause?: EscalationCause | undefined;
      escalationId?: string | undefined;
      handBack?: HandBackKind | 'abandoned' | undefined;
    },
  ): Promise<void> {
    const from = this.controlOwner;
    const to = transition(from, event);
    this.controlOwner = to;
    await this.event({
      type: 'control_transfer',
      actor: event.type === 'claim' || event.type === 'hand_back' ? 'human' : 'automation',
      stepId: extra.stepId,
      from,
      to,
      ...(extra.operatorId ? { operatorId: extra.operatorId } : {}),
      ...(extra.cause ? { cause: extra.cause } : {}),
      ...(extra.escalationId ? { escalationId: extra.escalationId } : {}),
      ...(extra.handBack ? { handBack: extra.handBack } : {}),
    });
    await this.run.update({ controlOwner: to });
  }

  /**
   * A person's action becomes a first-class step: the target is derived from the observation they
   * acted on, the page is observed again once it settles, and the step is logged as human.
   */
  private async recordHuman(action: HumanAction, stepId: string): Promise<RecordedStep> {
    // Events can arrive faster than observations: a click right after a change belongs to the same
    // page as the change, so an action older than the previous after-observation reuses its before.
    const burst = this.humanBurst;
    const inBurst = burst !== undefined && action.at <= burst.afterStartedAt;
    const before = inBurst
      ? burst.before
      : (this.lastObservation ?? (await this.deps.surface.observe({ screenshot: false })));
    const node = nodeForHuman(action, before);
    const risk: Risk =
      node && action.kind === 'click'
        ? classifyRisk(this.policy, {
            action: { kind: 'click', target: { ref: node.ref } },
            node,
            observation: before,
            phase: this.phase,
            baseUrl: this.baseUrl,
            values: {},
          })
          ? 'risky'
          : 'safe'
        : 'safe';
    if (!inBurst) await this.settleAfter(before);
    const afterStartedAt = this.now().toISOString();
    const after = await this.observe('human', stepId);
    this.humanBurst = { before, afterStartedAt };
    const { step, target, baseline } = humanStep({
      id: `h${++this.humanCount}`,
      action,
      before,
      after,
      paramValues: this.allValues,
      risk,
    });
    if (risk === 'risky') this.riskyExecuted = true;
    this.humanActions.push(step);
    await this.event({ type: 'human_action', actor: 'human', stepId, step });
    this.onHumanStep({ step, target, baseline, before, after });
    this.log(
      `human: ${step.intent}${node ? '' : ' (element was not in the last observation; structural target)'}`,
    );
    return step;
  }

  /** The escalation block of the result: the last escalation and every human action of the run. */
  protected escalationBlock(): EscalationBlock | undefined {
    const e = this.lastEscalation;
    if (!e?.resolution) return undefined;
    return {
      id: e.id,
      cause: e.cause,
      humanActions: this.humanActions,
      resolution: e.resolution.kind,
      ...(e.resolution.by ? { operatorId: e.resolution.by } : {}),
    };
  }

  /**
   * Gives the page a moment to react before the next observation: an action that navigates would
   * otherwise be observed on the page it left. Bounded, since some actions change nothing visible.
   */
  protected async settleAfter(before: SurfaceObservation): Promise<void> {
    const digest = digestOf(before);
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const now = await this.deps.surface.observe({ screenshot: false });
      if (digestOf(now) !== digest) return;
      await sleep(100);
    }
  }

  // ---- policy --------------------------------------------------------------------------------

  /**
   * Acts on a verdict (D-034). `allow` returns the effective risk; `block` stops the run before
   * anything executes; `confirm` escalates with CONFIRM_REQUIRED: approve_step runs the step,
   * resume and mark_complete mean the operator did it by hand (signal for the outer loop), abort
   * stops as POLICY_BLOCKED, and with nobody answering the run ends with ESCALATION_ABANDONED.
   * Nothing has run in the last three cases: `sideEffects` stays `none`.
   */
  protected async enforce(
    gate: GateResult,
    ctx: { stepId: string; intent: string; action: Action; target?: string | undefined },
  ): Promise<Risk> {
    const v = gate.verdict;
    if (v.kind === 'allow') return v.risk;
    if (v.kind === 'block') {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'POLICY_BLOCKED',
          expected: `${ctx.action.kind} at ${ctx.stepId} to pass policy rule ${v.rule}`,
          observed: v.reason,
        },
        ctx.stepId,
      );
    }
    const hb = await this.confirm({
      stepId: ctx.stepId,
      intent: ctx.intent,
      rule: v.rule,
      reason: v.reason,
    });
    switch (hb.kind) {
      case 'approve_step':
        return 'risky';
      case 'resume':
      case 'mark_complete':
        throw new HandBackSignal(hb.kind, ctx.stepId, this.lastEscalation as Escalation);
      case 'abort':
        throw new Stop(
          {
            kind: 'failure',
            failure: 'POLICY_BLOCKED',
            expected: `operator ${hb.operatorId} to approve ${ctx.stepId}`,
            observed: `${v.reason}; the operator aborted`,
          },
          ctx.stepId,
        );
      case 'abandoned':
        throw new Stop(
          {
            kind: 'failure',
            failure: 'ESCALATION_ABANDONED',
            expected: `an operator to confirm ${ctx.stepId} (CONFIRM_REQUIRED)`,
            observed: `${v.reason}; ${this.deps.operator ? 'nobody claimed the escalation' : 'no operator is attached to this run'}`,
          },
          ctx.stepId,
        );
    }
  }

  /** A CONFIRM_REQUIRED escalation, recorded as a `confirmation` event however it ends. */
  protected async confirm(req: {
    stepId: string;
    intent: string;
    rule: string;
    reason: string;
  }): Promise<HandBackOutcome> {
    const hb = await this.escalate({
      cause: 'CONFIRM_REQUIRED',
      detail: req.reason,
      stepId: req.stepId,
      stepIntent: req.intent,
      suggestedActions: ['approve_step', 'resume', 'mark_complete', 'abort'],
    });
    const answer =
      hb.kind === 'approve_step'
        ? 'approved'
        : hb.kind === 'abort'
          ? 'denied'
          : hb.kind === 'abandoned'
            ? 'unattended'
            : 'handled';
    await this.event({
      type: 'confirmation',
      actor: hb.kind === 'abandoned' ? 'automation' : 'human',
      stepId: req.stepId,
      cause: 'CONFIRM_REQUIRED',
      rule: req.rule,
      reason: req.reason,
      answer,
      ...(hb.kind !== 'abandoned' ? { operatorId: hb.operatorId } : {}),
    });
    this.log(`confirmation: CONFIRM_REQUIRED at ${req.stepId} → ${answer}`);
    return hb;
  }

  /** `button "Open Account"`, with sensitive values redacted for the operator's terminal. */
  protected describeNode(node: A11yNode): string {
    return redactText(`${node.role} "${node.name}"`, this.sensitive);
  }

  // ---- assisted fallback (01 §15, D-038) ------------------------------------------------------

  /**
   * One model call, one action, re-verified against the step's own postcondition, within
   * policy.assistedFallback.maxPerRun. The proposal passes the policy gate like any action and a
   * risky one is refused: an assisted recovery never commits anything. Returns the observation on
   * which the postcondition held, or undefined when the original failure stands.
   */
  protected async assist(input: {
    step: Step;
    failure: 'TARGET_NOT_FOUND' | 'CHECKPOINT_FAILED';
    expected: string;
    observed: string;
    obs: SurfaceObservation;
    values: ParamValues;
    detectors: Condition[];
  }): Promise<SurfaceObservation | undefined> {
    const planner = this.deps.recoveryPlanner;
    const config = this.policy.assistedFallback;
    if (!planner || !config.enabled || this.phase !== 'replay') return undefined;
    const { step, obs, values } = input;
    const stepId = step.id;
    const attempt = this.assisted + 1;
    if (attempt > config.maxPerRun) {
      this.log(
        `assisted: budget of ${config.maxPerRun} proposal(s) per run exhausted at ${stepId}`,
      );
      return undefined;
    }
    this.assisted = attempt;
    const remaining = config.maxPerRun - attempt;
    const routine: RecoveryRoutine = { kind: 'assisted' };
    const record = (outcome: Recovery['outcome'], proposal?: Action) =>
      this.recordRecovery(
        stepId,
        step.postcondition,
        routine,
        attempt,
        outcome,
        remaining,
        proposal,
      );
    this.log(
      `assisted: ${input.failure} at ${stepId}; asking ${planner.info().model} for one action`,
    );
    let proposal: Action | null = null;
    try {
      proposal = await planner.proposeOne({
        observation: {
          ...redactObservation(obs, this.sensitive),
          ...(obs.screenshotPng ? { screenshotPng: obs.screenshotPng } : {}),
        },
        step,
        expected: input.expected,
        observed: input.observed,
      });
    } catch (err) {
      this.log(`assisted: planner failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!proposal) {
      this.log('assisted: no proposal');
      await record('failed');
      return undefined;
    }
    const ref = actionTarget(proposal);
    const node = ref && 'ref' in ref ? obs.nodes.find((n) => n.ref === ref.ref) : undefined;
    if (ref && !node) {
      this.log('assisted: the proposal targets an element that is not on the page');
      await record('failed', proposal);
      return undefined;
    }
    if (actionParams(proposal).some((u) => !(u.param in values))) {
      this.log('assisted: the proposal uses an unknown parameter');
      await record('failed', proposal);
      return undefined;
    }
    const gate = checkPolicy(this.policy, {
      action: proposal,
      node,
      observation: obs,
      phase: 'replay',
      baseUrl: this.baseUrl,
      values,
      recorded: { risk: step.risk, confirm: step.confirm, approved: this.approved },
    });
    await this.event({
      type: 'policy_check',
      actor: 'automation',
      stepId,
      action: proposal,
      verdict: gate.verdict,
      liveRisk: gate.liveRisk,
      recordedRisk: step.risk,
      mismatch: gate.mismatch,
    });
    if (gate.verdict.kind !== 'allow' || gate.verdict.risk === 'risky') {
      this.log(
        `assisted: proposal refused (${gate.verdict.kind === 'allow' ? 'risky' : gate.verdict.rule}); an assisted recovery never runs a risky action`,
      );
      await record('failed', proposal);
      return undefined;
    }
    await this.event({
      type: 'decision',
      actor: 'automation',
      stepId,
      decision: { kind: 'tool', action: proposal, intent: `assisted recovery of ${stepId}` },
      intent: `assisted recovery of ${stepId}`,
    });
    const started = Date.now();
    const r = await this.act(proposal, values);
    await this.event({
      type: 'action',
      actor: 'automation',
      stepId,
      action: proposal,
      durationMs: Date.now() - started,
    });
    if (!r.ok) {
      this.log(`assisted: the proposal failed to execute: ${r.reason}: ${r.detail}`);
      await record('failed', proposal);
      return undefined;
    }
    const post = await this.waitFor(
      step.postcondition,
      step.postcondition.when.timeoutMs ?? this.stepTimeoutMs,
      stepId,
      input.detectors,
    );
    if (post.verdict) {
      await this.snapshot(stepId, post.obs);
      await this.raise(post.verdict, stepId);
    }
    if (!post.matched) {
      this.log(`assisted: the postcondition still does not hold: ${post.detail}`);
      await record('failed', proposal);
      return undefined;
    }
    await record('recovered', proposal);
    return post.obs;
  }

  // ---- recoveries ----------------------------------------------------------------------------

  /**
   * Runs one recovery routine (01 §9). `dismiss` clicks the routine's target; `wait-retry` sleeps
   * and re-checks the condition up to its attempts; `rebootstrap` raises a signal for the outer
   * loop. At most `recoveriesPerStep` routines run per step; beyond that the caller fails the step.
   */
  protected async recover(
    c: RecoverClassification,
    stepId: string,
    obs: SurfaceObservation,
  ): Promise<'recovered' | 'exhausted'> {
    const { condition, routine } = c;
    if (routine.kind === 'rebootstrap') {
      await this.snapshot(stepId, obs, `${stepId}-${condition.id}`);
      throw new RebootstrapSignal(condition, stepId);
    }
    const attempt = (this.recoveryCounts.get(stepId) ?? 0) + 1;
    const remaining = Math.max(0, this.budgets.recoveriesPerStep - attempt);
    if (attempt > this.budgets.recoveriesPerStep) {
      await this.recordRecovery(stepId, condition, routine, attempt, 'exhausted', 0);
      return 'exhausted';
    }
    this.recoveryCounts.set(stepId, attempt);
    await this.snapshot(stepId, obs, `${stepId}-${condition.id}`);
    this.log(`recovery: ${condition.id} at ${stepId} → ${routine.kind} (attempt ${attempt})`);

    let outcome: Recovery['outcome'] = 'failed';
    let detail = '';
    switch (routine.kind) {
      case 'dismiss': {
        const r = resolveTarget(obs.nodes, routine.target);
        if (!r.found) {
          detail = `dismiss target not found: ${describeTarget(routine.target)}`;
          break;
        }
        // Recovery routines never perform risky actions (D-034).
        const click: Action = { kind: 'click', target: { ref: r.ref } };
        const gate = checkPolicy(this.policy, {
          action: click,
          node: r.node,
          observation: obs,
          phase: 'replay',
          baseUrl: this.baseUrl,
          values: {},
          recorded: RECORDED_SAFE_APPROVED,
        });
        await this.event({
          type: 'policy_check',
          actor: 'automation',
          stepId,
          action: click,
          verdict: gate.verdict,
          liveRisk: gate.liveRisk,
          mismatch: gate.mismatch,
        });
        if (gate.verdict.kind !== 'allow') {
          detail = `dismiss click refused by policy (${gate.verdict.rule}): ${gate.verdict.reason}`;
          break;
        }
        const res = await this.act(click, {});
        if (res.ok) outcome = 'recovered';
        else detail = `dismiss click failed: ${res.reason}: ${res.detail}`;
        break;
      }
      case 'wait-retry': {
        for (let i = 0; i < routine.maxAttempts; i++) {
          await sleep(routine.ms);
          const again = await this.deps.surface.observe({ screenshot: false });
          if (!evaluatePredicate(condition.when, again).matched) {
            outcome = 'recovered';
            break;
          }
        }
        if (outcome !== 'recovered') {
          detail = `condition still matched after ${routine.maxAttempts} wait(s) of ${routine.ms} ms`;
        }
        break;
      }
      case 'assisted':
        detail = 'assisted fallback is not enabled';
        break;
    }
    await this.recordRecovery(stepId, condition, routine, attempt, outcome, remaining);
    if (outcome === 'failed') {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'UNEXPECTED_STATE',
          expected: `recovery "${routine.kind}" for condition ${condition.id} to succeed`,
          observed: detail,
        },
        stepId,
      );
    }
    return 'recovered';
  }

  protected exhausted(c: RecoverClassification, stepId: string): Stop {
    return new Stop(
      {
        kind: 'failure',
        failure: 'UNEXPECTED_STATE',
        expected: `condition ${c.condition.id} to clear after recovery "${c.routine.kind}"`,
        observed: `recovery budget (${this.budgets.recoveriesPerStep} per step) exhausted at ${stepId}; the condition still matches`,
      },
      stepId,
      'RECOVERY_EXHAUSTED',
    );
  }

  private async recordRecovery(
    stepId: string,
    condition: Condition,
    routine: RecoveryRoutine,
    attempt: number,
    outcome: Recovery['outcome'],
    budgetRemaining: number,
    proposal?: Action,
  ): Promise<void> {
    const recovery: Recovery = {
      stepId,
      conditionId: condition.id,
      routine,
      attempt,
      outcome,
      ...(proposal ? { proposal } : {}),
      at: this.now().toISOString(),
    };
    this.recoveries.push(recovery);
    await this.event({ type: 'recovery', actor: 'automation', stepId, recovery, budgetRemaining });
    this.log(`recovery: ${condition.id} at ${stepId} → ${outcome}`);
  }

  // ---- surface helpers ---------------------------------------------------------------------

  /** Bootstrap and entry navigations: gated like any other action, recorded safe and approved. */
  protected async navigate(route: string, stepId: string): Promise<void> {
    const started = Date.now();
    const action = { kind: 'navigate' as const, url: { text: route } };
    const gate = checkPolicy(this.policy, {
      action,
      observation: this.lastObservation ?? { title: '', frames: [], nodes: [], dialogs: [] },
      phase: 'replay',
      baseUrl: this.baseUrl,
      values: {},
      recorded: RECORDED_SAFE_APPROVED,
    });
    await this.event({
      type: 'policy_check',
      actor: 'automation',
      stepId,
      action,
      verdict: gate.verdict,
      liveRisk: gate.liveRisk,
      mismatch: gate.mismatch,
    });
    await this.enforce(gate, { stepId, intent: `open ${route}`, action });
    const r = await this.act(action, {});
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
          failure: r.reason === 'NAVIGATION_BLOCKED' ? 'POLICY_BLOCKED' : 'APP_ERROR',
          expected: `navigation to ${route} to succeed`,
          observed: `${r.reason}: ${r.detail}`,
        },
        stepId,
      );
    }
  }

  /** A full observation with a screenshot, masked wherever a sensitive value shows (D-035). */
  protected async observe(label: string, stepId: string | undefined): Promise<SurfaceObservation> {
    const obs = await this.deps.surface.observe({
      screenshot: true,
      ...(this.sensitive.length > 0
        ? { mask: (node: A11yNode) => shouldMask(node, this.sensitive) }
        : {}),
    });
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

  /**
   * Polls until the condition holds or the timeout passes. Detectors are evaluated on every poll
   * (01 §9): recoverable ones are recovered on the spot and the wait continues, session-level ones
   * raise the rebootstrap signal, and terminal ones end the wait with a verdict for the caller.
   */
  protected async waitFor(
    condition: Condition,
    timeoutMs: number,
    stepId: string,
    detectors: Condition[] = [],
  ): Promise<WaitResult> {
    let deadline = Date.now() + Math.max(0, timeoutMs);
    let obs: SurfaceObservation;
    let r: { matched: boolean; detail: string };
    let verdict: Classification | undefined;
    for (;;) {
      obs = await this.deps.surface.observe({ screenshot: false });
      r = evaluatePredicate(condition.when, obs);
      if (r.matched) break;
      if (detectors.length > 0) {
        const c = classify(obs, { stepId, detectors });
        if (c.kind === 'recover') {
          const started = Date.now();
          if ((await this.recover(c, stepId, obs)) === 'recovered') {
            deadline += Date.now() - started;
            continue;
          }
          throw this.exhausted(c, stepId);
        }
        if (c.kind !== 'proceed') {
          verdict = c;
          break;
        }
      }
      if (Date.now() >= deadline) break;
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
    return { matched: r.matched, obs, detail: r.detail, verdict };
  }

  /** Persists a redacted observation as evidence. */
  protected async snapshot(stepId: string, obs: SurfaceObservation, name?: string): Promise<void> {
    this.lastSnapshot = await this.run.putJson(
      `snapshots/${name ?? stepId}.json`,
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

  /** One report per step id; a re-run after a rebootstrap updates it with the new attempt count. */
  private report(entry: StepReport): void {
    const i = this.stepsRun.findIndex((s) => s.stepId === entry.stepId);
    if (i >= 0) this.stepsRun[i] = entry;
    else this.stepsRun.push(entry);
  }

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
