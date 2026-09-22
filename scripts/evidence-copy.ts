/**
 * Copies a run folder into /evidence/<name>/ for the submission, plus the capability it compiled
 * (discovery) or replayed. Files under /evidence/ are never edited afterwards; re-run this with a
 * fresh run to replace a folder, and say so in the commit.
 *
 *   pnpm evidence:copy <runId> <name> [--force]
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const [runId, name, flag] = process.argv.slice(2);
if (!runId || !name) {
  console.error('usage: pnpm evidence:copy <runId> <name> [--force]');
  process.exit(2);
}
const force = flag === '--force';
const dataDir = process.env.HANDSOFF_DATA_DIR ?? './data';
const source = path.resolve(dataDir, 'runs', runId);
const target = path.resolve('evidence', name);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(path.join(source, 'result.json')))) {
  console.error(`${source} has no result.json; is the run finished?`);
  process.exit(2);
}
if (await exists(target)) {
  if (!force) {
    console.error(`${target} already exists; pass --force to replace it`);
    process.exit(2);
  }
  await rm(target, { recursive: true, force: true });
}
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(`copied ${source} → ${target}`);

const run = JSON.parse(await readFile(path.join(source, 'run.json'), 'utf8')) as {
  kind: string;
  capability?: { id: string; version: number };
};
const result = JSON.parse(await readFile(path.join(source, 'result.json'), 'utf8')) as {
  status: string;
  capability?: { id: string; version: number };
};
const ref = result.status === 'compiled' ? result.capability : run.capability;
if (ref) {
  const file = path.resolve(dataDir, 'capabilities', ref.id, `v${ref.version}.json`);
  if (await exists(file)) {
    const dest = path.resolve('evidence', `capability.${ref.id}.v${ref.version}.json`);
    await cp(file, dest);
    console.log(`copied ${file} → ${dest}`);
  }
}
