import { classify } from '../conditions/classify.js';
import { digestOf } from '../digest.js';
import type { Planner, PlannerTurn } from '../ports/planner.js';
import type { ParamValues, SurfaceObservation } from '../ports/surface.js';
import { redactJson, redactObservation } from '../redact.js';
import {
  type Action,
  actionParams,
  actionTarget,
  type Decision,
  type DiscoveryResult,
  type InputSpec,
  type RecordedStep,
  type Run,
  type Sensitivity,
  type TargetSpec,
} from '../schema/index.js';
import { newRunId } from '../store/run-id.js';
import { compileCapability, type DiscoveredOutput, type DiscoveredStep } from '../compile/compile.js';
import { baselineOf, deriveTargetSpec } from '../compile/derive-target.js';
import {
  credentialsFromEnv,
  EngineArgumentError,
  EngineBase,
  type EngineDeps,
  type EngineTimeouts,
  Stop,
} from './base.js';
import { resolveValue } from './values.js';

export interface DiscoverParam {
  name: string;
  type: InputSpec['type'];
  description: string;
  sensitivity: Sensitivity;
  value: string;
  enum?: string[] | undefined;
}

export interface DiscoverOptions extends EngineTimeouts {
  goal: string;
  params: DiscoverParam[];
  /** Id and name of the capability to compile. */
  capabilityId: string;
  name: string;
  description?: string | undefined;
  /** Route to open after bootstrap. Default "/". */
  entryRoute?: string | undefined;
  requiresAuth?: boolean | undefined;
  baseUrl: string;
  variantId?: string | undefined;
  maxSteps?: number | undefined;
  /** Business outcomes the caller knows about; become outcome detectors on the capability. */
  outcomes?: Array<{ code: string; text: string; message?: string | undefined }> | undefined;
  /** Sensitivity of every discovered output. Default sensitive: this is financial data. */
  outputSensitivity?: Sensitivity | undefined;
  compilerVersion?: string | undefined;
}

export interface DiscoverDeps extends EngineDeps {
  planner: Planner;
}

const STUCK_REPEATS = 3;

/**
 * The LLM-driven observe → decide → act loop (§6). The model sees redacted observations and
 * parameters by name only; every action is recorded with locator strategies derived from the
 * element it acted on; a successful run is compiled into a draft capability (§7).
 */
export async function discover(options: DiscoverOptions, deps: DiscoverDeps): Promise<DiscoveryResult> {
  if (options.params.some((p) => p.value === '')) {
    throw new EngineArgumentError('every parameter needs a value for discovery');
  }
  const requiresAuth = options.requiresAuth ?? true;
  const credentials = requiresAuth ? credentialsFromEnv(deps.profile, deps.env ?? process.env) : {};
  return new DiscoveryEngine(options, deps, credentials, requiresAuth).execute();
}

interface PendingStep {
  intent: string;
  action: Action;
  target: TargetSpec | undefined;
  baseline: ReturnType<typeof baselineOf> | undefined;
  before: SurfaceObservation;
  signature: string;
}

class DiscoveryEngine extends EngineBase {
  private readonly values: ParamValues;
  private readonly steps: DiscoveredStep[] = [];
  private readonly recorded: RecordedStep[] = [];
  private readonly signatures: string[] = [];
  private readonly digests: string[] = [];

  constructor(
    private readonly options: DiscoverOptions,
    private readonly discoverDeps: DiscoverDeps,
    credentials: ParamValues,
    private readonly requiresAuth: boolean,
  ) {
    super(discoverDeps, options.baseUrl, options, credentials);
    this.values = Object.fromEntries(options.params.map((p) => [p.name, p.value]));
    this.sensitive = options.params
      .filter((p) => p.sensitivity === 'sensitive' || p.sensitivity === 'secret')
      .map((p) => ({ name: p.name, value: p.value }));
  }

  async execute(): Promise<DiscoveryResult> {
    const { options } = this;
    const planner = this.discoverDeps.planner;
    const startedAt = this.now();
    const entryRoute = options.entryRoute ?? '/';
    const run: Run = {
      id: newRunId(startedAt),
      kind: 'discovery',
      goal: {
        text: options.goal,
        params: Object.fromEntries(
          options.params.map((p) => [p.name, { type: p.type, sensitivity: p.sensitivity }]),
        ),
      },
      target: {
        vendorProductId: this.deps.profile.vendorProductId,
        ...(options.variantId ? { variantId: options.variantId } : {}),
        entry: new URL(entryRoute, options.baseUrl).toString(),
      },
      model: planner.info().model,
      startedAt: startedAt.toISOString(),
      controlOwner: 'automation',
      sideEffects: 'none',
    };
    this.run = await this.deps.store.runs.create(run);
    this.log(`discovery ${run.id} started in ${this.run.dir}`);

    let result: DiscoveryResult;
    try {
      await this.resolveVersion();
      if (this.requiresAuth) await this.bootstrap();
      this.currentStep = 'entry';
      await this.navigate(entryRoute, 'entry');
      const finish = await this.loop();
      const capability = this.compile(finish, run);
      await this.deps.store.capabilities.put(capability);
      this.log(`compiled ${capability.id} v${capability.version} (${capability.steps.length} steps)`);
      result = {
        status: 'compiled',
        capability: { id: capability.id, version: capability.version },
        stepsRecorded: this.recorded.length,
        evidence: this.evidence(false),
      };
    } catch (err) {
      result = this.fromError(err);
    }

    await this.run.putText(
      'transcript.redacted.jsonl',
      planner
        .transcript()
        .map((e) => JSON.stringify(redactJson(e, this.sensitive)))
        .join('\n')
        .concat('\n'),
    );
    await this.event({ type: 'result', actor: 'automation', result });
    await this.run.update({ finishedAt: this.now().toISOString(), sideEffects: this.sideEffects() });
    await this.run.finish(result);
    this.log(`discovery ${run.id} finished: ${result.status}`);
    return result;
  }

  // ---- the loop ------------------------------------------------------------------------------

  private async loop(): Promise<{
    outputs: DiscoveredOutput[];
    finalObservation: SurfaceObservation;
    firstObservation: SurfaceObservation;
  }> {
    const maxSteps = this.options.maxSteps ?? 30;
    const planner = this.discoverDeps.planner;
    const params = this.options.params.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      sensitivity: p.sensitivity,
    }));
    let lastAction: PlannerTurn['lastAction'];
    let pending: PendingStep | undefined;
    let firstObservation: SurfaceObservation | undefined;

    for (let turn = 1; turn <= maxSteps; turn++) {
      this.checkRunTimeout();
      this.currentStep = `t${turn}`;
      const obs = await this.observe('turn', `t${turn}`);
      firstObservation ??= obs;
      if (pending) {
        this.commit(pending, obs);
        pending = undefined;
      }
      this.checkDetectors(obs, `t${turn}`);
      this.checkStuck(obs);

      const redacted = redactObservation(obs, this.sensitive);
      const decision = await planner.decide({
        turn,
        goal: this.options.goal,
        params,
        observation: { ...redacted, ...(obs.screenshotPng ? { screenshotPng: obs.screenshotPng } : {}) },
        ...(lastAction ? { lastAction } : {}),
        stepsRemaining: maxSteps - turn,
      });
      await this.event({
        type: 'decision',
        actor: 'automation',
        stepId: `t${turn}`,
        decision,
        ...(decision.kind === 'tool' ? { intent: decision.intent } : {}),
      });

      switch (decision.kind) {
        case 'finish': {
          const outputs = this.collectOutputs(decision, obs);
          if ('error' in outputs) {
            lastAction = { decision, status: 'invalid', detail: outputs.error };
            continue;
          }
          this.log(`finish: ${decision.summary}`);
          return { outputs: outputs.outputs, finalObservation: obs, firstObservation };
        }
        case 'give_up':
          throw new Stop({ kind: 'stopped', status: 'gave_up', reason: decision.reason }, `t${turn}`);
        case 'request_human':
          throw new Stop(
            {
              kind: 'stopped',
              status: 'gave_up',
              reason: `the model asked for an operator: ${decision.reason} (escalation arrives in P6)`,
            },
            `t${turn}`,
          );
        case 'tool': {
          const outcome = await this.perform(decision, obs, turn);
          lastAction = { decision, status: outcome.status, detail: outcome.detail };
          if (outcome.pending) pending = outcome.pending;
          break;
        }
      }
    }
    throw new Stop(
      { kind: 'stopped', status: 'limit', reason: `step limit of ${maxSteps} reached` },
      this.currentStep,
    );
  }

  private async perform(
    decision: Extract<Decision, { kind: 'tool' }>,
    obs: SurfaceObservation,
    turn: number,
  ): Promise<{ status: 'ok' | 'failed' | 'invalid' | 'blocked'; detail: string; pending?: PendingStep }> {
    const stepId = `t${turn}`;
    const action = decision.action;
    const targetRef = actionTarget(action);
    let node: SurfaceObservation['nodes'][number] | undefined;
    if (targetRef) {
      if (!('ref' in targetRef)) return { status: 'invalid', detail: 'the planner must target a ref' };
      node = obs.nodes.find((n) => n.ref === targetRef.ref);
      if (!node) {
        return { status: 'invalid', detail: `ref ${targetRef.ref} is not in the current observation` };
      }
    }
    for (const u of actionParams(action)) {
      if (!(u.param in this.values)) {
        return { status: 'invalid', detail: `unknown parameter ${u.param}` };
      }
    }

    // Policy gate: P5 adds allowlist and live risk classification here (D-015).
    await this.event({
      type: 'policy_check',
      actor: 'automation',
      stepId,
      action,
      verdict: { kind: 'allow', risk: 'safe' },
      liveRisk: 'safe',
      mismatch: false,
    });

    const paramValues = Object.values(this.values);
    const target = node ? deriveTargetSpec(node, obs.nodes, paramValues) : undefined;
    const baseline = target ? baselineOf(target, obs.nodes) : undefined;
    const started = Date.now();
    const r = await this.deps.surface.act(action, {
      actor: 'automation',
      values: this.values,
      baseUrl: this.baseUrl,
    });
    await this.event({
      type: 'action',
      actor: 'automation',
      stepId,
      action,
      ...(baseline ? { resolvedBy: baseline.resolvedBy, candidateCount: baseline.candidateCount } : {}),
      durationMs: Date.now() - started,
    });
    if (!r.ok) return { status: 'failed', detail: `${r.reason}: ${r.detail}` };

    const signature = JSON.stringify({
      kind: action.kind,
      target: node?.path ?? null,
      value: 'value' in action ? action.value : 'url' in action ? action.url : null,
    });
    return {
      status: 'ok',
      detail: `${action.kind} done`,
      pending: {
        intent: decision.intent,
        action: target ? withSpec(action, target) : action,
        target,
        baseline,
        before: obs,
        signature,
      },
    };
  }

  /** The observation after an action has arrived: the step is complete and gets recorded. */
  private commit(pending: PendingStep, after: SurfaceObservation): void {
    const id = `s${this.steps.length + 1}`;
    this.steps.push({
      intent: pending.intent,
      action: pending.action,
      target: pending.target,
      baseline: pending.baseline,
      before: pending.before,
      after,
    });
    const recorded: RecordedStep = {
      id,
      intent: pending.intent,
      action: pending.action,
      ...(pending.target ? { target: pending.target } : {}),
      recordedBy: 'automation',
      observedBefore: digestOf(pending.before),
      observedAfter: digestOf(after),
      resolvedBy: pending.baseline?.resolvedBy ?? 0,
      candidateCount: pending.baseline?.candidateCount ?? 0,
      bindings: actionParams(pending.action).map((u) => ({
        param: u.param,
        field: u.field,
        inferred: false,
      })),
      risk: 'safe',
    };
    this.recorded.push(recorded);
    this.signatures.push(pending.signature);
    this.digests.push(digestOf(after));
  }

  private collectOutputs(
    decision: Extract<Decision, { kind: 'finish' }>,
    obs: SurfaceObservation,
  ): { outputs: DiscoveredOutput[] } | { error: string } {
    const outputs: DiscoveredOutput[] = [];
    for (const [name, v] of Object.entries(decision.outputs)) {
      if ('ref' in v) {
        const node = obs.nodes.find((n) => n.ref === v.ref);
        if (!node) return { error: `output ${name} refers to ${v.ref}, which is not in the current observation` };
        outputs.push({ name, node, raw: node.value ?? node.name });
      } else {
        try {
          outputs.push({ name, raw: resolveValue(v, this.values) });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    return { outputs };
  }

  private checkDetectors(obs: SurfaceObservation, stepId: string): void {
    const c = classify(obs, { stepId, detectors: this.deps.profile.detectors });
    if (c.kind === 'proceed') return;
    const reason =
      c.kind === 'outcome'
        ? `${c.code}: ${c.message}`
        : c.kind === 'fail'
          ? `${c.failure}: ${c.observed}`
          : c.kind === 'recover'
            ? `condition ${c.condition.id} needs recovery "${c.routine.kind}" (P4)`
            : `condition ${c.condition.id} requires an operator (P6)`;
    throw new Stop({ kind: 'stopped', status: 'aborted', reason }, stepId);
  }

  private checkStuck(obs: SurfaceObservation): void {
    const n = STUCK_REPEATS;
    const last = this.signatures.slice(-n);
    if (last.length === n && last.every((s) => s === last[0])) {
      throw new Stop(
        { kind: 'stopped', status: 'limit', reason: `stuck: the same action was repeated ${n} times` },
        this.currentStep,
      );
    }
    const digests = [...this.digests.slice(-(n - 1)), digestOf(obs)];
    if (this.digests.length >= n - 1 && digests.every((d) => d === digests[0]) && this.steps.length >= n) {
      throw new Stop(
        { kind: 'stopped', status: 'limit', reason: `stuck: ${n} actions produced no observable change` },
        this.currentStep,
      );
    }
  }

  // ---- compile and results -------------------------------------------------------------------

  private compile(
    finish: { outputs: DiscoveredOutput[]; finalObservation: SurfaceObservation; firstObservation: SurfaceObservation },
    run: Run,
  ) {
    const { options } = this;
    const info = this.discoverDeps.planner.info();
    const inputs: InputSpec[] = options.params.map((p) => ({
      name: p.name,
      type: p.type,
      ...(p.enum ? { enum: p.enum } : {}),
      description: p.description,
      sensitivity: p.sensitivity,
      required: true,
    }));
    return compileCapability({
      id: options.capabilityId,
      name: options.name,
      description: options.description ?? options.goal,
      version: this.nextVersion,
      vendorProductId: this.deps.profile.vendorProductId,
      surfaceKind: this.deps.profile.surfaceKind,
      entryRoute: options.entryRoute ?? '/',
      requiresAuth: this.requiresAuth,
      inputs,
      values: this.values,
      steps: this.steps,
      outputs: finish.outputs,
      finalObservation: finish.finalObservation,
      firstObservation: finish.firstObservation,
      outcomes: options.outcomes ?? [],
      outputSensitivity: options.outputSensitivity ?? 'sensitive',
      provenance: {
        runId: run.id,
        model: info.model,
        effort: info.effort,
        recordedAt: this.now().toISOString(),
        variantId: options.variantId,
        compiler: options.compilerVersion ?? 'handsoff@0.1.0',
      },
    });
  }

  private nextVersion = 1;

  /** Resolved before the run starts so a compiled artifact never overwrites an earlier version. */
  private async resolveVersion(): Promise<void> {
    const latest = await this.deps.store.capabilities.latestVersion(this.options.capabilityId);
    this.nextVersion = (latest ?? 0) + 1;
  }

  private fromError(err: unknown): DiscoveryResult {
    if (err instanceof Stop) {
      const reason =
        err.reason.kind === 'stopped'
          ? err.reason.reason
          : err.reason.kind === 'failure'
            ? `${err.reason.failure}: ${err.reason.observed}`
            : `${err.reason.code}: ${err.reason.message}`;
      const status = err.reason.kind === 'stopped' ? err.reason.status : 'aborted';
      this.log(`stopped (${status}) at ${err.atStep ?? 'run'}: ${reason}`);
      return { status, reason, stepsRecorded: this.recorded.length, evidence: this.evidence(true) };
    }
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.log(`engine error: ${message}`);
    return { status: 'aborted', reason: message, stepsRecorded: this.recorded.length, evidence: this.evidence(true) };
  }

}

function withSpec(action: Action, spec: TargetSpec): Action {
  switch (action.kind) {
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      return { ...action, target: { spec } };
    default:
      return action;
  }
}
