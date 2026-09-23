# 05 · Progress Tracker

Status: draft · Last updated: 2026-09-22

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
- [ ] One real run completed and copied to `evidence/discovery-run/` (needs a key for any supported provider, e.g. `GEMINI_API_KEY` on the free tier; command in the README)

### P3 · Compile and close the thread
- [x] Compile passes: prune, bind by provenance, targets with baseline, postconditions from deltas, outputs as extract steps, provenance, route canonicalisation (built in P2)
- [x] Versioning with `latest.json` (a new discovery of an existing id writes the next version with `supersedes`)
- [x] Compiled artifact replays with matching outputs (integration test: success 1250.75, outcome MEMBER_NOT_FOUND)
- [ ] Console skeleton lists runs and capabilities

### P4 · Conditions and the result contract
- [ ] Chaos modes: not-found, validation, session-expiry, interstitial
- [ ] Optional chaos modes: slow, error
- [ ] App profile detectors
- [ ] Classifier with precedence and budgets
- [ ] Recovery routines: dismiss, wait-retry, rebootstrap
- [ ] Full `ReplayResult` incl. `sideEffects`
- [ ] Fixture tests for the classifier
- [ ] `evidence/replay-member-not-found/`

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
| §3.1 | Goal-driven agent loop on a real UI | [ ] | |
| §3.2 | Typed, versioned, reviewable artifact | [ ] | |
| §3.3 | Deterministic replay with error taxonomy and result contract | [ ] | |
| §3.4 | Allowlist, risky-action handling, redaction | [ ] | |
| §3.5 | Structured log plus failure evidence | [ ] | |
| §3.6 | Escalation, live-session handoff, hand-back, recorded human actions | [ ] | |
| §3.7 | Design for heterogeneity and multi-tenant | [ ] | docs only is acceptable |
| §4 | At least one real LLM discovery run with evidence | [ ] | |
| §6.1 | `/README.md` | [ ] | |
| §6.2 | `/REPORT.md` seven headings | [ ] | |
| §6.3 | `/evidence/` | [ ] | |

## Open questions

- None yet. Add questions here with the date; move them to the decision log when answered.

## Cuts made

Feeds REPORT §7. Record what was cut, when, why, and what would be built next.

| Date | Cut | Why | Next |
|---|---|---|---|
| 2026-09-21 | Remote co-browsing screencast | Brief scopes it out; headed handoff is real and cheaper ([D-012](08-decision-log.md#d-012--handoff-via-the-headed-browser-with-captured-human-actions-no-screencast)) | Session broker + CDP screencast |
| 2026-09-21 | Desktop surface implementation | Brief asks for design only | `desktop-a11y` surface over UI Automation |
| 2026-09-21 | Assisted fallback as built | Design is the interesting part ([D-008](08-decision-log.md#d-008--stretch-goals-variant-b-built-assisted-fallback-designed-built-if-time)) | Enable `RecoveryPlanner` behind policy |
