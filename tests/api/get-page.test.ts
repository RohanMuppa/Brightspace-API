import { describe, it, expect, vi, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * Brightspace web pages (an LTI quickLink, a tool launch) check the session
 * cookie and ignore a Bearer token, so getPage() sends the stored cookie.
 * A read-only page fetch is never worth an MFA prompt, so it never logs in,
 * and the cookie never leaves the configured Brightspace origin.
 */

const BASE = "https://purdue.brightspace.com";
const SESSION_COOKIE = "d2lSessionVal=abc; d2lSecureSessionVal=def";
const EXPIRED_STUB =
  '<html><head><script>window.location.replace("/d2l/login?sessionExpired=1");</script></head></html>';

const browserToken = (overrides: Partial<TokenData> = {}): TokenData => ({
  accessToken: "eyJ.jwt.sig",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
  cookieHeader: SESSION_COOKIE,
  ...overrides,
});

function makeClient(token: TokenData) {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const tokenManager = { getToken: vi.fn(async () => token) } as unknown as TokenManager;
  const onAuthExpired = vi.fn(async () => true);
  const client = new D2LApiClient({
    baseUrl: BASE,
    tokenManager,
    onAuthExpired,
    retry: { maxAttempts: 1 },
  });
  return { client, fetchMock, onAuthExpired };
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("D2LApiClient.getPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the session cookie and no Bearer token, without letting fetch follow redirects", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html("<html>launch</html>"));

    const page = await client.getPage("/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X");

    expect(page).toEqual({ html: "<html>launch</html>" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X`);
    expect(init.headers.Cookie).toBe(SESSION_COOKIE);
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe("manual");
  });

  it("returns null without a request when no session cookie is stored", async () => {
    const { client, fetchMock } = makeClient(browserToken({ cookieHeader: undefined }));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on the login redirect instead of opening a browser login", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html(EXPIRED_STUB));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it("returns null on a 302 to /d2l/login without requesting the login page", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(browserToken());
    fetchMock.mockResolvedValueOnce(redirect("/d2l/login?sessionExpired=1&target=x"));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it("follows a same-origin redirect with the cookie", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock
      .mockResolvedValueOnce(redirect(`${BASE}/d2l/le/lti/101/toolLaunch/77?topicId=55`))
      .mockResolvedValueOnce(html("<form></form>"));

    expect(await client.getPage("/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X")).toEqual({
      html: "<form></form>",
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/d2l/le/lti/101/toolLaunch/77?topicId=55`);
    expect(init.headers.Cookie).toBe(SESSION_COOKIE);
  });

  it("hands back a cross-origin redirect instead of following it with the cookie", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    const kaltura = "https://cdnapisec.kaltura.com/p/123456/embed?entry_id=1_abc";
    fetchMock.mockResolvedValueOnce(redirect(kaltura));

    expect(await client.getPage("/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X")).toEqual({
      redirect: kaltura,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an absolute URL on its own origin and requests only the path", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html("ok"));

    await client.getPage(`${BASE}/d2l/le/lti/101/toolLaunch/77?ou=101#frag`);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/d2l/le/lti/101/toolLaunch/77?ou=101`);
  });

  it("never sends a request to another origin", async () => {
    const { client, fetchMock } = makeClient(browserToken());

    for (const target of [
      "https://evil.example.com/d2l/le/lti/101/toolLaunch/77",
      "//evil.example.com/d2l/le/lti/101/toolLaunch/77",
      "http://purdue.brightspace.com/d2l/le/lti/101/toolLaunch/77",
    ]) {
      expect(await client.getPage(target)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:pw@purdue.brightspace.com/d2l/home",
    "https://user@purdue.brightspace.com/d2l/home",
    "https://evil.example/d2l/home",
    "/\\evil.example/d2l/home",
  ])("refuses %s without reading the cookie or sending a request", async path => {
    const { client, fetchMock } = makeClient(browserToken());
    const getToken = (client as unknown as { tokenManager: { getToken: ReturnType<typeof vi.fn> } }).tokenManager
      .getToken;

    expect(await client.getPage(path)).toBeNull();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["@evil.example/d2l/home", ".evil.example/d2l/home", ":8443/d2l/home"])(
    "resolves %s against the Brightspace origin, never another host",
    async path => {
      const { client, fetchMock } = makeClient(browserToken());
      fetchMock.mockResolvedValue(html("ok"));

      await client.getPage(path);

      for (const [url] of fetchMock.mock.calls) {
        expect(new URL(url as string).origin).toBe(BASE);
      }
    }
  );

  it("keeps session query parameters out of the error it throws", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html("forbidden", 403));

    const error = await client
      .getPage("/d2l/le/lti/101/toolLaunch/77?ou=101&d2lSessionVal=SECRET&D2LSecureSessionVal=SECRET2")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).not.toMatch(/SECRET|sessionval/i);
    expect((error as ApiError).message).toContain("ou=101");
  });
});
