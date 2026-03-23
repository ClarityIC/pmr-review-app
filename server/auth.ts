/**
 * Google OAuth 2.0 authentication routes.
 * Uses redirect mode (no popups) with HttpOnly session cookies.
 * Restricts access to @clarityic.com accounts only.
 */
import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { getEnv } from './config.js';

export const authRouter = Router();

const ALLOWED_DOMAIN = 'clarityic.com';

function getOAuthClient() {
  return new OAuth2Client(getEnv('GOOGLE_CLIENT_ID'));
}

/** Check current session — called on frontend mount. */
authRouter.get('/me', (req: Request, res: Response) => {
  const session = (req as any).session;
  if (session?.user) {
    res.json({ user: session.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

/**
 * Receives the Google credential POST from the redirect flow.
 * Google posts a form with `credential` (JWT) to this URI.
 */
authRouter.post('/google-redirect', async (req: Request, res: Response) => {
  const { credential } = req.body;
  if (!credential) {
    return res.redirect('/?error=Missing+credential');
  }

  try {
    const client = getOAuthClient();
    const clientId = getEnv('GOOGLE_CLIENT_ID');
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload) throw new Error('Empty token payload');

    const email = payload.email || '';
    const domain = payload.hd || email.split('@')[1] || '';

    if (domain !== ALLOWED_DOMAIN) {
      console.warn(`[auth] Blocked login attempt from domain: ${domain} (${email})`);
      return res.redirect(`/?error=${encodeURIComponent(`Access restricted to @${ALLOWED_DOMAIN} accounts.`)}`);
    }

    (req as any).session.user = {
      email,
      name: payload.name || email,
      picture: payload.picture || null,
    };

    console.log(`[auth] Login: ${email}`);
    res.redirect('/cases');
  } catch (err: any) {
    console.error('[auth] Token verification failed:', err.message);
    res.redirect(`/?error=${encodeURIComponent('Sign-in failed. Please try again.')}`);
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  const email = (req as any).session?.user?.email;
  (req as any).session.destroy(() => {
    console.log(`[auth] Logout: ${email}`);
    res.json({ ok: true });
  });
});

/** Express middleware to require an authenticated session on API routes. */
export function requireAuth(req: Request, res: Response, next: Function) {
  if ((req as any).session?.user) return next();
  res.status(401).json({ error: 'Authentication required' });
}
