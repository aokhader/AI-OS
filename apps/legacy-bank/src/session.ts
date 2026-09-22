import type { NextFunction, Request, Response } from 'express';

interface SessionData {
  user?: string;
  lastSeen?: number;
}

function session(req: Request): SessionData | null {
  return (req.session as SessionData | null | undefined) ?? null;
}

export function signIn(req: Request, user: string): void {
  req.session = { user, lastSeen: Date.now() };
}

export function signOut(req: Request): void {
  req.session = null;
}

export function currentUser(req: Request): string | undefined {
  return session(req)?.user;
}

/**
 * A legacy-style session: fixed inactivity timeout. An expired session is cleared and the user is
 * bounced to sign-in with a notice, which is what the SESSION_EXPIRED detector looks for.
 */
export function requireAuth(ttlMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const s = session(req);
    if (!s?.user) {
      res.redirect('/login');
      return;
    }
    if (typeof s.lastSeen === 'number' && Date.now() - s.lastSeen > ttlMs) {
      req.session = null;
      res.redirect('/login?expired=1');
      return;
    }
    s.lastSeen = Date.now();
    next();
  };
}
