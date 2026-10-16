import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Port of brightspace-mcp-server#252: the README's Configuration table is the
 * list of settings, but it had drifted to omit D2L_PASSWORD and
 * D2L_TOTP_SECRET. Every D2L_* name in src/ must appear in that section unless
 * it is listed here as internal.
 */

const INTERNAL = new Set<string>([
  // None today. Add a name here, with a reason, only if no user ever sets it.
]);

const root = resolve(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const namesInSource = new Set(
  sourceFiles(join(root, "src")).flatMap((file) => readFileSync(file, "utf-8").match(/\bD2L_[A-Z_]+\b/g) ?? [])
);

// Windows checkouts may convert to CRLF; match on LF regardless.
const readme = readFileSync(join(root, "README.md"), "utf-8").replace(/\r\n/g, "\n");

function section(heading: string): string {
  const start = readme.indexOf(`## ${heading}\n`);
  expect(start, `README.md has no "## ${heading}" section`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

describe("README environment variable reference", () => {
  const table = section("Configuration")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .join("\n");

  it("finds the variables it is meant to guard", () => {
    // A broken scan would make the check below pass vacuously.
    expect(namesInSource).toContain("D2L_BASE_URL");
    expect(namesInSource).toContain("D2L_TOTP_SECRET");
  });

  it("names every user-facing D2L_* variable the client reads", () => {
    const missing = [...namesInSource]
      .filter((name) => !INTERNAL.has(name))
      .filter((name) => !table.includes(`\`${name}\``))
      .sort();
    expect(missing, "add these to the Configuration table in README.md, or to INTERNAL here").toEqual([]);
  });

  it("keeps the internal allowlist honest", () => {
    for (const name of INTERNAL) expect(namesInSource, `${name} is no longer in src/`).toContain(name);
  });
});
