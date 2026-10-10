/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import type { AppConfig } from "../types/index.js";
import { configStoreExists, loadConfigStore } from "./config-store.js";
import { resolveStoredPassword } from "./secure-config.js";
import { getStoredTotpUri } from "../auth/credential-store.js";
import { normalizeTotpEnrollment } from "../auth/totp.js";
import { migrateLegacyState } from "../auth/legacy-state.js";

export interface LoadConfigOptions {
  /**
   * Treat an unavailable native credential store as "no stored password"
   * (logged as a warning) instead of an error. Right for a read-only client:
   * a saved session needs no password, and a cron host often has no desktop
   * keyring. Wrong for setup and auth, which exist to use that store.
   */
  tolerateCredentialStore?: boolean;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  dotenv.config({ quiet: true });
  const store = configStoreExists() ? loadConfigStore() : null;

  if (store) {
    console.error("[config] Loaded base config from ~/.brightspace-mcp/config.json");
  } else {
    console.error("[config] No config.json found, using environment variables");
  }

  // Resolve sessionDir: env > store > default
  const sessionRoot = process.env.D2L_SESSION_DIR
    ? expandTilde(process.env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");

  // Code-entry and other interactive MFA methods need a visible browser.
  const headless = envBoolean(process.env.D2L_HEADLESS, "D2L_HEADLESS")
    ?? store?.headless
    ?? true;

  // Resolve tokenTtl: env > store > default (3600)
  const tokenTtl = positiveSeconds(process.env.D2L_TOKEN_TTL, "D2L_TOKEN_TTL")
    ?? positiveSeconds(store?.tokenTtl, "tokenTtl in config.json")
    ?? 3600;

  // Resolve includeCourseIds: env > store > undefined
  const includeCourseIds = process.env.D2L_INCLUDE_COURSES
    ? process.env.D2L_INCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.includeCourses;

  // Resolve excludeCourseIds: env > store > undefined
  const excludeCourseIds = process.env.D2L_EXCLUDE_COURSES
    ? process.env.D2L_EXCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.excludeCourses;

  // Resolve activeOnly: env > store > default (true)
  const activeOnly = envBoolean(process.env.D2L_ACTIVE_ONLY, "D2L_ACTIVE_ONLY")
    ?? store?.activeOnly
    ?? true;

  // Opt-in: sign in with Microsoft's passwordless phone approval, so no
  // password is read or saved. Every sign-in then needs the phone, which is
  // why it is off unless the user chose it in setup or set D2L_PASSWORDLESS.
  const passwordless = envBoolean(process.env.D2L_PASSWORDLESS, "D2L_PASSWORDLESS")
    ?? store?.passwordless
    ?? false;

  // Opt-in: ask Microsoft to skip the second factor for its "Don't ask again"
  // window. Off unless the user said yes in setup or set D2L_REMEMBER_MFA=true,
  // so a shared machine never remembers MFA without the user choosing it.
  const rememberMfa = envBoolean(process.env.D2L_REMEMBER_MFA, "D2L_REMEMBER_MFA")
    ?? store?.rememberMfa
    ?? false;

  const configuredUrl = new URL(process.env.D2L_BASE_URL || store?.baseUrl || "https://purdue.brightspace.com");
  if (configuredUrl.protocol !== "https:" || configuredUrl.username || configuredUrl.password) {
    throw new Error("The Brightspace URL must be an HTTPS school URL without embedded credentials.");
  }
  const baseUrl = configuredUrl.origin;
  const username = process.env.D2L_USERNAME || store?.username;
  const password = passwordless ? undefined : await resolveStoredPassword(baseUrl, username, store, options.tolerateCredentialStore === true);
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
    : username ? (await getStoredTotpUri(baseUrl, username).catch(() => null)) ?? undefined : undefined;
  // A new account must never inherit another account's cookies, even at the same school.
  const sessionDir = accountSessionDirectory(sessionRoot, baseUrl, username);
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
  const account = createHash("sha256").update(JSON.stringify([new URL(baseUrl).origin, username])).digest("hex");
  return path.join(root, "accounts", account);
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

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
