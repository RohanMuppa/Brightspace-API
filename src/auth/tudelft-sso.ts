/** TU Delft login entry point. Licensed under MIT; see LICENSE. */

import type { Page } from "playwright";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";

const TUDELFT_HOST = "brightspace.tudelft.nl";

export function isTUDelftBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === TUDELFT_HOST;
  } catch {
    return false;
  }
}

/**
 * TU Delft signs students and staff in with their NetID through SURFconext.
 * Reuse the shared credential and MFA flow; only TU Delft's first click
 * (into SURFconext, which hands straight back to TU Delft's own IdP) differs.
 */
export class TUDelftSSOFlow {
  private readonly common: PurdueSSOFlow;

  constructor(config: ConstructorParameters<typeof PurdueSSOFlow>[0]) {
    this.common = new PurdueSSOFlow(config);
  }

  hasCredentials(): boolean {
    return this.common.hasCredentials();
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.startTUDelftLogin(page);
  }

  async identifyAccount(page: Page): Promise<boolean> {
    return this.common.identifyAccount(page);
  }

  async login(page: Page): Promise<boolean> {
    await this.startTUDelftLogin(page);
    return this.common.login(page);
  }

  private async startTUDelftLogin(page: Page): Promise<void> {
    let current: URL;
    try {
      current = new URL(page.url());
    } catch {
      return;
    }
    if (current.hostname.toLowerCase() !== TUDELFT_HOST || !current.pathname.includes("/d2l/login")) return;

    const button = page.getByRole("button", { name: "Log in with your TU Delft NetID" }).first();
    if (!await button.isVisible().catch(() => false)) {
      throw new UnsupportedAuthenticationError("TU Delft's Brightspace sign-in button is unavailable.");
    }
    await button.click();
  }
}
