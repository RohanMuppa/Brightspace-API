/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import type { AppConfig } from "../types/index.js";
import { configStoreExists, loadConfigStore, type ConfigStoreData } from "./config-store.js";
import { resolveStoredPassword } from "./secure-config.js";
import { getStoredTotpUri } from "../auth/credential-store.js";
import { canonicalUsername } from "../auth/username.js";
import { normalizeTotpEnrollment } from "../auth/totp.js";
import { migrateLegacyState } from "../auth/legacy-state.js";
import { startupPhase } from "./startup-phase.js";

export interface LoadConfigOptions {
  /**
   * Treat an unavailable native credential store as "no stored password"
   * (logged as a warning) instead of an error. Right for a read-only client:
   * a saved session needs no password, and a cron host often has no desktop
   * keyring. Wrong for setup and auth, which exist to use that store.
   */
  tolerateCredentialStore?: boolean;
}

function readConfigStore(): ConfigStoreData | null {
  const store = configStoreExists() ? loadConfigStore() : null;
  if (store) {
    console.error("[config] Loaded base config from ~/.brightspace-mcp/config.json");
  } else {
    console.error("[config] No config.json found, using environment variables");
  }
  return store;
}

/**
 * Which school and account this configuration signs in as, and where that
 * account's session lives (env > store > default for each). Shared by
 * loadConfig and by commands that need only the location, such as
 * `auth --logout`, so they can never disagree about where a session is.
 */
function resolveAccountLocation(store: ConfigStoreData | null): {
  baseUrl: string; username: string | undefined; sessionRoot: string; sessionDir: string;
} {
  const sessionRoot = process.env.D2L_SESSION_DIR
    ? expandTilde(process.env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");

  const configuredUrl = new URL(process.env.D2L_BASE_URL || store?.baseUrl || "https://purdue.brightspace.com");
  if (configuredUrl.protocol !== "https:" || configuredUrl.username || configuredUrl.password) {
    throw new Error("The Brightspace URL must be an HTTPS school URL without embedded credentials.");
  }
  const baseUrl = configuredUrl.origin;
  const username = process.env.D2L_USERNAME || store?.username;
  // A new account must never inherit another account's cookies, even at the same school.
  return { baseUrl, username, sessionRoot, sessionDir: accountSessionDirectory(sessionRoot, baseUrl, username) };
}

/**
 * Where the configured account keeps its saved session. Unlike loadConfig it
 * reads no password and migrates nothing, so it works when the credential
 * store is locked. `sessionDir` holds the account's files; `sessionRoot` is
 * the directory above any `accounts/<hash>/` layer.
 */
export function resolveSessionLocation(): { sessionDir: string; sessionRoot: string } {
  dotenv.config({ quiet: true });
  const { sessionDir, sessionRoot } = resolveAccountLocation(readConfigStore());
  return { sessionDir, sessionRoot };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  dotenv.config({ quiet: true });
  const store = readConfigStore();

  // Code-entry and other interactive MFA methods need a visible browser.
  const headless = envBoolean(process.env.D2L_HEADLESS, "D2L_HEADLESS")
    ?? store?.headless
    ?? true;

  // Resolve tokenTtl: env > store > default (3600)
  const tokenTtl = positiveSeconds(process.env.D2L_TOKEN_TTL, "D2L_TOKEN_TTL")
    ?? positiveSeconds(store?.tokenTtl, "tokenTtl in config.json")
    ?? 3600;

  // Resolve includeCourseIds: env > store > undefined
  const includeCourseIds = courseIdList(process.env.D2L_INCLUDE_COURSES, "D2L_INCLUDE_COURSES")
    ?? store?.includeCourses;

  // Resolve excludeCourseIds: env > store > undefined
  const excludeCourseIds = courseIdList(process.env.D2L_EXCLUDE_COURSES, "D2L_EXCLUDE_COURSES")
    ?? store?.excludeCourses;

  // Resolve activeOnly: env > store > default (true)
  const activeOnly = envBoolean(process.env.D2L_ACTIVE_ONLY, "D2L_ACTIVE_ONLY")
    ?? store?.activeOnly
    ?? true;

  // Opt-in: sign in with Microsoft's passwordless phone approval, so no
  // password is read or saved. Every sign-in then needs the phone, which is
  // why it is off unless D2L_PASSWORDLESS is set or passwordless is hand-edited
  // into config.json; setup no longer offers it as a question.
  const passwordless = envBoolean(process.env.D2L_PASSWORDLESS, "D2L_PASSWORDLESS")
    ?? store?.passwordless
    ?? false;

  // Opt-in: ask Microsoft to skip the second factor for its "Don't ask again"
  // window. Off unless the user said yes in setup or set D2L_REMEMBER_MFA=true,
  // so a shared machine never remembers MFA without the user choosing it.
  const rememberMfa = envBoolean(process.env.D2L_REMEMBER_MFA, "D2L_REMEMBER_MFA")
    ?? store?.rememberMfa
    ?? false;

  const { baseUrl, username, sessionRoot, sessionDir } = resolveAccountLocation(store);
  const password = passwordless
    ? undefined
    : await startupPhase("reading the saved password from the OS credential store", () => resolveStoredPassword(baseUrl, username, store, options.tolerateCredentialStore === true));
  // Opt-in: only an enrollment the user deliberately saved makes the Entra
  // sign-in answer a verification-code challenge itself. With none, every MFA
  // challenge is handled exactly as before. The keyring entry is per account;
  // D2L_TOTP_SECRET exists for CI and containers, where there is no keyring,
  // and is deliberately weaker (see .env.example) so it is never the default.
  const envTotpSecret = process.env.D2L_TOTP_SECRET;
  const totpUri = envTotpSecret
    ? normalizeTotpEnrollment(envTotpSecret, username ?? "")
    // A credential store that cannot be read means "no enrollment saved",
    // which is the default anyway. It must never be a startup failure: this is
    // an optional extra, unlike the password resolveStoredPassword above
    // reports a locked or missing store for, loudly.
    : username
      ? (await startupPhase("reading the saved authenticator key from the OS credential store", () => getStoredTotpUri(baseUrl, username).catch(() => null))) ?? undefined
      : undefined;
  const legacyMigration = sessionDir !== sessionRoot ? await migrateLegacyState(sessionRoot) : undefined;

  return {
    baseUrl,
    sessionDir,
    sessionRoot,
    legacyBrowserStateMigrated: legacyMigration?.browserState === "encrypted",
    tokenTtl,
    headless,
    passwordless,
    rememberMfa,
    username,
    password,
    totpUri,
    campus: process.env.D2L_CAMPUS || store?.campus,
    courseFilter: {
      includeCourseIds,
      excludeCourseIds,
      activeOnly,
    },
  };
}

export function accountSessionDirectory(root: string, baseUrl: string, username?: string): string {
  if (!username) return root;
  const origin = new URL(baseUrl).origin;
  const directory = (name: string) => path.join(root, "accounts", createHash("sha256").update(JSON.stringify([origin, name])).digest("hex"));
  const canonical = directory(canonicalUsername(username));
  // Earlier releases named the directory after the username exactly as
  // given. Its encryption key is tied to that path, so a session already
  // saved there keeps being used rather than stranded.
  const legacy = directory(username);
  return legacy !== canonical && !fs.existsSync(canonical) && fs.existsSync(legacy) ? legacy : canonical;
}

/**
 * An on/off environment variable. Comparing against the exact string "false"
 * read "0", "no", "False" and a typo as true, so D2L_HEADLESS=0 kept the
 * browser hidden from a user who needed it to enter an MFA code. An empty
 * value counts as unset, and anything unrecognized is ignored with a warning
 * so config.json or the default applies.
 */
function envBoolean(value: string | undefined, source: string): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  console.error(`[config] Ignoring ${source}=${JSON.stringify(value)}: expected true or false`);
  return undefined;
}

/**
 * A token lifetime must be a whole, positive number of seconds. NaN, zero, a
 * negative number, or "1h" read as 1 second would all produce a token that is
 * already inside the refresh buffer, so every tool call would mint again.
 */
function positiveSeconds(value: string | number | undefined, source: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text) && Number(text) > 0) return Number(text);
  console.error(`[config] Ignoring ${source}=${JSON.stringify(value)}: expected a positive whole number of seconds`);
  return undefined;
}

/**
 * A comma-separated list of course (org unit) ids. parseInt read "123x" as
 * 123 and dropped "CS180" without a word, so a whitelist of course codes
 * became empty and an empty whitelist filters nothing: every course showed.
 * Each entry must be a positive whole number or it is ignored with a warning,
 * and a list with no valid id is ignored outright so config.json applies, as
 * positiveSeconds does. Empty entries from a stray comma are skipped quietly.
 */
function courseIdList(value: string | undefined, source: string): number[] | undefined {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;
  const ids: number[] = [];
  for (const entry of entries) {
    if (/^\d+$/.test(entry) && Number(entry) > 0) ids.push(Number(entry));
    else console.error(`[config] Ignoring ${JSON.stringify(entry)} in ${source}: expected a numeric course id`);
  }
  if (ids.length > 0) return ids;
  console.error(`[config] Ignoring ${source}=${JSON.stringify(value)}: no valid course id`);
  return undefined;
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
