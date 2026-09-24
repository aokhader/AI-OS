# 03 · UI Context (Operator Console)

Status: draft · Last updated: 2026-09-23

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

Built in P3: `/runs`, `/runs/:id`, `/capabilities`, `/capabilities/:id` and `/capabilities/:id/v/:version` over the read API in `apps/runner/src/server/api.ts` (`/api/runs`, `/api/runs/:id`, `/api/run-files/:id/*`, `/api/capabilities`, `/api/capabilities/:id[/v/:version]`). The wire types are `RunListItem`, `RunDetail`, `CapabilityListItem` and `CapabilityDetail` in core, the only thing the console imports from the workspace. Run detail groups the event log by step and shows each observation's screenshot inline; capability detail lists every locator strategy of every step in resolution order. `/escalations` is a placeholder until P6.

TODO: wireframe-level description of the escalation screens.

## 3. Handoff interaction model

The sequence the operator experiences: notification → open escalation → read cause and screenshot → *Claim* → work in the headed browser → *Hand back* with resume / mark complete / abort. What the console shows while the human owns control (live human-action feed, disabled automation controls). What happens on timeout.

TODO

## 4. Real-time data flow

WebSocket event stream from the runner → TanStack Query cache invalidation per run id. Which events refresh which screens. Fallback to polling when the socket drops. No client-side state beyond the query cache and the route.

P3 uses polling only: the runs list refetches every 5 s and an unfinished run every 3 s. The socket arrives with escalations in P6.

TODO

## 5. Visual language

Minimal tokens: neutral background, one accent, and four status colours for `success`, `outcome`, `failure`, `escalated`/awaiting. Monospace for ids, codes and paths. Tables over cards for lists. Screenshots shown at natural size with a masked-region indicator.

TODO

## 6. Accessibility and keyboard

Every control reachable by keyboard; claim and hand-back are buttons with explicit labels; status conveyed by text as well as colour; screenshots have alt text stating step and time.

TODO

## 7. Out of scope

Operator authentication, multi-operator contention and leases, remote co-browsing, notifications outside the console, mobile layout beyond basic responsiveness.
