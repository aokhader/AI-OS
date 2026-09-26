import { type Classification, classify } from '../conditions/classify.js';
import { describePredicate, evaluatePredicate } from '../conditions/predicate.js';
import { digestOf } from '../digest.js';
import {
  checkPolicy,
  type GateResult,
  type Phase,
  permissivePolicy,
  RECORDED_SAFE_APPROVED,
} from '../policy/gate.js';
import type { ConfirmRequest, Operator } from '../ports/operator.js';
import type { RunHandle, Store } from '../ports/store.js';
import type { ParamValues, Surface, SurfaceObservation } from '../ports/surface.js';
import { redactJson, redactText, type SensitiveValue, shouldMask } from '../redact.js';
import { describeTarget, resolveTarget } from '../resolve/resolve-target.js';
import {
  type A11yNode,
  type Action,
  type AppProfile,
  actionTarget,
  type BootstrapStep,
  type Condition,
  type FailureKind,
  type Policy,
  type Recovery,
  type RecoveryRoutine,
  type Risk,
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
  /** Answers `confirm` verdicts (D-034). Without one, replay stops before a risky step. */
  operator?: Operator | undefined;
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
  private readonly recoveryCounts = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  protected rebootstraps = 0;

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
      this.raise(ok.verdict, 'bootstrap');
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
        this.raise(w.verdict, stepId);
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
      const r = await this.deps.surface.act(action, {
        actor: 'automation',
        values,
        baseUrl: this.baseUrl,
      });
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
      this.raise(post.verdict, stepId);
    }
    const after = await this.settled('after', stepId, detectors, {
      condition: step.postcondition,
      met: post.matched,
      detail: post.detail,
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
      this.raise(c, stepId);
    }
  }

  /** Turns a terminal classification into a Stop. Escalation arrives in P6. */
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
            observed: `condition ${c.condition.id} matched where recovery "${c.routine.kind}" cannot run`,
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

  // ---- policy --------------------------------------------------------------------------------

  /**
   * Acts on a verdict (D-034). `allow` returns the effective risk; `block` stops the run before
   * anything executes; `confirm` asks the operator, and with none attached the run ends with
   * `ESCALATION_ABANDONED`, since it needed a human and had none. Nothing has run: `sideEffects`
   * stays `none`.
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
    const answer = await this.confirm({
      ...ctx,
      cause: 'CONFIRM_REQUIRED',
      rule: v.rule,
      reason: v.reason,
    });
    if (answer.answer === 'approved') return 'risky';
    if (answer.answer === 'denied') {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'POLICY_BLOCKED',
          expected: `operator ${answer.operatorId} to approve ${ctx.stepId}`,
          observed: `${v.reason}; the operator denied it`,
        },
        ctx.stepId,
      );
    }
    throw new Stop(
      {
        kind: 'failure',
        failure: 'ESCALATION_ABANDONED',
        expected: `an operator to confirm ${ctx.stepId} (CONFIRM_REQUIRED)`,
        observed: `${v.reason}; no operator is attached to this run`,
      },
      ctx.stepId,
    );
  }

  /** Asks the attached operator, if any, and records the answer as a `confirmation` event. */
  protected async confirm(
    req: Omit<ConfirmRequest, 'runId' | 'phase' | 'screenshot'>,
  ): Promise<{ answer: 'approved' | 'denied' | 'unattended'; operatorId?: string }> {
    const operator = this.deps.operator;
    let answer: 'approved' | 'denied' | 'unattended' = 'unattended';
    if (operator) {
      this.log(
        `confirmation: ${req.cause} at ${req.stepId} (${req.reason}) → asking operator ${operator.info().id}`,
      );
      answer = await operator.confirm({
        runId: this.run.id,
        phase: this.phase,
        ...req,
        ...(this.lastScreenshot ? { screenshot: this.lastScreenshot } : {}),
      });
    }
    await this.event({
      type: 'confirmation',
      actor: answer === 'unattended' ? 'automation' : 'human',
      stepId: req.stepId,
      cause: req.cause,
      rule: req.rule,
      reason: req.reason,
      answer,
      ...(operator ? { operatorId: operator.info().id } : {}),
    });
    this.log(`confirmation: ${req.cause} at ${req.stepId} → ${answer}`);
    return { answer, ...(operator ? { operatorId: operator.info().id } : {}) };
  }

  /** `button "Open Account"`, with sensitive values redacted for the operator's terminal. */
  protected describeNode(node: A11yNode): string {
    return redactText(`${node.role} "${node.name}"`, this.sensitive);
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
        const res = await this.deps.surface.act(click, {
          actor: 'automation',
          values: {},
          baseUrl: this.baseUrl,
        });
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
    );
  }

  private async recordRecovery(
    stepId: string,
    condition: Condition,
    routine: RecoveryRoutine,
    attempt: number,
    outcome: Recovery['outcome'],
    budgetRemaining: number,
  ): Promise<void> {
    const recovery: Recovery = {
      stepId,
      conditionId: condition.id,
      routine,
      attempt,
      outcome,
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
