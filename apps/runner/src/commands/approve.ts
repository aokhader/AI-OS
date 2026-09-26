import { createFsStore } from '@handsoff/core';

export interface ApproveCommandOptions {
  capability: string;
  version?: string | undefined;
  dataDir?: string | undefined;
}

/**
 * The reviewer's step (00 flow D): marks a capability version `approved`, which is what lets its
 * risky steps replay unattended when their `confirm` is `none` (01 §12). Steps with
 * `confirm: operator` still ask, approved or not.
 */
export async function runApproveCommand(opts: ApproveCommandOptions): Promise<number> {
  const dataDir = opts.dataDir ?? process.env.HANDSOFF_DATA_DIR ?? './data';
  const store = createFsStore(dataDir);
  const version = opts.version ? Number.parseInt(opts.version, 10) : undefined;
  const capability = await store.capabilities.get(opts.capability, version);
  if (!capability) {
    console.error(
      `capability ${opts.capability}${version ? ` v${version}` : ''} not found under ${dataDir}/capabilities`,
    );
    return 2;
  }
  if (capability.status === 'approved') {
    console.error(`${capability.id} v${capability.version} is already approved`);
    return 0;
  }
  if (capability.status === 'retired') {
    console.error(
      `${capability.id} v${capability.version} is retired; discover a new version instead`,
    );
    return 2;
  }
  await store.capabilities.put({ ...capability, status: 'approved' });
  const risky = capability.steps.filter((s) => s.risk === 'risky');
  console.error(
    `${capability.id} v${capability.version} approved · ${risky.length} risky step(s)${
      risky.length > 0 ? `: ${risky.map((s) => `${s.id} (confirm ${s.confirm})`).join(', ')}` : ''
    }`,
  );
  return 0;
}
