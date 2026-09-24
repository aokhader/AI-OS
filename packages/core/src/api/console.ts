import type { Capability, DiscoveryResult, ReplayResult, Run, RunEvent } from '../schema/index.js';

/**
 * The console's read API, served by the runner (`handsoff serve`, P3). Types only: the console
 * imports these from core and nothing else from the runtime (01 §3), so the wire shape is pinned
 * here rather than in the runner.
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
