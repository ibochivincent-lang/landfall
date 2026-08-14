/**
 * email.js — thin wrapper over Resend's REST API.
 *
 * Calls fetch() directly rather than pulling in the `resend` npm package:
 * this touches the same auth-critical send path as password resets, and
 * api/[...path].js has an established "no new dependency for something
 * security-critical" posture (see hashPassword/verifyPassword). Vercel Node
 * functions already have global fetch, so this adds zero new dependencies.
 *
 * Requires RESEND_API_KEY and FROM_EMAIL in the environment. FROM_EMAIL must
 * be an address on a domain verified with Resend — Resend cannot send from a
 * vercel.app subdomain this project doesn't control DNS for, and its sandbox
 * sender only delivers to the Resend account owner's own inbox. See
 * docs/gaps.md and the README env-var table for setup notes.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Sends an email. Never throws — callers (password reset, contact form)
 * must not have their response shape or timing change based on whether the
 * send succeeded, so failures are logged and returned, not thrown.
 *
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;

  if (!apiKey || !from) {
    const error = 'Email not sent: RESEND_API_KEY or FROM_EMAIL is not configured.';
    console.error('[landfall-email]', error);
    return { ok: false, error };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text }),
      signal: AbortSignal.timeout(8000),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = body.message || `Resend responded ${res.status}`;
      console.error('[landfall-email]', error);
      return { ok: false, error };
    }
    return { ok: true, id: body.id };
  } catch (err) {
    console.error('[landfall-email]', err.message);
    return { ok: false, error: err.message };
  }
}

export { sendEmail };
