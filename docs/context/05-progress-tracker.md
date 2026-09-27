# 05 · Progress Tracker

Status: draft · Last updated: 2026-09-26

Updated at the end of every working session. Phases mirror [04-roadmap.md](04-roadmap.md). Check a box only when the phase's exit criterion is demonstrably met, not when the code exists.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` cut (say why in "Cuts made")

## Session log

| Date | Session | What landed | Next |
|---|---|---|---|
| 2026-09-21 | 1 | `docs/context/` created: overview, architecture, tech stack and data model, decision log; skeletons for UI, roadmap, tracker, AI rules, code standards; root `CLAUDE.md` | P0: workspace scaffold, mock app happy path, core schemas |
| 2026-09-21 | 2 | P0 complete. pnpm workspace with six packages; Biome, vitest, base tsconfig; core zod schemas with cross-field rules and 24 tests; JSON Schema export; app profile and policy files validate; legacy-bank happy path (frameset, tables, no ids) with 11 supertest tests, variant B branding and labels included; CLI skeleton; console shell. Docs updated: D-025, stack table, bootstrap credentials, policy patterns | P1: `surface-playwright` observe / act / resolve, filesystem store, replay engine skeleton, hand-written artifact replays with zero LLM |
| 2026-09-21 | 3 | P1 complete. `surface-playwright` with an in-page walker (roles, names, values, bounding boxes, frame paths, structural paths), acting by ref, native dialog tracking; pure `resolveTarget` with the three strategies; predicate evaluation and the ordered classifier; replay engine with bootstrap, preconditions, postcondition waits, output extraction and the full result contract; filesystem store; `handsoff replay` CLI; Chromium integration test. `pnpm handsoff replay … memberId=10001` → success, savingsBalance 1250.75, 3.4 s, 14 screenshots; `memberId=99999` → outcome MEMBER_NOT_FOUND at s2, exit 3. Decisions D-026, D-027 | P2: Anthropic planner, discovery loop, redaction of params in observation and transcript, one real run copied to `/evidence/` |
| 2026-09-21 | 4 | P2 built, real run pending. Shared engine base for both engines; `Planner` port; Anthropic planner with eleven flat strict tools, `*_param` tools, hand-written loop with explicit stop reasons, screenshots only on the last two turns, opt-out server-side fallbacks; discovery loop with stuck detector, provenance bindings, target derivation with baseline, transcript persisted redacted; rule-based compiler (postconditions from observation deltas, outputs as extract steps, route canonicalisation, salience ranking); `ScriptedPlanner`; `handsoff discover` with `--scripted`; `pnpm evidence:copy`. Integration test closes discover → compile → replay with no model (P3's exit criterion). 62 unit, 4 integration tests. Decisions D-028, D-029 | Real discovery run with `ANTHROPIC_API_KEY`, then `pnpm evidence:copy <runId> discovery-run`; P3 console skeleton |
| 2026-09-22 | 5 | Discovery made provider-agnostic (no Anthropic credit available). Planner protocol (tool schemas, prompt, rendering, `parseToolCall`) moved into core; `@handsoff/llm-openai` over the OpenAI chat-completions protocol with presets for Google AI Studio, OpenAI, Groq, OpenRouter, Ollama and custom endpoints, image and effort fallbacks on 400; `handsoff discover --provider` / `HANDSOFF_LLM_PROVIDER` with key detection; `provider` in `PlannerInfo` and provenance; JSON Schema regenerated. 74 unit tests (12 new), 4 integration tests. Decisions D-030, D-031 | Real discovery run with `GEMINI_API_KEY` (free tier) or any other provider, then `pnpm evidence:copy <runId> discovery-run`; P3 console skeleton |
| 2026-09-23 | 6 | P2 and P3 closed. Real discovery runs with Gemini (`gemini-3.8-flash` via Google AI Studio, provider `google`): the first compiled v2 in 4 turns but anchored the results row's `View` link on the member's name and status, which led to D-032 (rows keyed by a parameter value contribute no anchors); the re-run after the fix compiled v3 (4 steps, `role`+`structural` for the link, no leaks), which replays to `1250.75` with every strategy resolving first-try and to `MEMBER_NOT_FOUND` for an unknown member. `evidence/discovery-run/` holds that run and `capability.get-member-savings-balance.v3.json`. `handsoff serve`: Fastify read API (`/api/runs`, `/api/runs/:id`, `/api/run-files`, `/api/capabilities[/:id[/v/:n]]`) with 5 tests, serves the console build; console (react-router, TanStack Query, Tailwind v4) with runs, run detail (result, step reports, event timeline with screenshots), capabilities and capability detail (every locator strategy, conditions, raw JSON). `.env` duplicate-key warning. 80 unit tests, 4 integration tests. Decision D-032 | P4: chaos modes, app-profile detectors, classifier budgets, recoveries, full `ReplayResult`, fixture tests, `evidence/replay-member-not-found/` |
| 2026-09-25 | 7 | P4 complete. Chaos modes in the mock app (`x-handsoff-chaos`, each fires once per browser via its own cookie: injected miss, session expiry, native `alert()` interstitial, busy page with auto-refresh, 500 page, rejected sub-account submit) with 8 supertest tests; detectors evaluated inside every wait; recovery routines dismiss / wait-retry / rebootstrap (sign in again and re-run from entry, D-033) with budgets from `policy.budgets`; `stepsRun[].attempts`; the surface races every snapshot against a native dialog opening, since Playwright's `evaluate` blocks while one is open; classifier precedence session-level > fatal > interstitial > outcome > escalate with 11 tests over observations captured from the mock app; 6 chaos integration tests; `evidence/replay-member-not-found/` and `evidence/replay-session-expiry/`. Discovery now waits for the page to change after an action. Planner paces the Gemini free tier (5 requests a minute) and reads 429 delays; `gemini-3.8-flash` caps the free tier at 20 requests a day, so the second capability, `open-sub-account` (8 steps, select and type from parameters, confirmation route generalised to `/members/:memberId/confirmation/*`), was discovered with `gemini-3.5-flash-lite` in 93 s and replays to a confirmation number and, under `--chaos validation`, to `VALIDATION_REJECTED` at s7. Anchor heuristics tightened from that artifact: bare punctuation is data, a single-row table is not its own header, key/value cells anchor on the label beside them. 102 unit, 12 integration tests. Decision D-033 | P5: policy gate with live risk (the sub-account submit must come out `risky`), network allowlist, confirm gating, screenshot masking |
| 2026-09-25 | 8 | P5 complete. `checkPolicy` in core runs before every act in both engines (action, origin and route allowlists; live risk from button text, form action and routes; recorded-vs-live mismatch events); `Operator` port with `confirmation` events, CLI `--operator tty | none | approve-all` and `handsoff approve`; an unattended replay stops before a risky step with `ESCALATION_ABANDONED`; the surface answers off-allowlist navigations with a 403 block page (`NAVIGATION_BLOCKED`, runtime detector `POLICY_BLOCKED`); redaction with `«name#sha256:…»` placeholders in everything persisted, overlay masking of screenshots by the surface, masked sensitive outputs in `result.json`. Both capabilities re-discovered with Gemini 3.5 Flash Lite under the gate: `get-member-savings-balance` v4 and `open-sub-account` v2, whose submit was confirmed at discovery, compiled `risky` with `confirm: operator`, then approved. All evidence regenerated with masked screenshots: `discovery-run`, `discovery-run-open-sub-account`, `replay-success`, `replay-member-not-found`, `replay-session-expiry`, `replay-confirm-required`, `discovery-policy-blocked`. 136 unit, 22 integration tests. Decisions D-034, D-035 | P6: control-owner state machine, escalation record and WebSocket push, console inbox with claim and hand-back, human-action capture, checkpoint-scan resume, abandonment timeout, `evidence/replay-escalation-handoff/` |
| 2026-09-26 | 9 | P6 complete. One escalation path in core for every cause (`escalate()`: record to the store and `escalation.json`, owner to `awaiting_operator`, `Operator.escalate(record, controls)` with claim and hand-back); control-owner machine with a guarded `act`; human-action capture injected by the surface (clicks, changes the person caused, Enter submits) turned into `RecordedStep`s with targets derived from the last observation, burst-safe; checkpoint-scan resume and `mark_complete` re-extraction; abandonment timer until the claim; `REPLAY_FAILURE` and `RECOVERY_EXHAUSTED` behind `policy.escalateOn` and only with an operator attached; discovery escalates on `request_human`, stuck and escalate-class conditions and compiles human steps (`recordedBy: human`, whole-field parameter values inferred); `--operator console` serves the live API (`/api/escalations`, claim, hand-back, `/ws`) from the run's process; console inbox and detail with claim, hand-back and the human-action feed; `pnpm demo:handoff`. `evidence/replay-escalation-handoff/` (claimed and handed back over the real API, the click by a stand-in script). 151 unit, 31 integration tests. Decision D-036 | P7: variant B with overrides, fingerprint at session start, `evidence/replay-variant-b/`; assisted fallback only if time remains |
| 2026-09-26 | 10 | P7 complete, stretch included. Variant detection by fingerprint once the entry page is open (`detectVariants`), overrides applied in memory (`applyVariant`: labels, routes, a new `frames` map, detectors, per-step replacements), `variant` run event, `DRIFT_SUSPECTED` on an unknown, ambiguous or contradicted fingerprint before any step runs, `replay --variant`; the mock's variant B gains reordered account columns and a `--variant b` switch (`pnpm dev:b`). Assisted fallback built as the Planner asked for one turn: `assist()` in the engine on TARGET_NOT_FOUND and CHECKPOINT_FAILED, behind `policy.assistedFallback`, gated (never a risky proposal), re-verified by the step's postcondition, budgeted per run, `transcript.assisted.jsonl`; `replay --assisted`; the mock's `relabel` chaos. Evidence: `replay-variant-b` (every step by its first strategy on B, 9 label and 11 frame rewrites) and `replay-assisted-fallback` (a real model proposing the relabelled button). 161 unit, 40 integration tests. Decisions D-037, D-038 | P8: README, REPORT.md with the seven headings, evidence curation, cuts list, consistency pass |
| 2026-09-26 | 11 | P8 complete. `/REPORT.md` written under the brief's seven headings; `/README.md` rewritten for a fresh clone (setup, running without live services, the demo path, then one section per capability of the system and an evidence table); `/evidence/` indexed, ten runs and two artifacts; the three skeleton docs (03, 06, 07) written in full and the docs index updated; the exported JSON Schemas refreshed (two were stale); the cuts table rewritten; a fresh-clone check ran the README's replay, not-found and scripted discovery without a key. 161 unit, 40 integration tests | Submission: commit, push, email the repository link |

## Phases

### P0 · Foundations
- [x] `docs/context/` written (session 1)
- [x] pnpm workspace with six packages stubbed and building (`pnpm typecheck` clean across all six)
- [x] Biome, vitest, base tsconfig (`pnpm lint`, `pnpm test`, `pnpm format`)
- [x] `legacy-bank` variant A happy path with framesets and tables (11 supertest tests; boots on `:4100`)
- [x] zod schemas: `Condition`, `TargetSpec`, `Capability`, `ReplayResult`, `AppProfile`, `Policy` (plus `Run`, `RunEvent`, `Escalation`, `Observation`)
- [x] Example artifact validates against `CapabilitySchema`; `data/app-profiles/acme-coreteller.json` and `config/policy.json` validate too

### P1 · Surface and hand-written replay
- [x] `observe()` with refs, frame paths, screenshot, dialogs, digest (plus per-frame URLs and structural paths)
- [x] `act()` for all action kinds (extract is read from the observation by the engine)
- [x] `resolveTarget()` with `role`, `anchored`, `structural`; reports `resolvedBy`, `candidateCount`; pure, 9 unit tests
- [x] Filesystem `Store`
- [x] Replay engine with bootstrap, preconditions, postcondition waits, classifier, outputs, result contract
- [x] Event log and screenshots (before/after every step; snapshot JSON on failure)
- [x] Hand-written `get-member-savings-balance` replays to `success` (CLI and integration test); unknown member → `outcome`

### P2 · Discovery
- [x] Planner with strict tools and `*_param` tools (parameters by name, never by value)
- [x] Discovery loop, stop conditions, stuck detector
- [x] Redaction in observation, event log, snapshots and transcript
- [x] `ScriptedPlanner` and an integration test that discovers, compiles and replays with no model
- [x] One real run completed and copied to `evidence/discovery-run/` (Gemini via Google AI Studio, run `run_20260923_020413_4203`, compiled v3; session 6)

### P3 · Compile and close the thread
- [x] Compile passes: prune, bind by provenance, targets with baseline, postconditions from deltas, outputs as extract steps, provenance, route canonicalisation (built in P2)
- [x] Versioning with `latest.json` (a new discovery of an existing id writes the next version with `supersedes`)
- [x] Compiled artifact replays with matching outputs (integration test: success 1250.75, outcome MEMBER_NOT_FOUND)
- [x] Console skeleton lists runs and capabilities (`handsoff serve` + `pnpm console`; session 6)

### P4 · Conditions and the result contract
- [x] Chaos modes: not-found, validation, session-expiry, interstitial (`x-handsoff-chaos`, fire once per browser, 8 supertest tests; session 7)
- [x] Optional chaos modes: slow (busy page with auto-refresh), error (500 page)
- [x] App profile detectors: session-expired, system-notice, system-busy, app-error, permission-denied
- [x] Classifier with precedence and budgets (session-level > fatal > interstitial > outcome > escalate > postcondition; budgets from `policy.budgets`)
- [x] Recovery routines: dismiss, wait-retry, rebootstrap (re-run from entry, D-033), evaluated inside every wait
- [x] Full `ReplayResult` incl. `sideEffects`, `recoveries`, `stepsRun[].attempts`
- [x] Fixture tests for the classifier over observations captured from the mock app (11 tests)
- [x] `evidence/replay-member-not-found/` (natural unknown member) and `evidence/replay-session-expiry/` (injected expiry, recovered)

### P5 · Policy and redaction
- [x] `PolicyGate` with live risk classification and mismatch events (`checkPolicy`: action, origin and route allowlists, button text, form action, routes; 22 unit tests; session 8)
- [x] Network-level origin block (surface answers off-allowlist navigations with a 403 block page; `NAVIGATION_BLOCKED`; runtime detector `POLICY_BLOCKED`)
- [x] `confirm` handling and approval gating (`Operator` port, `--operator tty | none | approve-all`, `handsoff approve`, `confirmation` events; a recorded-safe risky step needs an operator whatever the approval, D-034)
- [x] Screenshot masking, hashed sensitive values, masked outputs (overlays painted by the surface; `«name#sha256:…»` in everything persisted; `result.json` outputs masked, D-035)
- [x] Off-allowlist navigation blocked with evidence (`evidence/discovery-policy-blocked/`: gate blocks `/admin/users` and `https://example.com/`, the network layer blocks the clicked footer link)

### P6 · Escalation and handoff
- [x] Control-owner state machine in core (`transition`, guarded `act`; 4 unit tests over every owner × event; session 9)
- [x] Escalation record and WebSocket push (`escalate()` in core writes the store record and `escalation.json`; `--operator console` serves claim / hand-back / `/ws` from the run's process, D-036)
- [x] Console inbox and detail with claim / hand-back (`/escalations`, `/escalations/:id`, open count in the navigation, human-action feed)
- [x] Human-action capture in the surface (injected script reports clicks, changes and Enter submits; engine derives the TargetSpec from the last observation; discovery compiles human steps with `recordedBy: human`)
- [x] Checkpoint-scan resume and `mark_complete` re-extraction (`scanCheckpoints`; outputs of skipped steps read from the resume observation; a skipped risky step counts as committed)
- [x] Abandonment timeout (until the claim; `ESCALATION_ABANDONED`, resolution `abandoned`)
- [x] `evidence/replay-escalation-handoff/` (claimed and handed back over the real console API; the click on the live page made by a stand-in script, see `scripts/handoff-demo.ts`)

### P7 · Cross-tenant variant, stretch
- [x] Variant B on `:4101` (branding, labels, renamed main frame, reordered account columns; `pnpm dev:b` or `--variant b`; session 10)
- [x] Fingerprints, profile-level and capability-level overrides (`detectVariants`, `applyVariant`: labels, routes, frames, detectors, per-step replacements; 6 unit tests; `replay --variant`)
- [x] `DRIFT_SUSPECTED` on unknown fingerprint (and on a contradicted request or an ambiguous page, before any step runs)
- [x] `evidence/replay-variant-b/` (v4 recorded on A succeeds on B, every step by its first strategy; 9 label and 11 frame rewrites)
- [x] Stretch: assisted fallback (`createRecoveryPlanner` over the Planner port; engine `assist()` on TARGET_NOT_FOUND and CHECKPOINT_FAILED behind `policy.assistedFallback`, gated, re-verified, budgeted; `replay --assisted`; mock `relabel` chaos; 4 unit and 4 integration tests; `evidence/replay-assisted-fallback/` with a real model; D-038)

### P8 · Submission
- [x] `/README.md` with setup, keys, offline path, demo commands (rewritten around Setup → Running without live services → Demo path, plus an evidence table; session 11)
- [x] `/REPORT.md` with the seven headings in order (about 2,400 words, three dense pages)
- [x] `/evidence/` curated (ten run folders and the two artifacts, every one regenerated after masking; indexed in the README and the report; nothing edited in place)
- [x] Tests where they count: classifier, resolver, gate, schema, control owner (161 unit, 40 integration)
- [x] Final consistency pass over `docs/context/` (03, 06 and 07 written in full, no `TODO` left; exported JSON Schemas refreshed; links checked)
- [x] Fresh-clone check of the README (a clone with `.env.example` copied ran the replay, the not-found outcome and the scripted discovery without a key; the offline install could not fetch one dev dependency from the local store, which a networked install would)

## Brief coverage

| Brief | Requirement | Status | Evidence |
|---|---|---|---|
| §3.1 | Goal-driven agent loop on a real UI | [x] | `evidence/discovery-run/` (Gemini 3.5 Flash Lite, 4 turns, compiled v4) and `evidence/discovery-run-open-sub-account/` (the write flow, risky submit confirmed through the gate) |
| §3.2 | Typed, versioned, reviewable artifact | [x] | `evidence/capability.get-member-savings-balance.v4.json`, `evidence/capability.open-sub-account.v2.json`, `packages/core/schema/*.schema.json`, console capability detail |
| §3.3 | Deterministic replay with error taxonomy and result contract | [x] | chaos integration tests (6 modes), `evidence/replay-session-expiry/` (recovery), `evidence/replay-member-not-found/` (outcome), classifier fixture tests |
| §3.4 | Allowlist, risky-action handling, redaction | [x] | gate at every act in both engines with unit tests for allow, block, confirm and mismatch; network block; `evidence/replay-confirm-required/` (unattended run stops before the risky submit); no raw sensitive value under any run folder (integration test) |
| §3.5 | Structured log plus failure evidence | [x] | `events.jsonl`, screenshots and redacted snapshots in every evidence run; `failingScreenshot` and `lastObservation` on failures |
| §3.6 | Escalation, live-session handoff, hand-back, recorded human actions | [x] | `evidence/replay-escalation-handoff/`: automation pauses at the risky submit, the person clicks it in the same browser session, the click is a `human_action` with a real target, the checkpoint scan resumes at s8, the result carries the `escalation` block; 9 integration tests cover confirm / resume / mark complete / abort / abandonment / REPLAY_FAILURE / discovery with help / the live API |
| §3.7 | Design for heterogeneity and multi-tenant | [x] | `Surface` seam and desktop design in 01 §5, §14; built: one capability on two tenants through the profile's overrides with a clean resolution report (`evidence/replay-variant-b/`); drift measured by `resolvedBy`/`candidateCount` and by fingerprint (`DRIFT_SUSPECTED`); 5 integration tests |
| §4 | At least one real LLM discovery run with evidence | [x] | `evidence/discovery-run/` |
| §6.1 | `/README.md` | [x] | setup, keys, running without live services, the demo path, one section per capability of the system, the evidence table |
| §6.2 | `/REPORT.md` seven headings | [x] | the seven headings in the brief's order and wording |
| §6.3 | `/evidence/` | [x] | two discovery runs, eight replays including four exceptional states, the two artifacts |

## Open questions

- 2026-09-23 · `evidence/discovery-run/steps/*.png` show the member number typed into the search field (synthetic data). Screenshot masking lands in P5; regenerate the evidence run afterwards so the submission shows masked screenshots. **Resolved 2026-09-25:** masking landed in P5 and every evidence folder was regenerated with masked screenshots and hashed placeholders.

## Cuts made

Feeds REPORT §7. Record what was cut, when, why, and what would be built next.

| Date | Cut | Why | Next |
|---|---|---|---|
| 2026-09-21 | Remote co-browsing screencast | Brief scopes it out; headed handoff is real and cheaper ([D-012](08-decision-log.md#d-012--handoff-via-the-headed-browser-with-captured-human-actions-no-screencast)) | Session broker + CDP screencast |
| 2026-09-21 | Desktop surface implementation | Brief asks for design only | `desktop-a11y` surface over UI Automation |
| 2026-09-21 | Assisted fallback as built | Design is the interesting part ([D-008](08-decision-log.md#d-008--stretch-goals-variant-b-built-assisted-fallback-designed-built-if-time)) | **Reversed 2026-09-26:** built in P7 ([D-038](08-decision-log.md#d-038--assisted-fallback-is-the-discovery-planner-asked-for-one-turn-proposals-never-run-risky-actions)) |
| 2026-09-26 | Operator authentication, leases, audit trail | Brief scopes the console out; the control-owner machine is the part that matters ([D-036](08-decision-log.md#d-036--escalation-is-one-port-with-claim-and-hand-back-the-runner-embeds-the-live-api-only-for-the-run-it-owns)) | Auth on the console and API, leases that return an abandoned claim to the inbox |
| 2026-09-26 | Multi-run stability signal | Buffer day went to the assisted fallback instead | Replay N times, aggregate the per-step resolution report into a flakiness score |
| 2026-09-26 | Agent-facing capability catalog, code generation | Stretch goals not taken; the artifact contract and JSON Schema are the seam | A catalog endpoint over `replay()`; a test-file emitter from an artifact |
| 2026-09-26 | Keyed hashes, data-loss scan of typed human input, CI | Hardening beyond the demo's threat model, stated as limits in REPORT §6 | HMAC with a deployment secret; a scan of `type` values during handoffs; a CI job for the four checks |
