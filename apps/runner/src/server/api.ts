import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  type CapabilityDetail,
  type CapabilityListItem,
  createFsStore,
  type DiscoveryResult,
  KebabIdSchema,
  type ReplayResult,
  type RunDetail,
  RunIdSchema,
  type RunListItem,
  type RunSummary,
} from '@handsoff/core';
import Fastify, { type FastifyInstance } from 'fastify';

export interface ApiOptions {
  dataDir: string;
  /** Built console to serve at `/`; skipped when the folder does not exist. */
  consoleDist?: string | undefined;
  logger?: boolean | undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function summarize(result: ReplayResult | DiscoveryResult | undefined): RunSummary | null {
  if (!result) return null;
  const summary: RunSummary = { status: result.status };
  if ('code' in result) summary.code = result.code;
  if ('kind' in result) summary.kind = result.kind;
  if ('atStep' in result && result.atStep) summary.atStep = result.atStep;
  if ('reason' in result) summary.reason = result.reason;
  if ('capability' in result && result.capability) summary.capability = result.capability;
  return summary;
}

async function listVersions(dataDir: string, id: string): Promise<number[]> {
  try {
    const files = await readdir(path.join(dataDir, 'capabilities', id));
    return files
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .map((v) => Number.parseInt(v, 10))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * The read API behind the operator console (01 §2, 03 §2): runs, their events and files, and
 * capabilities with their versions. Everything is read from the filesystem store on each request;
 * there is no cache to invalidate. Ids are validated before they touch a path.
 */
export async function createApi(options: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const store = createFsStore(options.dataDir);
  const runsRoot = path.resolve(options.dataDir, 'runs');

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/runs', async (): Promise<RunListItem[]> => {
    const runs = await store.runs.list();
    const items = await Promise.all(
      runs.map(async (run) => ({ run, summary: summarize(await store.runs.result(run.id)) })),
    );
    return items.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const id = RunIdSchema.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid run id' });
    const run = await store.runs.get(id.data);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const [events, result] = await Promise.all([
      store.runs.events(run.id),
      store.runs.result(run.id),
    ]);
    const detail: RunDetail = { run, events, result: result ?? null };
    return detail;
  });

  // Screenshots and snapshots: /api/run-files/<runId>/steps/001-s1-before.png
  await app.register(fastifyStatic, {
    root: runsRoot,
    prefix: '/api/run-files/',
    decorateReply: false,
    index: false,
    list: false,
  });

  app.get('/api/capabilities', async (): Promise<CapabilityListItem[]> => {
    const refs = await store.capabilities.list();
    const items: CapabilityListItem[] = [];
    for (const ref of refs) {
      const c = await store.capabilities.get(ref.id, ref.version);
      if (!c) continue;
      items.push({
        id: c.id,
        version: c.version,
        name: c.name,
        status: c.status,
        stepCount: c.steps.length,
        recordedAt: c.provenance.recordedAt,
        provider: c.provenance.provider,
        model: c.provenance.model,
      });
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
  });

  const capabilityRoute = async (
    idRaw: string,
    versionRaw: string | undefined,
  ): Promise<CapabilityDetail | { code: 400 | 404; error: string }> => {
    const id = KebabIdSchema.safeParse(idRaw);
    if (!id.success) return { code: 400, error: 'invalid capability id' };
    let version: number | undefined;
    if (versionRaw !== undefined) {
      version = Number.parseInt(versionRaw, 10);
      if (!Number.isInteger(version) || version < 1) return { code: 400, error: 'invalid version' };
    }
    const capability = await store.capabilities.get(id.data, version);
    if (!capability) return { code: 404, error: 'capability not found' };
    return { capability, versions: await listVersions(options.dataDir, id.data) };
  };

  app.get<{ Params: { id: string } }>('/api/capabilities/:id', async (req, reply) => {
    const r = await capabilityRoute(req.params.id, undefined);
    return 'code' in r ? reply.code(r.code).send({ error: r.error }) : r;
  });

  app.get<{ Params: { id: string; version: string } }>(
    '/api/capabilities/:id/v/:version',
    async (req, reply) => {
      const r = await capabilityRoute(req.params.id, req.params.version);
      return 'code' in r ? reply.code(r.code).send({ error: r.error }) : r;
    },
  );

  const dist = options.consoleDist;
  if (dist && (await exists(path.join(dist, 'index.html')))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: true });
    // Client-side routes (/runs/:id …) fall through to the SPA shell; API misses stay JSON.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply
        .code(404)
        .type('text/plain')
        .send(
          'HandsOff API is up. The console is not built: run `pnpm --filter @handsoff/operator-console dev` for the dev server, or `build` to serve it from here.',
        );
    });
  }

  return app;
}
