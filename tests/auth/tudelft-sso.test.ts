import { describe, expect, it, vi } from "vitest";
import { createSSOFlow } from "../../src/auth/sso-flow.js";
import { TUDelftSSOFlow, isTUDelftBrightspace } from "../../src/auth/tudelft-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const TUDELFT_URL = "https://brightspace.tudelft.nl";

describe("TU Delft sign-in entry point", () => {
  it("routes only TU Delft's exact Brightspace host to its handler", () => {
    expect(isTUDelftBrightspace(TUDELFT_URL)).toBe(true);
    expect(isTUDelftBrightspace(`${TUDELFT_URL}.example.org`)).toBe(false);
    expect(createSSOFlow({ baseUrl: TUDELFT_URL } as AppConfig)).toBeInstanceOf(TUDelftSSOFlow);
  });

  it("does not match lookalike or malformed hosts", () => {
    expect(isTUDelftBrightspace("https://tudelft.brightspace.com")).toBe(false);
    expect(isTUDelftBrightspace("not a url")).toBe(false);
  });

  it("selects the NetID button before the inherited sign-in flow", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: () => `${TUDELFT_URL}/d2l/login`,
      getByRole: vi.fn(() => ({ first: () => ({ isVisible: async () => true, click }) })),
    };
    await new TUDelftSSOFlow({ baseUrl: TUDELFT_URL }).prepareLogin(page as never);
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Log in with your TU Delft NetID" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not select a NetID button after leaving the login page", async () => {
    const page = { url: () => "https://engine.surfconext.nl/authentication/idp/single-sign-on", getByRole: vi.fn() };
    await new TUDelftSSOFlow({ baseUrl: TUDELFT_URL }).prepareLogin(page as never);
    expect(page.getByRole).not.toHaveBeenCalled();
  });

  it("reports an unavailable sign-in button instead of hanging", async () => {
    const page = {
      url: () => `${TUDELFT_URL}/d2l/login`,
      getByRole: vi.fn(() => ({ first: () => ({ isVisible: async () => false, click: vi.fn() }) })),
    };
    await expect(new TUDelftSSOFlow({ baseUrl: TUDELFT_URL }).prepareLogin(page as never))
      .rejects.toThrow("TU Delft's Brightspace sign-in button is unavailable.");
  });
});
