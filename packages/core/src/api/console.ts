import type {
  Capability,
  DiscoveryResult,
  Escalation,
  HandBackKind,
  RecordedStep,
  ReplayResult,
  Run,
  RunEvent,
} from '../schema/index.js';

/**
 * The console's API, served by the runner (`handsoff serve` read-only; `--operator console` live,
 * P6). Types only: the console imports these from core and nothing else from the runtime (01 §3),
 * so the wire shape is pinned here rather than in the runner.
 */
export interface RunSummary {
  status: string;
  /** Business outcome code (`outcome`). */
  code?: string | undefined;
  /** Failure kind (`failure`). */
  kind?: string | undefined;
  atStep?: string | undefined;
  /** Why a discovery stopped without compiling. */
  reason?: string | undefined;
  /** The capability a discovery compiled. */
  capability?: { id: string; version: number } | undefined;
}

export interface RunListItem {
  run: Run;
  summary: RunSummary | null;
}

export interface RunDetail {
  run: Run;
  events: RunEvent[];
  result: ReplayResult | DiscoveryResult | null;
}

export interface CapabilityListItem {
  id: string;
  version: number;
  name: string;
  status: Capability['status'];
  stepCount: number;
  recordedAt: string;
  provider?: string | undefined;
  model: string;
}

export interface CapabilityDetail {
  capability: Capability;
  /** Every version on disk, ascending. */
  versions: number[];
}

/** An escalation as the inbox lists it: `live` when this process can act on it. */
export interface EscalationListItem {
  escalation: Escalation;
  open: boolean;
  live: boolean;
}

export interface EscalationDetail {
  escalation: Escalation;
  /** Human actions recorded so far, redacted; from the live controls or from the run's events. */
  humanActions: RecordedStep[];
  open: boolean;
  live: boolean;
}

export interface ClaimRequest {
  operatorId: string;
}

export interface HandBackRequest {
  operatorId: string;
  kind: HandBackKind;
}

/** Pushed over `/ws` by the runner; the console invalidates the matching queries (03 §4). */
export type ConsoleMessage =
  | { type: 'escalation'; escalation: Escalation }
  | { type: 'human_action'; escalationId: string; runId: string; step: RecordedStep }
  | { type: 'run'; runId: string };
