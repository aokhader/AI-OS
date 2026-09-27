# 03 · UI Context (Operator Console)

Status: draft · Last updated: 2026-09-26

Skeleton. The heading structure is final; each section says what belongs there and carries a `TODO` until it is written. The console is web-only ([D-005](08-decision-log.md#d-005--web-only-operator-console-vite--react-no-mobile)) and is context plus controls; the headed browser window is where the operator actually works ([D-012](08-decision-log.md#d-012--handoff-via-the-headed-browser-with-captured-human-actions-no-screencast)).

## 1. Purpose and personas

What the console is for (make escalations actionable, make runs and capabilities reviewable) and who uses it: operator, reviewer, developer. One paragraph per persona with their top task.

TODO

## 2. Information architecture

Routes and what each shows:

| Route | Screen | Primary content |
|---|---|---|
| `/runs` | Runs list | kind, capability or goal, status, started, duration, escalation badge |
| `/runs/:id` | Run detail | step timeline with before/after screenshots, events, result, recoveries, drift flags |
| `/escalations` | Inbox | open first; cause, capability, step, age, claim button |
| `/escalations/:id` | Escalation detail | intervention context, latest screenshot, claim / hand-back controls, human actions so far |
| `/capabilities` | Capabilities | id, name, latest version, status, last replay result |
| `/capabilities/:id` | Capability detail | inputs, outputs, steps with targets and risk, detectors, versions, approve toggle, replay form |

Built in P3: `/runs`, `/runs/:id`, `/capabilities`, `/capabilities/:id` and `/capabilities/:id/v/:version` over the read API in `apps/runner/src/server/api.ts` (`/api/runs`, `/api/runs/:id`, `/api/run-files/:id/*`, `/api/capabilities`, `/api/capabilities/:id[/v/:version]`). The wire types are `RunListItem`, `RunDetail`, `CapabilityListItem` and `CapabilityDetail` in core, the only thing the console imports from the workspace. Run detail groups the event log by step and shows each observation's screenshot inline; capability detail lists every locator strategy of every step in resolution order.

Built in P6: `/escalations` and `/escalations/:id` over `/api/escalations`, `/api/escalations/:id`, `POST /api/escalations/:id/claim`, `POST /api/escalations/:id/hand-back` and the socket at `/ws` (types `EscalationListItem`, `EscalationDetail`, `ClaimRequest`, `HandBackRequest`, `ConsoleMessage`). The inbox lists open escalations first with cause, run, capability or goal, step, status (`awaiting_operator`, `human` with the claimer, or the resolution) and age; the navigation shows the open count. The detail screen has two columns: on the left why automation stopped (cause, detail, step and intent, what the run is doing, timestamps), the controls, and the human-action feed; on the right the latest masked screenshot. Controls depend on state: an unresolved escalation that is live in the serving process shows an operator id field, *Claim and work in the browser*, and one button per suggested hand-back with a one-line explanation of each; after the claim the field locks and a notice says the person has control; a resolved escalation links to the run; an escalation from another process says which command to start so it becomes live. The runs list shows `awaiting_operator` or `human` as the status of a live run.

## 3. Handoff interaction model

The sequence the operator experiences: the open count in the navigation changes → open the escalation → read the cause, the step and the screenshot → *Claim and work in the browser* → act in the headed window, watching each action appear in the feed → hand back with *Approve step* (automation runs the step it asked about), *Resume automation* (automation runs the checkpoint scan and continues from wherever the page is), *Mark complete* (automation verifies the success condition and reads the outputs from the page) or *Abort*. Nothing in the console drives the browser: it is context plus controls, and the window is the work surface ([D-012](08-decision-log.md#d-012--handoff-via-the-headed-browser-with-captured-human-actions-no-screencast)). While the person has control, automation cannot act (the engine refuses `act` unless the owner is `automation`), and every click, change and Enter-key submit is recorded as a step. If nobody claims within `escalationTimeoutMs` the run ends with `ESCALATION_ABANDONED` and the escalation shows `abandoned`; the timer stops at the claim. The terminal operator (`--operator tty`) offers the same choices as text prompts.

## 4. Real-time data flow

WebSocket event stream from the runner → TanStack Query cache invalidation per run id. Which events refresh which screens. Fallback to polling when the socket drops. No client-side state beyond the query cache and the route.

The runner pushes `ConsoleMessage`s over `/ws`: `escalation` (raised, claimed or resolved), `human_action` (one recorded step) and `run` (a run changed). The console invalidates the matching TanStack queries on each message and keeps polling as the fallback (runs 5 s, an unfinished run 3 s, escalations 3 s, an open escalation 2 s), so a dropped socket makes it slower, never stale; the socket reconnects after 3 s. The socket is only fed by the process that owns the browser (`--operator console`); under `handsoff serve` it stays silent and polling does the work.

## 5. Visual language

Minimal tokens: neutral background, one accent, and four status colours for `success`, `outcome`, `failure`, `escalated`/awaiting. Monospace for ids, codes and paths. Tables over cards for lists. Screenshots shown at natural size with a masked-region indicator.

TODO

## 6. Accessibility and keyboard

Every control reachable by keyboard; claim and hand-back are buttons with explicit labels; status conveyed by text as well as colour; screenshots have alt text stating step and time.

TODO

## 7. Out of scope

Operator authentication, multi-operator contention and leases, remote co-browsing, notifications outside the console, mobile layout beyond basic responsiveness.
