import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANIFEST_NAME, SyncManifest, unchangedSinceSync } from "../../src/sync/manifest.js";

/**
 * The manifest is how a rerun tells the files it wrote from the user's own:
 * keyed by course and topic (never by name alone, since the name on disk can
 * drift from what was planned), and only an entry that still matches the
 * file's recorded size and mtime may ever be replaced.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-manifest-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("SyncManifest.load", () => {
  it("reads as empty when no manifest file exists", async () => {
    const manifest = await SyncManifest.load(root);
    expect(manifest.get(1, 2)).toBeUndefined();
  });

  it("reads as empty when the file is malformed JSON", async () => {
    await fs.writeFile(path.join(root, MANIFEST_NAME), "{not json");
    const manifest = await SyncManifest.load(root);
    expect(manifest.get(1, 2)).toBeUndefined();
  });

  it("drops an entry whose path escapes the destination", async () => {
    await fs.writeFile(
      path.join(root, MANIFEST_NAME),
      JSON.stringify({ courses: { "1": { "2": { path: "../../etc/passwd", bytes: 10 } } } }),
    );
    const manifest = await SyncManifest.load(root);
    expect(manifest.get(1, 2)).toBeUndefined();
  });

  it("round-trips an entry written by set() and save()", async () => {
    const manifest = await SyncManifest.load(root);
    manifest.set(1, 2, { path: "Week 1/notes.pdf", bytes: 10, size: 10, mtimeMs: 1000 });
    await manifest.save();

    const reloaded = await SyncManifest.load(root);
    expect(reloaded.get(1, 2)).toEqual({ path: "Week 1/notes.pdf", bytes: 10, size: 10, mtimeMs: 1000 });
  });

  it("writes nothing when nothing changed", async () => {
    const manifest = await SyncManifest.load(root);
    await manifest.save();
    await expect(fs.access(path.join(root, MANIFEST_NAME))).rejects.toThrow();
  });

  it("writes the manifest file with restrictive permissions", async () => {
    const manifest = await SyncManifest.load(root);
    manifest.set(1, 2, { path: "a.pdf", bytes: 1 });
    await manifest.save();
    const stat = await fs.stat(path.join(root, MANIFEST_NAME));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("SyncManifest.ownerOf", () => {
  it("finds the topic that owns a path, compared the way the dedupe compares names", async () => {
    const manifest = await SyncManifest.load(root);
    manifest.set(1, 2, { path: "Week 1/Notes.pdf", bytes: 1 });
    expect(manifest.ownerOf(1, "week 1/notes.pdf")).toBe(2);
    expect(manifest.ownerOf(1, "week 1/missing.pdf")).toBeUndefined();
  });

  it("updates the owner index when an entry's path changes", async () => {
    const manifest = await SyncManifest.load(root);
    manifest.set(1, 2, { path: "a.pdf", bytes: 1 });
    manifest.set(1, 2, { path: "b.pdf", bytes: 1 });
    expect(manifest.ownerOf(1, "a.pdf")).toBeUndefined();
    expect(manifest.ownerOf(1, "b.pdf")).toBe(2);
  });
});

describe("unchangedSinceSync", () => {
  it("is true when size and mtime still match", () => {
    expect(unchangedSinceSync({ path: "a", bytes: 1, size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 1000 })).toBe(true);
  });

  it("is false when the size on disk has changed", () => {
    expect(unchangedSinceSync({ path: "a", bytes: 1, size: 10, mtimeMs: 1000 }, { size: 11, mtimeMs: 1000 })).toBe(false);
  });

  it("is false when the entry recorded no state", () => {
    expect(unchangedSinceSync({ path: "a", bytes: 1 }, { size: 10, mtimeMs: 1000 })).toBe(false);
  });
});
