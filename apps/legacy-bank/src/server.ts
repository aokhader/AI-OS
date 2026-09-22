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

  app.post('/members/search', auth, (req, res) => {
    const mno = field(req.body, 'mno').trim();
    const member = mno ? bank.findMember(mno) : undefined;
    res.render('search-results', { pageTitle: labels.searchResults, mno, member });
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
    const reference = `E${Date.now().toString(36).toUpperCase()}`;
    console.error(`[legacy-bank] ${reference}`, err);
    res.status(500).render('error', { pageTitle: 'Application error', reference });
  });

  return app;
}
