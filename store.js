'use strict';

// ══════════════════════════════════════════════════════
//  store.js
//  In-memory key-value store for session tokens.
//  Tokens are written by /notify, read+deleted by /poll.
//  Render's free tier keeps the process alive, so
//  in-memory is fine. Tokens expire after 10 minutes.
// ══════════════════════════════════════════════════════

const store = new Map(); // token → { result, expiresAt }

/**
 * Save a result for a token.
 * @param {string} token
 * @param {string} result  e.g. 'otp_allowed' | 'otp_correct' | 'otp_wrong'
 * @param {number} ttlMs   Time-to-live in milliseconds
 */
export function setResult(token, result, ttlMs) {
  store.set(token, {
    result,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Get and immediately delete a result for a token.
 * Returns null if not found or expired.
 * @param {string} token
 * @returns {string|null}
 */
export function popResult(token) {
  const entry = store.get(token);
  if (!entry) return null;

  store.delete(token); // consume — can't be replayed

  if (Date.now() > entry.expiresAt) return null; // expired

  return entry.result;
}

/**
 * Check if a token exists (without consuming it).
 * @param {string} token
 * @returns {boolean}
 */
export function hasToken(token) {
  return store.has(token);
}

// ── Cleanup expired entries every 5 minutes ──
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(token);
  }
}, 5 * 60 * 1000);
