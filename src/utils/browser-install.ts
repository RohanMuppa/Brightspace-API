/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Recognising a missing Playwright browser, and restoring it automatically.
 *
 * This package's postinstall downloads Chromium. npm skips postinstall under
 * `--ignore-scripts` and under the newer allow-scripts policy, both of which
 * are common on global installs, so the package can land without a browser and
 * fail only later, at first sign-in. Disk cleanup can also remove an already
 * downloaded browser after a successful install.
 *
 * Playwright's own message does say what to run, but by the time it has been
 * flattened into a generic "Authentication failed" further up, the actionable
 * command is gone. Sign-in repairs a missing executable itself, once, with
 * this package's own Playwright, and retries once — it never touches
 * dependency code, which a missing-executable error cannot distinguish from a
 * missing Playwright package without checking separately.
 */

import { spawn, execFileSync } from "node:child_process";
import * as path from "node:path";
import { createRequire } from "node:module";
import { AUTH_COMMAND, CLEAR_NPX_CACHE_COMMAND, GLOBAL_INSTALL_COMMAND } from "./commands.js";

export const PLAYWRIGHT_INSTALL_HINT =
  "Chromium is missing or could not be restored. It may have been removed after installation, " +
  "or the install script may have been skipped. Run `npx playwright install chromium` to download it directly, " +
  `then retry with ${AUTH_COMMAND}. If that does not help, reinstall and clear caches with ${CLEAR_NPX_CACHE_COMMAND}.`;

/** Browser downloads are disposable; this package's own Playwright code is not. */
export const PLAYWRIGHT_DEPENDENCY_MISSING_HINT =
  "Playwright's package code is missing, not just the browser download, so it cannot be restored automatically. " +
  `Reinstall with ${GLOBAL_INSTALL_COMMAND} (or \`npm ci\` if you cloned the repository), then retry with ${AUTH_COMMAND}.`;

/** Thrown when sign-in could not launch Chromium even after one repair attempt. */
export class BrowserInstallError extends Error {
  constructor(readonly dependencyMissing = false) {
    super(dependencyMissing ? PLAYWRIGHT_DEPENDENCY_MISSING_HINT : PLAYWRIGHT_INSTALL_HINT);
    this.name = "BrowserInstallError";
  }
}

/** True when an error is Playwright reporting that no browser binary exists. */
export function isMissingBrowserError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /Executable doesn't exist|Failed to launch.*because executable doesn't exist/i.test(
    message
  );
}

/** True when Playwright's own package code, not just a browser download, is missing. */
export function isMissingPlaywrightError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    /playwright/i.test(error instanceof Error ? error.message : "");
}

export interface InstallChromiumOptions {
  spawnImpl?: typeof spawn;
  execPath?: string;
  cliPath?: string;
  timeoutMs?: number;
}

/** The CLI of the Playwright this package depends on, so the browser revision matches. */
export function playwrightCliPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
}

/**
 * Downloads Chromium through this package's own Playwright dependency, never
 * whatever `playwright` happens to be on the caller's PATH. Bounded by a
 * timeout so a stalled download cannot hang sign-in forever; the child is
 * killed as a process group (Playwright spawns its own download worker)
 * before reporting failure.
 */
export function installChromium(options: InstallChromiumOptions = {}): Promise<{ ok: boolean; message?: string }> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const execPath = options.execPath ?? process.execPath;
  let cliPath: string;
  try {
    cliPath = options.cliPath ?? playwrightCliPath();
  } catch (error) {
    return Promise.resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  return new Promise((resolve) => {
    const child = spawnImpl(execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", 2, 2],
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      // Include Playwright's download worker, so a timeout cannot leave an
      // orphan downloading into the cache or holding its installation lock.
      try {
        if (child.pid && process.platform === "win32") {
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", timeout: 5000 });
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
      resolve({ ok: false, message: `Chromium installation timed out. Check your connection, then retry with ${AUTH_COMMAND}.` });
    }, options.timeoutMs ?? 120_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
    child.once("error", () => clearTimeout(timer));
    child.once("error", (error) => resolve({ ok: false, message: error.message }));
    child.once("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, message: `Playwright's installer exited with code ${code}.` }));
  });
}

/**
 * One repair and one retry; unrelated launch failures never download
 * anything, and a missing Playwright package is reported instead of treated
 * as a missing browser download, since installing a browser cannot fix it.
 */
export async function launchWithBrowserRecovery<T>(
  launch: () => Promise<T>,
  install: () => Promise<{ ok: boolean }> = installChromium,
  progress: () => void = () => console.error("Restoring Chromium for Brightspace sign-in..."),
): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    if (isMissingPlaywrightError(error)) throw new BrowserInstallError(true);
    if (!isMissingBrowserError(error)) throw error;
  }
  progress();
  let installed: { ok: boolean };
  try {
    installed = await install();
  } catch {
    throw new BrowserInstallError();
  }
  if (!installed.ok) throw new BrowserInstallError();
  try {
    return await launch();
  } catch (error) {
    if (isMissingPlaywrightError(error)) throw new BrowserInstallError(true);
    if (isMissingBrowserError(error)) throw new BrowserInstallError();
    throw error;
  }
}
