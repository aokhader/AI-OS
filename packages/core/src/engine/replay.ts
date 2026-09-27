import { describePredicate, matchUrl } from '../conditions/predicate.js';
import { RUNTIME_DETECTORS } from '../policy/gate.js';
import type { ParamValues, SurfaceObservation } from '../ports/surface.js';
import { maskOutputs, redactJson } from '../redact.js';
import { resolveTarget } from '../resolve/resolve-target.js';
import type {
  Capability,
  CapabilityRef,
  Condition,
  EscalationCause,
  FailureKind,
  ReplayResult,
  Run,
} from '../schema/index.js';
import { newRunId } from '../store/run-id.js';
import {
  credentialsFromEnv,
  EngineArgumentError,
  EngineBase,
  type EngineDeps,
  type EngineTimeouts,
  type HandBackOutcome,
  HandBackSignal,
  RebootstrapSignal,
  Stop,
} from './base.js';
import { scanCheckpoints } from './checkpoint.js';
import { parseOutput } from './parsers.js';
import { substituteRoute } from './values.js';

export interface ReplayOptions extends EngineTimeouts {
  capability: Capability;
  params: ParamValues;
  /** Origin of the target app, e.g. http://localhost:4100. Routes resolve against it. */
  baseUrl: string;
  variantId?: string | undefined;
}

export type ReplayDeps = EngineDeps;

/** @deprecated use EngineArgumentError */
export const ReplayArgumentError = EngineArgumentError;

/** Failures an operator cannot fix by acting on the page. */
const NEVER_ESCALATED: ReadonlySet<FailureKind> = new Set([
  'POLICY_BLOCKED',
  'ESCALATION_ABANDONED',
  'TIMEOUT',
]);

/**
 * Deterministic replay of a capability against a live surface. No model is involved: targets are
 * resolved from observations, every step is checkpointed, and every runtime condition is classified
 * before the engine decides what to do. docs/context/01-architecture.md §9–11.
 */
export async function replay(options: ReplayOptions, deps: ReplayDeps): Promise<ReplayResult> {
  const { capability, params } = options;
  for (const input of capability.inputs) {
    const value = params[input.name];
    if (input.required && value === undefined) {
      throw new EngineArgumentError(`missing required parameter ${input.name}`);
    }
    if (input.type === 'enum' && value !== undefined && !input.enum?.includes(value)) {
      throw new EngineArgumentError(
        `parameter ${input.name} must be one of ${input.enum?.join(', ')}`,
      );
    }
  }
  if (capability.app.vendorProductId !== deps.profile.vendorProductId) {
    throw new EngineArgumentError(
      `capability is bound to ${capability.app.vendorProductId} but the profile is ${deps.profile.vendorProductId}`,
    );
  }
  const credentials = capability.entry.requiresAuth
    ? credentialsFromEnv(deps.profile, deps.env ?? process.env)
    : {};
  return new ReplayEngine(options, deps, credentials).execute();
}

class ReplayEngine extends EngineBase {
  protected override readonly phase = 'replay';
  private readonly detectors: Condition[];

  constructor(
    private readonly options: ReplayOptions,
    deps: ReplayDeps,
    credentials: ParamValues,
  ) {
    super(deps, options.baseUrl, options, credentials);
    this.approved = options.capability.status === 'approved';
    this.detectors = [
      ...RUNTIME_DETECTORS,
      ...deps.profile.detectors,
      ...options.capability.detectors,
    ];
    this.sensitive = options.capability.inputs
      .filter((i) => i.sensitivity === 'sensitive' || i.sensitivity === 'secret')
      .map((i) => ({ name: i.name, value: options.params[i.name] ?? '' }))
      .filter((s) => s.value !== '');
    this.allValues = Object.values(options.params);
  }

  protected override escalationSubject(): { capability: CapabilityRef } {
    const { capability } = this.options;
    return { capability: { id: capability.id, version: capability.version } };
  }

  async execute(): Promise<ReplayResult> {
    const { capability, params, baseUrl, variantId } = this.options;
    const startedAt = this.now();
    const run: Run = {
      id: newRunId(startedAt),
      kind: 'replay',
      capability: { id: capability.id, version: capability.version },
      target: {
        vendorProductId: capability.app.vendorProductId,
        ...(variantId ? { variantId } : {}),
        entry: new URL(substituteRoute(capability.entry.route, params), baseUrl).toString(),
      },
      startedAt: startedAt.toISOString(),
      controlOwner: 'automation',
      sideEffects: 'none',
    };
    this.run = await this.deps.store.runs.create(redactJson(run, this.sensitive));
    this.log(`run ${run.id} started in ${this.run.dir}`);

    let result: ReplayResult;
    try {
      if (capability.entry.requiresAuth) await this.bootstrap();
      result = this.build({ status: 'success', outputs: await this.runFlow() }, undefined);
    } catch (err) {
      if (err instanceof Stop) {
        result = this.fromStop(err);
      } else {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.log(`engine error: ${message}`);
        result = this.build(
          {
            status: 'failure',
            kind: 'UNEXPECTED_STATE',
            expected: 'the engine to complete the run',
            observed: message,
          },
          this.currentStep,
        );
      }
    }

    // Sensitive outputs go to the caller in clear and to disk as hashed placeholders (D-035).
    const persisted: ReplayResult = redactJson(
      result.status === 'success'
        ? { ...result, outputs: maskOutputs(result.outputs, capability.outputs) }
        : result,
      this.sensitive,
    );
    await this.event({ type: 'result', actor: 'automation', result: persisted });
    await this.run.update({
      finishedAt: this.now().toISOString(),
      sideEffects: result.sideEffects,
    });
    await this.run.finish(persisted);
    this.log(`run ${run.id} finished: ${result.status}`);
    return result;
  }

  /**
   * Entry, steps, success. A session-level condition signs in again and restarts from the entry
   * (D-033). A hand-back resumes after the checkpoint scan or completes from the live page, and a
   * failure policy lets an operator fix becomes an escalation first (D-036).
   */
  private async runFlow(): Promise<Record<string, unknown>> {
    let start = 0;
    for (;;) {
      try {
        if (start === 0) await this.enter();
        return await this.flow(start);
      } catch (err) {
        if (err instanceof RebootstrapSignal) {
          await this.rebootstrap(err);
          start = 0;
          continue;
        }
        if (err instanceof HandBackSignal) {
          if (err.kind === 'mark_complete') return this.completeByHuman();
          start = await this.resumeFrom(err.stepId);
          continue;
        }
        if (err instanceof Stop && err.reason.kind === 'failure') {
          const hb = await this.escalateFailure(err);
          if (hb?.kind === 'mark_complete') return this.completeByHuman();
          if (hb?.kind === 'resume') {
            start = await this.resumeFrom(err.atStep ?? 'entry');
            continue;
          }
        }
        throw err;
      }
    }
  }

  /**
   * REPLAY_FAILURE and RECOVERY_EXHAUSTED escalate only when policy says so and an operator is
   * attached; otherwise the failure stands as classified. Abort and abandonment leave the original
   * failure in place, with the escalation block saying what happened.
   */
  private async escalateFailure(stop: Stop): Promise<HandBackOutcome | undefined> {
    if (stop.reason.kind !== 'failure' || !this.deps.operator) return undefined;
    if (NEVER_ESCALATED.has(stop.reason.failure)) return undefined;
    const cause: EscalationCause | undefined =
      stop.escalationCause === 'RECOVERY_EXHAUSTED'
        ? this.policy.escalateOn.recoveryExhausted
          ? 'RECOVERY_EXHAUSTED'
          : undefined
        : this.policy.escalateOn.replayFailure
          ? 'REPLAY_FAILURE'
          : undefined;
    if (!cause) return undefined;
    const stepId = stop.atStep ?? 'run';
    const step = this.options.capability.steps.find((s) => s.id === stepId);
    return this.escalate({
      cause,
      detail: `${stop.reason.failure}: expected ${stop.reason.expected}; observed ${stop.reason.observed}`,
      stepId,
      ...(step ? { stepIntent: step.intent } : {}),
      suggestedActions: ['resume', 'mark_complete', 'abort'],
    });
  }

  private async enter(): Promise<void> {
    const { capability, params } = this.options;
    this.currentStep = 'entry';
    await this.navigate(substituteRoute(capability.entry.route, params), 'entry');
    for (const pre of capability.entry.preconditions) {
      const w = await this.waitFor(
        pre,
        pre.when.timeoutMs ?? this.stepTimeoutMs,
        'entry',
        this.detectors,
      );
      if (w.verdict) {
        await this.snapshot('entry', w.obs);
        await this.raise(w.verdict, 'entry');
      }
      if (!w.matched) {
        await this.snapshot('entry', w.obs);
        throw new Stop(
          {
            kind: 'failure',
            failure: 'UNEXPECTED_STATE',
            expected: `at entry: ${describePredicate(pre.when)}`,
            observed: w.detail,
          },
          'entry',
        );
      }
    }
  }

  /** The compiled steps from `start`, the success condition and the outputs. */
  private async flow(start: number): Promise<Record<string, unknown>> {
    const { capability, params } = this.options;
    for (const step of capability.steps.slice(start)) {
      this.checkRunTimeout();
      await this.runStep(step, params, this.detectors, false);
      await this.extractOutputsAt(step.id);
    }
    this.currentStep = undefined;
    const success = await this.waitFor(
      capability.success,
      this.stepTimeoutMs,
      'success',
      this.detectors,
    );
    if (success.verdict) {
      await this.snapshot('success', success.obs);
      await this.raise(success.verdict, 'success');
    }
    if (!success.matched) {
      throw new Stop(
        {
          kind: 'failure',
          failure: 'CHECKPOINT_FAILED',
          expected: describePredicate(capability.success.when),
          observed: success.detail,
        },
        'success',
      );
    }
    return this.finalizeOutputs(success.obs);
  }

  // ---- hand-back -----------------------------------------------------------------------------

  /**
   * The checkpoint scan (01 §11): where did the human leave the flow? Postconditions of the step
   * that escalated and of every following step are evaluated against a fresh observation; the
   * flow continues after the last one that holds. Outputs of skipped steps are read from that
   * observation, and a skipped risky step counts as committed.
   */
  private async resumeFrom(stepId: string): Promise<number> {
    const { capability } = this.options;
    const steps = capability.steps;
    const obs = await this.observe('resume', stepId);
    const found = steps.findIndex((s) => s.id === stepId);
    const from = found >= 0 ? found : stepId === 'success' ? steps.length : 0;
    const scan = scanCheckpoints(steps, obs, from);
    for (const check of scan.checks) {
      const step = steps.find((s) => s.id === check.stepId);
      if (!step) continue;
      await this.event({
        type: 'condition',
        actor: 'automation',
        stepId: check.stepId,
        conditionId: step.postcondition.id,
        role: 'postcondition',
        matched: check.matched,
      });
    }
    const next = steps[scan.resumeAt]?.id ?? 'success';
    this.log(
      `resume: checkpoint scan from ${stepId} → ${
        scan.satisfied.length > 0
          ? `postcondition(s) of ${scan.satisfied.join(', ')} hold`
          : 'no postcondition holds'
      }; continuing at ${next}`,
    );
    for (const step of steps.slice(from, scan.resumeAt)) {
      if (step.risk === 'risky') {
        this.riskyExecuted = true;
        this.riskyConfirmed = true;
      }
      await this.extractOutputsAt(step.id);
    }
    return scan.resumeAt;
  }

  /**
   * The operator says the goal is achieved: verify the success condition on the live page and
   * re-extract every output from it. The operator never types a result.
   */
  private async completeByHuman(): Promise<Record<string, unknown>> {
    const { capability } = this.options;
    this.currentStep = 'success';
    const w = await this.waitFor(capability.success, this.stepTimeoutMs, 'success', this.detectors);
    if (w.verdict) {
      await this.snapshot('success', w.obs);
      await this.raise(w.verdict, 'success');
    }
    if (!w.matched) {
      await this.snapshot('success', w.obs);
      throw new Stop(
        {
          kind: 'failure',
          failure: 'CHECKPOINT_FAILED',
          expected: describePredicate(capability.success.when),
          observed: `marked complete by the operator, but ${w.detail}`,
        },
        'success',
      );
    }
    const ran = new Set(this.stepsRun.map((s) => s.stepId));
    if (capability.steps.some((s) => s.risk === 'risky' && !ran.has(s.id))) {
      this.riskyExecuted = true;
      this.riskyConfirmed = true;
    }
    return this.finalizeOutputs(w.obs);
  }

  // ---- outputs -------------------------------------------------------------------------------

  private async extractOutputsAt(stepId: string): Promise<void> {
    const obs = this.lastObservation;
    for (const spec of this.options.capability.outputs) {
      if (spec.atStep !== stepId || this.rawOutputs.has(spec.name) || !obs) continue;
      const raw = this.readOutput(spec, obs, stepId);
      if (raw !== undefined) this.rawOutputs.set(spec.name, raw);
    }
  }

  private readOutput(
    spec: Capability['outputs'][number],
    obs: SurfaceObservation,
    stepId: string,
  ): string | undefined {
    if ('urlParam' in spec.source) {
      const step = this.options.capability.steps.find((s) => s.id === stepId);
      const patterns = [step?.postcondition.when.url, this.options.capability.success.when.url];
      for (const pattern of patterns) {
        if (!pattern) continue;
        const m = matchUrl(pattern, obs);
        const value = m?.params[spec.source.urlParam];
        if (value !== undefined) return value;
      }
      return undefined;
    }
    const r = resolveTarget(obs.nodes, spec.source);
    return r.found ? (r.node.value ?? r.node.name) : undefined;
  }

  private finalizeOutputs(obs: SurfaceObservation): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    for (const spec of this.options.capability.outputs) {
      const raw = this.rawOutputs.get(spec.name) ?? this.readOutput(spec, obs, 'success');
      const parsed = raw === undefined ? undefined : parseOutput(raw, spec);
      if (parsed === undefined) {
        if (spec.required) {
          throw new Stop(
            {
              kind: 'failure',
              failure: 'UNEXPECTED_STATE',
              expected: `output ${spec.name} (${spec.type}${spec.parser ? `, ${spec.parser}` : ''}) after step ${spec.atStep}`,
              observed:
                raw === undefined
                  ? 'no source text could be extracted'
                  : `"${raw}" could not be parsed`,
            },
            'success',
          );
        }
        continue;
      }
      outputs[spec.name] = parsed;
    }
    return outputs;
  }

  // ---- results -------------------------------------------------------------------------------

  private fromStop(stop: Stop): ReplayResult {
    switch (stop.reason.kind) {
      case 'outcome':
        return this.build(
          {
            status: 'outcome',
            code: stop.reason.code,
            message: stop.reason.message,
            ...(stop.reason.data !== undefined ? { data: stop.reason.data } : {}),
          },
          stop.atStep,
        );
      case 'failure':
        return this.build(
          {
            status: 'failure',
            kind: stop.reason.failure,
            expected: stop.reason.expected,
            observed: stop.reason.observed,
          },
          stop.atStep,
        );
      case 'stopped':
        return this.build(
          {
            status: 'failure',
            kind: 'UNEXPECTED_STATE',
            expected: 'the replay to run to completion',
            observed: `${stop.reason.status}: ${stop.reason.reason}`,
          },
          stop.atStep,
        );
    }
  }

  private build(
    head:
      | { status: 'success'; outputs: Record<string, unknown> }
      | { status: 'outcome'; code: string; message: string; data?: unknown }
      | { status: 'failure'; kind: FailureKind; expected: string; observed: string },
    atStep: string | undefined,
  ): ReplayResult {
    const { capability, variantId } = this.options;
    const escalation = this.escalationBlock();
    return {
      ...head,
      capability: { id: capability.id, version: capability.version },
      ...(variantId ? { variantId } : {}),
      ...(atStep ? { atStep } : {}),
      stepsRun: this.stepsRun,
      recoveries: this.recoveries,
      sideEffects: this.sideEffects(),
      ...(escalation ? { escalation } : {}),
      evidence: this.evidence(head.status !== 'success'),
    };
  }
}
