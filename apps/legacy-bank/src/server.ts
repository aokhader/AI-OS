import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSession from 'cookie-session';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from './config.js';
import { ACCOUNT_TYPES, type AccountType, type Bank, createBank, formatMoney } from './data.js';
import { currentUser, requireAuth, signIn, signOut } from './session.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface FormBody {
  [key: string]: string | undefined;
}

function field(body: unknown, name: string): string {
  const b = body as FormBody | undefined;
  const v = b?.[name];
  return typeof v === 'string' ? v : '';
}

/** Express 5 types route params as possibly repeated; this app never repeats them. */
function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

// ---- chaos injection (D-024) --------------------------------------------------------------------

export const CHAOS_MODES = [
  'not-found',
  'validation',
  'session-expiry',
  'interstitial',
  'slow',
  'error',
] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];
const CHAOS_COOKIE = 'coreteller_chaos';

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

interface Chaos {
  /** True once per browser for an armed mode; false afterwards or when the mode is not armed. */
  fire(mode: ChaosMode): boolean;
}

/**
 * `x-handsoff-chaos: mode[,mode]` arms runtime conditions for the browser that sends it. Each mode
 * fires once, on the request it targets, and is then remembered in a cookie of its own so that it
 * stays fired even when the session cookie is cleared; that is what lets a recovery be observed
 * succeeding. Ignored unless the server is configured to honour the header.
 */
function chaosFor(req: Request, res: Response, allow: boolean): Chaos {
  const raw = req.headers['x-handsoff-chaos'];
  const header = allow ? (Array.isArray(raw) ? raw.join(',') : (raw ?? '')) : '';
  const armed = new Set(
    header
      .split(',')
      .map((m) => m.trim())
      .filter((m): m is ChaosMode => (CHAOS_MODES as readonly string[]).includes(m)),
  );
  const fired = new Set((cookieValue(req, CHAOS_COOKIE) ?? '').split(',').filter(Boolean));
  return {
    fire(mode) {
      if (!armed.has(mode) || fired.has(mode)) return false;
      fired.add(mode);
      res.cookie(CHAOS_COOKIE, [...fired].join(','), { httpOnly: true, sameSite: 'lax' });
      return true;
    },
  };
}

export function createApp(config: AppConfig, bank: Bank = createBank()): express.Express {
  const app = express();
  const { variant } = config;
  const { labels } = variant;

  app.set('view engine', 'ejs');
  app.set('views', path.join(here, '..', 'views'));
  app.disable('x-powered-by');
  app.locals.institution = variant.institution;
  app.locals.product = variant.product;
  app.locals.productVersion = variant.productVersion;
  app.locals.mainFrameName = variant.mainFrameName;
  app.locals.theme = variant.theme;
  app.locals.labels = labels;
  app.locals.formatMoney = formatMoney;
  app.locals.accountTypes = ACCOUNT_TYPES;

  app.use(express.urlencoded({ extended: false }));
  app.use(
    cookieSession({
      name: 'coreteller',
      secret: config.cookieSecret,
      httpOnly: true,
      sameSite: 'lax',
    }),
  );
  // Legacy apps send no caching headers and browsers happily cache framed pages. Be explicit.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const auth = requireAuth(config.sessionTtlMs);
  const chaos = (req: Request, res: Response) => chaosFor(req, res, config.allowChaosHeader);

  function renderError(res: Response): void {
    const reference = `E${Date.now().toString(36).toUpperCase()}`;
    res.status(500).render('error', { pageTitle: 'Application error', reference });
  }

  function renderResults(
    res: Response,
    mno: string,
    member: ReturnType<Bank['findMember']>,
    interstitial: boolean,
  ): void {
    res.render('search-results', { pageTitle: labels.searchResults, mno, member, interstitial });
  }

  // ---- sign-in -------------------------------------------------------------------------------

  app.get('/login', (req, res) => {
    res.render('login', {
      pageTitle: labels.signIn,
      expired: req.query.expired === '1',
      error: undefined,
      uid: '',
    });
  });

  app.post('/login', (req, res) => {
    const uid = field(req.body, 'uid').trim();
    const pwd = field(req.body, 'pwd');
    if (uid === config.user && pwd === config.pass) {
      signIn(req, uid);
      res.redirect('/');
      return;
    }
    res.status(401).render('login', {
      pageTitle: labels.signIn,
      expired: false,
      error: 'Invalid user ID or password.',
      uid,
    });
  });

  app.get('/logout', (req, res) => {
    signOut(req);
    res.redirect('/login');
  });

  // ---- frameset and navigation ----------------------------------------------------------------

  app.get('/', auth, (_req, res) => {
    res.render('frameset');
  });

  app.get('/nav', auth, (req, res) => {
    res.render('nav', { pageTitle: 'Navigation', user: currentUser(req) });
  });

  // ---- members ------------------------------------------------------------------------------

  app.get('/members', auth, (_req, res) => {
    res.render('member-lookup', { pageTitle: labels.memberLookup, mno: '' });
  });

  // The search is where most injected conditions land: it is the first request of every flow.
  app.post('/members/search', auth, (req, res) => {
    const mno = field(req.body, 'mno').trim();
    const c = chaos(req, res);
    if (c.fire('error')) {
      renderError(res);
      return;
    }
    if (c.fire('session-expiry')) {
      req.session = null;
      res.redirect('/login?expired=1');
      return;
    }
    if (c.fire('slow')) {
      res.render('busy', {
        pageTitle: 'Please Wait',
        refreshUrl: `/members/search?mno=${encodeURIComponent(mno)}`,
      });
      return;
    }
    const member = c.fire('not-found') || mno === '' ? undefined : bank.findMember(mno);
    renderResults(res, mno, member, c.fire('interstitial'));
  });

  // Where the busy page lands after its refresh. Declared before /members/:id on purpose.
  app.get('/members/search', auth, (req, res) => {
    const mno = String(req.query.mno ?? '').trim();
    renderResults(res, mno, mno === '' ? undefined : bank.findMember(mno), false);
  });

  app.get('/members/:id', auth, (req, res) => {
    const member = bank.findMember(param(req, 'id'));
    if (!member) {
      res.status(404).render('not-found', {
        pageTitle: labels.memberDetail,
        message: `No matching member for number ${param(req, 'id')}.`,
      });
      return;
    }
    res.render('member-detail', { pageTitle: labels.memberDetail, member });
  });

  app.get('/members/:id/accounts/open', auth, (req, res) => {
    const member = bank.findMember(param(req, 'id'));
    if (!member) {
      res.status(404).render('not-found', {
        pageTitle: labels.openSubAccount,
        message: `No matching member for number ${param(req, 'id')}.`,
      });
      return;
    }
    res.render('open-account', {
      pageTitle: labels.openSubAccount,
      member,
      errors: {},
      values: { acct_type: '', deposit: '' },
    });
  });

  app.post('/members/:id/accounts/open', auth, (req, res) => {
    const member = bank.findMember(param(req, 'id'));
    if (!member) {
      res.status(404).render('not-found', {
        pageTitle: labels.openSubAccount,
        message: `No matching member for number ${param(req, 'id')}.`,
      });
      return;
    }
    const values = {
      acct_type: field(req.body, 'acct_type').trim(),
      deposit: field(req.body, 'deposit').trim(),
    };
    const errors: Record<string, string> = {};
    if (!(ACCOUNT_TYPES as readonly string[]).includes(values.acct_type)) {
      errors.acct_type = `${labels.accountType} is required.`;
    }
    const deposit = values.deposit === '' ? Number.NaN : Number(values.deposit);
    if (!Number.isFinite(deposit) || deposit < 0) {
      errors.deposit = `${labels.initialDeposit} must be a number of 0 or more.`;
    }
    // Injected validation: a legacy edit rule that rejects an otherwise valid submit once.
    if (Object.keys(errors).length === 0 && chaos(req, res).fire('validation')) {
      errors.deposit = `${labels.initialDeposit} must be entered with two decimal places, for example 25.00.`;
    }
    if (Object.keys(errors).length > 0) {
      res.status(200).render('open-account', {
        pageTitle: labels.openSubAccount,
        member,
        errors,
        values,
      });
      return;
    }
    const result = bank.openAccount(member.id, values.acct_type as AccountType, deposit);
    if ('error' in result) {
      res.status(200).render('open-account', {
        pageTitle: labels.openSubAccount,
        member,
        errors: { acct_type: 'This membership is closed; no new accounts may be opened.' },
        values,
      });
      return;
    }
    res.redirect(`/members/${member.id}/confirmation/${result.confirmation.number}`);
  });

  app.get('/members/:id/confirmation/:conf', auth, (req, res) => {
    const member = bank.findMember(param(req, 'id'));
    const confirmation = bank.getConfirmation(param(req, 'conf'));
    if (!member || !confirmation || confirmation.memberId !== member.id) {
      res.status(404).render('not-found', {
        pageTitle: labels.confirmation,
        message: 'No such confirmation.',
      });
      return;
    }
    res.render('confirmation', { pageTitle: labels.confirmation, member, confirmation });
  });

  // ---- fallthrough ---------------------------------------------------------------------------

  app.use((_req, res) => {
    res.status(404).render('not-found', { pageTitle: 'Not Found', message: 'Page not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[legacy-bank]', err);
    renderError(res);
  });

  return app;
}
