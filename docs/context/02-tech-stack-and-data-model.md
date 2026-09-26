# 02 · Tech Stack and Data Model

Status: stable · Last updated: 2026-09-25

The concrete choices behind [01-architecture.md](01-architecture.md). Every type here has a zod schema of the same name in `@handsoff/core` (`CapabilitySchema`, `ConditionSchema`, …) and the TypeScript type is inferred from it. The JSON Schema for `Capability` is exported so a reviewer can validate an artifact without running the code.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, ESM, pnpm workspaces | Playwright's home; one language end to end ([D-001](08-decision-log.md#d-001--typescript-on-node-22-pnpm-monorepo)) |
| Language | TypeScript 5.9, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `skipLibCheck` (third-party declarations only) | Errors as data needs exhaustive unions |
| Schemas | zod 4.x; `z.toJSONSchema` exports the reviewable schemas to `packages/core/schema/` | One definition for validation, types and the reviewable artifact schema |
| Browser automation | Playwright (Chromium only), headed by default | Accessibility snapshot, frame handling, request routing for the network-level allowlist ([D-002](08-decision-log.md#d-002--perceive-via-accessibility-tree--screenshot-act-via-playwright)) |
| LLM | `@anthropic-ai/sdk` (reference adapter, default `claude-opus-5`) and the `openai` SDK for any OpenAI-compatible endpoint (Google AI Studio, Groq, OpenRouter, Ollama); provider chosen by `HANDSOFF_LLM_PROVIDER` | See [LLM integration](#llm-integration) ([D-004](08-decision-log.md#d-004--anthropic-claude-behind-a-thin-planner-interface), [D-020](08-decision-log.md#d-020--default-model-claude-opus-5-overridable), [D-031](08-decision-log.md#d-031--provider-selectable-discovery-with-an-openai-compatible-adapter)) |
| Embedded server | Fastify 5 + `@fastify/websocket` + `@fastify/static` | Small, typed, serves the console build |
| Console | Vite, React 19, TypeScript, Tailwind v4, TanStack Query, react-router | Minimal, fast to build; no server-side rendering needed |
| Mock target | Express 5 + EJS, `cookie-session` | Server-rendered on purpose; framesets and tables are trivial in EJS |
| Logging | pino, one JSON object per line | The event log **is** the log; pino writes `events.jsonl` |
| CLI | commander | Standard, tiny |
| Tests | vitest; Playwright for a few integration tests against the mock app | Classifier, resolver, gate and schema tests run on saved fixtures with no browser |
| Lint / format | Biome | One tool, fast, no config sprawl |
| Dev tooling | `tsx` runs TypeScript directly; every package exports its `src/index.ts`, so there is no build or emit step; `tsc --noEmit` per package for typechecking; Vite builds the console | Nothing in the demo runs under plain `node`; a build step is a failure mode for no benefit ([D-025](08-decision-log.md#d-025--packages-export-typescript-source-no-build-step)) |

Root scripts (to be created in P0):

| Script | Does | Since |
|---|---|---|
| `pnpm dev` | Starts the mock app (P0); grows to legacy-bank A and B, the runner in `serve` mode, and the console dev server | P0 |
| `pnpm handsoff discover --goal "…" --param memberId=10001 --target acme-coreteller` | One discovery run (`tsx apps/runner/src/cli.ts`) | P2 |
| `pnpm handsoff replay --capability get-member-savings-balance --param memberId=10001` | One replay | P1 |
| `pnpm handsoff replay … --chaos session-expiry` | Replay with an injected condition | P4 |
| `pnpm serve` | `handsoff serve`: the console's read API on `:4000`, plus the console build when present | P3 |
| `pnpm console` | Vite dev server for the console on `:5173`, proxying `/api` to `:4000` | P3 |
| `pnpm test` | Unit tests, no browser, no API key | P0 |
| `pnpm test:integration` | Playwright tests against the mock app, headless, no API key | P1 |
| `pnpm typecheck`, `pnpm lint`, `pnpm format` | `tsc --noEmit` per package; Biome check; Biome format | P0 |
| `pnpm schema:export` | Regenerates `packages/core/schema/*.schema.json` from the zod schemas | P0 |
| `pnpm evidence:copy <runId> <name>` | Copies a run folder into `/evidence/<name>/` | P8 |

## LLM integration

The engine talks to a `Planner`; the planner talks to a model. What every planner says and reads back is the **planner protocol** in `packages/core/src/planners/protocol.ts` ([D-030](08-decision-log.md#d-030--planner-protocol-in-core-adapters-translate-wire-formats-only)): the eleven tool schemas (zod, exported as JSON Schema), the system prompt, the observation and turn rendering, and `parseToolCall`, which maps a validated call onto a core `Decision`. Provider packages only translate the protocol into a wire format. Two exist, and `handsoff discover` picks one from the environment ([D-031](08-decision-log.md#d-031--provider-selectable-discovery-with-an-openai-compatible-adapter)):

| Provider id | Package | Endpoint | Key | Default model |
|---|---|---|---|---|
| `anthropic` | `@handsoff/llm-anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` | `claude-opus-5` |
| `google` | `@handsoff/llm-openai` | Google AI Studio, OpenAI-compatible endpoint (free tier) | `GEMINI_API_KEY` | `gemini-3.8-flash` (free tier: about 20 requests a day, five a minute) |
| `openai` | `@handsoff/llm-openai` | OpenAI | `OPENAI_API_KEY` | none; set `HANDSOFF_MODEL` |
| `groq` | `@handsoff/llm-openai` | Groq (free tier) | `GROQ_API_KEY` | none |
| `openrouter` | `@handsoff/llm-openai` | OpenRouter | `OPENROUTER_API_KEY` | none |
| `ollama` | `@handsoff/llm-openai` | local Ollama on `:11434` | none | none |
| `openai-compatible` | `@handsoff/llm-openai` | `HANDSOFF_LLM_BASE_URL` | `HANDSOFF_LLM_API_KEY` | none |

Selection: `--provider`, else `HANDSOFF_LLM_PROVIDER`, else the first key present in the order above. `HANDSOFF_MODEL` and `HANDSOFF_EFFORT` apply to whichever provider is chosen. The provider and the model that served the run land in the capability's `provenance` and in the transcript.

Common to both adapters:

- Tools: `click`, `type_text`, `type_param`, `select_option`, `select_param`, `press_key`, `navigate`, `wait`, `finish`, `give_up`, `request_human`. Flat schemas with `additionalProperties: false`, generated from the zod schema the planner validates with; the engine validates the resulting `Decision` again ([D-028](08-decision-log.md#d-028--flat-parameter-tools-instead-of-a-value-union-in-the-model-facing-schemas)).
- One decision per observation. Replies without a tool call, truncated replies and invalid inputs are retried up to twice within one decision with the problem fed back; after that the planner gives up with the reason, which the engine records.
- Screenshots ride only on the two most recent user messages; older ones keep the text. This keeps requests small and, on Anthropic, the cached prefix stable.
- The planner never sees a parameter value (the `*_param` tools take a name), and the transcript persisted to the run folder is redacted.

Anthropic adapter (`packages/llm-anthropic/src/planner.ts`), verified against Anthropic's TypeScript guidance on 2026-09-21:

- Client: `new Anthropic()` reads `ANTHROPIC_API_KEY` from the environment. Never pass a key in code.
- Thinking: adaptive, `thinking: { type: "adaptive" }`, no `budget_tokens` (rejected on Opus 5). Effort via `output_config: { effort }`, default `high`.
- Tools are `strict: true`; `tool_choice: { type: "auto", disable_parallel_tool_use: true }` so the model proposes exactly one action per observation.
- Observations reach the model as a `tool_result` whose content is a text block followed by an image block; the system prompt carries `cache_control: { type: "ephemeral" }`. Check `usage.cache_read_input_tokens` in the transcript.
- `stop_reason` handling is explicit ([D-022](08-decision-log.md#d-022--manual-tool-use-loop-on-sdk-types-not-the-beta-tool-runner)): `tool_use` → validate, gate, act; `end_turn` with no tool → nudge, then `give_up` with the model's text; `max_tokens` → retry with a higher limit; `refusal` → stop with `stop_details`; `pause_turn` → continue.
- Refusal fallbacks: `client.beta.messages.create` with `fallbacks: "default"` and the `server-side-fallback-2026-07-01` beta. `HANDSOFF_FALLBACKS=off` disables it, and a 400 that rejects the parameter makes the planner continue without it. The model that actually served a turn is recorded.
- No assistant prefill. All API data structures use SDK types (`Anthropic.Beta.BetaMessageParam`, `BetaToolUseBlock`, …); no hand-rolled equivalents.

OpenAI-compatible adapter (`packages/llm-openai/src/planner.ts`), over the `openai` SDK with `baseURL` pointed at the chosen endpoint:

- Tools are `{ type: "function", function: { name, description, parameters } }` without `strict`, because the compatible endpoints differ on strict-mode support and the zod validation on the way back is the real check. `tool_choice: "auto"`.
- The result of the previous action goes back as the `tool` message for the pending call; the new observation follows as a `user` message with a text part and, where the endpoint takes images, an `image_url` data URL. Tool messages cannot carry images, which is why the two are split.
- If the model returns several tool calls, only the first is kept in the history and executed; the next tool result says so.
- `finish_reason` handling: a function call under `tool_calls` or `stop` → validate; `stop` without a call → nudge; `length` → nudge; `content_filter` → `give_up`.
- `reasoning_effort` is forwarded for `google` and `openai` (Gemini accepts `none` … `high`; `xhigh` and `max` clamp to `high`) and dropped on a 400 that names it. Images are on for `google` and `openai` and off elsewhere; `HANDSOFF_LLM_IMAGES=on|off` overrides, and a 400 that names images makes the planner continue with text only.
- The SDK retries 429 and 5xx with backoff, five times by default, which is what a free tier needs.
- Verified against Google's OpenAI-compatibility documentation on 2026-09-22: function calling, `image_url` data URLs and `reasoning_effort` are supported on the endpoint, and unknown parameters are ignored rather than rejected.

The planner never acts. It returns a `Decision`; the engine in `core` owns the gate, the surface and the recording.

## Data model

### Enumerations

```ts
type Sensitivity   = 'public' | 'internal' | 'sensitive' | 'secret';
type Risk          = 'safe' | 'risky';
type Confirm       = 'none' | 'operator';
type Actor         = 'automation' | 'human';
type ControlOwner  = 'automation' | 'awaiting_operator' | 'human' | 'aborted';
type SurfaceKind   = 'web' | 'legacy-web' | 'desktop-a11y';
type ConditionRole = 'precondition' | 'postcondition' | 'detector';
type ConditionClass= 'outcome' | 'recover' | 'fail' | 'escalate';
type FailureKind   = 'TARGET_NOT_FOUND' | 'CHECKPOINT_FAILED' | 'UNEXPECTED_STATE' | 'APP_ERROR'
                   | 'TIMEOUT' | 'POLICY_BLOCKED' | 'DRIFT_SUSPECTED' | 'ESCALATION_ABANDONED';
type EscalationCause = 'PLANNER_REQUESTED' | 'STUCK' | 'CONFIRM_REQUIRED' | 'CONDITION_ESCALATE'
                   | 'RECOVERY_EXHAUSTED' | 'REPLAY_FAILURE';
type SideEffects   = 'none' | 'possible' | 'committed';
```

### Capability (the artifact)

```ts
interface Capability {
  schemaVersion: 1;
  id: string;                          // kebab-case, stable across versions: "get-member-savings-balance"
  name: string;
  description: string;                 // what it does, for a human reviewer and a calling agent
  version: number;                     // integer, D-017
  supersedes?: number;
  status: 'draft' | 'approved' | 'retired';
  provenance: {
    runId: string;
    model: string;                     // model that served the discovery run
    effort?: string;
    recordedAt: string;                // ISO
    variantId?: string;                // variant the recording was made on
    compiler: string;                  // "handsoff@0.1.0"
  };
  app: { vendorProductId: string; surfaceKind: SurfaceKind };
  entry: {
    route: string;                     // may contain :param segments
    requiresAuth: boolean;             // bootstrap routine runs first if true
    preconditions: Condition[];        // role 'precondition'
  };
  inputs: InputSpec[];
  outputs: OutputSpec[];
  steps: Step[];
  success: Condition;                  // role 'postcondition'; verified after the last step
  detectors: Condition[];              // role 'detector'; the bound App Profile's detectors always apply as well
  policy: { requiredScopes: string[]; riskySteps: string[] };   // riskySteps is derived, kept for reviewers
  variants?: Record<string, CapabilityVariantOverrides>;        // capability-specific, keyed by variantId
}

interface InputSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  enum?: string[];
  description: string;
  sensitivity: Sensitivity;
  required: boolean;
  example?: string;                    // never a real value for sensitive inputs
}

interface OutputSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  parser?: 'currency' | 'date' | 'text';
  description: string;
  source: TargetSpec | { urlParam: string };
  atStep: string;                      // step id after which it is extracted
  required: boolean;
  sensitivity: Sensitivity;            // sensitive outputs are masked in result.json, returned in-process
}

interface CapabilityVariantOverrides {
  steps?: Record<string, Partial<Pick<Step, 'target' | 'postcondition' | 'preconditions'>>>;
  detectors?: Condition[];
}
```

### Step, Action, Target

```ts
interface Step {
  id: string;                          // "s1", "s2", ...
  intent: string;                      // the model's stated reason at discovery, or the operator's
  action: Action;                      // TargetRef inside is { spec } after compile
  target?: TargetSpec;                 // duplicated from action for reviewers; absent for press/wait/navigate
  bindings: Binding[];
  preconditions: Condition[];
  postcondition: Condition;            // the checkpoint
  risk: Risk;                          // as classified at discovery; re-classified live at replay (D-015)
  confirm: Confirm;
  baseline: { resolvedBy: number; candidateCount: number };   // discovery resolution, D-016
  recordedBy: Actor;
}

interface Binding {
  param: string;
  field: 'value' | 'navigate.url' | 'postcondition.url' | 'precondition.url';
  inferred: boolean;                   // true only for whole-segment URL canonicalisation
}

type Value     = { text: string } | { param: string };
type TargetRef = { ref: string } | { spec: TargetSpec };

type Action =
  | { kind: 'click';    target: TargetRef }
  | { kind: 'type';     target: TargetRef; value: Value; clear?: boolean }
  | { kind: 'select';   target: TargetRef; value: Value }
  | { kind: 'press';    key: string }
  | { kind: 'navigate'; url: Value }
  | { kind: 'wait';     reason: string; ms?: number }
  | { kind: 'extract';  name: string; target: TargetRef };

interface TargetSpec { strategies: Strategy[]; framePath: string[] }

type Strategy =
  | { kind: 'role';       role: string; name: string; exact?: boolean }
  | { kind: 'anchored';   anchor: string; relation: 'labels' | 'same-row-column' | 'right-of' | 'below'; column?: string; role?: string }
  | { kind: 'structural'; path: string };

type Resolution =
  | { found: true;  resolvedBy: number; candidateCount: number; handle: unknown }
  | { found: false; tried: Array<{ index: number; candidateCount: number }>; nearest: A11yNode[] };
```

### Condition and recovery

```ts
interface Condition {
  id: string;
  when: Predicate;
  role: ConditionRole;
  class?: ConditionClass;              // detectors only
  code?: string;                       // outcome code or FailureKind
  message?: string;                    // may reference {{ref}} text extracted from the page
  recovery?: RecoveryRoutine;          // class 'recover' only
  atSteps?: string[];
  terminal?: boolean;                  // default true for outcomes
}

interface Predicate {
  url?: string;
  textPresent?: string[];
  textAbsent?: string[];
  element?: TargetSpec;
  dialog?: boolean;
  frameTitle?: string;
  timeoutMs?: number;
}

type RecoveryRoutine =
  | { kind: 'dismiss'; target: TargetSpec }
  | { kind: 'wait-retry'; ms: number; maxAttempts: number }
  | { kind: 'rebootstrap' }
  | { kind: 'assisted' };

interface Recovery {
  stepId: string;
  conditionId: string;
  routine: RecoveryRoutine;
  attempt: number;
  outcome: 'recovered' | 'exhausted' | 'failed';
  proposal?: Action;                   // assisted only
  at: string;
}
```

### Observation

```ts
interface Observation {
  at: string;
  url?: string;                        // top document
  title: string;
  frames: FrameInfo[];                 // { framePath, url, title } for every frame incl. the top document
  nodes: A11yNode[];
  dialogs: DialogInfo[];
  screenshot: ScreenshotRef;           // { path } once persisted; masked
  digest: string;                      // hash over urls, roles, names, values and paths of nodes
}

interface FrameInfo { framePath: string[]; url: string; title: string }

interface A11yNode {
  ref: string;
  role: string;
  name: string;
  value?: string;                      // never emitted for password fields
  states: string[];
  bbox: { x: number; y: number; w: number; h: number };   // page coordinates
  framePath: string[];
  path: string;                        // "form[1]/table[1]/tr[2]/td[2]/input[1]"; tbody/thead/tfoot are transparent
  parentRef?: string;
  formAction?: string;                 // web surfaces: resolved action URL of the enclosing form; the policy gate reads it
}

/** What the surface returns; the engine persists the PNG and produces an Observation. */
interface SurfaceObservation extends Omit<Observation, 'screenshot' | 'digest'> { screenshotPng?: Uint8Array }

interface DialogInfo { kind: 'alert' | 'confirm' | 'prompt' | 'modal'; text: string; ref?: string }
```

### Run, events, results

```ts
interface Run {
  id: string;                          // "run_<yyyymmdd>_<hhmmss>_<4hex>"
  kind: 'discovery' | 'replay';
  goal?: { text: string; params: Record<string, { type: string; sensitivity: Sensitivity }> };  // values never stored
  capability?: { id: string; version: number };
  target: { vendorProductId: string; variantId?: string; entry: string };
  model?: string;
  startedAt: string;
  finishedAt?: string;
  controlOwner: ControlOwner;
  sideEffects: SideEffects;
}

type RunEvent = { at: string; runId: string; stepId?: string; actor: Actor } & (
  | { type: 'observation';      digest: string; url?: string; title: string; nodeCount: number; dialogCount: number; screenshot?: string }
  | { type: 'decision';         decision: Decision | { kind: 'resolve'; target: TargetSpec } ; intent?: string }
  | { type: 'policy_check';     action: Action; verdict: Verdict; liveRisk: Risk; recordedRisk?: Risk; mismatch: boolean }
  | { type: 'confirmation';     cause: EscalationCause; rule: string; reason: string; answer: 'approved' | 'denied' | 'unattended'; operatorId?: string }
  | { type: 'action';           action: Action; resolvedBy?: number; candidateCount?: number; durationMs: number }
  | { type: 'condition';        conditionId: string; role: ConditionRole; class?: ConditionClass; matched: boolean; code?: string }
  | { type: 'recovery';         recovery: Recovery; budgetRemaining: number }
  | { type: 'drift';            baseline: Step['baseline']; observed: { resolvedBy: number; candidateCount: number }; fingerprintMismatch?: boolean }
  | { type: 'control_transfer'; from: ControlOwner; to: ControlOwner; operatorId?: string; cause?: EscalationCause }
  | { type: 'human_action';     step: RecordedStep }
  | { type: 'result';           result: ReplayResult | DiscoveryResult }
);

interface RecordedStep extends Omit<Step, 'baseline' | 'bindings' | 'preconditions' | 'postcondition' | 'risk' | 'confirm'> {
  observedBefore: string;              // digest
  observedAfter: string;
  resolvedBy: number;
  candidateCount: number;
  bindings: Binding[];
  risk: Risk;
}

interface StepReport { stepId: string; attempts: number; durationMs: number; resolvedBy?: number; candidateCount?: number; drift: boolean }

interface EvidenceRef { runDir: string; failingScreenshot?: string; lastObservation?: string }

type ReplayResult = (
  | { status: 'success'; outputs: Record<string, unknown> }
  | { status: 'outcome'; code: string; message: string; data?: unknown }
  | { status: 'failure'; kind: FailureKind; expected: string; observed: string }
) & {
  capability: { id: string; version: number };
  variantId?: string;
  atStep?: string;
  stepsRun: StepReport[];
  recoveries: Recovery[];
  sideEffects: SideEffects;
  escalation?: { id: string; humanActions: RecordedStep[]; resolution: 'resumed' | 'completed_by_human' | 'aborted' };
  evidence: EvidenceRef;
};

type DiscoveryResult =
  | { status: 'compiled'; capability: { id: string; version: number }; stepsRecorded: number; escalation?: ReplayResult['escalation']; evidence: EvidenceRef }
  | { status: 'gave_up' | 'limit' | 'aborted'; reason: string; stepsRecorded: number; evidence: EvidenceRef };
```

### Escalation and session

```ts
interface Escalation {
  id: string;
  runId: string;
  cause: EscalationCause;
  detail: string;
  atStep?: string;
  stepIntent?: string;
  screenshot: string;                  // masked, path
  snapshotDigest: string;
  suggestedActions: Array<'approve_step' | 'resume' | 'mark_complete' | 'abort'>;
  requestedAt: string;
  claimedBy?: string;                  // free-text operator id in the demo
  claimedAt?: string;
  resolution?: { kind: 'resumed' | 'completed_by_human' | 'aborted' | 'abandoned'; at: string; resumedAtStep?: string };
}

interface SessionState { runId: string; controlOwner: ControlOwner; operatorId?: string; since: string }
```

### App Profile

```ts
interface AppProfile {
  vendorProductId: string;
  name: string;
  surfaceKind: SurfaceKind;
  bootstrap: BootstrapRoutine;
  detectors: Condition[];              // shared across every capability on this product
  variants: Record<string, Variant>;
}

interface BootstrapRoutine {
  entry: string;                                   // login route
  credentials: Record<string, { env: string }>;    // param name → environment variable NAME; values never logged
  steps: Array<Omit<Step, 'bindings' | 'baseline' | 'recordedBy'>>;   // type/select steps use { param } values bound from credentials
  success: Condition;
}

interface Variant {
  name: string;                        // "First Example Credit Union"
  fingerprint: Fingerprint;
  overrides: ProfileVariantOverrides;
}

interface Fingerprint { titleIncludes?: string; textPresent?: string[]; versionBanner?: string; urlPattern?: string }

interface ProfileVariantOverrides {
  labels?: Record<string, string>;     // applied to role.name and anchored.anchor/column
  routes?: Record<string, string>;
  detectors?: Condition[];
}
```

Override application order at replay: profile variant `labels` and `routes` first, then the capability's own `variants[variantId].steps` and `detectors`.

### Policy

```ts
interface Policy {
  allowedOrigins: string[];
  allowedRoutes: string[];             // glob; ** allowed
  deniedRoutes: string[];
  allowedActions: Action['kind'][];
  riskyPatterns: { buttonText: string[]; formAction: string[]; routes: string[] };   // regex / glob
  riskyMode: { discovery: 'escalate' | 'block'; replay: 'require_approved' };
  escalationTimeoutMs: number;
  budgets: { recoveriesPerStep: number; rebootstrapsPerRun: number };
  assistedFallback: { enabled: boolean; maxPerRun: number };
}

type Verdict =
  | { kind: 'allow';   risk: Risk }
  | { kind: 'block';   rule: string; reason: string }
  | { kind: 'confirm'; rule: string; reason: string };
```

### Ports

This document defines data. Behaviour lives behind the six port interfaces in [01 §5](01-architecture.md#5-seams), which are the seams adapters implement. Listed here so a reader can find every named type in one place:

| Port | Implemented by | One line |
|---|---|---|
| `Surface` | `@handsoff/surface-playwright` | observe, act on a ref, close; human-action capture in P6. Resolution is `resolveTarget()` in core, not a surface method |
| `Planner` | `@handsoff/llm-anthropic`, `@handsoff/llm-openai`; `ScriptedPlanner` in core for tests; all over the planner protocol in core | one `Decision` per observation during discovery |
| `RecoveryPlanner` | a planner package, optional | at most one proposed `Action` for a failed replay step |
| `Store` | filesystem implementation in core (`createFsStore`) | capabilities, runs (a `RunHandle` appends events and writes screenshots, snapshots and the result), escalations, app profiles; everything read from disk is validated with its zod schema |
| `PolicyGate` | core (`checkPolicy`, a pure function) | `Verdict`, live risk and mismatch for every action before it executes, in both engines |
| `Operator` | `handsoff` CLI (terminal, approve-all); console inbox in P6 | answers a `confirm` verdict; absent, replay stops before the step with `ESCALATION_ABANDONED` |
| `Redactor` | core | masks observations, screenshots, params and transcripts |

## Example artifact

`data/capabilities/get-member-savings-balance/v1.json`, as compile would emit it from a discovery run on variant A. Abbreviated only where a structure repeats.

```json
{
  "schemaVersion": 1,
  "id": "get-member-savings-balance",
  "name": "Get member savings balance",
  "description": "Looks up a member by member number and returns the current balance of their Savings share account.",
  "version": 1,
  "status": "draft",
  "provenance": {
    "runId": "run_20260924_143012_a1b2",
    "model": "claude-opus-5",
    "effort": "high",
    "recordedAt": "2026-09-24T14:32:40Z",
    "variantId": "first-example-cu",
    "compiler": "handsoff@0.1.0"
  },
  "app": { "vendorProductId": "acme-coreteller", "surfaceKind": "legacy-web" },
  "entry": {
    "route": "/members",
    "requiresAuth": true,
    "preconditions": [
      { "id": "entry-member-lookup", "role": "precondition", "when": { "textPresent": ["Member Lookup"], "timeoutMs": 10000 } }
    ]
  },
  "inputs": [
    { "name": "memberId", "type": "string", "description": "Member number as printed on the member card", "sensitivity": "sensitive", "required": true }
  ],
  "outputs": [
    {
      "name": "savingsBalance",
      "type": "number",
      "parser": "currency",
      "description": "Current balance of the Savings share account",
      "source": { "strategies": [ { "kind": "anchored", "anchor": "Savings", "relation": "same-row-column", "column": "Balance" } ], "framePath": ["main"] },
      "atStep": "s4",
      "required": true,
      "sensitivity": "sensitive"
    }
  ],
  "steps": [
    {
      "id": "s1",
      "intent": "Enter the member number into the lookup field",
      "action": { "kind": "type", "target": { "spec": { "strategies": [ { "kind": "anchored", "anchor": "Member #", "relation": "labels", "role": "textbox" }, { "kind": "role", "role": "textbox", "name": "Member #" }, { "kind": "structural", "path": "table[1] > tr[2] > td[2] > input[1]" } ], "framePath": ["main"] } }, "value": { "param": "memberId" }, "clear": true },
      "target": { "strategies": [ { "kind": "anchored", "anchor": "Member #", "relation": "labels", "role": "textbox" }, { "kind": "role", "role": "textbox", "name": "Member #" }, { "kind": "structural", "path": "table[1] > tr[2] > td[2] > input[1]" } ], "framePath": ["main"] },
      "bindings": [ { "param": "memberId", "field": "value", "inferred": false } ],
      "preconditions": [],
      "postcondition": { "id": "s1-post", "role": "postcondition", "when": { "element": { "strategies": [ { "kind": "anchored", "anchor": "Member #", "relation": "labels", "role": "textbox" } ], "framePath": ["main"] }, "timeoutMs": 5000 } },
      "risk": "safe",
      "confirm": "none",
      "baseline": { "resolvedBy": 0, "candidateCount": 1 },
      "recordedBy": "automation"
    },
    {
      "id": "s2",
      "intent": "Run the lookup",
      "action": { "kind": "click", "target": { "spec": { "strategies": [ { "kind": "role", "role": "button", "name": "Search" }, { "kind": "anchored", "anchor": "Member #", "relation": "right-of", "role": "button" }, { "kind": "structural", "path": "table[1] > tr[2] > td[3] > input[1]" } ], "framePath": ["main"] } } },
      "target": { "strategies": [ { "kind": "role", "role": "button", "name": "Search" }, { "kind": "anchored", "anchor": "Member #", "relation": "right-of", "role": "button" }, { "kind": "structural", "path": "table[1] > tr[2] > td[3] > input[1]" } ], "framePath": ["main"] },
      "bindings": [],
      "preconditions": [],
      "postcondition": { "id": "s2-post", "role": "postcondition", "when": { "textPresent": ["Search Results"], "timeoutMs": 10000 } },
      "risk": "safe",
      "confirm": "none",
      "baseline": { "resolvedBy": 0, "candidateCount": 1 },
      "recordedBy": "automation"
    },
    {
      "id": "s3",
      "intent": "Open the matching member's detail page",
      "action": { "kind": "click", "target": { "spec": { "strategies": [ { "kind": "role", "role": "link", "name": "View" }, { "kind": "anchored", "anchor": "Member #", "relation": "same-row-column", "column": "Action", "role": "link" }, { "kind": "structural", "path": "table[2] > tr[2] > td[4] > a[1]" } ], "framePath": ["main"] } } },
      "target": { "strategies": [ { "kind": "role", "role": "link", "name": "View" }, { "kind": "anchored", "anchor": "Member #", "relation": "same-row-column", "column": "Action", "role": "link" }, { "kind": "structural", "path": "table[2] > tr[2] > td[4] > a[1]" } ], "framePath": ["main"] },
      "bindings": [ { "param": "memberId", "field": "postcondition.url", "inferred": true } ],
      "preconditions": [],
      "postcondition": { "id": "s3-post", "role": "postcondition", "when": { "url": "/members/:memberId", "textPresent": ["Member Detail"], "timeoutMs": 10000 } },
      "risk": "safe",
      "confirm": "none",
      "baseline": { "resolvedBy": 0, "candidateCount": 1 },
      "recordedBy": "automation"
    },
    {
      "id": "s4",
      "intent": "Read the Savings balance from the accounts table",
      "action": { "kind": "extract", "name": "savingsBalance", "target": { "spec": { "strategies": [ { "kind": "anchored", "anchor": "Savings", "relation": "same-row-column", "column": "Balance" }, { "kind": "structural", "path": "table[3] > tr[2] > td[3]" } ], "framePath": ["main"] } } },
      "target": { "strategies": [ { "kind": "anchored", "anchor": "Savings", "relation": "same-row-column", "column": "Balance" }, { "kind": "structural", "path": "table[3] > tr[2] > td[3]" } ], "framePath": ["main"] },
      "bindings": [],
      "preconditions": [ { "id": "s4-pre", "role": "precondition", "when": { "textPresent": ["Accounts"] } } ],
      "postcondition": { "id": "s4-post", "role": "postcondition", "when": { "element": { "strategies": [ { "kind": "anchored", "anchor": "Savings", "relation": "same-row-column", "column": "Balance" } ], "framePath": ["main"] } } },
      "risk": "safe",
      "confirm": "none",
      "baseline": { "resolvedBy": 0, "candidateCount": 1 },
      "recordedBy": "automation"
    }
  ],
  "success": { "id": "success", "role": "postcondition", "when": { "url": "/members/:memberId", "textPresent": ["Member Detail", "Savings"] } },
  "detectors": [
    {
      "id": "member-not-found",
      "role": "detector",
      "class": "outcome",
      "code": "MEMBER_NOT_FOUND",
      "message": "No member matches the supplied member number",
      "when": { "textPresent": ["No matching member"] },
      "atSteps": ["s2"],
      "terminal": true
    }
  ],
  "policy": { "requiredScopes": ["members:read"], "riskySteps": [] },
  "variants": {
    "sample-federal-cu": {
      "steps": {
        "s3": { "target": { "strategies": [ { "kind": "role", "role": "link", "name": "Open" }, { "kind": "anchored", "anchor": "Member Number", "relation": "same-row-column", "column": "Actions", "role": "link" } ], "framePath": ["content"] } }
      }
    }
  }
}
```

Points a reviewer should be able to check from this file alone: what the capability needs (`inputs`), what it returns (`outputs`, with sensitivity), what it will do (`steps[].intent` and `action`), how it finds each control and how confident it was at recording time (`target.strategies`, `baseline`), what it asserts (`postcondition`, `success`), which business answers it can produce (`detectors`), and whether anything is irreversible (`risk`, `confirm`, `policy.riskySteps`).

## Filesystem layout

```
<repo>/
  data/                                 runtime data, git-ignored except app-profiles/
    app-profiles/
      acme-coreteller.json
    capabilities/
      get-member-savings-balance/
        v1.json
        v2.json
        latest.json                     { "version": 2 }
      open-sub-account/
        v1.json
        latest.json
    runs/
      run_20260924_143012_a1b2/
        run.json
        events.jsonl
        steps/001-before.png, 001-after.png, ...
        escalation.json                 only if escalated
        transcript.redacted.jsonl       discovery only
        result.json
  config/
    policy.json
  evidence/                             curated copies, committed, never edited
    discovery-run/
    discovery-run-open-sub-account/
    replay-success/
    replay-member-not-found/
    replay-session-expiry/
    replay-confirm-required/
    discovery-policy-blocked/
    replay-escalation-handoff/
    replay-variant-b/
    capability.get-member-savings-balance.v1.json
  .env                                  git-ignored
  .env.example                          committed
```

## Configuration and environment

| Variable | Default | Used by |
|---|---|---|
| `HANDSOFF_LLM_PROVIDER` | detected from the keys below | discovery only: `anthropic`, `google`, `openai`, `groq`, `openrouter`, `ollama`, `openai-compatible` |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | none | discovery only; replay never reads them |
| `HANDSOFF_LLM_BASE_URL`, `HANDSOFF_LLM_API_KEY` | none | provider `openai-compatible` |
| `HANDSOFF_MODEL` | provider default: `claude-opus-5`, `gemini-3.8-flash`; required elsewhere | planner |
| `HANDSOFF_LLM_MIN_INTERVAL_MS` | preset: 12500 for google (five requests a minute), 0 elsewhere | planner pacing |
| `HANDSOFF_EFFORT` | `high` for anthropic; forwarded to google and openai only | planner |
| `HANDSOFF_LLM_IMAGES` | preset: on for anthropic, google, openai | planner |
| `HANDSOFF_FALLBACKS` | `on` | anthropic planner |
| `HANDSOFF_PORT` | `4000` | embedded server |
| `HANDSOFF_DATA_DIR` | `./data` | store |
| `HANDSOFF_POLICY` | `./config/policy.json` | policy gate; the CLI refuses to run without it |
| `HANDSOFF_OPERATOR` | `tty` in a terminal, `none` otherwise | who answers a `confirm` verdict: `tty`, `none`, `approve-all`; `--operator` overrides |
| `HANDSOFF_HEADLESS` | `false` | surface |
| `HANDSOFF_MAX_STEPS` | `30` | discovery |
| `HANDSOFF_STEP_TIMEOUT_MS` | `15000` | both engines; per-step ceiling on waits |
| `HANDSOFF_RUN_TIMEOUT_MS` | `600000` | both engines |
| `LEGACY_BANK_USER`, `LEGACY_BANK_PASS` | none | referenced by name in the app profile's bootstrap routine; never logged |
| `LEGACY_BANK_PORT_A`, `LEGACY_BANK_PORT_B` | `4100`, `4101` | mock app |
| `LEGACY_BANK_SESSION_TTL_MS` | `1800000` | mock app; chaos sets it low |
| `LEGACY_BANK_ALLOW_CHAOS_HEADER` | `true` in dev | mock app honours `x-handsoff-chaos` |

Chaos injection ([D-024](08-decision-log.md#d-024--chaos-modes-four-required-two-optional)): `handsoff replay --chaos <mode>[,<mode>]` sets an `x-handsoff-chaos` header on the browser context. The mock app honours it only when `LEGACY_BANK_ALLOW_CHAOS_HEADER` is true. Each mode fires once per browser, on the request it targets, and is then remembered in a cookie of its own (so it stays fired after the session cookie is cleared), which is what lets a recovery be observed succeeding. The member search is the target of most modes because it is the first request of every flow: `not-found` (the next search finds nobody), `session-expiry` (the next search clears the session and bounces to sign-in with the notice), `interstitial` (the next results page opens a native "System notice" `alert()`), `slow` (the next search shows a "system is busy" page that refreshes to the results after 2 s), `error` (the next search is a 500 application-error page). `validation` targets the sub-account form: the next otherwise valid submit is rejected with a legacy edit rule. Several modes can be armed at once; one fires per request.

Running without live services: replay needs no API key and no network. Discovery tests use `ScriptedPlanner`, which replays a saved decision list from `packages/core/test/fixtures/` against the mock app.
