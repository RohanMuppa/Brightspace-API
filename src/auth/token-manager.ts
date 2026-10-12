/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenData } from "../types/index.js";
import { SessionStore } from "./session-store.js";
import { mintAccessToken } from "./token-mint.js";
import { log } from "../utils/logger.js";
import { TokenRefreshError } from "../api/errors.js";

/**
 * Token refresh buffer - tokens within this time of expiry are considered invalid.
 * This prevents using tokens that might expire during a request.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Matches the tokenTtl default in the app config. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export interface TokenManagerOptions {
  sessionDir?: string;
  /** Tenant base URL. Without it the cookie mint is not attempted. */
  baseUrl?: string;
  /**
   * Lifetime in seconds stamped on a minted token. Anything but a positive
   * whole number is ignored (with a warning) in favour of the 3600 default.
   */
  tokenTtl?: number;
  /** Injection seam for tests. */
  mint?: typeof mintAccessToken;
  /** Persistence injection keeps unit tests independent of native credentials. */
  sessionStore?: Pick<SessionStore, "load" | "save" | "clear" | "saveIfCurrent" | "clearIfCurrent"> & Partial<Pick<SessionStore, "fingerprint">>;
}

/**
 * A programmatic caller can pass any number, or a hand-built AppConfig. NaN,
 * zero, a negative or fractional lifetime would stamp a token that is already
 * inside the refresh buffer, so every call would mint again.
 */
function resolveTokenTtl(tokenTtl: number | undefined): number {
  if (tokenTtl === undefined) return DEFAULT_TOKEN_TTL_SECONDS;
  if (Number.isSafeInteger(tokenTtl) && tokenTtl > 0) return tokenTtl;
  log("WARN", `Ignoring tokenTtl=${String(tokenTtl)}: expected a positive whole number of seconds; using ${DEFAULT_TOKEN_TTL_SECONDS}`);
  return DEFAULT_TOKEN_TTL_SECONDS;
}

/**
 * TokenManager manages token lifecycle with in-memory caching and disk persistence.
 * Handles expiry detection with a configurable refresh buffer.
 */
export class TokenManager {
  private cachedToken: TokenData | null = null;
  private readonly sessionStore: NonNullable<TokenManagerOptions["sessionStore"]>;
  private readonly baseUrl?: string;
  private readonly tokenTtl: number;
  private readonly mint: typeof mintAccessToken;
  /** Single in-flight mint, so concurrent callers share one request. */
  private mintInFlight: Promise<TokenData | null> | null = null;
  private rejectedAccessToken: string | null = null;
  /**
   * The saved session this process last read or wrote, as the account it
   * belongs to. Kept even while cachedToken is null (an unusable token on
   * disk), so a later sign-in can still be compared with the account that
   * the in-memory state, and the API client's response cache, were built for.
   * Null once the session is known to be gone.
   */
  private identityToken: TokenData | null = null;
  /** SessionStore.fingerprint() of the file when identityToken was read or written. */
  private observedFingerprint: string | undefined;
  /**
   * Set when the session was signed out or replaced by a different account
   * since sessionChanged() last answered. Errs toward true.
   */
  private sessionReplaced = false;

  constructor(sessionDir?: string);
  constructor(options: TokenManagerOptions);
  constructor(sessionDirOrOptions?: string | TokenManagerOptions) {
    const options: TokenManagerOptions =
      typeof sessionDirOrOptions === "string" || sessionDirOrOptions === undefined
        ? { sessionDir: sessionDirOrOptions }
        : sessionDirOrOptions;

    this.sessionStore = options.sessionStore ?? new SessionStore(options.sessionDir);
    this.baseUrl = options.baseUrl ? new URL(options.baseUrl).origin : undefined;
    this.tokenTtl = resolveTokenTtl(options.tokenTtl);
    this.mint = options.mint ?? mintAccessToken;
  }

  /**
   * Get the current token if valid, otherwise null.
   * Checks memory cache first, then loads from disk if needed.
   * Returns null if token is expired or within refresh buffer.
   */
  async getToken(rejectedAccessToken?: string): Promise<TokenData | null> {
    if (rejectedAccessToken) this.rejectedAccessToken = rejectedAccessToken;
    // Check memory cache first, after asking whether the saved session is
    // still the one this process remembers. Another process may have signed
    // out (deleted it), or signed in again, since this token was cached; when
    // it has, the memory is dropped or refreshed from disk here. Skipped when
    // nothing is remembered, so a cold start costs no extra stat.
    await this.syncWithDisk();
    if (this.cachedToken && this.isUsable(this.cachedToken)) {
      log("DEBUG", "Returning cached token");
      return this.cachedToken;
    }

    // Try loading from disk
    const storedToken = await this.sessionStore.load();
    if (storedToken) await this.observe(storedToken);
    if (storedToken && this.isUsable(storedToken)) {
      log("DEBUG", "Loaded valid token from session store");
      this.cachedToken = storedToken;
      return storedToken;
    }

    // The token is stale, but if it carried the session material we can trade
    // that for a fresh JWT over plain HTTP instead of relaunching the browser.
    // Disk may have been refreshed by another MCP process. Never prefer stale
    // cached cookies over the current persisted session.
    const mintable = this.pickMintable(storedToken);
    if (mintable) {
      const minted = await this.mintFromSession(mintable);
      if (minted) return minted;
    }

    log("DEBUG", "No valid token available");
    return null;
  }

  /**
   * Whether the saved session was signed out or replaced by a different
   * account since this was last asked, for example by `auth --logout`
   * running in another process, or a new sign-in as someone else. When it
   * was, anything built under the old session (the API client's response
   * cache) must not be trusted. Costs one stat while the file is unchanged.
   *
   * True when the file is missing, and when a reload shows a different
   * account than the one remembered (same tenant and session cookie is the
   * same account; with neither side carrying a cookie the answer is true,
   * because when unsure the safe move is to clear). The same account's token
   * re-minted by another process is not a change, so it does not wipe a
   * cache that is still valid. The answer is true once per change.
   * A failed stat answers false; a replaced file this process cannot read
   * answers true (the in-memory token is still served, but cached responses
   * are not trusted until the file reads again).
   */
  async sessionChanged(): Promise<boolean> {
    await this.syncWithDisk();
    const changed = this.sessionReplaced;
    this.sessionReplaced = false;
    return changed;
  }

  /**
   * Drop everything remembered about the saved session without touching any
   * file: the cached token, a remembered rejection and the recorded file
   * identity. The next getToken() reads the disk afresh. Call it right after
   * deleting the session files, so this process stops acting signed in even
   * when another process has already signed in again and recreated the file,
   * which a plain existence check could not tell apart. Also makes the next
   * sessionChanged() answer true, so cached API responses are not served
   * either.
   */
  forgetSession(): void {
    this.cachedToken = null;
    this.rejectedAccessToken = null;
    this.identityToken = null;
    this.observedFingerprint = undefined;
    this.sessionReplaced = true;
  }

  /**
   * Compare the saved file with what this process last saw of it, and bring
   * memory in line: file gone, forget everything; file replaced or rewritten,
   * reload it and adopt it (flagging a different account). A fingerprint
   * that cannot be determined, or an unreadable replacement, keeps the
   * current state, with an unreadable replacement flagged as changed.
   * Does nothing, and costs nothing, when nothing is remembered.
   */
  private async syncWithDisk(): Promise<void> {
    if (!this.identityToken && !this.rejectedAccessToken) return;
    const fingerprint = await this.sessionStore.fingerprint?.();
    if (fingerprint === null) {
      log("DEBUG", "The saved session is gone; dropping the in-memory token");
      this.forgetSession();
      return;
    }
    if (typeof fingerprint !== "string" || !this.identityToken || fingerprint === this.observedFingerprint) return;

    log("DEBUG", "The saved session changed on disk; reloading it");
    let loaded: TokenData | null;
    try {
      loaded = await this.sessionStore.load();
    } catch (error) {
      // Cannot tell whose session this is. Keep serving the token in memory,
      // do not record the fingerprint (so the next call tries again), and
      // make sure cached responses are not trusted.
      log("WARN", "The saved session changed but could not be read", error);
      this.sessionReplaced = true;
      return;
    }
    if (!loaded) {
      this.forgetSession();
      return;
    }
    this.adopt(loaded, fingerprint);
    this.cachedToken = this.isUsable(loaded) ? loaded : null;
  }

  /**
   * Remember `token` as the session now on disk. `fingerprint` is the file's
   * identity from a stat taken before it was read; without one, it is taken
   * now, after the read or write that produced `token`. If another process
   * rewrote the file in the instant between that read or write and the stat,
   * this records their file's identity against our token, so the change goes
   * unnoticed until the next rewrite. That is acceptable: the token held is
   * itself valid, and the window is microseconds wide.
   */
  private adopt(token: TokenData, fingerprint: string | null | undefined): void {
    if (this.identityToken && !this.sameAccount(this.identityToken, token)) this.sessionReplaced = true;
    this.identityToken = token;
    this.observedFingerprint = fingerprint ?? undefined;
  }

  private async observe(token: TokenData): Promise<void> {
    this.adopt(token, await this.sessionStore.fingerprint?.());
  }

  /**
   * Whether two sessions belong to the same account on the same tenant. This
   * token's shape has no account name, so the session cookie is the only
   * signal; unknown is not the same, so with no cookie on either side this
   * answers false.
   */
  private sameAccount(a: TokenData, b: TokenData): boolean {
    if (a.tenantOrigin !== b.tenantOrigin) return false;
    return a.cookieHeader !== undefined && a.cookieHeader === b.cookieHeader;
  }

  /**
   * Only use persisted session material, including updates from other processes.
   */
  private pickMintable(candidate: TokenData | null): TokenData | null {
    return this.baseUrl && candidate && this.matchesTenant(candidate) && candidate.cookieHeader && candidate.csrfToken ? candidate : null;
  }

  /**
   * Mint a fresh token from the stale one's session material, collapsing
   * concurrent callers onto a single request.
   */
  private async mintFromSession(stale: TokenData): Promise<TokenData | null> {
    if (this.mintInFlight) {
      log("DEBUG", "Joining the in-flight token mint");
      return this.mintInFlight;
    }

    const inFlight = this.runMint(stale).finally(() => {
      this.mintInFlight = null;
    });
    this.mintInFlight = inFlight;
    return inFlight;
  }

  private async runMint(stale: TokenData): Promise<TokenData | null> {
    log("DEBUG", "Trying to mint an access token from the session cookie");

    let result;
    try {
      result = await this.mint({
        baseUrl: this.baseUrl as string,
        cookieHeader: stale.cookieHeader as string,
        csrfToken: stale.csrfToken as string,
      });
    } catch (error) {
      throw new TokenRefreshError("token service request failed", error instanceof Error ? error : undefined);
    }

    // The auth CLI or another process can finish a login while HTTP minting
    // is in flight. Its newer session wins over either result of this request.
    const current = await this.sessionStore.load();
    if (!current) {
      // Signed out while the mint was in flight. Saving a token now would
      // quietly undo that, so drop everything and let the caller sign in.
      log("DEBUG", "The saved session was removed during the refresh");
      this.forgetSession();
      return null;
    }
    if (!this.sameToken(current, stale)) {
      await this.observe(current);
      this.cachedToken = current;
      if (this.isUsable(current)) return current;
      throw new TokenRefreshError("saved authentication changed during refresh");
    }

    if (result.ok) {
      const now = Date.now();
      const token: TokenData = {
        accessToken: result.accessToken,
        tenantOrigin: this.baseUrl,
        capturedAt: now,
        expiresAt: now + this.tokenTtl * 1000,
        source: "browser",
        cookieHeader: stale.cookieHeader,
        csrfToken: stale.csrfToken,
      };
      if (!await this.sessionStore.saveIfCurrent(token, stale)) return this.afterConcurrentChange();
      await this.observe(token);
      this.cachedToken = token;
      this.rejectedAccessToken = null;
      log("INFO", "Minted a fresh access token from the session cookie");
      return token;
    }

    if (result.reason === "sessionExpired") {
      log("INFO", "The session cookie has expired, a browser login is needed");
      if (!await this.sessionStore.clearIfCurrent(stale)) return this.afterConcurrentChange();
      this.cachedToken = null;
      this.observedFingerprint = undefined;
      return null;
    }

    throw new TokenRefreshError(result.detail ?? "unexpected token service response");
  }

  /**
   * Set a new token, caching in memory and persisting to disk.
   */
  async setToken(token: TokenData): Promise<void> {
    await this.sessionStore.save(token);
    await this.observe(token);
    this.cachedToken = token;
    this.rejectedAccessToken = null;
    log("DEBUG", "Token cached and persisted");
  }

  /**
   * Clear the token from memory and disk.
   */
  async clearToken(): Promise<void> {
    this.cachedToken = null;
    this.identityToken = null;
    this.observedFingerprint = undefined;
    this.sessionReplaced = true;
    await this.sessionStore.clear();
    log("DEBUG", "Token cleared from memory and disk");
  }

  private isUsable(token: TokenData): boolean {
    return this.matchesTenant(token) && token.accessToken !== this.rejectedAccessToken && this.isValid(token);
  }

  private matchesTenant(token: TokenData): boolean {
    return this.baseUrl === undefined || token.tenantOrigin === this.baseUrl;
  }

  private sameToken(a: TokenData, b: TokenData): boolean {
    return a.accessToken === b.accessToken && a.capturedAt === b.capturedAt &&
      a.cookieHeader === b.cookieHeader && a.csrfToken === b.csrfToken && a.tenantOrigin === b.tenantOrigin;
  }

  private async afterConcurrentChange(): Promise<TokenData | null> {
    const loaded = await this.sessionStore.load();
    if (!loaded) {
      // Nothing is saved any more: the user signed out. That is not a refresh
      // failure; the caller proceeds to the ordinary sign-in.
      this.forgetSession();
      return null;
    }
    await this.observe(loaded);
    this.cachedToken = loaded;
    if (this.isUsable(loaded)) return loaded;
    throw new TokenRefreshError("saved authentication changed during refresh");
  }

  /**
   * Check if a token is valid (not expired and outside refresh buffer).
   * A token is valid if it expires more than REFRESH_BUFFER_MS from now.
   */
  isValid(token: TokenData): boolean {
    const now = Date.now();
    const timeUntilExpiry = token.expiresAt - now;

    // Token must expire more than REFRESH_BUFFER_MS in the future
    const valid = timeUntilExpiry > REFRESH_BUFFER_MS;

    if (!valid) {
      log(
        "DEBUG",
        `Token invalid: expires in ${Math.round(timeUntilExpiry / 1000)}s (buffer: ${REFRESH_BUFFER_MS / 1000}s)`
      );
    }

    return valid;
  }

  /**
   * Check if a token refresh is needed.
   * Returns true if no valid token is available.
   */
  async needsRefresh(): Promise<boolean> {
    const token = await this.getToken();
    return token === null;
  }
}
