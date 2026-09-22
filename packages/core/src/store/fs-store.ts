import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunHandle, Store } from '../ports/store.js';
import {
  AppProfileSchema,
  type Capability,
  type CapabilityRef,
  CapabilitySchema,
  type DiscoveryResult,
  type Escalation,
  EscalationSchema,
  type ReplayResult,
  type Run,
  type RunEvent,
  RunEventSchema,
  RunSchema,
} from '../schema/index.js';

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Filesystem store (D-006). Layout in docs/context/02-tech-stack-and-data-model.md.
 * Everything read from disk is validated with its zod schema so a bad file fails loudly.
 */
export function createFsStore(rootDir: string): Store {
  const root = path.resolve(rootDir);
  const capDir = (id: string) => path.join(root, 'capabilities', id);
  const runDir = (id: string) => path.join(root, 'runs', id);

  function runHandle(id: string): RunHandle {
    const dir = runDir(id);
    return {
      id,
      dir,
      async appendEvent(event) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, {
          flag: 'a',
        });
      },
      async putScreenshot(name, png) {
        const file = path.join(dir, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, png);
        return toPosix(name);
      },
      async putJson(name, value) {
        await writeJson(path.join(dir, name), value);
        return toPosix(name);
      },
      async putText(name, text) {
        const file = path.join(dir, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text);
        return toPosix(name);
      },
      async update(patch) {
        const current = RunSchema.parse(await readJson(path.join(dir, 'run.json')));
        await writeJson(path.join(dir, 'run.json'), { ...current, ...patch });
      },
      async finish(result) {
        await writeJson(path.join(dir, 'result.json'), result);
      },
    };
  }

  return {
    capabilities: {
      async get(id, version) {
        const v = version ?? (await this.latestVersion(id));
        if (v === undefined) return undefined;
        const raw = await readJson(path.join(capDir(id), `v${v}.json`));
        return raw === undefined ? undefined : CapabilitySchema.parse(raw);
      },
      async put(capability: Capability) {
        const dir = capDir(capability.id);
        await writeJson(path.join(dir, `v${capability.version}.json`), capability);
        const latest = (await this.latestVersion(capability.id)) ?? 0;
        if (capability.version >= latest) {
          await writeJson(path.join(dir, 'latest.json'), { version: capability.version });
        }
      },
      async list() {
        const refs: CapabilityRef[] = [];
        for (const id of await listDirs(path.join(root, 'capabilities'))) {
          const v = await this.latestVersion(id);
          if (v !== undefined) refs.push({ id, version: v });
        }
        return refs;
      },
      async latestVersion(id) {
        const raw = (await readJson(path.join(capDir(id), 'latest.json'))) as
          | { version?: number }
          | undefined;
        return typeof raw?.version === 'number' ? raw.version : undefined;
      },
    },
    appProfiles: {
      async get(vendorProductId) {
        const raw = await readJson(path.join(root, 'app-profiles', `${vendorProductId}.json`));
        return raw === undefined ? undefined : AppProfileSchema.parse(raw);
      },
      async list() {
        try {
          const files = await readdir(path.join(root, 'app-profiles'));
          return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw err;
        }
      },
    },
    runs: {
      async create(run) {
        const handle = runHandle(run.id);
        await mkdir(handle.dir, { recursive: true });
        await writeJson(path.join(handle.dir, 'run.json'), run);
        return handle;
      },
      async open(id) {
        const raw = await readJson(path.join(runDir(id), 'run.json'));
        return raw === undefined ? undefined : runHandle(id);
      },
      async get(id) {
        const raw = await readJson(path.join(runDir(id), 'run.json'));
        return raw === undefined ? undefined : RunSchema.parse(raw);
      },
      async list() {
        const runs: Run[] = [];
        for (const id of (await listDirs(path.join(root, 'runs'))).sort()) {
          const run = await this.get(id);
          if (run) runs.push(run);
        }
        return runs;
      },
      async events(id) {
        try {
          const text = await readFile(path.join(runDir(id), 'events.jsonl'), 'utf8');
          return text
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => RunEventSchema.parse(JSON.parse(line)) as RunEvent);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw err;
        }
      },
      async result(id) {
        return (await readJson(path.join(runDir(id), 'result.json'))) as
          | ReplayResult
          | DiscoveryResult
          | undefined;
      },
    },
    escalations: {
      async put(escalation: Escalation) {
        await writeJson(path.join(root, 'escalations', `${escalation.id}.json`), escalation);
      },
      async get(id) {
        const raw = await readJson(path.join(root, 'escalations', `${id}.json`));
        return raw === undefined ? undefined : EscalationSchema.parse(raw);
      },
      async list() {
        try {
          const files = await readdir(path.join(root, 'escalations'));
          const out: Escalation[] = [];
          for (const f of files.filter((f) => f.endsWith('.json')).sort()) {
            const e = await this.get(f.slice(0, -5));
            if (e) out.push(e);
          }
          return out;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw err;
        }
      },
    },
  };
}
