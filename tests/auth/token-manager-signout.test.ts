import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TokenManager } from "../../src/auth/token-manager.js";
import { SessionStore, SESSION_FILE } from "../../src/auth/session-store.js";
import { TokenRefreshError } from "../../src/api/errors.js";
import type { TokenData } from "../../src/types/index.js";
import type { mintAccessToken } from "../../src/auth/token-mint.js";
import { MemoryCredentialBackend, retireTestFile } from "./secure-store-fixtures.js";

type MintFn = typeof mintAccessToken;

const BASE_URL = "https://purdue.brightspace.com";

const tokenNamed = (accessToken: string, extra: Partial<TokenData> = {}): TokenData => ({
  accessToken,
  tenantOrigin: BASE_URL,
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
  ...extra,
});

/** This TokenData shape carries no account name, only a session cookie. */
const withCookie = (accessToken: string, cookieHeader: string, extra: Partial<TokenData> = {}) =>
  tokenNamed(accessToken, { cookieHeader, csrfToken: "xsrf", ...extra });

/** A path no operating system can stat: Node rejects the NUL byte before any syscall. */
const unstattablePath = (dir: string) => path.join(dir, "bad\0dir");

/** An injectable store whose every method is a stub, so a test can count calls. */
const stubStore = (overrides: Record<string, unknown> = {}) => ({
  load: vi.fn(async () => null as TokenData | null),
  save: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  saveIfCurrent: vi.fn(async () => true),
  clearIfCurrent: vi.fn(async () => true),
  ...overrides,
}) as any;

/**
 * Several processes can share one saved session (this library and the sibling
 * brightspace-mcp-server, or two scripts started at different times). Once
 * `auth --logout` deletes session.json, a process that is already running
 * must stop using what it remembers, within its next call.
 */
describe("TokenManager notices a deleted or replaced saved session", () => {
  let dir: string;
  let backend: MemoryCredentialBackend;
  let other: SessionStore;
  let sessionPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "token-manager-signout-"));
    sessionPath = path.join(dir, SESSION_FILE);
    backend = new MemoryCredentialBackend();
    other = new SessionStore(dir, { backend, trash: retireTestFile });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A process: its own TokenManager over the shared directory. */
  const startProcess = (extra: Record<string, unknown> = {}) =>
    new TokenManager({ baseUrl: BASE_URL, sessionStore: new SessionStore(dir, { backend, trash: retireTestFile }), ...extra });

  it("returns the cached token while the saved session still exists", async () => {
    const proc = startProcess();
    await proc.setToken(tokenNamed("old-token-12345678"));

    expect((await proc.getToken())?.accessToken).toBe("old-token-12345678");
    expect(await proc.sessionChanged()).toBe(false);
  });

  it("returns null after another process deletes session.json, then picks up a new sign-in", async () => {
    const proc = startProcess();
    await proc.setToken(tokenNamed("old-token-12345678"));
    expect((await proc.getToken())?.accessToken).toBe("old-token-12345678");

    await fs.unlink(sessionPath); // what logout does, from another process

    expect(await proc.getToken()).toBeNull();
    expect(await proc.getToken()).toBeNull();

    await other.save(tokenNamed("new-token-87654321"));
    expect((await proc.getToken())?.accessToken).toBe("new-token-87654321");
  });

  it("does not hand back a token it had already seen rejected once the session is gone and rewritten", async () => {
    const proc = startProcess();
    await proc.setToken(tokenNamed("old-token-12345678"));
    await proc.getToken("old-token-12345678");
    await fs.unlink(sessionPath);
    expect(await proc.getToken()).toBeNull();

    // The same token text signed in again is a fresh sign-in, not the rejected one.
    await other.save(tokenNamed("old-token-12345678"));
    expect((await proc.getToken())?.accessToken).toBe("old-token-12345678");
  });

  it("forgets a rejection even when nothing is cached (the rejected-token half of the guard)", async () => {
    const proc = startProcess();
    await other.save(tokenNamed("same-text-12345678"));

    // Rejected on first sight: nothing usable, nothing cached.
    expect(await proc.getToken("same-text-12345678")).toBeNull();
    expect((proc as any).cachedToken).toBeNull();

    await fs.unlink(sessionPath);
    expect(await proc.getToken()).toBeNull();

    // The identical text saved again is a new sign-in; the rejection died with the old file.
    await other.save(tokenNamed("same-text-12345678"));
    expect((await proc.getToken())?.accessToken).toBe("same-text-12345678");
  });

  it("forgets a rejection reported while no session file existed, once that is noticed", async () => {
    const proc = startProcess();
    expect(await proc.getToken("same-text-12345678")).toBeNull(); // nothing saved, nothing cached
    expect(await proc.getToken()).toBeNull();

    await other.save(tokenNamed("same-text-12345678"));
    expect((await proc.getToken())?.accessToken).toBe("same-text-12345678");
  });

  it("keeps a rejection while the saved session is unchanged", async () => {
    const proc = startProcess();
    await other.save(tokenNamed("same-text-12345678"));
    expect(await proc.getToken("same-text-12345678")).toBeNull();
    expect(await proc.getToken()).toBeNull();
  });

  describe("sessionChanged()", () => {
    it("is true once the file is gone, and false after the loss has been reported", async () => {
      const proc = startProcess();
      await proc.setToken(tokenNamed("old-token-12345678"));
      await fs.unlink(sessionPath);

      expect(await proc.sessionChanged()).toBe(true);
      await other.save(tokenNamed("new-token-87654321"));
      expect(await proc.sessionChanged()).toBe(false);
    });

    it("is true when the file was deleted and recreated by a different account before the next request", async () => {
      const proc = startProcess();
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));
      expect((await proc.getToken())?.accessToken).toBe("alice-token-12345678");

      await fs.unlink(sessionPath);
      await other.save(withCookie("bob-token-12345678", "d2lSessionVal=bob"));

      expect(await proc.sessionChanged()).toBe(true);
      // And the new account's token is what is served from now on.
      expect((await proc.getToken())?.accessToken).toBe("bob-token-12345678");
      expect(await proc.sessionChanged()).toBe(false);
    });

    it("getToken adopts a different account's token written over the file, and reports the change once", async () => {
      const proc = startProcess();
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));

      await fs.unlink(sessionPath);
      await other.save(withCookie("bob-token-12345678", "d2lSessionVal=bob"));

      // The first thing to notice is getToken, not the client's cache check.
      expect((await proc.getToken())?.accessToken).toBe("bob-token-12345678");
      expect(await proc.sessionChanged()).toBe(true);
      expect(await proc.sessionChanged()).toBe(false);
    });

    it("is false when another process re-minted the same account's token (hourly refresh)", async () => {
      const proc = startProcess();
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));

      await other.save(withCookie("alice-reminted-1234567", "d2lSessionVal=alice"));

      expect(await proc.sessionChanged()).toBe(false);
      // The re-minted token is the one served now.
      expect((await proc.getToken())?.accessToken).toBe("alice-reminted-1234567");
      expect(await proc.sessionChanged()).toBe(false);
    });

    it("clears when it cannot tell: no cookie on either side", async () => {
      const proc = startProcess();
      await proc.setToken(tokenNamed("first-token-12345678"));
      await other.save(tokenNamed("second-token-1234567"));
      expect(await proc.sessionChanged()).toBe(true);
    });

    it("clears when a cookie is known on only one side", async () => {
      const proc = startProcess();
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));
      await other.save(tokenNamed("nameless-token-1234"));
      expect(await proc.sessionChanged()).toBe(true);
    });

    it("is true when the same cookie's session moved to another tenant", async () => {
      const proc = startProcess();
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));
      await other.save(withCookie("alice-other-tenant-1", "d2lSessionVal=alice", { tenantOrigin: "https://other.brightspace.com" }));
      expect(await proc.sessionChanged()).toBe(true);
    });

    it("is true when the replacement session is not usable yet (expired), so the old cache is not trusted", async () => {
      const proc = startProcess();
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));
      await fs.unlink(sessionPath);
      await other.save(withCookie("bob-expired-1234567", "d2lSessionVal=bob", { expiresAt: Date.now() - 1000 }));

      expect(await proc.sessionChanged()).toBe(true);
      expect(await proc.getToken()).toBeNull();
    });

    it("never touches the disk on a cold start", async () => {
      const store = stubStore({ fingerprint: vi.fn(async () => "x") });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });

      expect(await proc.sessionChanged()).toBe(false);
      expect(store.fingerprint).not.toHaveBeenCalled();
      expect(store.load).not.toHaveBeenCalled();
    });
  });

  describe("forgetSession()", () => {
    it("drops the cached token synchronously and touches no files", async () => {
      const store = stubStore({ fingerprint: vi.fn(async () => "fp-1") });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await proc.setToken(tokenNamed("old-token-12345678"));
      store.save.mockClear();
      store.fingerprint.mockClear();

      proc.forgetSession();

      expect((proc as any).cachedToken).toBeNull();
      expect(store.load).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(store.clear).not.toHaveBeenCalled();
      expect(store.fingerprint).not.toHaveBeenCalled();
    });

    it("drops the token even when a re-sign-in has already recreated the file", async () => {
      const own = new SessionStore(dir, { backend, trash: retireTestFile });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: own });
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));
      await fs.unlink(sessionPath);
      await other.save(withCookie("alice-token-12345678", "d2lSessionVal=alice", { capturedAt: Date.now() })); // someone signs in again

      proc.forgetSession();

      expect((proc as any).cachedToken).toBeNull();
      expect(await proc.sessionChanged()).toBe(true);
      // The next call reads the recreated file rather than serving memory.
      const load = vi.spyOn(own, "load");
      expect((await proc.getToken())?.accessToken).toBe("alice-token-12345678");
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("forgets a remembered rejection", async () => {
      const proc = startProcess();
      await other.save(tokenNamed("same-text-12345678"));
      expect(await proc.getToken("same-text-12345678")).toBeNull();

      proc.forgetSession();

      expect((await proc.getToken())?.accessToken).toBe("same-text-12345678");
    });
  });

  it("checks with a stat, never a decrypting load, on the cached hot path", async () => {
    const injected = new SessionStore(dir, { backend, trash: retireTestFile });
    const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: injected });
    await proc.setToken(tokenNamed("old-token-12345678"));
    const load = vi.spyOn(injected, "load");

    for (let i = 0; i < 5; i++) await proc.getToken();
    await proc.sessionChanged();

    expect(load).not.toHaveBeenCalled();
  });

  it("does not stat at all on a cold start whose load finds nothing", async () => {
    const store = stubStore({ fingerprint: vi.fn(async () => null) });
    const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });

    expect(await proc.getToken()).toBeNull();
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.fingerprint).not.toHaveBeenCalled();
  });

  describe("when the file's state cannot be determined", () => {
    it("does not sign the user out when the stat fails for a reason other than a missing file", async () => {
      const hybrid = stubStore({ fingerprint: () => new SessionStore(unstattablePath(dir), { backend }).fingerprint() });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: hybrid });
      await proc.setToken(tokenNamed("old-token-12345678"));

      expect((await proc.getToken())?.accessToken).toBe("old-token-12345678");
      expect(await proc.sessionChanged()).toBe(false);
      expect(hybrid.load).not.toHaveBeenCalled();
    });

    it("keeps the cached token when the injected store cannot report a fingerprint at all", async () => {
      const store = stubStore();
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await proc.setToken(tokenNamed("old-token-12345678"));

      expect((await proc.getToken())?.accessToken).toBe("old-token-12345678");
      expect(await proc.sessionChanged()).toBe(false);
    });

    it("keeps the cached token, and says the session changed, when the replaced file cannot be read", async () => {
      let fp = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));

      fp = "fp-2";
      store.load.mockRejectedValue(new Error("credential store locked"));

      expect(await proc.sessionChanged()).toBe(true);
      expect((await proc.getToken())?.accessToken).toBe("alice-token-12345678");
    });
  });

  describe("an injected store", () => {
    it("signs the manager out when the store reports the file missing", async () => {
      let fp: string | null = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await proc.setToken(tokenNamed("old-token-12345678"));
      expect((await proc.getToken())?.accessToken).toBe("old-token-12345678");

      fp = null;
      expect(await proc.getToken()).toBeNull();
    });

    it("reloads from the store when the fingerprint changes, and not otherwise", async () => {
      let fp = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));

      await proc.getToken();
      await proc.getToken();
      expect(store.load).not.toHaveBeenCalled();

      fp = "fp-2";
      store.load.mockResolvedValue(withCookie("alice-reminted-1234567", "d2lSessionVal=alice"));
      expect((await proc.getToken())?.accessToken).toBe("alice-reminted-1234567");
      expect(store.load).toHaveBeenCalledTimes(1);

      await proc.getToken(); // fingerprint recorded; no further reload
      expect(store.load).toHaveBeenCalledTimes(1);
    });

    it("treats a file that vanished between the stat and the reload as signed out", async () => {
      let fp = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await proc.setToken(withCookie("alice-token-12345678", "d2lSessionVal=alice"));

      fp = "fp-2";
      store.load.mockResolvedValue(null);

      expect(await proc.getToken()).toBeNull();
      expect(await proc.sessionChanged()).toBe(true);
    });
  });

  describe("a signed-out session while a mint is in flight", () => {
    const expiredWithCookies = (): TokenData => ({
      ...withCookie("expired-token-123456", "d2lSessionVal=expired"),
      expiresAt: Date.now() - 1000,
    });

    it("returns null, not a refresh error, when the file is deleted during the mint", async () => {
      const mint = vi.fn<MintFn>(async () => {
        await fs.unlink(sessionPath);
        return { ok: true, accessToken: "fresh-jwt" } as const;
      });
      const proc = startProcess({ mint });
      await proc.setToken(expiredWithCookies());

      expect(await proc.getToken()).toBeNull();
      expect(mint).toHaveBeenCalledTimes(1);
      expect(await fs.stat(sessionPath).catch(() => null)).toBeNull(); // not resurrected
    });

    it("returns null when the file is deleted during a mint that reports the cookie expired", async () => {
      const mint = vi.fn<MintFn>(async () => {
        await fs.unlink(sessionPath);
        return { ok: false, reason: "sessionExpired" } as const;
      });
      const proc = startProcess({ mint });
      await proc.setToken(expiredWithCookies());

      expect(await proc.getToken()).toBeNull();
    });

    it("returns null when the file disappears between the post-mint read and the save", async () => {
      const stale = expiredWithCookies();
      const store = stubStore({
        saveIfCurrent: vi.fn(async () => false),
      });
      store.load.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue(null);
      const mint = vi.fn<MintFn>(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store, mint });

      expect(await proc.getToken()).toBeNull();
    });

    it("still reports a refresh error when the replacement exists but cannot be used", async () => {
      const stale = expiredWithCookies();
      const unusable = { ...stale, accessToken: "replaced-expired-12", capturedAt: stale.capturedAt + 1 };
      const store = stubStore({ saveIfCurrent: vi.fn(async () => false) });
      store.load.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue(unusable);
      const mint = vi.fn<MintFn>(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const proc = new TokenManager({ baseUrl: BASE_URL, sessionStore: store, mint });

      await expect(proc.getToken()).rejects.toBeInstanceOf(TokenRefreshError);
    });
  });
});
