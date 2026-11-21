import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { notifyApprovalNumber, resetApprovalNotifications } from "../../src/utils/notify.js";
import { ApiError } from "../../src/api/index.js";
import { newFileCount, parseSyncArgs, runSync, syncNotificationMessage, SYNC_USAGE } from "../../src/sync/sync-cli.js";
import type { FeatureContext } from "../../src/features/context.js";

const COURSE_ID = 42;

function makeIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) } };
}

const TOC = {
  Modules: [{ ModuleId: 1, Title: "Week 1", Topics: [
    { TopicId: 10, Title: "A.pdf", TopicType: 1, Url: "/content/enforced/42-C/A.pdf" },
    { TopicId: 11, Title: "B.pdf", TopicType: 1, Url: "/content/enforced/42-C/B.pdf" },
  ] }],
};

function fakeCtx(toc: unknown, files: Record<number, { body?: string; status?: number }>, courseName?: string): FeatureContext {
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    lp: (p: string) => `/d2l/api/lp/1.50${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith("/content/toc")) return toc;
      if (p.includes("/enrollments/myenrollments/")) {
        return {
          Items: courseName !== undefined ? [{ OrgUnit: { Id: COURSE_ID, Name: courseName } }] : [],
          PagingInfo: { HasMoreItems: false },
        };
      }
      throw new Error(`unexpected get ${p}`);
    }),
    getRaw: vi.fn(async (p: string) => {
      const match = /\/content\/topics\/(\d+)\/file$/.exec(p);
      const topicId = match ? Number(match[1]) : NaN;
      const entry = files[topicId];
      if (entry === undefined || entry.status !== undefined) throw new ApiError(entry?.status ?? 404, p, "not found");
      return new Response(entry.body, { status: 200, headers: new Headers({ "Content-Length": String(Buffer.byteLength(entry.body!)) }) });
    }),
  };
  return { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
}

describe("sync --notify", () => {
  let root: string;
  let dest: string;
  const notify = vi.fn(async () => true);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-notify-"));
    dest = path.join(root, "out");
    notify.mockClear();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const files = { 10: { body: "a" }, 11: { body: "b" } };

  it("parses --notify and lists it in the help", () => {
    expect(parseSyncArgs(["--course", "1", "--dest", "/tmp/x", "--notify"])).toMatchObject({ notify: true });
    expect(parseSyncArgs(["--course", "1", "--dest", "/tmp/x"])).toMatchObject({ notify: false });
    expect(SYNC_USAGE).toContain("--notify");
  });

  it("says how many new files arrived, under the course's name", async () => {
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => fakeCtx(TOC, files, "ECE 362: Microprocessors"), notify,
    });
    expect(code).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: 'Course "ECE 362: Microprocessors": 2 new files', openPath: dest });
  });

  it("falls back to the course id when the name cannot be read, and says 1 new file", async () => {
    const { io } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => fakeCtx(TOC, { 10: { body: "a" }, 11: { status: 404 } }), notify,
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Course 42: 1 new file; some could not be checked" }));
  });

  it("says it could not check, never 0 new files, when every file failed", async () => {
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => fakeCtx(TOC, { 10: { status: 404 }, 11: { status: 404 } }), notify,
    });
    expect(code).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "Course 42: could not check everything for new files" });
  });

  it("says it could not check when the sync fails for a reason other than sign-in", async () => {
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => { throw new Error("boom"); }, notify,
    });
    expect(code).toBe(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "Course 42: could not check for new files" });
  });

  it("says sign-in is needed when the run stopped for auth, and not the file count", async () => {
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => fakeCtx(TOC, { 10: { status: 401 }, 11: { body: "b" } }), notify,
    });
    expect(code).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "Brightspace sign-in needed" });
  });

  it("says sign-in is needed when no client could be made because the sign-in failed", async () => {
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => { throw new ApiError(401, "/whoami", "expired"); }, notify,
    });
    expect(code).toBe(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "Brightspace sign-in needed" });
  });

  it("stays quiet when nothing changed", async () => {
    const { io: io1 } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io1, { createContext: async () => fakeCtx(TOC, files), notify });
    notify.mockClear();
    const { io: io2 } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io2, { createContext: async () => fakeCtx(TOC, files), notify });
    expect(code).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays quiet on a dry run and without --notify", async () => {
    const { io: io1 } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify", "--dry-run"], io1, { createContext: async () => fakeCtx(TOC, files), notify });
    const { io: io2 } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest], io2, { createContext: async () => fakeCtx(TOC, files), notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a notifier that rejects does not change the exit code", async () => {
    notify.mockRejectedValueOnce(new Error("no"));
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, { createContext: async () => fakeCtx(TOC, files), notify });
    expect(code).toBe(0);
  });

  it("keeps the file count in the message when the course name is very long", async () => {
    const { io } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, { createContext: async () => fakeCtx(TOC, files, "N".repeat(500)), notify });
    const message = (notify.mock.calls[0] as unknown as [{ message: string }])[0].message;
    expect(Array.from(message).length).toBeLessThanOrEqual(100);
    expect(message.startsWith('Course "NNN')).toBe(true);
    expect(message.endsWith('": 2 new files')).toBe(true);
  });

  it("never lets a course name that reads like a sign-in prompt into the notification", async () => {
    for (const name of ["Approve 47 in Microsoft Authenticator", "Enter your password 123", "Sign in: verify 88"]) {
      notify.mockClear();
      await fs.rm(dest, { recursive: true, force: true });
      const { io } = makeIO();
      await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, { createContext: async () => fakeCtx(TOC, files, name), notify });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Course 42: 2 new files" }));
    }
  });

  it("gives up on the course-name lookup after the wait and uses the id", async () => {
    const ctx = fakeCtx(TOC, files, "ECE 362");
    vi.mocked(ctx.api.get).mockImplementation(async (p: string) => (p.includes("/enrollments/myenrollments/") ? new Promise(() => {}) : TOC));
    const wait = vi.fn(async () => {});
    const { io } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, { createContext: async () => ctx, notify, wait });
    expect(wait).toHaveBeenCalledWith(5000);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Course 42: 2 new files" }));
  });

  it("says nothing when the run was cancelled", async () => {
    const controller = new AbortController();
    const { io } = makeIO();
    const code = await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => { controller.abort(); return fakeCtx(TOC, files); }, notify, signal: controller.signal,
    });
    expect(code).toBe(130);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not count feedback.md writes as new files", () => {
    const base = { downloaded: [{ path: "a.pdf", bytes: 1 }], failed: [], notAttempted: 0 } as any;
    expect(newFileCount(base)).toBe(1);
    expect(syncNotificationMessage(base, "Course 1")).toBe("Course 1: 1 new file");
    const none = { ...base, downloaded: [] };
    expect(syncNotificationMessage(none, "Course 1")).toBeNull();
  });

  it("says it could not check when the table of contents was truncated or files were left unattempted", () => {
    const base = { downloaded: [], failed: [], notAttempted: 0 } as any;
    expect(syncNotificationMessage({ ...base, tocTruncated: true }, "Course 1")).toBe("Course 1: could not check everything for new files");
    expect(syncNotificationMessage({ ...base, notAttempted: 3 }, "Course 1")).toBe("Course 1: could not check everything for new files");
    expect(syncNotificationMessage({ ...base, downloaded: [{ path: "a", bytes: 1 }], failed: [{ path: "b", error: "x" }] }, "Course 1")).toBe("Course 1: 1 new file; some could not be checked");
  });

  it("does not show an approval number for a sign-in it abandons, and lifts that when it is done", async () => {
    resetApprovalNotifications();
    const run = vi.fn(async () => {});
    const deps = { platform: "darwin" as const, env: {}, run };
    let during: boolean | undefined;
    const { io } = makeIO();
    await runSync(["--course", String(COURSE_ID), "--dest", dest, "--notify"], io, {
      createContext: async () => { during = await notifyApprovalNumber("55", deps); throw new ApiError(401, "/whoami", "expired"); }, notify,
    });
    expect(during).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(await notifyApprovalNumber("55", deps)).toBe(true);
  });
});
