import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { AUTH_COMMAND } from "../../src/utils/commands.js";

const BASE_URL = "https://purdue.brightspace.com";
const SIGN_SELECTOR = "#idRichContext_DisplaySign";

interface PollState {
  number?: string;
  code?: boolean;
  challenge?: boolean;
  kmsi?: boolean;
  url?: string;
  cookie?: boolean;
  d2l?: boolean;
  /** Entra's "You didn't enter the expected verification code" message. */
  codeError?: boolean;
}

function captureWarnings() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("[WARN]")) lines.push(first);
  });
  return lines;
}

/** A sequence of page states driven by the same two-second poll as production. */
function makeMfaPage(states: PollState[]) {
  let poll = 0;
  const yes = vi.fn(async () => {});
  const fill = vi.fn(async () => {});
  const press = vi.fn(async () => {});
  const current = () => states[Math.min(poll, states.length - 1)] ?? {};
  const locatorTarget = (selector: string) => ({
    isVisible: async () => {
      if (selector === SIGN_SELECTOR) return current().number !== undefined;
      if (selector === "#idTxtBx_SAOTCC_OTC" || selector === 'input[name="otc"]') return Boolean(current().code);
      if (selector === "#idSubmit_SAOTCC_Continue") return Boolean(current().code);
      if (selector === "#idSpan_SAOTCC_Error_OTC") return Boolean(current().codeError);
      if (selector === "#idDiv_SAOTCAS_Title" || selector === "#idDiv_SAOTCC_Title") return Boolean(current().challenge || current().code);
      if (selector === "#KmsiCheckboxField" || selector === "#idSIButton9") return Boolean(current().kmsi);
      return false;
    },
    textContent: async () => selector === SIGN_SELECTOR ? current().number ?? null : null,
    click: yes,
    fill,
    press,
  });
  const page = {
    url: vi.fn(() => current().url ?? "https://login.microsoftonline.com/common/SAS/BeginAuth"),
    locator: vi.fn((selector: string) => ({ first: () => locatorTarget(selector) })),
    getByText: vi.fn(() => ({ first: () => ({ isVisible: async () => Boolean(current().kmsi) }) })),
    context: vi.fn(() => ({
      cookies: vi.fn(async () => current().cookie ? [{ name: "d2lSessionVal", value: "live" }] : []),
    })),
    evaluate: vi.fn(async () => Boolean(current().d2l)),
    waitForTimeout: vi.fn(async (milliseconds: number) => {
      poll += 1;
      vi.advanceTimersByTime(milliseconds);
    }),
  };
  return { page, yes, fill, press, poll: () => poll };
}

describe("Purdue MFA loop ported from Brightspace Bar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const handleMFA = (
    page: unknown,
    requestMfaCode?: () => Promise<string>,
    onMfaChallenge?: (number: string | null) => void,
  ): Promise<void> =>
    (new PurdueSSOFlow({ baseUrl: BASE_URL, requestMfaCode, onMfaChallenge }) as any).handleMFA(page);

  it("logs a number once per change and stops only at verified Brightspace home", async () => {
    const lines = captureWarnings();
    const { page } = makeMfaPage([
      { number: "42", challenge: true },
      { number: "42", challenge: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    const numbers = lines.filter(line => line.includes("Number match:"));
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toContain("Number match: 42.");
    expect(numbers[1]).toContain("Number match: 73.");
  });

  it("reports onMfaChallenge once when a number is already visible on the first poll", async () => {
    const onMfaChallenge = vi.fn();
    const { page } = makeMfaPage([
      { number: "42", challenge: true },
      { number: "42", challenge: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect(onMfaChallenge).toHaveBeenCalledTimes(1);
    expect(onMfaChallenge).toHaveBeenCalledWith("42");
  });

  it("reports onMfaChallenge with null first, then once more when a number later appears", async () => {
    const onMfaChallenge = vi.fn();
    const { page } = makeMfaPage([
      { challenge: true },
      { challenge: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect(onMfaChallenge).toHaveBeenCalledTimes(2);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(1, null);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(2, "73");
  });

  it("clicks Yes only on a proven stay-signed-in page", async () => {
    const { page, yes } = makeMfaPage([
      { kmsi: true, url: "https://login.microsoftonline.com/common/kmsi" },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    expect(yes).toHaveBeenCalledOnce();
  });

  it("submits an authenticator code without exposing it in logs", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill, yes } = makeMfaPage([
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(requestMfaCode).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledWith("123456");
    expect(yes).toHaveBeenCalledOnce();
  });

  it("directs non-interactive authentication to the CLI when a code is required", async () => {
    const { page, poll } = makeMfaPage([{ code: true }]);
    // Must be the pinned command. An untagged npx invocation runs whatever old
    // global copy is on PATH, which is how a healthy server once sent someone
    // into a stale build that could not sign in at all.
    await expect(handleMFA(page)).rejects.toThrow(`Run \`${AUTH_COMMAND}\``);
    expect(poll()).toBe(0);
  });

  it("asks for a code once even if the field lingers while Microsoft validates", async () => {
    // Microsoft often leaves the OTC input on screen for a few seconds after
    // submit. The poll must not read that as "ask them again".
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill } = makeMfaPage([
      { code: true },
      { code: true },
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(requestMfaCode).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledOnce();
  });

  it("completes a verified Brightspace home without announcing stale challenge controls", async () => {
    const lines = captureWarnings();
    const onMfaChallenge = vi.fn();
    const { page } = makeMfaPage([
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true, number: "42", challenge: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect({ warnings: lines, onMfaChallenge: onMfaChallenge.mock.calls }).toEqual({ warnings: [], onMfaChallenge: [] });
  });

  it("does not ask for a code when a verified Brightspace home still shows a stale code field", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill } = makeMfaPage([
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true, code: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(requestMfaCode).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it("does not click stay-signed-in controls once Brightspace home is verified", async () => {
    const { page, yes } = makeMfaPage([
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true, kmsi: true },
    ]);
    await handleMFA(page);
    expect(yes).not.toHaveBeenCalled();
  });

  it("marks the code submitted only after it was filled and submitted", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const flow = new PurdueSSOFlow({ baseUrl: BASE_URL, requestMfaCode }) as any;
    const { page, fill } = makeMfaPage([{ code: true }]);
    fill.mockRejectedValueOnce(new Error("detached"));
    await expect(flow.handleMFA(page)).rejects.toThrow();
    expect(flow.mfaCodeSubmitted).toBe(false);
  });

  describe("rejected authenticator codes", () => {
    const codes = (...values: string[]) => {
      let index = 0;
      return vi.fn(async () => values[Math.min(index++, values.length - 1)]);
    };

    it("clears the field and asks again when Entra rejects a code", async () => {
      const lines = captureWarnings();
      const requestMfaCode = codes("111111", "222222");
      const { page, fill } = makeMfaPage([
        { code: true },
        { code: true, codeError: true },
        { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
      ]);
      await handleMFA(page, requestMfaCode);
      expect(requestMfaCode).toHaveBeenCalledTimes(2);
      expect(fill.mock.calls).toEqual([["111111"], [""], ["222222"]]);
      expect(lines.filter(line => line.includes("rejected the authenticator code"))).toHaveLength(1);
    });

    it("does not count the previous code's error again while the new code is verified", async () => {
      // Entra may leave the old message up for a moment after the new submit.
      const requestMfaCode = codes("111111", "222222");
      const { page } = makeMfaPage([
        { code: true },
        { code: true, codeError: true },
        { code: true, codeError: true },
        { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
      ]);
      await handleMFA(page, requestMfaCode);
      expect(requestMfaCode).toHaveBeenCalledTimes(2);
    });

    it("counts a fresh rejection as soon as the old message was hidden in between", async () => {
      const requestMfaCode = codes("111111", "222222", "333333");
      const { page } = makeMfaPage([
        { code: true },
        { code: true, codeError: true },
        { code: true },
        { code: true, codeError: true },
        { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
      ]);
      await handleMFA(page, requestMfaCode);
      expect(requestMfaCode).toHaveBeenCalledTimes(3);
    });

    it("ignores an error message that was on screen before any code was submitted", async () => {
      const requestMfaCode = codes("111111");
      const { page } = makeMfaPage([
        { code: true, codeError: true },
        { code: true, codeError: true },
        { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
      ]);
      await handleMFA(page, requestMfaCode);
      expect(requestMfaCode).toHaveBeenCalledOnce();
    });

    it("gives up after three rejected codes instead of waiting out the five minutes", async () => {
      captureWarnings();
      const requestMfaCode = codes("111111", "222222", "333333", "444444");
      const { page, poll } = makeMfaPage([
        { code: true },
        { code: true, codeError: true },
      ]);
      const failure = handleMFA(page, requestMfaCode);
      await expect(failure).rejects.toBeInstanceOf(MfaApprovalError);
      await expect(failure).rejects.toThrow("rejected 3 authenticator codes");
      expect(requestMfaCode).toHaveBeenCalledTimes(3);
      expect(poll()).toBeLessThan(10);
    });
  });

  it("leaves code entry to the user when the browser is visible", async () => {
    const { page, fill } = makeMfaPage([
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await (new PurdueSSOFlow({ baseUrl: BASE_URL, headless: false }) as any).handleMFA(page);
    expect(fill).not.toHaveBeenCalled();
  });

  it("rejects the login shell even when it has a cookie and D2L.LP", async () => {
    const { page, poll } = makeMfaPage([
      { url: `${BASE_URL}/d2l/login`, cookie: true, d2l: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    expect(poll()).toBe(1);
  });

  it("classifies an observed challenge timeout as failed MFA", async () => {
    captureWarnings();
    const { page } = makeMfaPage([{ number: "18", challenge: true }]);
    await expect(handleMFA(page)).rejects.toBeInstanceOf(MfaApprovalError);
  });

  it("carries the last announced number-match digits on a timed-out challenge", async () => {
    captureWarnings();
    const { page } = makeMfaPage([
      { number: "18", challenge: true },
      { number: "73", challenge: true },
    ]);
    await expect(handleMFA(page)).rejects.toMatchObject({ numberMatch: "73" });
  });

  it("classifies a timeout with no challenge as unsupported instead of failed MFA", async () => {
    const { page } = makeMfaPage([{}]);
    await expect(handleMFA(page)).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
  });
});
