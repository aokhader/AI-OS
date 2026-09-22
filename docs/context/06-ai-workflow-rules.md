# 06 · AI Workflow Rules

Status: draft · Last updated: 2026-09-21

How coding assistants (and the human, on a bad day) work in this repo. Skeleton: headings are final, each section holds its intent and a `TODO` until written in full. The root [`CLAUDE.md`](../../CLAUDE.md) repeats the non-negotiables and points here ([D-009](08-decision-log.md#d-009--ai-workflow-rules-root-claudemd-pointing-into-docscontext)).

## 1. Session start ritual

Read, in order: [README.md](README.md) → [00-project-overview.md](00-project-overview.md) → [01-architecture.md](01-architecture.md) → [05-progress-tracker.md](05-progress-tracker.md) (session log and the current phase). Then state, in one line, which phase and which checklist items this session targets.

TODO: expand with what to skim versus read in full once the docs stabilise.

## 2. Sources of truth and precedence

Brief > decision log > architecture > tech stack and data model > code. If code disagrees with the docs, decide which is wrong, fix that one, and record a decision if the design changed.

TODO

## 3. When to decide and when to ask

Decide alone: anything the docs already cover, naming, test structure, file layout inside a package, error messages. Ask first: anything that changes a schema, a seam, a result status, a policy default, the roadmap order, or the deliverable paths. Asking means proposing a decision-log entry, not an open question.

TODO

## 4. Recording decisions

Before deviating from 01 or 02, add a `D-0NN` entry to [08-decision-log.md](08-decision-log.md) with alternatives and why. Mark the superseded decision. Then change the docs, then the code.

TODO

## 5. Progress tracker discipline

At the end of every session: add a session-log row, tick only exit-criterion-met boxes, move answered open questions to the decision log, add any cuts to "Cuts made".

TODO

## 6. Evidence is immutable

Files under `/evidence/` are copied from `data/runs/` by `pnpm evidence:copy` and never edited afterwards. If evidence is wrong, produce a new run and replace the folder in one commit that says so.

TODO

## 7. Secrets and sensitive data

No secrets in the repo, in docs, in fixtures or in evidence. `.env` is git-ignored; `.env.example` has names only. Member ids and balances in fixtures are synthetic. Any file destined for `/evidence/` passes through the redactor.

TODO

## 8. Testing expectations

What must have tests: schemas (valid and invalid artifacts), the classifier (fixtures for every condition class and the precedence rules), the resolver (each strategy and the baseline comparison), the policy gate (allow, block, confirm, mismatch), the control-owner transitions. What need not: the console, the mock app's views.

TODO

## 9. Commits and branches

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), scope is the package (`feat(core): …`). Work on `main` for this take-home; one commit per coherent change; the message says what and why. Commit messages end with the attribution line the tooling supplies.

TODO

## 10. Prohibited shortcuts

- No scaling infrastructure: no queues, workers, databases, containers for the demo.
- No LLM call on the replay path outside `RecoveryPlanner` behind `policy.assistedFallback`.
- No parameter binding by value matching; provenance only ([D-013](08-decision-log.md#d-013--parameters-bound-by-provenance-not-by-value-matching)).
- No new locator strategy without a decision-log entry.
- No `any`, no `as unknown as`, no `@ts-ignore` without a comment naming the issue.
- No test ids, ids or semantic hooks added to the mock app to make automation easier.

TODO: examples of each.
