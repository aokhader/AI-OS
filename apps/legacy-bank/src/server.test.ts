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
    allowChaosHeader: false,
    ...overrides,
  };
}

async function signedIn(app: ReturnType<typeof createApp>) {
  const agent = request.agent(app);
  await agent
    .post('/login')
    .type('form')
    .send({ uid: 'teller', pwd: 'pw' })
    .expect(302)
    .expect('Location', '/');
  return agent;
}

describe('legacy-bank', () => {
  it('bounces unauthenticated requests to sign-in', async () => {
    const app = createApp(config());
    await request(app).get('/').expect(302).expect('Location', '/login');
    await request(app).get('/members').expect(302).expect('Location', '/login');
  });

  it('rejects bad credentials', async () => {
    const app = createApp(config());
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ uid: 'teller', pwd: 'wrong' })
      .expect(401);
    expect(res.text).toContain('Invalid user ID or password.');
  });

  it('walks the happy path: sign in, lookup, results, detail, open sub-account, confirmation', async () => {
    const app = createApp(config());
    const agent = await signedIn(app);

    const frameset = await agent.get('/').expect(200);
    expect(frameset.text).toContain('<frameset');
    expect(frameset.text).toContain('name="main"');
    expect(frameset.text).toContain('<title>First Example Credit Union - ACME CoreTeller</title>');

    const nav = await agent.get('/nav').expect(200);
    expect(nav.text).toContain('Member Lookup');
    expect(nav.text).toContain('target="main"');

    const lookup = await agent.get('/members').expect(200);
    expect(lookup.text).toContain('Member Lookup');
    expect(lookup.text).toContain('Member #');
    expect(lookup.text).toContain('value="Search"');

    const results = await agent
      .post('/members/search')
      .type('form')
      .send({ mno: '10001' })
      .expect(200);
    expect(results.text).toContain('Search Results');
    expect(results.text).toContain('Alex Rivera');
    expect(results.text).toContain('href="/members/10001">View</a>');

    const detail = await agent.get('/members/10001').expect(200);
    expect(detail.text).toContain('Member Detail');
    expect(detail.text).toContain('Accounts');
    expect(detail.text).toContain('Savings');
    expect(detail.text).toContain('$1,250.75');
    expect(detail.text).toContain('Open sub-account');

    const form = await agent.get('/members/10001/accounts/open').expect(200);
    expect(form.text).toContain('Open sub-account');
    expect(form.text).toContain('value="Open Account"');

    const invalid = await agent
      .post('/members/10001/accounts/open')
      .type('form')
      .send({ acct_type: '', deposit: 'abc' })
      .expect(200);
    expect(invalid.text).toContain('Please correct the errors below.');
    expect(invalid.text).toContain('Account type is required.');
    expect(invalid.text).toContain('Initial deposit must be a number of 0 or more.');

    const opened = await agent
      .post('/members/10001/accounts/open')
      .type('form')
      .send({ acct_type: 'Money Market', deposit: '25.00' })
      .expect(302);
    const location = opened.headers.location;
    expect(location).toMatch(/^\/members\/10001\/confirmation\/C-\d{6}$/);

    const confirmation = await agent.get(location as string).expect(200);
    expect(confirmation.text).toContain('Confirmation');
    expect(confirmation.text).toContain('Confirmation number');
    expect(confirmation.text).toContain('10001-M01');
    expect(confirmation.text).toContain('$25.00');

    const detailAfter = await agent.get('/members/10001').expect(200);
    expect(detailAfter.text).toContain('Money Market');
    expect(detailAfter.text).toContain('10001-M01');
  });

  it('reports an unknown member as a business outcome, not an error', async () => {
    const app = createApp(config());
    const agent = await signedIn(app);
    const results = await agent
      .post('/members/search')
      .type('form')
      .send({ mno: '99999' })
      .expect(200);
    expect(results.text).toContain('No matching member for number 99999.');
    const direct = await agent.get('/members/99999').expect(404);
    expect(direct.text).toContain('No matching member');
  });

  it('refuses new accounts on a closed membership', async () => {
    const app = createApp(config());
    const agent = await signedIn(app);
    const res = await agent
      .post('/members/10004/accounts/open')
      .type('form')
      .send({ acct_type: 'Savings', deposit: '10' })
      .expect(200);
    expect(res.text).toContain('This membership is closed');
  });

  it('expires the session after the inactivity timeout and says so on sign-in', async () => {
    const app = createApp(config({ sessionTtlMs: 5 }));
    const agent = await signedIn(app);
    await new Promise((r) => setTimeout(r, 20));
    await agent.get('/members').expect(302).expect('Location', '/login?expired=1');
    const login = await agent.get('/login?expired=1').expect(200);
    expect(login.text).toContain('Your session has expired');
    await agent.get('/members').expect(302).expect('Location', '/login');
  });

  it('signs out to the top frame', async () => {
    const app = createApp(config());
    const agent = await signedIn(app);
    await agent.get('/logout').expect(302).expect('Location', '/login');
    await agent.get('/members').expect(302).expect('Location', '/login');
  });

  it('keeps the markup hostile: no ids, labels or test hooks', async () => {
    const app = createApp(config());
    const agent = await signedIn(app);
    const pages = [
      (await agent.get('/login')).text,
      (await agent.get('/')).text,
      (await agent.get('/nav')).text,
      (await agent.get('/members')).text,
      (await agent.post('/members/search').type('form').send({ mno: '10001' })).text,
      (await agent.get('/members/10001')).text,
      (await agent.get('/members/10001/accounts/open')).text,
    ];
    for (const html of pages) {
      expect(html).not.toMatch(/\sid="/);
      expect(html).not.toMatch(/data-testid/);
      expect(html).not.toMatch(/<label/);
      expect(html).not.toMatch(/aria-/);
    }
  });

  it('serves variant B with its own branding, labels and frame name', async () => {
    const app = createApp(config({ variant: variants.b }));
    const agent = await signedIn(app);
    const frameset = await agent.get('/').expect(200);
    expect(frameset.text).toContain('Sample Federal Credit Union');
    expect(frameset.text).toContain('name="content"');
    const lookup = await agent.get('/members').expect(200);
    expect(lookup.text).toContain('Member Number');
    expect(lookup.text).toContain('value="Find"');
    const results = await agent
      .post('/members/search')
      .type('form')
      .send({ mno: '10001' })
      .expect(200);
    expect(results.text).toContain('href="/members/10001">Open</a>');
    expect(results.text).toContain('Actions');
  });
});
