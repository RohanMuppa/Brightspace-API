import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  isMissingBrowserError,
  isMissingPlaywrightError,
  PLAYWRIGHT_INSTALL_HINT,
  PLAYWRIGHT_DEPENDENCY_MISSING_HINT,
  BrowserInstallError,
  launchWithBrowserRecovery,
  installChromium,
  playwrightCliPath,
} from "../../src/utils/browser-install.js";

/**
 * A global install done with --ignore-scripts, or under npm's allow-scripts
 * policy, silently skips the Chromium download. Sign-in then fails with a
 * message that gets flattened into a generic "Authentication failed" further
 * up. This predicate is what keeps the actual remedy attached to the error.
 */

describe("isMissingBrowserError", () => {
  it("matches Playwright's missing-executable error", () => {
    const real = new Error(
      "browserType.launch: Executable doesn't exist at " +
        "/Users/me/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app\n" +
        "╔═══════════════════════════════════════════════════════════════════════════╗\n" +
        "║ Looks like Playwright was just installed or updated.                      ║\n" +
        "║ Please run the following command to download new browsers:                ║\n" +
        "║     npx playwright install                                                ║\n" +
        "╚═══════════════════════════════════════════════════════════════════════════╝"
    );
    expect(isMissingBrowserError(real)).toBe(true);
  });

  it("does not guess a missing executable from installation advice alone", () => {
    expect(isMissingBrowserError(new Error("please run npx playwright install chromium"))).toBe(false);
    expect(isMissingBrowserError(new Error("Host system is missing dependencies. Run npx playwright install-deps"))).toBe(false);
  });

  it("accepts a string as well as an Error", () => {
    expect(isMissingBrowserError("Executable doesn't exist at /path")).toBe(true);
  });

  it("does not match unrelated launch failures", () => {
    expect(isMissingBrowserError(new Error("Timeout 60000ms exceeded"))).toBe(false);
    expect(isMissingBrowserError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
    expect(isMissingBrowserError(new Error("Target page, context or browser has been closed"))).toBe(false);
  });

  it("is safe on empty and non-error input", () => {
    expect(isMissingBrowserError(null)).toBe(false);
    expect(isMissingBrowserError(undefined)).toBe(false);
    expect(isMissingBrowserError({})).toBe(false);
    expect(isMissingBrowserError("")).toBe(false);
  });
});

describe("isMissingPlaywrightError", () => {
  it("matches a missing Playwright package, not just a missing browser", () => {
    const error = Object.assign(new Error("Cannot find package 'playwright'"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isMissingPlaywrightError(error)).toBe(true);
    const cjs = Object.assign(new Error("Cannot find module 'playwright'"), { code: "MODULE_NOT_FOUND" });
    expect(isMissingPlaywrightError(cjs)).toBe(true);
  });

  it("does not match an unrelated missing module", () => {
    const error = Object.assign(new Error("Cannot find package 'left-pad'"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isMissingPlaywrightError(error)).toBe(false);
  });

  it("is safe on empty and non-error input", () => {
    expect(isMissingPlaywrightError(null)).toBe(false);
    expect(isMissingPlaywrightError(new Error("Executable doesn't exist"))).toBe(false);
  });
});

describe("PLAYWRIGHT_INSTALL_HINT", () => {
  it("names the command that actually fixes it", () => {
    expect(PLAYWRIGHT_INSTALL_HINT).toContain("npx playwright install chromium");
  });

  it("explains why the browser is missing, not just what to run", () => {
    expect(PLAYWRIGHT_INSTALL_HINT).toContain("removed after installation");
    expect(PLAYWRIGHT_INSTALL_HINT).toMatch(/ignore-scripts|allow-scripts|install script may have been skipped/i);
  });
});

describe("PLAYWRIGHT_DEPENDENCY_MISSING_HINT", () => {
  it("names a reinstall command, distinct from a plain browser download", () => {
    expect(PLAYWRIGHT_DEPENDENCY_MISSING_HINT).toContain("npm install -g");
    expect(PLAYWRIGHT_DEPENDENCY_MISSING_HINT).not.toContain("npx playwright install");
  });
});

describe("BrowserInstallError", () => {
  it("carries the browser-missing hint by default", () => {
    const error = new BrowserInstallError();
    expect(error.dependencyMissing).toBe(false);
    expect(error.message).toBe(PLAYWRIGHT_INSTALL_HINT);
  });

  it("carries the dependency-missing hint when flagged", () => {
    const error = new BrowserInstallError(true);
    expect(error.dependencyMissing).toBe(true);
    expect(error.message).toBe(PLAYWRIGHT_DEPENDENCY_MISSING_HINT);
  });
});

describe("launchWithBrowserRecovery", () => {
  const missing = new Error("Executable doesn't exist at /browser");

  it("installs only after a missing-browser failure and retries once", async () => {
    const launch = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue("browser");
    const install = vi.fn(async () => ({ ok: true }));
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).resolves.toBe("browser");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledOnce();
  });

  it("never installs on healthy or unrelated failures", async () => {
    const install = vi.fn();
    await expect(launchWithBrowserRecovery(async () => "browser", install)).resolves.toBe("browser");
    await expect(launchWithBrowserRecovery(async () => { throw new Error("Permission denied"); }, install)).rejects.toThrow("Permission denied");
    expect(install).not.toHaveBeenCalled();
  });

  it("stops on failed installation or a still-missing browser", async () => {
    const launch = vi.fn().mockRejectedValue(missing);
    const install = vi.fn(async () => ({ ok: false }));
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).rejects.toBeInstanceOf(BrowserInstallError);
    expect(launch).toHaveBeenCalledOnce();

    install.mockResolvedValue({ ok: true });
    launch.mockClear();
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).rejects.toBeInstanceOf(BrowserInstallError);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("reports deleted Playwright package code without attempting a browser download", async () => {
    const install = vi.fn();
    const error = Object.assign(new Error("Cannot find package 'playwright'"), { code: "ERR_MODULE_NOT_FOUND" });
    const failure = expect(launchWithBrowserRecovery(async () => { throw error; }, install)).rejects.toMatchObject({ dependencyMissing: true });
    await failure;
    expect(install).not.toHaveBeenCalled();
  });

  it("reports a dependency-missing failure discovered only on the retry launch", async () => {
    const dependencyError = Object.assign(new Error("Cannot find package 'playwright'"), { code: "ERR_MODULE_NOT_FOUND" });
    const launch = vi.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(dependencyError);
    const install = vi.fn(async () => ({ ok: true }));
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).rejects.toMatchObject({ dependencyMissing: true });
  });
});

describe("installChromium", () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
  }

  it("runs this package's own Playwright CLI and resolves ok on a clean exit", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const result = installChromium({ spawnImpl, execPath: "/usr/bin/node", cliPath: "/pkg/node_modules/playwright/cli.js" });
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ ok: true });
    expect(spawnImpl).toHaveBeenCalledWith("/usr/bin/node", ["/pkg/node_modules/playwright/cli.js", "install", "chromium"], {
      stdio: ["ignore", 2, 2],
      detached: process.platform !== "win32",
    });
  });

  it("resolves not-ok on a non-zero exit", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const result = installChromium({ spawnImpl, cliPath: "/cli.js" });
    child.emit("close", 1);
    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it("resolves not-ok when the installer cannot be spawned", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const result = installChromium({ spawnImpl, cliPath: "/cli.js" });
    child.emit("error", new Error("ENOENT"));
    await expect(result).resolves.toEqual({ ok: false, message: "ENOENT" });
  });

  it("bounds an installer that never exits", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
      const result = installChromium({ spawnImpl, cliPath: "/cli.js", timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ ok: false, message: expect.stringContaining("timed out") });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds the Playwright CLI this package depends on", () => {
    expect(playwrightCliPath()).toMatch(/node_modules[\\/]playwright[\\/]cli\.js$/);
  });
});
