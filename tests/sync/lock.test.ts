import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireSyncLock, STALE_LOCK_MS } from "../../src/sync/lock.js";
import { LOCK_NAME } from "../../src/sync/manifest.js";
import { SyncInputError } from "../../src/sync/errors.js";

/** One sync at a time per destination: two running together would race the manifest and the plan. */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-lock-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("acquireSyncLock", () => {
  it("takes the lock and writes a lock file", async () => {
    const release = await acquireSyncLock(root);
    await expect(fs.access(path.join(root, LOCK_NAME))).resolves.toBeUndefined();
    await release();
  });

  it("removes the lock file on release", async () => {
    const release = await acquireSyncLock(root);
    await release();
    await expect(fs.access(path.join(root, LOCK_NAME))).rejects.toThrow();
  });

  it("refuses a second lock while a live one is held", async () => {
    const release = await acquireSyncLock(root);
    await expect(acquireSyncLock(root)).rejects.toBeInstanceOf(SyncInputError);
    await release();
  });

  it("names the holding pid in the refusal", async () => {
    const release = await acquireSyncLock(root);
    const error = await acquireSyncLock(root).catch((e) => e);
    expect(error.message).toContain(String(process.pid));
    await release();
  });

  it("takes over a lock left by a dead process", async () => {
    await fs.writeFile(path.join(root, LOCK_NAME), JSON.stringify({ pid: 999999, startedAt: Date.now(), token: "x" }));
    const release = await acquireSyncLock(root);
    await release();
  });

  it("takes over a lock older than the stale threshold even for a live pid", async () => {
    await fs.writeFile(
      path.join(root, LOCK_NAME),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - STALE_LOCK_MS - 1000, token: "x" }),
    );
    const release = await acquireSyncLock(root);
    await release();
  });

  it("treats an unreadable lock file as dead and takes it over", async () => {
    await fs.writeFile(path.join(root, LOCK_NAME), "{not json");
    const release = await acquireSyncLock(root);
    await release();
  });

  it("lets a second sync proceed once the first releases", async () => {
    const release = await acquireSyncLock(root);
    await release();
    const second = await acquireSyncLock(root);
    await second();
  });
});
