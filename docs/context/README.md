# HandsOff — Project Context

Status: stable · Last updated: 2026-09-21

This folder is the shared source of truth for the HandsOff build. Read it at the start of every working session, human or AI, before touching code. The assessment brief it answers lives at [../description.md](../description.md); the original PDF sits alongside it.

**HandsOff in one line:** an LLM figures out how to complete a goal in a legacy banking UI once, the run is compiled into a typed, versioned capability, and from then on the capability replays deterministically with no model in the loop, explicit error handling, safety guardrails, and a human escalation path that hands over the live session.

## Reading order

| # | Doc | Read when | Status |
|---|---|---|---|
| 1 | [00-project-overview.md](00-project-overview.md) | Always. What we are building, for whom, the flows, and how the brief will grade it. | full |
| 2 | [01-architecture.md](01-architecture.md) | Always. Components, seams, engines, contracts. The load-bearing doc. | full |
| 3 | [02-tech-stack-and-data-model.md](02-tech-stack-and-data-model.md) | Before writing code or schemas. | full |
| 4 | [08-decision-log.md](08-decision-log.md) | Before proposing a change to anything in 01 or 02. | full |
| 5 | [05-progress-tracker.md](05-progress-tracker.md) | Start and end of every session. | skeleton |
| 6 | [04-roadmap.md](04-roadmap.md) | When planning a session's work. | skeleton |
| 7 | [06-ai-workflow-rules.md](06-ai-workflow-rules.md) | Once, then whenever unsure how to proceed. | skeleton |
| 8 | [07-code-standards.md](07-code-standards.md) | Before writing code. | skeleton |
| 9 | [03-ui-context.md](03-ui-context.md) | Before touching the operator console. | skeleton |

## Precedence when documents disagree

1. The brief ([../description.md](../description.md)). It defines requirements, deliverable paths and grading.
2. [08-decision-log.md](08-decision-log.md). Accepted decisions win over prose elsewhere.
3. [01-architecture.md](01-architecture.md).
4. [02-tech-stack-and-data-model.md](02-tech-stack-and-data-model.md).
5. Code comments and README files inside packages.

If code disagrees with the docs, the docs are wrong or the code is wrong. Decide which, then fix that one and record the decision if it changes design.

## Conventions used in these docs

- Each doc starts with `Status` (`draft` or `stable`) and `Last updated`.
- The brief is cited by section number, for example "brief §3.3".
- Schemas are TypeScript in fenced blocks. Diagrams are Mermaid.
- Non-obvious choices carry a one-line "why" and, where relevant, "at real scale".
- Skeleton docs keep their full heading structure with `TODO` markers under each heading.

## How to update

- Small correction: edit in place and bump `Last updated`.
- Anything that contradicts 01 or 02: add an entry to [08-decision-log.md](08-decision-log.md) first, mark the superseded decision, then edit the docs.
- Turning a skeleton into a full doc: replace every `TODO`, then change its status in the table above.
- Never change files under `/evidence/` to match the docs. Evidence is immutable; fix the docs instead.
