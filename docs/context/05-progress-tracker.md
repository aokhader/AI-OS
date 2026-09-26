# 05 · Progress Tracker

Status: draft · Last updated: 2026-09-25

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
- [ ] `PolicyGate` with live risk classification and mismatch events
- [ ] Network-level origin block
- [ ] `confirm` handling and approval gating
- [ ] Screenshot masking, hashed sensitive values, masked outputs
- [ ] Off-allowlist navigation blocked with evidence

### P6 · Escalation and handoff
- [ ] Control-owner state machine in core
- [ ] Escalation record and WebSocket push
- [ ] Console inbox and detail with claim / hand-back
- [ ] Human-action capture in the surface
- [ ] Checkpoint-scan resume and `mark_complete` re-extraction
- [ ] Abandonment timeout
- [ ] `evidence/replay-escalation-handoff/`

### P7 · Cross-tenant variant, stretch
- [~] Variant B on `:4101` (branding, labels and frame name done in P0 via `LEGACY_BANK_VARIANT=b`; column reorder pending)
- [ ] Fingerprints, profile-level and capability-level overrides
- [ ] `DRIFT_SUSPECTED` on unknown fingerprint
- [ ] `evidence/replay-variant-b/`
- [ ] Stretch: assisted fallback (only if time)

### P8 · Submission
- [ ] `/README.md` with setup, keys, offline path, demo commands
- [ ] `/REPORT.md` with the seven headings in order
- [ ] `/evidence/` curated
- [ ] Tests where they count: classifier, resolver, gate, schema, control owner
- [ ] Final consistency pass over `docs/context/`
- [ ] Fresh-clone check of the README

## Brief coverage

| Brief | Requirement | Status | Evidence |
|---|---|---|---|
| §3.1 | Goal-driven agent loop on a real UI | [x] | `evidence/discovery-run/` (Gemini, 4 turns, compiled v3) |
| §3.2 | Typed, versioned, reviewable artifact | [x] | `evidence/capability.get-member-savings-balance.v3.json`, `packages/core/schema/capability.schema.json`, console capability detail |
| §3.3 | Deterministic replay with error taxonomy and result contract | [x] | chaos integration tests (6 modes), `evidence/replay-session-expiry/` (recovery), `evidence/replay-member-not-found/` (outcome), classifier fixture tests |
| §3.4 | Allowlist, risky-action handling, redaction | [ ] | |
| §3.5 | Structured log plus failure evidence | [x] | `events.jsonl`, screenshots and redacted snapshots in every evidence run; `failingScreenshot` and `lastObservation` on failures |
| §3.6 | Escalation, live-session handoff, hand-back, recorded human actions | [ ] | |
| §3.7 | Design for heterogeneity and multi-tenant | [ ] | docs only is acceptable |
| §4 | At least one real LLM discovery run with evidence | [x] | `evidence/discovery-run/` |
| §6.1 | `/README.md` | [ ] | |
| §6.2 | `/REPORT.md` seven headings | [ ] | |
| §6.3 | `/evidence/` | [ ] | |

## Open questions

- 2026-09-23 · `evidence/discovery-run/steps/*.png` show the member number typed into the search field (synthetic data). Screenshot masking lands in P5; regenerate the evidence run afterwards so the submission shows masked screenshots.

## Cuts made

Feeds REPORT §7. Record what was cut, when, why, and what would be built next.

| Date | Cut | Why | Next |
|---|---|---|---|
| 2026-09-21 | Remote co-browsing screencast | Brief scopes it out; headed handoff is real and cheaper ([D-012](08-decision-log.md#d-012--handoff-via-the-headed-browser-with-captured-human-actions-no-screencast)) | Session broker + CDP screencast |
| 2026-09-21 | Desktop surface implementation | Brief asks for design only | `desktop-a11y` surface over UI Automation |
| 2026-09-21 | Assisted fallback as built | Design is the interesting part ([D-008](08-decision-log.md#d-008--stretch-goals-variant-b-built-assisted-fallback-designed-built-if-time)) | Enable `RecoveryPlanner` behind policy |
