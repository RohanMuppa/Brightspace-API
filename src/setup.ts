#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import * as readline from "node:readline";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  configStoreExists,
  getConfigStorePath,
  loadConfigStore,
} from "./utils/config-store.js";
import { saveSecureConfig } from "./utils/secure-config.js";
import type { ConfigStoreData } from "./utils/config-store.js";
import { AUTH_COMMAND } from "./utils/commands.js";
import { applyPasswordInput, INITIAL_PASSWORD_INPUT } from "./utils/password-input.js";

// ANSI helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// ── School presets ──────────────────────────────────────────────────

interface SchoolPreset {
  name: string;
  baseUrl: string;
  usernameLabel: string;
  /** Named on its own: deriving it from `usernameLabel` reads wrongly for "username or full email". */
  passwordLabel: string;
  mfaNote: string;
  /** Asked only by shared instances that host several campuses. */
  campusPrompt?: string;
  /** Shown above the username prompt when the expected format is not obvious. */
  usernameHint?: string;
}

export const SCHOOL_PRESETS: Record<string, SchoolPreset> = {
  tudelft: {
    name: "TU Delft",
    baseUrl: "https://brightspace.tudelft.nl",
    usernameLabel: "TU Delft NetID",
    passwordLabel: "TU Delft NetID password",
    mfaNote: "NetID sign-in normally runs headlessly without MFA.",
    usernameHint: "Use your NetID, not your student email address.",
  },
  purdue: {
    name: "Purdue University",
    baseUrl: "https://purdue.brightspace.com",
    usernameLabel: "Purdue career account username or full email",
    passwordLabel: "Purdue career account password",
    mfaNote: "Microsoft Authenticator number matching can run without a browser window.",
  },
  suny: {
    name: "SUNY",
    baseUrl: "https://mylearning.suny.edu",
    usernameLabel: "SUNY campus username",
    passwordLabel: "SUNY campus password",
    mfaNote: "Approve the sign-in request from your campus MFA app.",
    campusPrompt: "Which SUNY campus are you at? (e.g. SUNY Poly)",
    usernameHint: "Most campuses want the full sign-in address, e.g. abc123@sunypoly.edu",
  },
  western: {
    name: "Western University",
    baseUrl: "https://westernu.brightspace.com",
    usernameLabel: "Western account username or full email",
    passwordLabel: "Western account password",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your Western account requires it.",
  },
};

/**
 * Pick the school preset named by `--purdue`, `--suny`, `--western`, etc.
 *
 * Own properties only: a bare index would make `--constructor` or
 * `--__proto__` resolve to something off `Object.prototype` and hand the
 * wizard an object with no `baseUrl`.
 */
export function presetForArgv(argv: string[] = process.argv): SchoolPreset | undefined {
  const flag = argv.find((a) => a.startsWith("--"))?.replace(/^--/, "").toLowerCase();
  if (!flag || !Object.prototype.hasOwnProperty.call(SCHOOL_PRESETS, flag)) return undefined;
  return SCHOOL_PRESETS[flag];
}

const preset = presetForArgv();

// ── Readline helpers ───────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Prompt for a password without echoing characters to the terminal.
 * We swap stdout.write to suppress the default echo, then print
 * asterisks ourselves for each accepted character. Key handling lives in
 * `applyPasswordInput`, which reads each chunk character by character so a
 * pasted password (one chunk, often ending in Enter) is taken correctly.
 */
function askPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute the built-in echo
    const origWrite = process.stdout.write.bind(process.stdout);
    let muted = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (
      chunk: any,
      encodingOrCb?: any,
      cb?: any,
    ): boolean => {
      if (muted) {
        // Swallow readline's echo completely
        if (typeof encodingOrCb === "function") {
          encodingOrCb();
          return true;
        }
        if (cb) cb();
        return true;
      }
      return origWrite(chunk, encodingOrCb, cb);
    };

    origWrite(prompt);
    muted = true;

    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    let input = INITIAL_PASSWORD_INPUT;
    const finish = () => {
      process.stdout.write = origWrite;
      process.stdin.setRawMode?.(false);
      process.stdin.removeListener("data", onData);
      rl.close();
    };
    const onData = (key: Buffer) => {
      const step = applyPasswordInput(input, key.toString("utf-8"));
      input = step.state;
      if (step.echo) origWrite(step.echo);
      if (step.cancelled) {
        finish();
        console.log("");
        process.exit(0);
      }
      if (step.done) {
        finish();
        origWrite("\n");
        resolve(input.password);
      }
    };

    process.stdin.on("data", onData);
  });
}

// ── URL validation ─────────────────────────────────────────────────

function normalizeUrl(input: string): string {
  let url = input.trim();
  // Strip trailing slashes
  url = url.replace(/\/+$/, "");
  // Auto-prepend https://
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Upgrade http:// to https://
  url = url.replace(/^http:\/\//i, "https://");
  return url;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// ── Saved settings ─────────────────────────────────────────────────

export interface WizardAnswers {
  baseUrl: string;
  username: string;
  password: string;
  headless: boolean;
  campus?: string;
}

/** The settings already on disk, or null when there are none to read. */
export function readExistingConfig(): ConfigStoreData | null {
  try {
    return configStoreExists() ? loadConfigStore() : null;
  } catch {
    // An unreadable config is replaced by the setup values.
    return null;
  }
}

function sameSchool(stored: string | undefined, chosen: string): boolean {
  // A config that never recorded a school (environment-driven installs) is
  // not a *different* school, so its settings are still ours to keep.
  if (!stored) return true;
  try {
    return new URL(stored).origin === new URL(chosen).origin;
  } catch {
    return false;
  }
}

/**
 * Merge the wizard's answers over the settings already saved.
 *
 * `saveConfigStore` replaces the whole file, and setup is the documented way
 * to update a saved password — so it runs again on configurations that carry
 * settings it never prompts for: the SUNY campus, course filters, a custom
 * session directory or token TTL. Writing only the answers deleted all of
 * them; most visibly, a SUNY user who reran plain `setup` lost the campus
 * that lets sign-in skip the shared campus picker.
 *
 * Settings are carried only within one school, since course ids and the
 * campus belong to a single tenant.
 */
export function buildConfigToSave(
  existing: ConfigStoreData | null,
  answers: WizardAnswers,
): ConfigStoreData {
  const carried = existing && sameSchool(existing.baseUrl, answers.baseUrl) ? existing : null;
  const config: ConfigStoreData = {
    ...carried,
    baseUrl: answers.baseUrl,
    username: answers.username,
    // Always the freshly typed one: a carried v1 plaintext password would
    // otherwise be the value written to the native store.
    password: answers.password,
    headless: answers.headless,
  };
  if (answers.campus) config.campus = answers.campus;
  return config;
}

// ── Auth spawn ─────────────────────────────────────────────────────

function runAuth(): Promise<boolean> {
  const scriptPath = path.resolve(thisDir, "auth-cli.js");

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [scriptPath],
      {
        env: { ...process.env },
        stdio: "inherit",
      },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

// ── Main wizard ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log("\n\nSetup cancelled.");
    process.exit(0);
  });

  console.log("");
  if (preset) {
    console.log(bold(`Brightspace MCP Server — ${preset.name} Setup`));
    console.log("=".repeat(`Brightspace MCP Server — ${preset.name} Setup`.length));
  } else {
    console.log(bold("Brightspace MCP Server — Setup Wizard"));
    console.log("======================================");
  }
  console.log(dim("  By Rohan Muppa — github.com/rohanmuppa/brightspace-mcp-server"));
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Step 1: Brightspace URL ──────────────────────────────────────
  let baseUrl = "";
  if (preset) {
    baseUrl = preset.baseUrl;
    console.log(dim(`  Brightspace URL: ${baseUrl}`));
    console.log("");
  } else {
    while (!baseUrl) {
      const raw = await ask(
        rl,
        "What is your Brightspace URL? (e.g., purdue.brightspace.com): ",
      );
      const normalized = normalizeUrl(raw);
      if (!raw || !isValidUrl(normalized)) {
        console.log(yellow("  Please enter a valid URL (e.g., purdue.brightspace.com)"));
        continue;
      }
      baseUrl = normalized;
    }
    console.log(dim(`  → ${baseUrl}`));
    console.log("");
  }

  // ── Campus (shared multi-campus instances only) ──────────────────
  let campus = "";
  if (preset?.campusPrompt) {
    console.log(dim("  Several campuses share this Brightspace site."));
    while (!campus) {
      campus = await ask(rl, `${preset.campusPrompt} `);
      if (!campus) console.log(yellow("  Campus is required for automatic sign-in."));
    }
    console.log(
      campus
        ? dim(`  → ${campus}`)
        : dim("  Set your campus before authenticating."),
    );
    console.log("");
  }

  // ── Step 2: Username ─────────────────────────────────────────────
  const usernamePrompt = preset
    ? `What is your ${preset.usernameLabel}? `
    : "What is your Brightspace username? ";
  if (preset?.usernameHint) {
    console.log(dim(`  ${preset.usernameHint}`));
  }
  let username = "";
  while (!username) {
    username = await ask(rl, usernamePrompt);
    if (!username) {
      console.log(yellow("  Username is required."));
    }
  }
  console.log("");

  // ── Step 3: Password (hidden) ────────────────────────────────────
  // Close the rl temporarily since askPassword manages its own
  rl.close();

  const passwordPrompt = preset
    ? `What is your ${preset.passwordLabel}? `
    : "What is your Brightspace password? ";
  let password = "";
  while (!password) {
    password = await askPassword(passwordPrompt);
    if (!password) {
      console.log(yellow("  Password is required."));
    }
  }
  console.log("");

  // Re-open readline for the remaining prompt
  const rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Step 4: MFA info ─────────────────────────────────────────────
  if (preset) {
    console.log(dim(`  MFA: ${preset.mfaNote}`));
  } else {
    console.log(dim("  MFA: You will be prompted to approve the sign-in on your phone during auth."));
  }
  console.log("");
  // Only two outcomes exist: a hidden browser or a visible one. Which kind of
  // MFA you have is detected at sign-in time, so offering "approve a prompt"
  // and "type a code" as separate choices would be a distinction the code does
  // not make, and picking between them would change nothing on disk.
  console.log("  How do you complete MFA?");
  console.log("    1. On your phone, or by typing a code here (recommended)");
  console.log("    2. In a visible browser window");
  let savedHeadless: boolean | undefined;
  try {
    savedHeadless = configStoreExists() ? loadConfigStore().headless : undefined;
  } catch {
    // An invalid old config is replaced by the setup values below.
  }
  const defaultMfaChoice = savedHeadless === false ? "2" : "1";
  let mfaChoice = "";
  while (!/^[12]$/.test(mfaChoice)) {
    mfaChoice = await ask(rl2, `  Choose 1 or 2 [${defaultMfaChoice}]: `) || defaultMfaChoice;
    if (!/^[12]$/.test(mfaChoice)) console.log(yellow("  Please enter 1 or 2."));
  }
  const headless = mfaChoice !== "2";
  console.log(dim(headless
    ? "  Authentication will run without a browser window."
    : "  A browser window will open when authentication is needed."));
  console.log("");

  // ── Step 5: Save config ──────────────────────────────────────────
  const config = buildConfigToSave(readExistingConfig(), {
    baseUrl,
    username,
    password,
    headless,
    campus: campus || undefined,
  });

  await saveSecureConfig(config);
  console.log(green("  Password saved in your operating system credential store."));
  console.log(green("  Config saved to: " + getConfigStorePath()));
  console.log("");

  // ── Step 6: Authenticate now? ────────────────────────────────────
  const authNow = await ask(rl2, "Would you like to authenticate now? (yes/no): ");
  rl2.close();
  if (/^y(es)?$/i.test(authNow)) {
    console.log("");
    console.log(dim("  Starting authentication..."));
    console.log("");
    const ok = await runAuth();
    if (ok) {
      console.log(green("\n  Authentication successful!"));
    } else {
      console.log(yellow(`\n  Authentication failed. You can retry later with: ${AUTH_COMMAND}`));
    }
  } else {
    console.log(dim(`  You can authenticate later by running: ${AUTH_COMMAND}`));
  }
  console.log("");

  // ── Final summary ────────────────────────────────────────────────
  console.log(bold("Setup complete!"));
  console.log("");
  console.log(`  Config saved to: ${dim(getConfigStorePath())}`);
  console.log("");
  console.log("  Next steps:");
  console.log("  1. Script against brightspace-api, or run the `brightspace` CLI");
  console.log("     Sign-in runs automatically if your saved session has expired.");
  console.log("");
}

// Both entry points — the `brightspace-setup` bin and `brightspace-mcp-server
// setup`, which imports this module — start the wizard here. VITEST is set
// only by the test runner, which imports the module for the helpers above and
// must not open prompts on stdin; no user environment sets it.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("Setup failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
