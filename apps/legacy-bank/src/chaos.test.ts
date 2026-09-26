import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from './config.js';
import { createApp } from './server.js';
import { variants } from './variants.js';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    variant: variants.a,
    user: 'teller',
    pass: 'pw',
    sessionTtlMs: 60_000,
    cookieSecret: 'test-secret',
    allowChaosHeader: true,
    ...overrides,
  };
}

async function signedIn(app: ReturnType<typeof createApp>, chaos?: string) {
  const agent = request.agent(app);
  if (chaos) agent.set('x-handsoff-chaos', chaos);
  await agent.post('/login').type('form').send({ uid: 'teller', pwd: 'pw' }).expect(302);
  return agent;
}

const search = (agent: ReturnType<typeof request.agent>, mno = '10001') =>
  agent.post('/members/search').type('form').send({ mno });

describe('legacy-bank chaos injection (D-024)', () => {
  it('ignores the header unless the server is configured to honour it', async () => {
    const agent = await signedIn(createApp(config({ allowChaosHeader: false })), 'not-found');
    const res = await search(agent).expect(200);
    expect(res.text).toContain('Alex Rivera');
  });

  it('not-found: the next search misses once, then the member is found again', async () => {
    const agent = await signedIn(createApp(config()), 'not-found');
    expect((await search(agent).expect(200)).text).toContain('No matching member for number');
    expect((await search(agent).expect(200)).text).toContain('Alex Rivera');
  });

  it('session-expiry: the next search bounces to sign-in with the notice, once', async () => {
    const agent = await signedIn(createApp(config()), 'session-expiry');
    await search(agent).expect(302).expect('Location', '/login?expired=1');
    expect((await agent.get('/login?expired=1').expect(200)).text).toContain(
      'Your session has expired',
    );
    await agent.post('/login').type('form').send({ uid: 'teller', pwd: 'pw' }).expect(302);
    expect((await search(agent).expect(200)).text).toContain('Alex Rivera');
  });

  it('slow: the next search shows a busy page that refreshes to the results', async () => {
    const agent = await signedIn(createApp(config()), 'slow');
    const busy = await search(agent).expect(200);
    expect(busy.text).toContain('The system is busy');
    expect(busy.text).toContain('http-equiv="refresh" content="2; url=/members/search?mno=10001"');
    const results = await agent.get('/members/search?mno=10001').expect(200);
    expect(results.text).toContain('Alex Rivera');
    expect(results.text).not.toContain('refresh');
  });

  it('interstitial: the next results page opens a System notice alert, once', async () => {
    const agent = await signedIn(createApp(config()), 'interstitial');
    const first = await search(agent).expect(200);
    expect(first.text).toContain('alert("System notice');
    expect(first.text).toContain('Alex Rivera');
    expect((await search(agent).expect(200)).text).not.toContain('alert(');
  });

  it('error: the next search is a 500 application error page, once', async () => {
    const agent = await signedIn(createApp(config()), 'error');
    const res = await search(agent).expect(500);
    expect(res.text).toContain('Application error');
    expect((await search(agent).expect(200)).text).toContain('Alex Rivera');
  });

  it('validation: a valid sub-account submit is rejected once with a legacy edit rule', async () => {
    const agent = await signedIn(createApp(config()), 'validation');
    const form = { acct_type: 'Money Market', deposit: '25.00' };
    const rejected = await agent
      .post('/members/10001/accounts/open')
      .type('form')
      .send(form)
      .expect(200);
    expect(rejected.text).toContain('Please correct the errors below.');
    expect(rejected.text).toContain('two decimal places');
    await agent.post('/members/10001/accounts/open').type('form').send(form).expect(302);
  });

  it('arms several modes at once and fires each on its own request', async () => {
    const agent = await signedIn(createApp(config()), 'slow,not-found');
    expect((await search(agent).expect(200)).text).toContain('The system is busy');
    expect((await search(agent).expect(200)).text).toContain('No matching member');
    expect((await search(agent).expect(200)).text).toContain('Alex Rivera');
  });
});
