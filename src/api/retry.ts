/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { ApiError, NetworkError, RateLimitError } from "./errors.js";

/**
 * Retry transient failures with exponential backoff and jitter.
 *
 * What counts as transient is decided by the caller through `shouldRetry`,
 * so this module knows nothing about HTTP. A 429 that names a Retry-After is
 * honored verbatim, even past `maxMs`, because the server has told us
 * exactly when to come back and guessing sooner only earns another 429.
 * A Retry-After longer than `maxRetryAfterMs` is not waited out at all: the
 * call would block far past any reasonable timeout, so the 429 is surfaced
 * at once and its RateLimitError (message and `retryAfter`) says when to try
 * again, leaving the caller to decide whether to wait that long.
 *
 * `sleep` and `jitter` are injectable so the backoff sequence is testable
 * without fake timers.
 */

export interface RetryConfig {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Backoff before the second attempt, doubled thereafter. Default 250. */
  initialMs?: number;
  /** Ceiling on the computed backoff. Default 5000. Retry-After ignores it. */
  maxMs?: number;
  /** Longest Retry-After worth waiting out. Default 30000. Longer ones rethrow. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Default Math.random. */
  jitter?: () => number;
}

export interface RetryOptions extends RetryConfig {
  shouldRetry: (error: unknown) => boolean;
  /** Milliseconds the failure itself asked us to wait, if it did. */
  retryAfterMs?: (error: unknown) => number | undefined;
}

const JITTER_FRACTION = 0.3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxAttempts = 3,
    initialMs = 250,
    maxMs = 5000,
    maxRetryAfterMs = 30_000,
    sleep = defaultSleep,
    jitter = Math.random,
    shouldRetry,
    retryAfterMs,
  } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;

      const requested = retryAfterMs?.(error);
      let delay: number;
      if (requested !== undefined) {
        if (requested > maxRetryAfterMs) throw error;
        delay = requested;
      } else {
        const base = Math.min(initialMs * 2 ** (attempt - 1), maxMs);
        delay = Math.round(base + base * JITTER_FRACTION * jitter());
      }
      await sleep(delay);
    }
  }
}

/**
 * Exactly three things get better by waiting: a rate limit, a server-side
 * failure, and a dropped connection. A 401 needs a new token, a 403 needs
 * permission, a 404 needs a different path. None of those are retried.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof ApiError) return error.status >= 500 && error.status <= 599;
  return error instanceof NetworkError;
}

/** The Retry-After a 429 carried, in milliseconds, or undefined. */
export function retryAfterMsFrom(error: unknown): number | undefined {
  if (error instanceof RateLimitError && typeof error.retryAfter === "number" && error.retryAfter > 0) {
    return error.retryAfter * 1000;
  }
  return undefined;
}

const DELTA_SECONDS = /^\d+$/;
const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const LONG_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIME = "\\d{2}:\\d{2}:\\d{2}";
// The three HTTP-date forms of RFC 9110 §5.6.7: IMF-fixdate, then the
// obsolete RFC 850 and asctime forms that recipients must still accept.
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
const RFC850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} (?:\\d{2}| \\d) ${TIME} \\d{4}$`);

/**
 * Parse a Retry-After header into whole seconds to wait, or undefined.
 *
 * RFC 9110 §10.2.3 allows either delta-seconds or an HTTP-date. A date is
 * converted to the seconds remaining from `now`, rounded up; one that is not
 * in the future asks for no wait at all. Anything else, `10abc` included, is
 * ignored so the caller falls back to its normal backoff.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (DELTA_SECONDS.test(trimmed)) return parseInt(trimmed, 10);

  let date: number;
  if (IMF_FIXDATE.test(trimmed) || RFC850_DATE.test(trimmed)) {
    date = Date.parse(trimmed);
  } else if (ASCTIME_DATE.test(trimmed)) {
    // asctime carries no zone, but HTTP dates are always GMT.
    date = Date.parse(`${trimmed} GMT`);
  } else {
    return undefined;
  }
  if (Number.isNaN(date) || date <= now) return undefined;
  return Math.ceil((date - now) / 1000);
}
