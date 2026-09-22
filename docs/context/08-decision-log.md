# 08 · Decision Log

Status: stable · Last updated: 2026-09-21

Lightweight architecture decision records. One entry per decision that shapes the system. The brief (§4, §5, §7) says every decision must be defended; this log is where the defence lives, and `/REPORT.md` will be distilled from it.

Rules:

- New decision: next `D-0NN`, status `accepted`, date, and the four fields below.
- Changing your mind: add a new entry and set the old one to `superseded by D-0NN`. Never rewrite history.
- Anything in [01-architecture.md](01-architecture.md) or [02-tech-stack-and-data-model.md](02-tech-stack-and-data-model.md) that has no entry here is a candidate for one.

## Index

| ID | Decision | Status |
|---|---|---|
| D-001 | TypeScript on Node 22, pnpm monorepo | accepted |
| D-002 | Perceive via accessibility tree + screenshot; act via Playwright | accepted |
| D-003 | Target is a locally built mock legacy bank app with a second variant | accepted |
| D-004 | Anthropic Claude behind a thin `Planner` interface | accepted |
| D-005 | Web-only operator console (Vite + React); no mobile | accepted |
| D-006 | Filesystem-only storage | accepted |
| D-007 | Two-week time box | accepted |
| D-008 | Stretch goals: variant B built; assisted fallback designed, built if time | accepted |
| D-009 | AI workflow rules: root `CLAUDE.md` pointing into `docs/context/` | accepted |
| D-010 | Product name: HandsOff | accepted |
| D-011 | One runner process; the CLI embeds the API and console | accepted |
| D-012 | Handoff via the headed browser with captured human actions; no screencast | accepted |
| D-013 | Parameters bound by provenance, not by value matching | accepted |
| D-014 | One `Condition` type in three roles, one ordered classifier | accepted |
| D-015 | Risk classified at act time; per-step `confirm` | accepted |
| D-016 | Three locator strategies with a recorded resolution baseline | accepted |
| D-017 | Integer artifact versions with `supersedes` | accepted |
| D-018 | Three terminal result statuses; escalation is metadata; `sideEffects` field | accepted |
| D-019 | App Profile is the cross-tenant reuse unit | accepted |
| D-020 | Default model `claude-opus-5`, overridable | accepted |
| D-021 | Compile is rule-based; no LLM at compile time | accepted |
| D-022 | Manual tool-use loop on SDK types, not the beta tool runner | accepted |
| D-023 | `core` has no runtime dependencies; LLM adapter is a separate package | accepted |
| D-024 | Chaos modes: four required, two optional | accepted |
| D-025 | Packages export TypeScript source; no build step | accepted |
| D-026 | Target resolution is a pure function in core; surfaces act on refs | accepted |
| D-027 | An in-page walker instead of the browser's accessibility snapshot | accepted |

---

## D-001 · TypeScript on Node 22, pnpm monorepo

Date: 2026-09-21 · Status: accepted

- **Decision.** TypeScript 5 in `strict` mode, ESM, Node 22 LTS, pnpm workspaces.
- **Alternatives.** Python 3.12 with Playwright and pydantic. Go.
- **Why.** Playwright's primary API is Node. zod gives one schema definition for validation, types and the exported JSON Schema the artifact must be reviewable as. A single language across engine, mock app and console means shared types with no duplication.
- **Consequences.** Everyone touching the repo needs Node and pnpm. No Python data tooling; none is needed.

## D-002 · Perceive via accessibility tree + screenshot; act via Playwright

Date: 2026-09-21 · Status: accepted

- **Decision.** Playwright drives Chromium. Each observation is the accessibility tree flattened to nodes with numbered refs, roles, names, values, bounding boxes and frame paths, plus a screenshot. The model acts by ref. The artifact stores locators derived from the resolved element, never raw refs or coordinates.
- **Alternatives.** Pure screenshot and pixel coordinates (the Anthropic computer-use tool). DOM-first CSS or XPath locators.
- **Why.** Brief §3.1 asks for an approach that survives a hostile DOM. The accessibility tree is what screen readers use, exists for desktop apps too (UI Automation, macOS Accessibility), and is more stable than markup. The screenshot lets the model disambiguate and lets us mask sensitive regions. Pure coordinates make deterministic replay brittle; DOM-first leans on the clean-DOM assumption the brief tells us to drop.
- **Consequences.** The `Observation` shape is the seam that must stay surface-agnostic (see D-016 and [01 §5](01-architecture.md#5-seams)). Framesets require explicit frame scoping in every locator.

## D-003 · Target is a locally built mock legacy bank app with a second variant

Date: 2026-09-21 · Status: accepted

- **Decision.** `apps/legacy-bank`: Express and EJS, server-rendered, frameset layout, table-based forms, no ids or test ids, cookie session with configurable expiry, injectable runtime failures. Variant B rebrands and relabels the same app.
- **Alternatives.** A public demo storefront. A public site plus a local app.
- **Why.** The brief's interesting problems are runtime errors (§1, §3.3) and cross-tenant reuse (§3.7). Only a local app lets us inject not-found, validation, session expiry and interstitials on demand and stand up a second "tenant". No terms-of-service or uptime risk. Public sites cannot show either.
- **Consequences.** We own a small extra codebase. It must stay deliberately hostile: no semantic ids, no test hooks, framesets on purpose.

## D-004 · Anthropic Claude behind a thin `Planner` interface

Date: 2026-09-21 · Status: accepted

- **Decision.** `@anthropic-ai/sdk` with tool use. `packages/llm-anthropic` implements `Planner` and `RecoveryPlanner` from `core`. A `ScriptedPlanner` in core serves tests and the offline path.
- **Alternatives.** OpenAI. Two providers behind a switch from day one.
- **Why.** One provider is enough for a take-home and the brief does not reward provider breadth (§7). The interface keeps the loop vendor-neutral without paying for a second implementation.
- **Consequences.** An API key is required for discovery only. Replay never needs it (D-023).

## D-005 · Web-only operator console (Vite + React); no mobile

Date: 2026-09-21 · Status: accepted

- **Decision.** `apps/operator-console` is a single responsive web app: runs, run detail, escalation inbox and detail, capabilities and approval.
- **Alternatives.** A native mobile app in addition. An agent-facing chat UI.
- **Why.** Brief §3.6 scopes the operator console out and says to mock it if needed. A web console is enough to make the handoff real and visible. Mobile was never a requirement.
- **Consequences.** No operator authentication and no multi-operator support. Both are documented as real-scale design in [01 §11](01-architecture.md#11-control-transfer-and-escalation).

## D-006 · Filesystem-only storage

Date: 2026-09-21 · Status: accepted

- **Decision.** Capabilities are versioned JSON files. Each run is a folder with `run.json`, `events.jsonl`, screenshots and `result.json`. App profiles and escalations are JSON files. Layout in [02](02-tech-stack-and-data-model.md#filesystem-layout).
- **Alternatives.** Filesystem plus a SQLite index.
- **Why.** Brief §7 explicitly does not reward storage infrastructure. Files are reviewable in a diff, copy straight into `/evidence/`, and need no migration story. The console reads the same files.
- **Consequences.** Listing and filtering in the console is a directory scan, fine at demo scale. The `Store` interface is the seam for a real database later.

## D-007 · Two-week time box

Date: 2026-09-21 · Status: accepted

- **Decision.** About two weeks of focused sessions, phased in [04-roadmap.md](04-roadmap.md), with a thin end-to-end thread by day five.
- **Alternatives.** One week; three or more.
- **Why.** Enough room for a real mock app, one stretch goal and a careful report. The brief warns against endurance over judgment (§9).
- **Consequences.** Depth goes to the artifact schema, replay error handling and the handoff model. Everything else is thin-but-real.

## D-008 · Stretch goals: variant B built; assisted fallback designed, built if time

Date: 2026-09-21 · Status: accepted

- **Decision.** The cross-tenant variant with per-variant overrides is on the roadmap as built. Assisted fallback exists in the schema and engine as the `RecoveryPlanner` port and a `recovery.kind = 'assisted'` record, and is implemented only if phase P7 has time.
- **Alternatives.** Both built. Neither built.
- **Why.** Brief §8 says one or two stretch goals, depth over breadth. Variant B is cheap (a second EJS layout and a label map) and is the strongest answer to §3.7. Assisted fallback is valuable but reuses the discovery loop, so the design is the interesting part.
- **Consequences.** The schema carries fields for a feature that may ship as design only. That is deliberate and will be stated in REPORT §7.

## D-009 · AI workflow rules: root `CLAUDE.md` pointing into `docs/context/`

Date: 2026-09-21 · Status: accepted

- **Decision.** A short `CLAUDE.md` at the repo root states the non-negotiables and says to read `docs/context/README.md` first. Full rules live in [06-ai-workflow-rules.md](06-ai-workflow-rules.md) and [07-code-standards.md](07-code-standards.md).
- **Alternatives.** Rules only inside `docs/context/`.
- **Why.** Coding assistants pick up the root file automatically; the human does not have to paste it each session.
- **Consequences.** Two places to keep in sync; the root file stays short so this is cheap.

## D-010 · Product name: HandsOff

Date: 2026-09-21 · Status: accepted

- **Decision.** The system is called HandsOff. Package scope `@handsoff/*`, CLI `handsoff`, environment prefix `HANDSOFF_`. Tagline: the model figures it out once, then takes its hands off.
- **Alternatives.** Keep the repo name "AI OS". Rote. Playbook.
- **Why.** Names the two things the brief cares about most: the model leaving the loop after discovery, and the human handoff.
- **Consequences.** The repo stays named `AI-OS`; the README title changes to HandsOff when the code lands.

## D-011 · One runner process; the CLI embeds the API and console

Date: 2026-09-21 · Status: accepted

- **Decision.** `apps/runner` (binary `handsoff`) runs discovery and replay in-process, owns the Playwright browser, and starts an embedded Fastify server (REST, WebSocket, built console) so the operator console can attach to the live session. `handsoff serve` runs the server alone for browsing runs and triggering replays from the UI.
- **Alternatives.** A long-running server with the CLI as a thin HTTP client. A pure CLI and library with no server.
- **Why.** The live session, the engines and the operator controls must share one process for the handoff to be real; a single process is the simplest way to guarantee it. Brief §4 accepts a single process if justified, and §7 penalises building service plumbing.
- **Consequences.** Two concurrent runs need two ports or one `serve` process; acceptable for a demo. At real scale a session broker owns browsers and the runner becomes a worker, described in [01 §2](01-architecture.md#2-topology).

## D-012 · Handoff via the headed browser with captured human actions; no screencast

Date: 2026-09-21 · Status: accepted

- **Decision.** The browser runs headed. On escalation the operator claims the session in the console, then acts directly in the real browser window. An injected page script reports their clicks, inputs and submits back to the runner, which records them as structured steps with real locators. The console shows the intervention context, the latest screenshot, and claim and hand-back controls.
- **Alternatives.** Screenshot streaming over WebSocket at about 2 fps with operator clicks forwarded through the surface. CDP screencast.
- **Why.** Brief §3.6 puts a real-time co-browsing console out of scope. The screencast is the largest single build item and is unusable at 2 fps. Working in the real window gives higher-fidelity recording (we see the actual element, not a coordinate) for a fraction of the code, and the session is genuinely the same one automation was using.
- **Consequences.** Operator and runner must be on the same machine for the demo. Remote operators need a session broker and a screencast or VNC bridge; documented as design in [01 §11](01-architecture.md#11-control-transfer-and-escalation).

## D-013 · Parameters bound by provenance, not by value matching

Date: 2026-09-21 · Status: accepted

- **Decision.** Discovery receives the goal plus typed parameters with concrete values. The model sees parameters as named placeholders and supplies `{ param: "memberId" }` instead of a literal wherever it uses one; the surface substitutes the value at act time. The binding is therefore recorded at the moment the value is used. Whole-field equality is used only to canonicalise URL segments, and such bindings are marked `inferred: true`.
- **Alternatives.** Let the model type literals and infer bindings afterwards by matching values against the step log.
- **Why.** `10001` also appears in URLs, titles and table cells, and a balance can equal a parameter by accident. Post-hoc matching misbinds precisely where correctness is most visible. Provenance binding also keeps sensitive values out of the model transcript entirely.
- **Consequences.** The planner tool schemas carry a `Value = { text } | { param }` union. The compile step becomes simpler and deterministic.

## D-014 · One `Condition` type in three roles, one ordered classifier

Date: 2026-09-21 · Status: accepted

- **Decision.** A single `Condition` type (a predicate over an observation) is used as a step precondition, a step postcondition (the checkpoint), and a detector. Detectors carry a class: `outcome`, `recover`, `fail` or `escalate`. One ordered `classify(observation, step)` function evaluates them with fixed precedence: session-level and fatal conditions, then known interstitials, then business outcomes, then the postcondition. Recovery budgets are explicit: at most two recoveries per step and one re-bootstrap per run.
- **Alternatives.** Separate `waitFor`, `checkpoint`, `expectedConditions` and `outcomes` mechanisms.
- **Why.** Four overlapping mechanisms with no precedence rule is how business outcomes get conflated with failures, which the brief (§10) calls the most common design mistake. One type and one classifier make the taxonomy testable over saved fixtures without a browser.
- **Consequences.** The schema is smaller. The classifier is the most tested unit in the codebase.

## D-015 · Risk classified at act time; per-step `confirm`

Date: 2026-09-21 · Status: accepted

- **Decision.** `PolicyGate.check` runs before every action in both discovery and replay and classifies risk from the live observation (button text, form action, route), not only from the value stored in the artifact. A recorded `risk` that disagrees with the live classification is a policy event and a drift signal. Each step carries `confirm: 'none' | 'operator'` so an approved artifact can still pause before an irreversible step.
- **Alternatives.** Classify risk once at discovery and rely on artifact approval as the only replay guard.
- **Why.** A button relabelled to "Post Transfer" must not replay as safe because it was safe last month. Brief §3.4 asks for conservative handling of the risky class; approval alone does not see the live page.
- **Consequences.** Slight per-step overhead. Two sources of risk truth, reconciled explicitly.

## D-016 · Three locator strategies with a recorded resolution baseline

Date: 2026-09-21 · Status: accepted

- **Decision.** Each target carries an ordered list of up to three strategies: `role` (role plus accessible name, frame-scoped), `anchored` (relative to stable text: labels, same row and column, right of, below), and `structural` (frame path plus positional path). Discovery records which strategy resolved and how many candidates matched. Replay records the same and treats a deeper or ambiguous resolution as `DRIFT_SUSPECTED`. Visual and bounding-box anchoring is a documented seam for screenshot-only surfaces, not implemented.
- **Alternatives.** A seven-rung ladder including text, attribute and bounding-box fallbacks.
- **Why.** Without a recorded baseline, fallback depth is not a measurable drift signal. Bounding boxes are stalest exactly when they are needed. Anchored targeting is the one strategy that survives table-based legacy layouts and is credible on desktop, so it deserves to be first-class rather than buried in a long list.
- **Consequences.** Fewer strategies to implement and test. The resolver must report `resolvedBy` and `candidateCount` on every call.

## D-017 · Integer artifact versions with `supersedes`

Date: 2026-09-21 · Status: accepted

- **Decision.** `version` is an integer. A new version records `supersedes` (the previous version) and why. Status is `draft`, `approved` or `retired`.
- **Alternatives.** Semantic versioning.
- **Why.** Semver implies compatibility rules we will not implement. A monotonic integer plus a link to the predecessor is all a reviewer or calling agent needs.
- **Consequences.** Versions are per capability id; there is no cross-capability compatibility contract.

## D-018 · Three terminal result statuses; escalation is metadata; `sideEffects` field

Date: 2026-09-21 · Status: accepted

- **Decision.** `ReplayResult.status` is `success`, `outcome` or `failure`. Recoverable conditions are recorded as events and never surface as a result. If a human intervened, the result carries an `escalation` block with the human's recorded actions and the resolution. Every result carries `sideEffects: 'none' | 'possible' | 'committed'`, derived from whether a risky step executed before the stop.
- **Alternatives.** `escalated` as a fourth terminal status. No side-effect state.
- **Why.** A caller always needs a business answer, even after a human finished the job. A timeout after a submit is materially different from one before it in a bank, and the caller must be told which happened.
- **Consequences.** `mark_complete` on hand-back must re-extract outputs from the live page using the artifact's output specs, so the result is still machine-derived.

## D-019 · App Profile is the cross-tenant reuse unit

Date: 2026-09-21 · Status: accepted

- **Decision.** An `AppProfile` describes one vendor product: bootstrap/login routine, shared detectors (session expired, error page, interstitials), and `variants`, each with a fingerprint and overrides. A capability binds to a profile, not to a tenant. The variant is detected at session start by fingerprint.
- **Alternatives.** One artifact per tenant. Tenant-specific fields inside the capability.
- **Why.** Brief §3.7: many tenants run the same vendor product configured differently. Recording once per product and overriding per variant is the only model that does not rebuild per tenant.
- **Consequences.** The mock app's variant B exercises exactly this path. Unknown fingerprints are a drift signal, not a silent fallback.

## D-020 · Default model `claude-opus-5`, overridable

Date: 2026-09-21 · Status: accepted

- **Decision.** Discovery defaults to `claude-opus-5` with adaptive thinking. `HANDSOFF_MODEL` overrides it, for example `claude-sonnet-5` for cheaper iteration.
- **Alternatives.** Default to Sonnet 5.
- **Why.** Follows current Anthropic guidance. A single discovery run is cheap at either price and the brief only requires one real run.
- **Consequences.** Model id and effort are recorded in the capability's provenance.

## D-021 · Compile is rule-based; no LLM at compile time

Date: 2026-09-21 · Status: accepted

- **Decision.** Turning a run into a capability is deterministic: prune wait-only steps and back-navigation pairs, apply provenance bindings, derive output specs from `extract` and `finish`, propose postconditions from observation deltas, tag risk via the policy gate, canonicalise routes by whole-segment equality.
- **Alternatives.** An extra model call to tidy step intents and checkpoints.
- **Why.** A reviewer must be able to trace every field of the artifact back to a recorded event. A model pass adds cost and non-determinism for no grading credit.
- **Consequences.** Step `intent` strings come from the model's own tool-call reasoning at discovery time, which is already recorded.

## D-022 · Manual tool-use loop on SDK types, not the beta tool runner

Date: 2026-09-21 · Status: accepted

- **Decision.** The discovery loop calls `client.messages.create` directly and manages the message array itself, using the SDK's exported types.
- **Alternatives.** `client.beta.messages.toolRunner` with `betaZodTool`.
- **Why.** Every tool result here is a fresh observation (snapshot plus screenshot), every action must pass the policy gate before it executes, and the loop has custom stop conditions and a stuck detector. Owning the loop is clearer than working around a runner, and it avoids a beta dependency in the one place the model is used.
- **Consequences.** About fifty more lines in the adapter. `stop_reason` handling (`end_turn`, `max_tokens`, `refusal`, `pause_turn`) is explicit.

## D-023 · `core` has no runtime dependencies; LLM adapter is a separate package

Date: 2026-09-21 · Status: accepted

- **Decision.** `packages/core` depends on zod only. Playwright lives in `packages/surface-playwright`; the Anthropic SDK lives in `packages/llm-anthropic`. The replay engine can reach a model only through the optional `RecoveryPlanner` port.
- **Alternatives.** Fold the adapter into core as one file.
- **Why.** "Replay does not call the LLM" is a claim the brief will check (§3.3). A dependency graph that makes the call impossible is stronger than a code comment saying so.
- **Consequences.** One extra tiny package. Worth it.

## D-024 · Chaos modes: four required, two optional

Date: 2026-09-21 · Status: accepted

- **Decision.** The mock app must support injecting: member not found, validation error, session expiry, and an unexpected interstitial dialog. Slow load and a 500 error page are added if trivial.
- **Alternatives.** All seven modes named in brief §3.3 including permission denied.
- **Why.** The four cover each condition class in D-014 (outcome, outcome, recover by bootstrap, recover by dismiss) and are enough to prove the taxonomy. The rest add breadth, not depth.
- **Consequences.** Permission denied is handled as a business outcome by the same detector mechanism but may not have a dedicated chaos switch.

## D-025 · Packages export TypeScript source; no build step

Date: 2026-09-21 · Status: accepted

- **Decision.** Every workspace package's `main`, `types` and `exports` point at `src/index.ts`. `tsx` runs the CLI and the mock app, vitest imports source directly, `tsc --noEmit` per package is the typecheck, and Vite builds the console. There is no emit step anywhere. `pnpm handsoff` is `tsx apps/runner/src/cli.ts`.
- **Alternatives.** `tsc -b` with project references emitting `dist/` and conditional exports so tests can still hit source.
- **Why.** Nothing in the demo runs under plain `node`. A build step adds a "did you build?" failure mode and a second module-resolution story for no reviewer benefit, and the brief grades "easy to run" (§7).
- **Consequences.** Publishing these packages would need a build; not a goal. zod 4's built-in `z.toJSONSchema` replaces the `zod-to-json-schema` dependency named in the first draft of the tech stack doc. `skipLibCheck` is on so third-party declarations are not re-checked.

## D-026 · Target resolution is a pure function in core; surfaces act on refs

Date: 2026-09-21 · Status: accepted

- **Decision.** `resolveTarget(nodes, spec)` lives in `@handsoff/core` and works on the node list of an observation. It returns the ref of the one matching node plus `resolvedBy` and `candidateCount`, or what it tried and the nearest nodes. The `Surface` port has no `resolve` method; `act` takes an action whose target is a ref from the latest observation.
- **Alternatives.** Resolution inside each surface adapter, for example as Playwright locators.
- **Why.** The three strategies are the load-bearing robustness story (brief §3.2, §3.3) and must be testable on saved snapshots without a browser. One implementation gives identical semantics on every surface, so a desktop adapter inherits it. The adapter stays small: observe, act, close.
- **Consequences.** The surface must emit enough structure for the strategies: structural paths, page-level bounding boxes, frame paths. Refs are valid only for the observation they came from, so the engine always observes before it acts.

## D-027 · An in-page walker instead of the browser's accessibility snapshot

Date: 2026-09-21 · Status: accepted

- **Decision.** The Playwright surface evaluates its own walker in every frame. It derives roles from HTML semantics, accessible names as a screen reader would (label association, submit `value`, cell text), values (never for password fields), states, bounding boxes and structural paths with transparent table sections, and keeps element handles for the refs on the page.
- **Alternatives.** Playwright's `page.accessibility.snapshot()` (deprecated; no refs, boxes or frames). `locator.ariaSnapshot()` (YAML; no boxes or structural paths). The CDP `Accessibility.getFullAXTree` (the real tree, but mapping nodes back to actable elements across frames is awkward).
- **Why.** Replay needs refs it can act on, page-level boxes for masking and geometric anchoring, per-frame paths for framesets, and structural paths for the third strategy. Legacy markup also needs name rules the browser does not apply, such as treating a table cell as the label of the control beside it.
- **Consequences.** About 250 lines of browser code we own; roles are HTML-semantic approximations, not the browser's computed roles. The walker is shipped to the page as source text with a shim for the helper esbuild injects under tsx, because Playwright does not invoke a string expression that evaluates to a function.
