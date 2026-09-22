# 02 · Tech Stack and Data Model

Status: stable · Last updated: 2026-09-21

The concrete choices behind [01-architecture.md](01-architecture.md). Every type here has a zod schema of the same name in `@handsoff/core` (`CapabilitySchema`, `ConditionSchema`, …) and the TypeScript type is inferred from it. The JSON Schema for `Capability` is exported so a reviewer can validate an artifact without running the code.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, ESM, pnpm workspaces | Playwright's home; one language end to end ([D-001](08-decision-log.md#d-001--typescript-on-node-22-pnpm-monorepo)) |
| Language | TypeScript 5.9, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `skipLibCheck` (third-party declarations only) | Errors as data needs exhaustive unions |
| Schemas | zod 4.x; `z.toJSONSchema` exports the reviewable schemas to `packages/core/schema/` | One definition for validation, types and the reviewable artifact schema |
| Browser automation | Playwright (Chromium only), headed by default | Accessibility snapshot, frame handling, request routing for the network-level allowlist ([D-002](08-decision-log.md#d-002--perceive-via-accessibility-tree--screenshot-act-via-playwright)) |
| LLM | `@anthropic-ai/sdk`, default model `claude-opus-5` | See [LLM integration](#llm-integration) ([D-004](08-decision-log.md#d-004--anthropic-claude-behind-a-thin-planner-interface), [D-020](08-decision-log.md#d-020--default-model-claude-opus-5-overridable)) |
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
| `pnpm test` | Unit tests, no browser, no API key | P0 |
| `pnpm test:integration` | Playwright tests against the mock app, headless, no API key | P1 |
| `pnpm typecheck`, `pnpm lint`, `pnpm format` | `tsc --noEmit` per package; Biome check; Biome format | P0 |
| `pnpm schema:export` | Regenerates `packages/core/schema/*.schema.json` from the zod schemas | P0 |
| `pnpm evidence:copy <runId> <name>` | Copies a run folder into `/evidence/<name>/` | P8 |

## LLM integration

Facts to hold onto (verified against Anthropic's current TypeScript guidance on 2026-09-21; re-check when implementing):

- Client: `new Anthropic()` reads `ANTHROPIC_API_KEY` from the environment. Never pass a key in code.
- Model: `claude-opus-5` by default. `HANDSOFF_MODEL` overrides, for example `claude-sonnet-5` for cheaper iteration.
- Thinking: adaptive. `thinking: { type: "adaptive" }`. Do **not** send `budget_tokens` (rejected on Opus 5). Effort via `output_config: { effort: "high" }`; `HANDSOFF_EFFORT` overrides (`low` … `max`).
- Tools: one tool per `Action` kind plus `finish`, `give_up`, `request_human`. Each tool has `strict: true`, `additionalProperties: false`, and an `input_schema` generated from the same zod schema the engine validates with. `tool_choice: { type: "auto", disable_parallel_tool_use: true }` so the model proposes exactly one action per observation.
- Observations reach the model as a `tool_result` whose content is a text block (the compact node listing) followed by an image block `{ type: "image", source: { type: "base64", media_type: "image/png", data } }` holding the masked screenshot.
- Prompt caching: the system prompt and tool list are stable, so the system block carries `cache_control: { type: "ephemeral" }`. Observations are volatile and come after it. Check `usage.cache_read_input_tokens` in the run log.
- `stop_reason` handling is explicit ([D-022](08-decision-log.md#d-022--manual-tool-use-loop-on-sdk-types-not-the-beta-tool-runner)): `tool_use` → validate input with zod, gate, act, append result; `end_turn` with no tool → treat as `give_up` with the model's text as reason; `max_tokens` → retry once with a higher limit, then fail; `refusal` → stop, record `stop_details`; `pause_turn` → append the assistant content and continue.
- No assistant prefill (rejected on current models). Format is controlled through tool schemas.
- Refusal fallbacks: Anthropic's current guidance is to enable server-side `fallbacks: "default"` (beta header `server-side-fallback-2026-07-01`, on `client.beta.messages`) for Opus 5 code. HandsOff enables it by default and `HANDSOFF_FALLBACKS=off` disables it; the model that actually served the turn is recorded in provenance.
- All API data structures use SDK types: `Anthropic.MessageParam`, `Anthropic.ToolUseBlock`, `Anthropic.ToolResultBlockParam`, `Anthropic.Message`. No hand-rolled equivalents.

Loop sketch (the real one lives in `packages/llm-anthropic/src/planner.ts`):

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const response = await client.messages.create({
  model: process.env.HANDSOFF_MODEL ?? "claude-opus-5",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { effort: (process.env.HANDSOFF_EFFORT as Effort) ?? "high" },
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools,                                   // strict tools generated from zod
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  messages,                                // Anthropic.MessageParam[]
});

for (const block of response.content) {
  if (block.type === "tool_use") {
    const parsed = ActionToolInput.safeParse(block.input);  // never trust tolerant parsing
    // → Decision handed back to the engine; the engine gates, acts, observes,
    //   and appends { type: "tool_result", tool_use_id: block.id, content: [text, image] }
  }
}
```

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
  url?: string;
  title: string;
  nodes: A11yNode[];
  dialogs: DialogInfo[];
  screenshot: ScreenshotRef;           // { path } once persisted; masked
  digest: string;                      // hash over (url, title, roles+names+values of nodes)
}

interface A11yNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  bbox: { x: number; y: number; w: number; h: number };
  framePath: string[];
  parentRef?: string;
}

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
| `Surface` | `@handsoff/surface-playwright` | observe, act, resolve, capture human actions |
| `Planner` | `@handsoff/llm-anthropic`; `ScriptedPlanner` in core for tests | one `Decision` per observation during discovery |
| `RecoveryPlanner` | `@handsoff/llm-anthropic`, optional | at most one proposed `Action` for a failed replay step |
| `Store` | filesystem implementation in core | capabilities, runs, escalations, app profiles |
| `PolicyGate` | core | `Verdict` for every action before it executes |
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
    replay-success/
    replay-member-not-found/
    replay-escalation-handoff/
    replay-variant-b/
    capability.get-member-savings-balance.v1.json
  .env                                  git-ignored
  .env.example                          committed
```

## Configuration and environment

| Variable | Default | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | discovery only; replay never reads it |
| `HANDSOFF_MODEL` | `claude-opus-5` | planner |
| `HANDSOFF_EFFORT` | `high` | planner |
| `HANDSOFF_FALLBACKS` | `on` | planner |
| `HANDSOFF_PORT` | `4000` | embedded server |
| `HANDSOFF_DATA_DIR` | `./data` | store |
| `HANDSOFF_POLICY` | `./config/policy.json` | policy gate |
| `HANDSOFF_HEADLESS` | `false` | surface |
| `HANDSOFF_MAX_STEPS` | `30` | discovery |
| `HANDSOFF_STEP_TIMEOUT_MS` | `15000` | both engines; per-step ceiling on waits |
| `HANDSOFF_RUN_TIMEOUT_MS` | `600000` | both engines |
| `LEGACY_BANK_USER`, `LEGACY_BANK_PASS` | none | referenced by name in the app profile's bootstrap routine; never logged |
| `LEGACY_BANK_PORT_A`, `LEGACY_BANK_PORT_B` | `4100`, `4101` | mock app |
| `LEGACY_BANK_SESSION_TTL_MS` | `1800000` | mock app; chaos sets it low |
| `LEGACY_BANK_ALLOW_CHAOS_HEADER` | `true` in dev | mock app honours `x-handsoff-chaos` |

Chaos injection: `handsoff replay --chaos <mode>[,<mode>]` sets an `x-handsoff-chaos` header on the browser context. The mock app honours it only when `LEGACY_BANK_ALLOW_CHAOS_HEADER` is true. Modes: `not-found` (any member id is unknown), `validation` (the sub-account form rejects the first submit), `session-expiry` (the session cookie expires after the next request), `interstitial` (a "System notice" modal is injected on the next page load), `slow` (2 s delay on the next response), `error` (the next response is a 500 page). Modes fire once, then clear, so a recovery can be observed succeeding.

Running without live services: replay needs no API key and no network. Discovery tests use `ScriptedPlanner`, which replays a saved decision list from `packages/core/test/fixtures/` against the mock app.
