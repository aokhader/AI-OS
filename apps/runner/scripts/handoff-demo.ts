/**
 * The handoff, end to end, with a stand-in for the person at the headed window (D-036):
 *
 *   1. replays `open-sub-account` (approved; its submit needs an operator) with the console
 *      operator, so the escalation is served by the live API on HANDSOFF_PORT;
 *   2. claims it over the real HTTP API, as the console would;
 *   3. performs the risky click on the live page with Playwright, standing in for a hand in the
 *      browser window (the DOM sees exactly what a person's click does);
 *   4. waits until the API lists the recorded human action, then hands back `resume` over HTTP;
 *   5. prints the run id so `pnpm evidence:copy <runId> replay-escalation-handoff` can keep it.
 *
 * To do the same by hand: `pnpm handsoff replay --capability open-sub-account --param
 * memberId=10001 --param accountType=Checking --param deposit=40.00 --operator console`, open the
 * console, claim the escalation, click Open Account in the browser window, then Resume.
 *
 *   pnpm demo:handoff          (from the repository root; runs against ./data and .env)
 */
import {
  createFsStore,
  type EscalationDetail,
  type EscalationListItem,
  replay,
} from '@handsoff/core';
import { createPlaywrightSurface } from '@handsoff/surface-playwright';
import { loadPolicy } from '../src/commands/policy.js';
import { loadEnv } from '../src/commands/replay.js';
import { createApi } from '../src/server/api.js';
import { createConsoleOperator, LiveRegistry } from '../src/server/live.js';

loadEnv();
const env = process.env;
const dataDir = env.HANDSOFF_DATA_DIR ?? './data';
const baseUrl = env.HANDSOFF_TARGET_URL ?? 'http://localhost:4100';
const port = Number.parseInt(env.HANDSOFF_PORT ?? '4000', 10);
const policy = loadPolicy(env);
if (!policy) throw new Error('config/policy.json is required');
const operatorId = env.HANDSOFF_DEMO_OPERATOR ?? 'demo-operator';
const params = { memberId: '10001', accountType: 'Checking', deposit: '40.00' };

const store = createFsStore(dataDir);
const capability = await store.capabilities.get('open-sub-account');
const profile = await store.appProfiles.get('acme-coreteller');
if (!capability || !profile) throw new Error('open-sub-account or the app profile is missing');
if (capability.status !== 'approved') {
  throw new Error(
    'approve open-sub-account first: pnpm handsoff approve --capability open-sub-account',
  );
}

const registry = new LiveRegistry();
const api = await createApi({ dataDir, live: registry });
await api.listen({ port, host: '127.0.0.1' });
const base = `http://127.0.0.1:${port}`;
console.error(`live console API on ${base}`);

const surface = await createPlaywrightSurface({
  headless: env.HANDSOFF_HEADLESS !== 'false',
  allowedOrigins: policy.allowedOrigins,
});
const log = (line: string) => console.error(`  ${line}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  if (!res.ok)
    throw new Error(`${init?.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const post = (url: string, body: unknown) =>
  json<{ escalation: EscalationDetail['escalation'] }>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The person: waits for the inbox, claims, clicks the button in the window, resumes. */
const person = (async () => {
  let open: EscalationListItem | undefined;
  while (!open) {
    await sleep(250);
    const list = await json<EscalationListItem[]>(`${base}/api/escalations`);
    open = list.find((e) => e.open && e.live);
  }
  const id = open.escalation.id;
  log(`person: sees ${id} (${open.escalation.cause} at ${open.escalation.atStep}) in the inbox`);
  await post(`${base}/api/escalations/${id}/claim`, { operatorId });
  log('person: claimed; clicking "Open Account" in the browser window');
  const frame = surface.page.frame({ name: 'main' });
  if (!frame) throw new Error('main frame missing');
  await frame.getByRole('button', { name: 'Open Account' }).click();
  for (let i = 0; i < 100; i++) {
    const detail = await json<EscalationDetail>(`${base}/api/escalations/${id}`);
    if (detail.humanActions.length > 0) {
      log(
        `person: the console shows "${detail.humanActions[0]?.intent}"; handing back with resume`,
      );
      break;
    }
    await sleep(200);
  }
  await post(`${base}/api/escalations/${id}/hand-back`, { operatorId, kind: 'resume' });
})();

try {
  const result = await replay(
    { capability, params, baseUrl, policy },
    { surface, store, profile, env, operator: createConsoleOperator(registry), log },
  );
  await person;
  console.error(
    `${result.status}${result.status === 'success' ? ` · outputs ${JSON.stringify(result.outputs)}` : ''} · side effects ${result.sideEffects} · escalation ${result.escalation?.resolution ?? 'none'} with ${result.escalation?.humanActions.length ?? 0} human action(s)`,
  );
  console.error(`evidence: ${result.evidence.runDir}`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'success' ? 0 : 1;
} finally {
  await surface.close();
  await api.close();
}
