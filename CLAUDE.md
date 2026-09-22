# HandsOff

Computer-use automation for legacy banking software: an LLM discovers how to complete a goal in a UI once, the run is compiled into a typed, replayable capability, and replay runs deterministically with error handling, guardrails and human escalation. This is a take-home assessment for interface.ai; the brief is `docs/description.md`.

## Read first

`docs/context/README.md`, then follow its reading order. Do not start coding without it. At session start, state which roadmap phase and tracker items you are working on.

## Non-negotiables

1. **No secrets or real data in the repo.** `.env` is git-ignored. Fixtures and evidence use synthetic data and pass through the redactor.
2. **No LLM on the replay path** except `RecoveryPlanner` behind `policy.assistedFallback`. `packages/core` must not import Playwright or the Anthropic SDK.
3. **Never edit `/evidence/`.** Replace a folder with a fresh run if it is wrong, in a commit that says so.
4. **Record before deviating.** Any change to a schema, seam, result status, policy default or roadmap order gets a `D-0NN` entry in `docs/context/08-decision-log.md` first.
5. **Keep the brief's deliverable paths and headings exactly:** `/README.md`, `/REPORT.md` with its seven headings in order, `/evidence/`.
6. **Update the tracker** (`docs/context/05-progress-tracker.md`) at the end of every session.

## Where things are

- Architecture and seams: `docs/context/01-architecture.md`
- Schemas, stack, env vars, example artifact: `docs/context/02-tech-stack-and-data-model.md`
- Working rules and prohibited shortcuts: `docs/context/06-ai-workflow-rules.md`
- Code standards: `docs/context/07-code-standards.md`
- Phases and exit criteria: `docs/context/04-roadmap.md`

## Conventions in brief

TypeScript strict, ESM, pnpm workspaces, zod at every boundary, errors as data across seams, Biome, vitest, conventional commits scoped by package.
