import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncCourse, DEFAULT_MAX_FILES } from "../../src/sync/course-sync.js";
import { SyncInputError } from "../../src/sync/errors.js";
import { MANIFEST_NAME } from "../../src/sync/manifest.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ApiError } from "../../src/api/index.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";

/**
 * syncCourse is the engine behind downloadCourseFiles and the `sync` CLI
 * command: it plans a course's table of contents into files and folders,
 * downloads what is missing, and keeps a manifest so a rerun only fetches
 * what is new and never overwrites the user's own files.
 */

const COURSE_ID = 42;

function fakeApi(toc: unknown, files: Record<number, { body?: string; headers?: Record<string, string>; error?: unknown }>) {
  const getCalls: string[] = [];
  const getRawCalls: string[] = [];
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (p: string, opts?: { signal?: AbortSignal }) => {
      getCalls.push(p);
      opts?.signal?.throwIfAborted();
      if (p.endsWith("/content/toc")) return toc;
      throw new Error(`unexpected get ${p}`);
    }),
    getRaw: vi.fn(async (p: string, opts?: { signal?: AbortSignal }) => {
      getRawCalls.push(p);
      opts?.signal?.throwIfAborted();
      const match = /\/content\/topics\/(\d+)\/file$/.exec(p);
      const topicId = match ? Number(match[1]) : NaN;
      const file = files[topicId];
      if (!file) throw new ApiError(404, p, "not found");
      if (file.error) throw file.error;
      const body = file.body ?? "";
      return new Response(body, {
        status: 200,
        headers: new Headers({ "Content-Length": String(Buffer.byteLength(body)), ...(file.headers ?? {}) }),
      });
    }),
  };
  return { api, getCalls, getRawCalls };
}

function makeCtx(api: unknown): FeatureContext {
  return { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
}

const SIMPLE_TOC = {
  Modules: [
    {
      ModuleId: 1,
      Title: "Week 1",
      Topics: [
        { TopicId: 10, Title: "Lecture Notes", TopicType: 1, Url: "/content/enforced/42-C/notes.txt" },
        { TopicId: 11, Title: "Syllabus Link", TopicType: 2, Url: "https://example.com" },
        { TopicId: 12, Title: "Broken Upload", TopicType: 1, Url: "" },
      ],
    },
    {
      ModuleId: 2,
      Title: "Week 2",
      Topics: [{ TopicId: 20, Title: "Recorded Lecture", TypeIdentifier: "ContentService" }],
    },
  ],
};

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "course-sync-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("syncCourse: planning and downloading", () => {
  it("downloads every File topic into a folder named after its module", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "week 1 notes" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root });

    expect(result.downloaded).toEqual([{ path: "Week 1/notes.txt", bytes: Buffer.byteLength("week 1 notes") }]);
    expect(await fs.readFile(path.join(root, "Week 1", "notes.txt"), "utf-8")).toBe("week 1 notes");
  });

  it("counts a link, an embedded-media topic, and a broken upload as non-files, not failures", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root });

    expect(result.nonFiles).toEqual({ link: 1, media: 1, broken: 1, other: 0 });
    expect(result.failed).toEqual([]);
  });

  it("creates a manifest recording what it wrote", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root });

    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf-8"));
    expect(manifest.courses["42"]["10"].path).toBe("Week 1/notes.txt");
  });

  it("is a no-op on a dry run: nothing written, planned files listed", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, dryRun: true });

    expect(result.planned).toEqual(["Week 1/notes.txt"]);
    expect(result.downloaded).toEqual([]);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("limits the sync to one module with moduleId", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, moduleId: 2, dryRun: true });

    expect(result.planned).toEqual([]);
    expect(result.nonFiles.media).toBe(1);
  });

  it("throws SyncInputError for an unknown moduleId", async () => {
    const { api } = fakeApi(SIMPLE_TOC, {});
    await expect(syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, moduleId: 999 })).rejects.toBeInstanceOf(SyncInputError);
  });
});

describe("syncCourse: rerun behaviour", () => {
  it("skips a file already on disk by default", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    const ctx = makeCtx(api);
    await syncCourse(ctx, { courseId: COURSE_ID, destination: root });

    const second = await syncCourse(ctx, { courseId: COURSE_ID, destination: root });
    expect(second.downloaded).toEqual([]);
    expect(second.skippedExisting).toBe(1);
  });

  it("leaves a user's own file (not recorded in the manifest) alone, never overwriting it", async () => {
    await fs.mkdir(path.join(root, "Week 1"), { recursive: true });
    await fs.writeFile(path.join(root, "Week 1", "notes.txt"), "my own annotated copy");
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "server copy" } });

    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, existing: "replace" });
    expect(result.skippedExisting).toBe(1);
    expect(await fs.readFile(path.join(root, "Week 1", "notes.txt"), "utf-8")).toBe("my own annotated copy");
  });

  it("replace overwrites a file it previously wrote and that is still untouched", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "version 1" } });
    const ctx = makeCtx(api);
    await syncCourse(ctx, { courseId: COURSE_ID, destination: root });

    const { api: api2 } = fakeApi(SIMPLE_TOC, { 10: { body: "version 2, a bit longer" } });
    const result = await syncCourse(makeCtx(api2), { courseId: COURSE_ID, destination: root, existing: "replace" });

    expect(result.downloaded).toEqual([{ path: "Week 1/notes.txt", bytes: Buffer.byteLength("version 2, a bit longer") }]);
    expect(await fs.readFile(path.join(root, "Week 1", "notes.txt"), "utf-8")).toBe("version 2, a bit longer");
  });

  it("keep_both saves a different copy beside the existing file", async () => {
    await fs.mkdir(path.join(root, "Week 1"), { recursive: true });
    await fs.writeFile(path.join(root, "Week 1", "notes.txt"), "existing");
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "a brand new different copy" } });

    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, existing: "keep_both" });
    expect(result.downloaded[0]?.path).toBe("Week 1/notes (1).txt");
    expect(await fs.readFile(path.join(root, "Week 1", "notes.txt"), "utf-8")).toBe("existing");
  });
});

describe("syncCourse: caps and failures", () => {
  it("reports a file over the file cap as not attempted, not failed", async () => {
    const toc = {
      Modules: [{
        ModuleId: 1,
        Title: "Week 1",
        Topics: [
          { TopicId: 10, Title: "a.txt", TopicType: 1, Url: "/a.txt" },
          { TopicId: 11, Title: "b.txt", TopicType: 1, Url: "/b.txt" },
        ],
      }],
    };
    const { api } = fakeApi(toc, { 10: { body: "a" }, 11: { body: "b" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, maxFiles: 1 });

    expect(result.downloaded).toHaveLength(1);
    expect(result.notAttempted).toBe(1);
  });

  it("uses the default file cap of 300 when none is given", () => {
    expect(DEFAULT_MAX_FILES).toBe(300);
  });

  it("records a download failure (e.g. a 403) without stopping the rest of the run", async () => {
    const toc = {
      Modules: [{
        ModuleId: 1,
        Title: "Week 1",
        Topics: [
          { TopicId: 10, Title: "locked.txt", TopicType: 1, Url: "/locked.txt" },
          { TopicId: 11, Title: "ok.txt", TopicType: 1, Url: "/ok.txt" },
        ],
      }],
    };
    const { api } = fakeApi(toc, { 10: { error: new ApiError(403, "/x", "forbidden") }, 11: { body: "ok" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root });

    expect(result.failed).toEqual([{ path: "Week 1/locked.txt", error: "Brightspace answered 403 (access denied)" }]);
    expect(result.downloaded).toEqual([{ path: "Week 1/ok.txt", bytes: 2 }]);
  });

  it("counts a 0-byte file as empty, not a failure", async () => {
    const toc = { Modules: [{ ModuleId: 1, Title: "Week 1", Topics: [{ TopicId: 10, Title: "empty.txt", TopicType: 1, Url: "/empty.txt" }] }] };
    const { api } = fakeApi(toc, { 10: { body: "" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root });

    expect(result.emptyOnBrightspace).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("refuses a sensitive destination before touching the network", async () => {
    const { api, getCalls } = fakeApi(SIMPLE_TOC, {});
    await expect(syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: path.join(root, ".hidden") })).rejects.toBeInstanceOf(SyncInputError);
    expect(getCalls).toEqual([]);
  });

  it("refuses a destination that does not exist", async () => {
    const { api } = fakeApi(SIMPLE_TOC, {});
    await expect(syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: path.join(root, "missing") })).rejects.toBeInstanceOf(SyncInputError);
  });

  it("refuses a second concurrent sync into the same destination", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    const ctx = makeCtx(api);
    const first = syncCourse(ctx, { courseId: COURSE_ID, destination: root });
    await expect(syncCourse(ctx, { courseId: COURSE_ID, destination: root })).rejects.toBeInstanceOf(SyncInputError);
    await first;
  });
});

describe("syncCourse: cancellation and auth", () => {
  it("stops cleanly when the signal aborts before the table of contents is read", async () => {
    const { api } = fakeApi(SIMPLE_TOC, { 10: { body: "x" } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root, signal: AbortSignal.abort("cancelled") });

    expect(result.stopped).toBe("cancelled");
    expect(result.downloaded).toEqual([]);
  });

  it("reports an expired session as stopped: auth, keeping files already saved", async () => {
    const toc = {
      Modules: [{
        ModuleId: 1,
        Title: "Week 1",
        Topics: [{ TopicId: 10, Title: "a.txt", TopicType: 1, Url: "/a.txt" }],
      }],
    };
    const { api } = fakeApi(toc, { 10: { error: new AuthProcessError("failed", "Sign-in failed") } });
    const result = await syncCourse(makeCtx(api), { courseId: COURSE_ID, destination: root });

    expect(result.stopped).toBe("auth");
    expect(result.authError).toBeDefined();
    expect(result.notAttempted).toBe(1);
  });
});
