# 05 · Progress Tracker

Status: draft · Last updated: 2026-09-21

Updated at the end of every working session. Phases mirror [04-roadmap.md](04-roadmap.md). Check a box only when the phase's exit criterion is demonstrably met, not when the code exists.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` cut (say why in "Cuts made")

## Session log

| Date | Session | What landed | Next |
|---|---|---|---|
| 2026-09-21 | 1 | `docs/context/` created: overview, architecture, tech stack and data model, decision log; skeletons for UI, roadmap, tracker, AI rules, code standards; root `CLAUDE.md` | P0: workspace scaffold, mock app happy path, core schemas |

## Phases

### P0 · Foundations
- [x] `docs/context/` written (this session)
- [ ] pnpm workspace with six packages stubbed and building
- [ ] Biome, vitest, base tsconfig
- [ ] `legacy-bank` variant A happy path with framesets and tables
- [ ] zod schemas: `Condition`, `TargetSpec`, `Capability`, `ReplayResult`, `AppProfile`, `Policy`
- [ ] Example artifact validates against `CapabilitySchema`

### P1 · Surface and hand-written replay
- [ ] `observe()` with refs, frame paths, screenshot, dialogs, digest
- [ ] `act()` for all action kinds
- [ ] `resolve()` with `role`, `anchored`, `structural`; reports `resolvedBy`, `candidateCount`
- [ ] Filesystem `Store`
- [ ] Replay engine skeleton with postcondition waits
- [ ] Event log and screenshots
- [ ] Hand-written `get-member-savings-balance` replays to `success`

### P2 · Discovery
- [ ] Planner with strict tools and `{ param }` values
- [ ] Discovery loop, stop conditions, stuck detector
- [ ] Redaction in observation and transcript
- [ ] `ScriptedPlanner` and a fixture-driven discovery test
- [ ] One real run completed and copied to `evidence/discovery-run/`

### P3 · Compile and close the thread
- [ ] Compile passes: prune, bind, targets with baseline, postconditions, outputs, provenance, route canonicalisation
- [ ] Versioning with `latest.json`
- [ ] Compiled artifact replays with matching outputs
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
- [ ] Variant B on `:4101`
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
