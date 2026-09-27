# 06 · AI Workflow Rules

Status: stable · Last updated: 2026-09-26

How coding assistants (and the human, on a bad day) work in this repo. The root [`CLAUDE.md`](../../CLAUDE.md) repeats the non-negotiables and points here ([D-009](08-decision-log.md#d-009--ai-workflow-rules-root-claudemd-pointing-into-docscontext)).

## 1. Session start ritual

Read, in order: [README.md](README.md) → [00-project-overview.md](00-project-overview.md) → [01-architecture.md](01-architecture.md) → [05-progress-tracker.md](05-progress-tracker.md) (session log and the current phase). Then state, in one line, which phase and which checklist items this session targets.

Read in full: the tracker's session log and the current phase, and the architecture sections the phase touches (the tracker names them). Skim: the rest of 01 and 02, using their headings; the decision log's index table, opening an entry only when a change would touch it. The overview is read once per session for the flows and the traceability table, which is how a change is checked against the brief.

## 2. Sources of truth and precedence

Brief > decision log > architecture > tech stack and data model > code. If code disagrees with the docs, decide which is wrong, fix that one, and record a decision if the design changed.

In practice the disagreement is usually a doc that describes the design as first written and code that met reality (a native dialog blocking script evaluation, a frame renamed by a tenant). Then the code is right, the doc gets the correction and the decision log gets an entry saying what reality was. The other direction, code that quietly narrows a contract, is the one to refuse: the result statuses, the condition classes and the control-owner states are fixed by decisions and the code follows them.

## 3. When to decide and when to ask

Decide alone: anything the docs already cover, naming, test structure, file layout inside a package, error messages. Ask first: anything that changes a schema, a seam, a result status, a policy default, the roadmap order, or the deliverable paths. Asking means proposing a decision-log entry, not an open question.

When the user has already said "go ahead with the phase", the phase's work is authorised, including the schema additions it needs; those still get their decision entry, written before the code. What is never decided alone: producing a new real-model run that spends the user's quota beyond what the phase requires, deleting evidence, or committing.

## 4. Recording decisions

Before deviating from 01 or 02, add a `D-0NN` entry to [08-decision-log.md](08-decision-log.md) with alternatives and why. Mark the superseded decision. Then change the docs, then the code.

An entry has four fields: the decision, stated so a reader can tell whether a given piece of code obeys it; the alternatives that were actually on the table; why, in terms of the brief or of something observed; and the consequences, which is where schema fields, flags and evidence folders are named. Entries are never rewritten; a changed mind is a new entry that supersedes the old one. Thirty-eight entries exist; the index table at the top of the log is the map.

## 5. Progress tracker discipline

At the end of every session: add a session-log row, tick only exit-criterion-met boxes, move answered open questions to the decision log, add any cuts to "Cuts made".

A ticked box names its evidence (a folder under `/evidence/`, a test file, a count of tests), so the tracker doubles as the map a reviewer can follow. The brief-coverage table is updated in the same pass. Numbers in the session row (tests, rewrites, requests) are the ones measured that session, not remembered.

## 6. Evidence is immutable

Files under `/evidence/` are copied from `data/runs/` by `pnpm evidence:copy` and never edited afterwards. If evidence is wrong, produce a new run and replace the folder in one commit that says so.

This was exercised: every evidence folder was replaced once masking landed (P5), and the assisted-fallback run was replaced when a stale mock instance produced a run that did not drift. The rule also covers the index: no README is added inside `/evidence/`; the evidence table lives in the root README and the report.

## 7. Secrets and sensitive data

No secrets in the repo, in docs, in fixtures or in evidence. `.env` is git-ignored; `.env.example` has names only. Member ids and balances in fixtures are synthetic. Any file destined for `/evidence/` passes through the redactor.

Assistants never print `.env` values, never paste a key into a command line, and never echo a parameter value marked sensitive into a chat or a commit message. The check before every evidence commit is mechanical: a search for the synthetic member number across `/evidence/` must find nothing, since the redactor hashes it everywhere and the surface paints over it in screenshots.

## 8. Testing expectations

What must have tests: schemas (valid and invalid artifacts), the classifier (fixtures for every condition class and the precedence rules), the resolver (each strategy and the baseline comparison), the policy gate (allow, block, confirm, mismatch), the control-owner transitions. What need not: the console, the mock app's views.

As built: unit tests sit next to the code (`*.test.ts`, no browser, no key) and cover the schemas, the classifier over snapshots captured from the mock app under each chaos mode, the resolver, the compiler's anchor rules, the policy gate, the redactor, the control-owner machine, the checkpoint scan, the human-step conversion, the variant overrides, the recovery planner, the planner adapters, the console API and the mock app's routes. Integration tests under `apps/runner/test/` drive real headless Chromium against an in-process mock app for every exit criterion: replay, discovery to compile to replay, every chaos mode, the gate at both layers, masking, every escalation path including the live API, both tenants, and assisted fallback with a scripted planner. Every phase adds its own file there.

## 9. Commits and branches

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), scope is the package (`feat(core): …`). Work on `main` for this take-home; one commit per coherent change; the message says what and why. Commit messages end with the attribution line the tooling supplies.

One commit per phase has been the rhythm: the assistant proposes the message at the end of the session, the human commits. Commits that replace evidence say so in the body.

## 10. Prohibited shortcuts

- No scaling infrastructure: no queues, workers, databases, containers for the demo.
- No LLM call on the replay path outside `RecoveryPlanner` behind `policy.assistedFallback`.
- No parameter binding by value matching; provenance only ([D-013](08-decision-log.md#d-013--parameters-bound-by-provenance-not-by-value-matching)).
- No new locator strategy without a decision-log entry.
- No `any`, no `as unknown as`, no `@ts-ignore` without a comment naming the issue.
- No test ids, ids or semantic hooks added to the mock app to make automation easier.

Examples of each, from this build: a job queue for replays (cut; the CLI is the runner); a model call to pick a locator at replay outside the assisted fallback (refused; the resolver is a pure function); binding `memberId` because the typed text equalled the parameter value (refused for automation steps, allowed for a person's typed value only as an `inferred` binding, D-013); a fourth locator strategy for visual anchoring (documented as a seam, not built); a cast to reach a Playwright internal (replaced by racing the dialog event); a `data-testid` on the search button when the relabel chaos broke every strategy (refused; that breakage is the point of the assisted fallback).
