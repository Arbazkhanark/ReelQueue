/**
 * Instagram long-lived token lifecycle.
 *
 * Assumed facts (UNVERIFIED in the 2026-10-15 session: Meta's token pages could not be
 * fetched; see docs/INSTAGRAM_SETUP.md "Unverified" list and re-check before launch):
 *   - a long-lived token is valid for 60 days;
 *   - it can be refreshed only if it is at least 24 hours old and not yet expired;
 *   - a token that is not refreshed before it expires cannot be refreshed and the
 *     user must reauthorize.
 *
 * The 10-day refresh lead time below is an APPLICATION policy, not a Meta rule.
 */
export const MIN_TOKEN_AGE_FOR_REFRESH_MS = 24 * 3_600_000;
export const DEFAULT_REFRESH_LEAD_MS = 10 * 24 * 3_600_000;

export type TokenAction = 'OK' | 'TOO_EARLY_TO_REFRESH' | 'REFRESH_DUE' | 'EXPIRED';

export function planTokenAction(args: {
  issuedAt: Date;
  expiresAt: Date;
  now: Date;
  refreshLeadMs?: number;
}): TokenAction {
  const now = args.now.getTime();
  if (now >= args.expiresAt.getTime()) return 'EXPIRED';

  const lead = args.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
  const due = args.expiresAt.getTime() - now <= lead;
  if (!due) return 'OK';

  return now - args.issuedAt.getTime() >= MIN_TOKEN_AGE_FOR_REFRESH_MS
    ? 'REFRESH_DUE'
    : 'TOO_EARLY_TO_REFRESH';
}
