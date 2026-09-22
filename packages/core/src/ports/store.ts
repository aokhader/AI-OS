import type {
  AppProfile,
  Capability,
  CapabilityRef,
  DiscoveryResult,
  Escalation,
  ReplayResult,
  Run,
  RunEvent,
} from '../schema/index.js';

export interface RunHandle {
  readonly id: string;
  /** Absolute path of the run folder. */
  readonly dir: string;
  appendEvent(event: RunEvent): Promise<void>;
  /** Writes a PNG under the run folder; returns the path relative to the run folder. */
  putScreenshot(name: string, png: Uint8Array): Promise<string>;
  /** Writes a JSON document under the run folder; returns the path relative to the run folder. */
  putJson(name: string, value: unknown): Promise<string>;
  /** Writes a text file under the run folder; returns the path relative to the run folder. */
  putText(name: string, text: string): Promise<string>;
  update(patch: Partial<Run>): Promise<void>;
  finish(result: ReplayResult | DiscoveryResult): Promise<void>;
}

export interface Store {
  capabilities: {
    get(id: string, version?: number): Promise<Capability | undefined>;
    put(capability: Capability): Promise<void>;
    list(): Promise<CapabilityRef[]>;
    latestVersion(id: string): Promise<number | undefined>;
  };
  appProfiles: {
    get(vendorProductId: string): Promise<AppProfile | undefined>;
    list(): Promise<string[]>;
  };
  runs: {
    create(run: Run): Promise<RunHandle>;
    open(id: string): Promise<RunHandle | undefined>;
    get(id: string): Promise<Run | undefined>;
    list(): Promise<Run[]>;
    events(id: string): Promise<RunEvent[]>;
    result(id: string): Promise<ReplayResult | DiscoveryResult | undefined>;
  };
  escalations: {
    put(escalation: Escalation): Promise<void>;
    get(id: string): Promise<Escalation | undefined>;
    list(): Promise<Escalation[]>;
  };
}
