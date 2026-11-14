import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanLine, parseSyncArgs, runSync } from "../../src/sync/sync-cli.js";
import { configureDestinationPolicy } from "../../src/utils/sensitive-paths.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ApiError } from "../../src/api/index.js";

const COURSE_ID = 42;

function makeIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) } };
}

function fakeCtx(toc: unknown, files: Record<number, string>): FeatureContext {
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith("/content/toc")) return toc;
      throw new Error(`unexpected get ${p}`);
    }),
    getRaw: vi.fn(async (p: string) => {
      const match = /\/content\/topics\/(\d+)\/file$/.exec(p);
      const topicId = match ? Number(match[1]) : NaN;
      const body = files[topicId];
      if (body === undefined) throw new ApiError(404, p, "not found");
      return new Response(body, { status: 200, headers: new Headers({ "Content-Length": String(Buffer.byteLength(body)) }) });
    }),
  };
  return { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
}

const TOC = {
  Modules: [{ ModuleId: 1, Title: "Week 1", Topics: [{ TopicId: 10, Title: "notes.txt", TopicType: 1, Url: "/notes.txt" }] }],
};

describe("parseSyncArgs", () => {
  it("requires --course and --dest", () => {
    expect(parseSyncArgs([])).toEqual({ error: "--course must be a course id (a whole number)." });
    expect(parseSyncArgs(["--course", "1"])).toEqual({ error: "--dest is required: the directory to save the course into." });
  });

  it("rejects an unknown --existing value", () => {
    expect(parseSyncArgs(["--course", "1", "--dest", "/tmp/x", "--existing", "delete"])).toEqual({
      error: "--existing must be skip, replace or keep_both.",
    });
  });

  it("parses every option", () => {
    const parsed = parseSyncArgs(["--course", "7", "--dest", "/tmp/out", "--existing", "replace", "--module", "3", "--dry-run", "--json", "--max-files", "10"]);
    expect(parsed).toMatchObject({
      courseId: 7,
      existing: "replace",
      moduleId: 3,
      dryRun: true,
      json: true,
      maxFiles: 10,
    });
  });

  it("recognizes --help", () => {
    expect(parseSyncArgs(["--help"])).toEqual({ help: true });
  });

  it("rejects an unknown flag", () => {
    expect(parseSyncArgs(["--course", "1", "--dest", "/tmp", "--bogus"])).toEqual({ error: "Unknown option: --bogus" });
  });
});

describe("cleanLine", () => {
  it("strips control characters and collapses them to a space", () => {
    expect(cleanLine("a\nb\tc")).toBe("a b c");
  });

  it("truncates a very long line", () => {
    const long = "x".repeat(400);
    const result = cleanLine(long);
    expect(result.length).toBe(300);
    expect(result.endsWith("...")).toBe(true);
  });
});

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-cli-"));
  configureDestinationPolicy({});
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("runSync", () => {
  it("prints the usage and exits 0 on --help", async () => {
    const { io, stdout } = makeIO();
    const code = await runSync(["--help"], io, { createContext: async () => fakeCtx(TOC, {}) });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Usage: brightspace sync");
  });

  it("exits 2 on a usage error, writing it to stderr", async () => {
    const { io, stderr } = makeIO();
    const code = await runSync([], io, { createContext: async () => fakeCtx(TOC, {}) });
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("--course must be a course id");
  });

  it("creates the destination and downloads the course, exiting 0", async () => {
    const dest = path.join(root, "out");
    const { io, stdout } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest], io, { createContext: async () => fakeCtx(TOC, { 10: "hello" }) });

    expect(code).toBe(0);
    expect(await fs.readFile(path.join(dest, "Week 1", "notes.txt"), "utf-8")).toBe("hello");
    expect(stdout.join("")).toContain("1 downloaded");
  });

  it("does not create the destination on a dry run", async () => {
    const dest = path.join(root, "preview");
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--dry-run"], io, { createContext: async () => fakeCtx(TOC, { 10: "hello" }) });

    expect(code).toBe(0);
    await expect(fs.access(dest)).rejects.toThrow();
  });

  it("prints JSON on stdout and the summary on stderr under --json", async () => {
    const dest = path.join(root, "out");
    const { io, stdout, stderr } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--json"], io, { createContext: async () => fakeCtx(TOC, { 10: "hello" }) });

    expect(() => JSON.parse(stdout.join(""))).not.toThrow();
    expect(stderr.join("")).toContain("downloaded");
  });

  it("exits 2 and leaves no folder behind for a refused destination", async () => {
    configureDestinationPolicy({ home: root });
    const dest = path.join(root, ".hidden");
    const { io, stderr } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest], io, { createContext: async () => fakeCtx(TOC, {}) });

    expect(code).toBe(2);
    expect(stderr.join("")).toContain("Cannot save into");
    await expect(fs.access(dest)).rejects.toThrow();
  });

  it("exits 1 when a file fails or is not attempted", async () => {
    const dest = path.join(root, "out");
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest], io, { createContext: async () => fakeCtx(TOC, {}) });
    expect(code).toBe(1);
  });

  it("returns 130 and says so when the signal is already aborted", async () => {
    const dest = path.join(root, "out");
    const { io, stderr } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest], io, {
      createContext: async () => fakeCtx(TOC, { 10: "hello" }),
      signal: AbortSignal.abort("cancelled"),
    });

    expect(code).toBe(130);
    expect(stderr.join("")).toContain("Interrupted");
  });
});
