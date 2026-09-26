import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { getInfo } from "../../src/features/info.js";
import type { FeatureContext } from "../../src/features/context.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * getInfo answers the first question of every support thread — which
 * version, which runtime, where is the config — without contacting
 * Brightspace and without revealing anything secret.
 */

const SESSION_DIR = path.join("/home/student", ".d2l-session", "accounts", "abc123");

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  baseUrl: "https://purdue.brightspace.com",
  sessionDir: SESSION_DIR,
  tokenTtl: 3600,
  headless: true,
  username: "student42",
  password: "hunter2-secret",
  courseFilter: { activeOnly: true },
  ...overrides,
});

function makeCtx(appConfig: AppConfig, version = "9.8.7"): FeatureContext {
  return { api: {} as FeatureContext["api"], config: appConfig, version };
}

describe("getInfo", () => {
  it("returns exactly the documented fields", async () => {
    expect(Object.keys(await getInfo(makeCtx(config()))).sort()).toEqual([
      "arch",
      "configPath",
      "hasStoredCredential",
      "node",
      "platform",
      "schoolUrl",
      "sessionStatePath",
      "version",
    ]);
  });

  it("reports the version the client was created with", async () => {
    expect((await getInfo(makeCtx(config(), "9.8.7"))).version).toBe("9.8.7");
  });

  it("reports the running Node version, platform, and architecture", async () => {
    const info = await getInfo(makeCtx(config()));
    expect([info.node, info.platform, info.arch]).toEqual([process.version, process.platform, process.arch]);
  });

  it("reports the config file under ~/.brightspace-mcp", async () => {
    expect((await getInfo(makeCtx(config()))).configPath).toBe(path.join(os.homedir(), ".brightspace-mcp", "config.json"));
  });

  it("reports the resolved session state directory", async () => {
    expect((await getInfo(makeCtx(config()))).sessionStatePath).toBe(SESSION_DIR);
  });

  it("reports the configured school origin", async () => {
    expect((await getInfo(makeCtx(config()))).schoolUrl).toBe("https://purdue.brightspace.com");
  });

  it("reports a stored credential as true when one was found", async () => {
    expect((await getInfo(makeCtx(config()))).hasStoredCredential).toBe(true);
  });

  it("reports a stored credential as false when none was found", async () => {
    expect((await getInfo(makeCtx(config({ password: undefined })))).hasStoredCredential).toBe(false);
  });

  it("never includes the password or the username anywhere in the output", async () => {
    const text = JSON.stringify(await getInfo(makeCtx(config())));
    expect(text).not.toMatch(/hunter2-secret|student42/);
  });

  it("carries no credential, token, cookie, or username field", async () => {
    const keys = Object.keys(await getInfo(makeCtx(config()))).join(" ");
    expect(keys).not.toMatch(/password|token|cookie|username|secret/i);
  });
});
