import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityDetail, CapabilityListItem, RunDetail, RunListItem } from '@handsoff/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const runId = 'run_20260923_010203_abcd';

describe('console API', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'handsoff-api-'));
    await cp(
      path.join(repoRoot, 'data/capabilities/get-member-savings-balance/v1.json'),
      path.join(dataDir, 'capabilities/get-member-savings-balance/v1.json'),
    );
    await writeFile(
      path.join(dataDir, 'capabilities/get-member-savings-balance/latest.json'),
      JSON.stringify({ version: 1 }),
    );
    const runDir = path.join(dataDir, 'runs', runId);
    await mkdir(path.join(runDir, 'steps'), { recursive: true });
    await writeFile(
      path.join(runDir, 'run.json'),
      JSON.stringify({
        id: runId,
        kind: 'replay',
        capability: { id: 'get-member-savings-balance', version: 1 },
        target: { vendorProductId: 'acme-coreteller', entry: 'http://localhost:4100/' },
        startedAt: '2026-09-23T01:02:03.000Z',
        finishedAt: '2026-09-23T01:02:06.000Z',
        controlOwner: 'automation',
        sideEffects: 'none',
      }),
    );
    await writeFile(
      path.join(runDir, 'result.json'),
      JSON.stringify({
        status: 'outcome',
        code: 'MEMBER_NOT_FOUND',
        message: 'No matching member',
        atStep: 's2',
        stepsRun: [],
        recoveries: [],
        sideEffects: 'none',
        evidence: { runDir },
      }),
    );
    await writeFile(path.join(runDir, 'steps/001-s1-before.png'), Buffer.from([137, 80, 78, 71]));
    app = await createApi({ dataDir, consoleDist: path.join(dataDir, 'no-console') });
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lists runs newest first with a result summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const items = res.json<RunListItem[]>();
    expect(items).toHaveLength(1);
    expect(items[0]?.run.id).toBe(runId);
    expect(items[0]?.summary).toEqual({
      status: 'outcome',
      code: 'MEMBER_NOT_FOUND',
      atStep: 's2',
    });
  });

  it('returns a run with its events and result, and serves its files', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    const detail = res.json<RunDetail>();
    expect(detail.run.kind).toBe('replay');
    expect(detail.events).toEqual([]);
    expect(detail.result?.status).toBe('outcome');

    const png = await app.inject({
      method: 'GET',
      url: `/api/run-files/${runId}/steps/001-s1-before.png`,
    });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
  });

  it('rejects malformed ids before touching the filesystem', async () => {
    expect((await app.inject({ url: '/api/runs/..%2F..%2Fetc' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/runs/run_20260923_010203_ffff' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/capabilities/Not%20Valid' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/capabilities/nope' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/run-files/../../package.json' })).statusCode).not.toBe(
      200,
    );
  });

  it('lists capabilities and returns one with its versions', async () => {
    const list = (await app.inject({ url: '/api/capabilities' })).json<CapabilityListItem[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'get-member-savings-balance',
      version: 1,
      status: 'draft',
      stepCount: 4,
    });

    const detail = (
      await app.inject({ url: '/api/capabilities/get-member-savings-balance' })
    ).json<CapabilityDetail>();
    expect(detail.capability.version).toBe(1);
    expect(detail.versions).toEqual([1]);
    const v1 = await app.inject({ url: '/api/capabilities/get-member-savings-balance/v/1' });
    expect(v1.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/capabilities/get-member-savings-balance/v/9' })).statusCode,
    ).toBe(404);
  });

  it('answers non-API paths with a hint when the console is not built', async () => {
    const res = await app.inject({ url: '/runs' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('console is not built');
    expect((await app.inject({ url: '/api/nothing' })).json()).toEqual({ error: 'not found' });
  });
});
