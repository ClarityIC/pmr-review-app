/**
 * Google OAuth 2.0 authentication routes.
 * Uses redirect mode (no popups) with a signed HttpOnly cookie.
 * Restricts access to @clarityic.com accounts only.
 *
 * Auth is stateless — user identity is stored in a signed cookie (pmr_auth),
 * not in a server-side session. This works correctly on Cloud Run where
 * requests may be routed across multiple instances.
 */
import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { getEnv } from './config.js';

export const authRouter = Router();

const ALLOWED_DOMAIN = 'clarityic.com';
const IS_PROD = process.env.NODE_ENV === 'production';

function getOAuthClient() {
  return new OAuth2Client(getEnv('GOOGLE_CLIENT_ID'));
}

/** Check current session — called on frontend mount. */
authRouter.get('/me', (req: Request, res: Response) => {
  const raw = (req as any).signedCookies?.pmr_auth;
  if (!raw) return res.status(401).json({ error: 'Not authenticated' });
  try {
    res.json({ user: JSON.parse(raw) });
  } catch {
    res.status(401).json({ error: 'Invalid session' });
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

    res.cookie('pmr_auth', JSON.stringify({
      email,
      name: payload.name || email,
      picture: payload.picture || null,
    }), {
      signed: true,
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
    });

    console.log(`[auth] Login: ${email}`);
    res.redirect('/cases');
  } catch (err: any) {
    console.error('[auth] Token verification failed:', err.message);
    res.redirect(`/?error=${encodeURIComponent('Sign-in failed. Please try again.')}`);
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  const raw = (req as any).signedCookies?.pmr_auth;
  const email = raw ? JSON.parse(raw)?.email : 'unknown';
  console.log(`[auth] Logout: ${email}`);
  res.clearCookie('pmr_auth');
  res.json({ ok: true });
});

/** Express middleware to require an authenticated session on API routes. */
export function requireAuth(req: Request, res: Response, next: Function) {
  const raw = (req as any).signedCookies?.pmr_auth;
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  try {
    (req as any).user = JSON.parse(raw);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
}
