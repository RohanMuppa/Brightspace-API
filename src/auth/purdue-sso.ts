/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT : see LICENSE file for details.
 */

import type { Locator, Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { AutomaticCodeAuthenticationError, MfaApprovalError, UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RequestMfaCode } from "./sso-flow.js";
import { DuoMfaHandler } from "./duo-mfa.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { generateTotp, secondsUntilFreshCode } from "./totp.js";

const EMAIL_SELECTORS = ["input[type=email]", "input[name=loginfmt]"];
const PASSWORD_SELECTORS = ["input[type=password]", "input[name=passwd]"];
const SUBMIT_SELECTORS = ["#idSIButton9", "input[type=submit]", "button[type=submit]"];
const FIELD_TIMEOUT_MS = 30_000;
const FIELD_POLL_MS = 250;

/**
 * Entra's number-match digits. The tenant shows a two-digit number that has to
 * be typed into Microsoft Authenticator, and nothing else on the machine
 * reveals it, so a headless run stalls forever unless this is scraped and
 * logged. Plain DOM text, no OCR.
 */
const NUMBER_MATCH_SELECTOR = "#idRichContext_DisplaySign";

/**
 * Microsoft's passwordless phone sign-in view ("Approve sign in request"),
 * which the tenant shows instead of a password page once the account has
 * registered passwordless sign-in in Authenticator. The number shown there is
 * typed into Authenticator like number match.
 */
const PASSWORDLESS_NUMBER_SELECTOR = "#idRemoteNGC_DisplaySign";
const PASSWORDLESS_APPROVAL_SELECTORS = [
  PASSWORDLESS_NUMBER_SELECTOR,
  "#idDiv_RemoteNGC_PollingDescription",
];
const MFA_CODE_SELECTORS = ["#idTxtBx_SAOTCC_OTC", 'input[name="otc"]'];
const MFA_CODE_SUBMIT_SELECTORS = ["#idSubmit_SAOTCC_Continue", "#idSIButton9"];
/**
 * Entra's "You didn't enter the expected verification code" message. A wrong
 * code does not navigate anywhere: the field stays put and this appears.
 */
const MFA_CODE_ERROR_SELECTOR = "#idSpan_SAOTCC_Error_OTC";
/** Rejected codes allowed per login before giving up instead of re-asking. */
const MAX_MFA_CODE_REJECTIONS = 3;
/**
 * Polls after a submission before an error message that was already on
 * screen at submit time (left over from the previous wrong code, and never
 * hidden in between) is believed to be the verdict on the new code.
 */
const MFA_CODE_VERDICT_SETTLE_POLLS = 3;

/** How often to look for the number while waiting on MFA. */
const NUMBER_MATCH_POLL_MS = 2000;

/** A person has to find their phone, unlock it, and read a prompt. */
const MFA_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Entra's own labels for reaching the verification-code form. Clicked only
 * when an authenticator enrollment is saved, and each at most once per login,
 * so this can never loop between method pages. The exact-match code label is
 * tried first; the vaguer "another way" links only open the method list.
 * Ported from ElliotDrel/brightspace-mcp-server (branch codex/purdue-totp).
 */
const CODE_METHOD_STEPS = [
  ["code", /^use a verification code$/i],
  ["other", /^(?:I can.t use my .+ right now|sign in another way|use a different verification option)$/i],
] as const;

/** Let Entra re-render the method page before the loop looks at it again. */
const METHOD_SWITCH_SETTLE_MS = 500;

/**
 * Never submit a code with less life than this left: Entra validates a moment
 * after the click, and a code that rolls over in between is rejected — which
 * would spend one of the rejection attempts for nothing.
 */
const MIN_CODE_LIFETIME_S = 5;

/**
 * How long an automatic code sign-in runs before it tells the caller it is
 * working. Long enough that a quick sign-in never reports anything, short
 * enough to answer inside a client's request timeout.
 */
const AUTOMATIC_PENDING_NOTICE_MS = 15_000;

/**
 * How long Entra gets to offer a way to switch to a verification code before
 * this flow gives up on typing one and waits for a phone approval like any
 * other login. A tenant can show a challenge with no code method at all; the
 * alternative to this fallback is polling a page nothing will ever click for
 * the full five minutes.
 */
const AUTOMATIC_FALLBACK_MS = 30_000;

/** Where Entra prints the account it believes is signing in. */
const ACCOUNT_LABEL_SELECTORS = ["#displayName", "#signInName", "#userDisplayName"];

interface PurdueSSOConfig {
  username?: string;
  password?: string;
  baseUrl?: string;
  headless?: boolean;
  /** Sign in with the username and Microsoft's phone approval alone. Opt-in: D2L_PASSWORDLESS=true. */
  passwordless?: boolean;
  /**
   * The account's saved authenticator enrollment. Present only when the user
   * saved one; absent means this flow behaves exactly as it did before, down
   * to the page queries it makes.
   */
  totpUri?: string;
  requestMfaCode?: RequestMfaCode;
  /**
   * Fired once per login as soon as an MFA challenge is visible: with the
   * number-match digits when one is already on screen, otherwise null. If a
   * number later appears after a null firing, this fires once more with it —
   * that is the only case it fires twice. Lets a caller (AuthRunner) answer
   * the user immediately instead of blocking for the whole 5-minute approval
   * wait, even on tenants that never show a number.
   */
  onMfaChallenge?: (number: string | null) => void;
  /**
   * Fired once per login when an automatic code sign-in has been running long
   * enough to be worth reporting. Distinct from onMfaChallenge because no
   * approval was requested: the caller must say "still signing in", never
   * "check your phone".
   */
  onAutomaticPending?: () => void;
}

/** Microsoft expects Purdue's full sign-in name, while setup also accepts a career account. */
function signInName(username: string, baseUrl?: string): string {
  const isPurdue = baseUrl && new URL(baseUrl).hostname.toLowerCase() === "purdue.brightspace.com";
  return isPurdue && !username.includes("@") ? `${username}@purdue.edu` : username;
}

export class PurdueSSOFlow {
  private config: PurdueSSOConfig;
  private accountHintSubmitted = false;
  /** One authenticator code at a time. See submitMfaCode. */
  private mfaCodeSubmitted = false;
  /**
   * The last submitted code still awaits Microsoft's verdict. Cleared the
   * first time a rejection is read, so one error message is counted once.
   */
  private mfaCodePending = false;
  /** The error message was already visible right after the last submission. */
  private mfaCodeErrorAtSubmit = false;
  /** The error message has been seen hidden since the last submission. */
  private mfaCodeErrorClearedSinceSubmit = false;
  /** Polls spent waiting on the last submission's verdict. */
  private mfaCodePollsSinceSubmit = 0;
  private mfaCodeRejections = 0;
  /** Method-switch controls already clicked this login; each is clicked at most once. */
  private readonly methodClicked = new Set<string>();
  /** An automatic code has been submitted at least once this login. See selectCodeMethod. */
  private automaticCodeSubmittedOnce = false;
  private readonly duoMfa: DuoMfaHandler;

  constructor(config: PurdueSSOConfig) {
    this.config = config;
    this.duoMfa = new DuoMfaHandler(config);
  }

  /**
   * Returns true if credentials are available for automated SSO login.
   */
  hasCredentials(): boolean {
    return Boolean(this.config.username && (this.config.password || this.config.passwordless));
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.handleCampusSelector(page);
  }

  /** First half of Brightspace Bar's choreography, with no password access. */
  async identifyAccount(page: Page): Promise<boolean> {
    if (!this.config.username) return false;
    const email = signInName(this.config.username, this.config.baseUrl);
    if (!await this.fillWhenReady(page, EMAIL_SELECTORS, email)) return false;
    if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) return false;
    this.accountHintSubmitted = true;
    return true;
  }

  /**
   * Execute the complete Microsoft Entra ID SSO login flow for Purdue.
   * Handles the school selector, saved credentials, device MFA approval, and stay-signed-in.
   *
   * @param page - Playwright page instance (already navigated to Brightspace or redirected to login)
   * @returns true after reaching Brightspace home; failures are typed errors
   */
  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting SSO login flow");

      // Step 1: Handle campus selector on purdue.brightspace.com/d2l/login
      await this.handleCampusSelector(page);

      // Restored Microsoft state can lead directly to MFA or stay-signed-in.
      const postCredential = await this.hasPostCredentialChallenge(page);
      const kmsi = await page.getByText("Stay signed in?").first().isVisible().catch(() => false);
      if (!page.url().includes("/d2l/home") && !postCredential && !kmsi) await this.enterCredentials(page);

      // Wait for device approval and print Microsoft's number match.
      await this.handleMFA(page);

      return true;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new UnsupportedAuthenticationError("The identity provider could not complete automatic sign-in. Check saved credentials and supported MFA settings.", error as Error);
    }
  }

  private async handleCampusSelector(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl.includes("purdue.brightspace.com") && currentUrl.includes("/d2l/login")) {
      // Follow the live Purdue control first, as Brightspace Bar does, so a
      // tenant-side destination change does not leave this client behind.
      const campus = page.getByText(/Purdue West Lafayette/i).first();
      if (await campus.isVisible().catch(() => false)) {
        log("INFO", "Campus selector detected : selecting Purdue West Lafayette");
        await campus.click();
        return;
      }

      // Retain the known endpoint as a fallback if the control has not rendered.
      const baseUrl = new URL(currentUrl).origin;
      log("INFO", "Campus selector detected : navigating directly to Shibboleth IdP");
      await page.goto(
        `${baseUrl}/d2l/lp/auth/saml/initiate-login?entityId=https://idp.purdue.edu/idp/shibboleth`,
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
    }
    // Already on sso.purdue.edu or past the campus selector : nothing to do
  }

  private async enterCredentials(page: Page): Promise<void> {
    if (!this.config.username) throw new BrowserAuthError("Username is required for SSO login", "credentials");
    if (!this.config.password && !this.config.passwordless) throw new BrowserAuthError("Password is required for SSO login", "credentials");

    log("INFO", "Entering credentials");
    // A submitted account hint only counts once Microsoft has actually left the
    // email step. It keeps that field on screen whenever it rejects the hint,
    // and clickWhenReady swallows a click that never landed on purpose (Entra
    // normally detaches the button after navigating), so identifyAccount can
    // report a success the page never granted. Skipping the email step there
    // spends the whole password timeout on a page still asking for a username
    // and then blames a missing password field.
    const hintAccepted = this.accountHintSubmitted && !await this.anyVisible(page, EMAIL_SELECTORS);
    this.accountHintSubmitted = false;
    if (!hintAccepted) {
      const email = signInName(this.config.username, this.config.baseUrl);
      if (!await this.fillWhenReady(page, EMAIL_SELECTORS, email)) {
        throw new UnsupportedAuthenticationError("The Microsoft email field did not appear. Automatic sign-in cannot continue.");
      }
      if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
        throw new UnsupportedAuthenticationError("The Microsoft email submit button did not appear. Automatic sign-in cannot continue.");
      }
    }
    // Passwordless: Microsoft answers the username with its approval view,
    // which handleMFA waits on like any other phone approval.
    if (!this.config.password) return;
    if (!await this.fillWhenReady(page, PASSWORD_SELECTORS, this.config.password)) {
      throw new UnsupportedAuthenticationError("The Microsoft password field did not appear. Automatic sign-in cannot continue.");
    }
    if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
      throw new UnsupportedAuthenticationError("The Microsoft password submit button did not appear. Automatic sign-in cannot continue.");
    }
  }

  /** Ported from Brightspace Bar's proven four-step Entra choreography. */
  private async actWhenReady(page: Page, selectors: string[], act: (target: Locator) => Promise<void>): Promise<boolean> {
    const deadline = Date.now() + FIELD_TIMEOUT_MS;
    do {
      for (const selector of selectors) {
        const target = page.locator(selector).first();
        if (await target.isVisible().catch(() => false)) {
          await act(target);
          return true;
        }
      }
      await page.waitForTimeout(FIELD_POLL_MS);
    } while (Date.now() < deadline);
    return false;
  }

  private async fillWhenReady(page: Page, selectors: string[], value: string): Promise<boolean> {
    return this.actWhenReady(page, selectors, target => target.fill(value));
  }

  private async clickWhenReady(page: Page, selectors: string[]): Promise<boolean> {
    // Entra often detaches the button after the click has already navigated.
    return this.actWhenReady(page, selectors, target => target.click().catch(() => {}));
  }

  /** Match Brightspace Bar's selector loop instead of trusting the first DOM match. */
  private async anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async hasPostCredentialChallenge(page: Page): Promise<boolean> {
    return this.duoMfa.isChallenge(page) || await this.anyVisible(page, [
      NUMBER_MATCH_SELECTOR,
      "#idDiv_SAOTCAS_Title",
      "#idDiv_SAOTCC_Title",
      "#KmsiCheckboxField",
      ...PASSWORDLESS_APPROVAL_SELECTORS,
    ]);
  }

  /**
   * Microsoft asked for a password, but passwordless sign-in left none saved:
   * a tenant can still ask for one (an unregistered method, a policy change),
   * and waiting out the 5-minute MFA timeout on a field nothing can fill
   * would only confuse the real cause.
   */
  private requirePasswordlessApproval(): never {
    throw new UnsupportedAuthenticationError(
      "Microsoft asked for a password, but passwordless sign-in is on (D2L_PASSWORDLESS, or passwordless in config.json), so none is saved. " +
      "Register passwordless phone sign-in in Microsoft Authenticator, or turn passwordless off and save a password with setup.",
    );
  }

  /** Brightspace Bar's bounded number/auth/KMSI polling loop. */
  private async handleMFA(page: Page): Promise<void> {
    if (!this.config.baseUrl) {
      throw new UnsupportedAuthenticationError("A school URL is required to verify authentication.");
    }
    const startedAt = Date.now();
    const deadline = startedAt + MFA_TIMEOUT_MS;
    let challenged = false;
    let announced: string | null = null;
    /** True once onMfaChallenge has been told about this login, number or not. */
    let announcedToCaller = false;
    /**
     * True once this login has told the user to go approve something. Only
     * then is a timeout really a missed approval; an automatic code sign-in
     * that stalls must not be reported as one.
     */
    let manualChallenged = false;
    /** True once automatic code entry applied to a poll of this login. */
    let automaticEngaged = false;
    /** True once onAutomaticPending has reported this login. */
    let automaticAnnounced = false;
    /**
     * True once Entra has had AUTOMATIC_FALLBACK_MS to offer a way to switch
     * to a verification code and offered none. One-way: from then on this
     * login announces and waits exactly as it would with no enrollment saved.
     */
    let methodSwitchExhausted = false;
    /** True once Duo answered a challenge: Duo's codes are not Entra's. */
    let duoChallengeObserved = false;
    try {
      while (Date.now() < deadline) {
        // A verified session outranks whatever challenge controls linger on
        // screen: answering them would prompt or announce for nothing.
        if (await this.isAuthenticated(page)) {
          log("INFO", "Login successful - verified Brightspace home");
          return;
        }
        if (await this.duoMfa.handle(page)) {
          challenged = true;
          manualChallenged = true;
          duoChallengeObserved = true;
        }
        // Whether this poll may answer the challenge itself. Recomputed every
        // poll, because the page — and so the identity provider and method on
        // screen — can change under us.
        const automatic = await this.automaticCodeApplicable(page, duoChallengeObserved, methodSwitchExhausted);
        if (automatic) automaticEngaged = true;
        if (await this.submitMfaCode(page, automatic)) challenged = true;
        const switched = automatic ? await this.selectCodeMethod(page) : "skipped";
        if (switched === "clicked") {
          await page.waitForTimeout(METHOD_SWITCH_SETTLE_MS);
          continue;
        }
        /** False while this poll is answering the challenge on the user's behalf. */
        const manualRequired = !automatic;
        const number = await this.readNumberMatch(page);
        const challengeVisible = number !== null ||
          await page.locator("#idDiv_SAOTCAS_Title").first().isVisible().catch(() => false) ||
          await page.locator("#idDiv_SAOTCC_Title").first().isVisible().catch(() => false) ||
          await this.anyVisible(page, PASSWORDLESS_APPROVAL_SELECTORS);
        // Entra showed a challenge but never a way to type a code. Stop
        // waiting for one and fall back to the announce-and-approve path this
        // flow has always used, rather than polling a dead page for 5 minutes.
        if (switched === "noSwitch" && challengeVisible && Date.now() - startedAt >= AUTOMATIC_FALLBACK_MS) {
          methodSwitchExhausted = true;
          log("WARN", "Microsoft offered no way to enter a verification code; waiting for approval on your device instead.");
        }
        // With no password saved, a password page can only end in a timeout.
        if (this.config.passwordless && !this.config.password && !challengeVisible && await this.anyVisible(page, PASSWORD_SELECTORS)) {
          this.requirePasswordlessApproval();
        }
        if (challengeVisible && !challenged && manualRequired) {
          challenged = true;
          manualChallenged = true;
          log("WARN", "Waiting up to 5 minutes for Microsoft MFA approval on your device.");
          this.config.onMfaChallenge?.(number);
          if (number) announcedToCaller = true;
        }
        if (number && number !== announced && manualRequired) {
          announced = number;
          log("WARN", `Number match: ${number}. Enter it in Microsoft Authenticator.`);
          if (!announcedToCaller) {
            announcedToCaller = true;
            this.config.onMfaChallenge?.(number);
          }
        }
        if (automatic && !automaticAnnounced && Date.now() - startedAt >= AUTOMATIC_PENDING_NOTICE_MS) {
          automaticAnnounced = true;
          this.config.onAutomaticPending?.();
        }
        await this.clickProvenKmsi(page);
        await page.waitForTimeout(NUMBER_MATCH_POLL_MS);
      }
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      // An automatic sign-in that never asked the user for anything is not a
      // missed approval, so it must not be reported as one — unless this
      // login fell back and really did ask (manualChallenged).
      if (automaticEngaged && !manualChallenged) {
        throw new AutomaticCodeAuthenticationError("Automatic code sign-in stopped before Brightspace was verified.", error as Error);
      }
      if (challenged) throw new MfaApprovalError(error as Error, announced ?? undefined);
      throw new UnsupportedAuthenticationError("Automatic sign-in stopped before a supported MFA challenge completed.", error as Error);
    }
    if (automaticEngaged && !manualChallenged) {
      throw new AutomaticCodeAuthenticationError("Automatic code sign-in did not reach a verified Brightspace session within 5 minutes.");
    }
    if (challenged) throw new MfaApprovalError(undefined, announced ?? undefined);
    throw new UnsupportedAuthenticationError("Sign-in did not reach a supported MFA challenge or Brightspace within 5 minutes.");
  }

  /**
   * Submit a verification code, from the saved enrollment when `automatic` is
   * set and otherwise from the user at the terminal. `automatic` is decided
   * per poll by automaticCodeApplicable; with no enrollment saved it is always
   * false and every line below behaves as it did before.
   */
  private async submitMfaCode(page: Page, automatic = false): Promise<boolean> {
    const input = await this.firstVisible(page, MFA_CODE_SELECTORS);
    if (!input) return false;
    // A visible browser leaves code entry to the user — unless the code can be
    // generated here, in which case there is nothing for them to type.
    if (this.config.headless === false && !automatic) return false;
    const isRetry = await this.mfaCodeRejected(page);
    if (isRetry) {
      this.mfaCodeRejections += 1;
      if (this.mfaCodeRejections >= MAX_MFA_CODE_REJECTIONS) {
        throw new MfaApprovalError(
          undefined,
          undefined,
          `Microsoft rejected ${this.mfaCodeRejections} authenticator codes in a row. Run ${AUTH_COMMAND} to try again.`,
        );
      }
      log(
        "WARN",
        automatic
          ? "Microsoft rejected the code; waiting for a fresh one before retrying."
          : `Microsoft rejected the authenticator code. Enter a new code (attempt ${this.mfaCodeRejections + 1} of ${MAX_MFA_CODE_REJECTIONS}).`,
      );
      this.mfaCodeSubmitted = false;
      await input.fill("");
    }
    // Ask once per code. This runs on every two-second poll, and Microsoft
    // commonly leaves the field on screen while it validates, so without this
    // a correct code gets a second prompt on the next tick. That prompt blocks
    // on stdin, and the deadline is only checked between iterations, so the
    // five-minute budget can never fire while parked there.
    if (this.mfaCodeSubmitted) return false;
    let code: string;
    if (automatic) {
      // Refuse to type a code to a page that is not showing this account.
      await this.assertExpectedMicrosoftAccount(page);
      // Resubmitting the rejected code would be rejected again, and a code in
      // its last seconds expires while Entra validates it, so wait out the
      // rest of the period in both cases. Entra's own form stays on screen
      // meanwhile, and the 5-minute budget is checked between polls.
      const remaining = secondsUntilFreshCode(this.config.totpUri!);
      if (isRetry || remaining < MIN_CODE_LIFETIME_S) {
        await page.waitForTimeout(Math.ceil(remaining * 1000) + 100);
      }
      code = generateTotp(this.config.totpUri!);
    } else {
      if (!this.config.requestMfaCode) {
        throw new UnsupportedAuthenticationError(
          `This MFA method requires a code. Run \`${AUTH_COMMAND}\` in a terminal to enter it.`,
        );
      }
      code = await this.config.requestMfaCode();
    }
    if (!/^\d{6,8}$/.test(code)) throw new UnsupportedAuthenticationError("The MFA code must contain 6-8 digits.");
    await input.fill(code);
    const submit = await this.firstVisible(page, MFA_CODE_SUBMIT_SELECTORS);
    if (submit) await submit.click();
    else await input.press("Enter");
    // Only a code that actually reached Microsoft counts as submitted.
    this.mfaCodeSubmitted = true;
    this.mfaCodePending = true;
    this.mfaCodeErrorAtSubmit = await this.anyVisible(page, [MFA_CODE_ERROR_SELECTOR]);
    this.mfaCodeErrorClearedSinceSubmit = false;
    this.mfaCodePollsSinceSubmit = 0;
    if (automatic) this.automaticCodeSubmittedOnce = true;
    log("INFO", "Authenticator code submitted");
    return true;
  }

  /**
   * Whether this poll may answer the challenge from the saved enrollment.
   *
   * Gated on the identity provider and the challenge on screen, never on a
   * school's URL: only Microsoft Entra's verification-code form is driven
   * here, so the test is whether Entra is the page in front of us.
   *
   * - no saved enrollment: always false, and not one extra page query is made
   * - Duo answered a challenge: Duo codes come from a different enrollment
   * - Entra's passwordless approval view: the phone IS the first factor there,
   *   and a code cannot stand in for it
   * - Entra never offered a code method: fall back to announce-and-approve
   */
  private async automaticCodeApplicable(page: Page, duoObserved: boolean, exhausted: boolean): Promise<boolean> {
    if (!this.config.totpUri || duoObserved || exhausted) return false;
    if (new URL(page.url()).hostname !== "login.microsoftonline.com") return false;
    return !await this.anyVisible(page, PASSWORDLESS_APPROVAL_SELECTORS);
  }

  /**
   * Move Entra from whatever method it defaulted to onto its verification-code
   * form, one control per login at most.
   *
   * - `codeForm`: the form is already up; submitMfaCode owns it
   * - `spent`: a code has already been submitted, so nothing more to switch to
   * - `clicked`: a method control was clicked; re-poll the new page
   * - `noSwitch`: Entra is offering no way to reach a code
   */
  private async selectCodeMethod(page: Page): Promise<"codeForm" | "spent" | "clicked" | "noSwitch"> {
    if (await this.firstVisible(page, MFA_CODE_SELECTORS)) return "codeForm";
    if (this.automaticCodeSubmittedOnce) return "spent";
    await this.assertExpectedMicrosoftAccount(page);
    for (const [step, label] of CODE_METHOD_STEPS) {
      if (this.methodClicked.has(step)) continue;
      const control = page.getByText(label).first();
      if (!await control.isVisible().catch(() => false)) continue;
      this.methodClicked.add(step);
      await control.click();
      return "clicked";
    }
    return "noSwitch";
  }

  /**
   * Refuse to drive Entra's method pages, or type a code into them, unless
   * this really is Microsoft showing the account we are signing in as. A code
   * typed into someone else's session is a second factor handed to them.
   */
  private async assertExpectedMicrosoftAccount(page: Page): Promise<void> {
    if (new URL(page.url()).hostname !== "login.microsoftonline.com" || !this.config.username) {
      throw new UnsupportedAuthenticationError("Automatic code entry requires Microsoft's own sign-in page and a configured account.");
    }
    const expected = signInName(this.config.username, this.config.baseUrl).toLowerCase();
    for (const selector of ACCOUNT_LABEL_SELECTORS) {
      const account = page.locator(selector).first();
      // These are alternative layouts, not required controls, and textContent()
      // auto-waits a missing element out for 30 seconds on every MFA poll.
      if (await account.count() === 0) continue;
      const value = await account.textContent({ timeout: 1000 }).catch(() => null);
      const shown = value?.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase();
      if (shown && shown !== expected) {
        throw new UnsupportedAuthenticationError("Microsoft is showing another account. Automatic code entry stopped.");
      }
    }
  }

  /**
   * True exactly once per submission that Entra rejected. A field that merely
   * lingers while a correct code is verified shows no error, so it never
   * counts. An error already on screen when the code went in is the previous
   * code's verdict until it has been hidden at least once, or has stayed up
   * for a few polls with the field still waiting.
   */
  private async mfaCodeRejected(page: Page): Promise<boolean> {
    if (!this.mfaCodePending) return false;
    this.mfaCodePollsSinceSubmit += 1;
    if (!await this.anyVisible(page, [MFA_CODE_ERROR_SELECTOR])) {
      this.mfaCodeErrorClearedSinceSubmit = true;
      return false;
    }
    const fresh = !this.mfaCodeErrorAtSubmit ||
      this.mfaCodeErrorClearedSinceSubmit ||
      this.mfaCodePollsSinceSubmit >= MFA_CODE_VERDICT_SETTLE_POLLS;
    if (!fresh) return false;
    this.mfaCodePending = false;
    return true;
  }

  private async firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
    for (const selector of selectors) {
      const target = page.locator(selector).first();
      if (await target.isVisible().catch(() => false)) return target;
    }
    return null;
  }

  /** The login shell also exposes D2L.LP, so verify origin and home as well. */
  private async isAuthenticated(page: Page): Promise<boolean> {
    try {
      const expected = new URL(this.config.baseUrl!);
      const current = new URL(page.url());
      if (current.origin !== expected.origin || !/^\/d2l\/home(?:\/|$)/.test(current.pathname)) return false;
      const cookies = await page.context().cookies(expected.origin);
      if (!cookies.some(cookie => cookie.name === "d2lSessionVal" && Boolean(cookie.value))) return false;
      return await page.evaluate(() => {
        const d2l = (window as unknown as Record<string, unknown>).D2L as Record<string, unknown> | undefined;
        return Boolean(d2l?.LP);
      });
    } catch {
      // Redirects can replace the execution context. Keep polling; this
      // verdict never causes credentials to be entered a second time.
      return false;
    }
  }

  private async clickProvenKmsi(page: Page): Promise<void> {
    if (new URL(page.url()).hostname !== "login.microsoftonline.com") return;
    const proven =
      await page.locator("#KmsiCheckboxField").first().isVisible().catch(() => false) ||
      await page.getByText("Stay signed in?").first().isVisible().catch(() => false);
    if (!proven) return;
    const yes = page.locator("#idSIButton9").first();
    if (await yes.isVisible().catch(() => false)) {
      await yes.click().catch(() => {});
      log("DEBUG", 'Clicked Yes on "Stay signed in?"');
    }
  }

  /** The digits on screen, or null when Entra is not showing any. */
  private async readNumberMatch(page: Page): Promise<string | null> {
    for (const selector of [NUMBER_MATCH_SELECTOR, PASSWORDLESS_NUMBER_SELECTOR]) {
      const sign = page.locator(selector).first();
      // isVisible answers immediately rather than waiting out a timeout, so the
      // runs that never show a number keep the poll on its two-second rhythm.
      if (!(await sign.isVisible().catch(() => false))) continue;
      const text = await sign.textContent().catch(() => null);
      const number = text?.trim();
      return number && /^\d{1,3}$/.test(number) ? number : null;
    }
    return null;
  }

}
