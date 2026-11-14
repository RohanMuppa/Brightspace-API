import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeStalePartials, PARTIAL_MAX_AGE_MS } from "../../src/sync/cleanup.js";

/**
 * A killed sync (kill -9, power loss) can leave `.download-<uuid>.part` files
 * behind. The next real sync removes them, but only that exact name, only
 * once they are old enough to be sure the run that made them is gone.
 */

const UUID = "11111111-2222-3333-4444-555555555555";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-cleanup-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function touchOld(file: string, ageMs: number): Promise<void> {
  await fs.writeFile(file, "partial");
  const old = new Date(Date.now() - ageMs);
  await fs.utimes(file, old, old);
}

describe("removeStalePartials", () => {
  it("removes an old partial download at the root", async () => {
    const file = path.join(root, `.download-${UUID}.part`);
    await touchOld(file, PARTIAL_MAX_AGE_MS + 1000);

    expect(await removeStalePartials(root)).toBe(1);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("leaves a fresh partial download alone: it may belong to a sync still running", async () => {
    const file = path.join(root, `.download-${UUID}.part`);
    await touchOld(file, 1000);

    expect(await removeStalePartials(root)).toBe(0);
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it("removes an old partial nested in a module folder", async () => {
    const dir = path.join(root, "Week 1");
    await fs.mkdir(dir);
    const file = path.join(dir, `.download-${UUID}.part`);
    await touchOld(file, PARTIAL_MAX_AGE_MS + 1000);

    expect(await removeStalePartials(root)).toBe(1);
  });

  it("does not descend into a hidden folder", async () => {
    const dir = path.join(root, ".git");
    await fs.mkdir(dir);
    const file = path.join(dir, `.download-${UUID}.part`);
    await touchOld(file, PARTIAL_MAX_AGE_MS + 1000);

    expect(await removeStalePartials(root)).toBe(0);
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it("leaves a file that merely looks similar alone", async () => {
    const file = path.join(root, "download-notes.pdf.part");
    await touchOld(file, PARTIAL_MAX_AGE_MS + 1000);

    expect(await removeStalePartials(root)).toBe(0);
  });

  it("does nothing when the root does not exist", async () => {
    await expect(removeStalePartials(path.join(root, "missing"))).resolves.toBe(0);
  });
});
