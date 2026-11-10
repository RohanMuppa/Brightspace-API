import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureDestinationPolicy,
  downloadRootsFromEnv,
  resetDownloadRootWarnings,
  sensitiveDestination,
  sensitiveDestinationMessage,
} from "../../src/utils/sensitive-paths.js";

/**
 * Names inside a download destination can come from a course (sync) or a
 * remote filename, so the destination itself must never be the home folder,
 * a hidden folder, or a system folder — otherwise a course could plant files
 * where they do real harm.
 */

let root: string;
let home: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-paths-"));
  home = path.join(root, "home", "student");
  await fs.mkdir(home, { recursive: true });
  configureDestinationPolicy({ home });
});

afterEach(async () => {
  configureDestinationPolicy({});
  resetDownloadRootWarnings();
  await fs.rm(root, { recursive: true, force: true });
});

describe("sensitiveDestination", () => {
  it("allows an ordinary folder under the home directory", async () => {
    const dest = path.join(home, "Documents", "Brightspace");
    await fs.mkdir(dest, { recursive: true });
    expect(await sensitiveDestination(dest)).toBeNull();
  });

  it("refuses the home directory itself", async () => {
    expect(await sensitiveDestination(home)).toMatch(/home directory itself/);
  });

  it("refuses a path through a hidden folder", async () => {
    const dest = path.join(home, ".ssh");
    expect(await sensitiveDestination(dest)).toMatch(/hidden folder/);
  });

  it("refuses a hidden folder nested deeper in the path", async () => {
    const dest = path.join(home, "project", ".git", "hooks");
    expect(await sensitiveDestination(dest)).toMatch(/hidden folder/);
  });

  it("refuses a Windows device path", async () => {
    expect(await sensitiveDestination("\\\\?\\C:\\Users\\student")).toMatch(/device path/);
  });

  it("follows a symbolic link to where it points before judging it", async () => {
    const real = path.join(home, ".secret");
    await fs.mkdir(real, { recursive: true });
    const link = path.join(home, "Documents");
    await fs.mkdir(path.dirname(link), { recursive: true }).catch(() => {});
    await fs.symlink(real, link).catch(async () => {
      // Documents may already exist from another test on some platforms; ignore.
    });
    const reason = await sensitiveDestination(link);
    expect(reason).not.toBeNull();
  });

  it("allows a destination inside an operator-configured extra root even inside a hidden folder", async () => {
    const dest = path.join(home, ".config", "brightspace");
    await fs.mkdir(dest, { recursive: true });
    configureDestinationPolicy({ home, allowRoots: [path.join(home, ".config")] });
    expect(await sensitiveDestination(dest)).toBeNull();
  });
});

describe("downloadRootsFromEnv", () => {
  it("accepts an absolute root distinct from the home folder", async () => {
    const extra = path.join(root, "data");
    await fs.mkdir(extra, { recursive: true });
    const roots = await downloadRootsFromEnv(extra, home);
    expect(roots).toHaveLength(1);
  });

  it("ignores a relative path", async () => {
    expect(await downloadRootsFromEnv("relative/path", home)).toEqual([]);
  });

  it("ignores an entry that is the home folder itself", async () => {
    expect(await downloadRootsFromEnv(home, home)).toEqual([]);
  });

  it("ignores an entry that contains the home folder", async () => {
    expect(await downloadRootsFromEnv(path.dirname(home), home)).toEqual([]);
  });
});

describe("sensitiveDestinationMessage", () => {
  it("names the destination and the reason", () => {
    const message = sensitiveDestinationMessage("/root/stuff", "it is the administrator's home");
    expect(message).toContain("/root/stuff");
    expect(message).toContain("it is the administrator's home");
  });
});
