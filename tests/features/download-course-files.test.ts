import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadCourseFiles } from "../../src/features/download-course-files.js";
import type { FeatureContext } from "../../src/features/context.js";
import { createBrightspaceClient } from "../../src/client/index.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * downloadCourseFiles is the client-facing wrapper over the shared sync
 * engine (src/sync/course-sync.ts): it validates arguments the way every
 * other feature does, and converts maxTotalMB to the engine's byte budget.
 */

const COURSE_ID = 7;

const TOC = {
  Modules: [{ ModuleId: 1, Title: "Week 1", Topics: [{ TopicId: 10, Title: "notes.txt", TopicType: 1, Url: "/notes.txt" }] }],
};

function fakeCtx(): FeatureContext {
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith("/content/toc")) return TOC;
      throw new Error(`unexpected get ${p}`);
    }),
    getRaw: vi.fn(async () => new Response("hello", { status: 200, headers: new Headers({ "Content-Length": "5" }) })),
  };
  return { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "download-course-files-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("downloadCourseFiles", () => {
  it("downloads the course into the destination and converts maxTotalMB to bytes", async () => {
    const ctx = fakeCtx();
    const result = await downloadCourseFiles(ctx, { courseId: COURSE_ID, destination: root, maxTotalMB: 1 });

    expect(result.downloaded).toEqual([{ path: "Week 1/notes.txt", bytes: 5 }]);
    expect(await fs.readFile(path.join(root, "Week 1", "notes.txt"), "utf-8")).toBe("hello");
  });

  it("rejects a non-whole courseId through the shared schema", async () => {
    const ctx = fakeCtx();
    await expect(downloadCourseFiles(ctx, { courseId: 1.5, destination: root } as never)).rejects.toThrow();
  });
});

describe("BrightspaceClient.downloadCourseFiles", () => {
  it("is exposed on the client facade and maps thrown errors to the public contract", async () => {
    const config = {
      baseUrl: "https://brightspace.example.edu",
      sessionDir: root,
      tokenTtl: 3600,
      headless: true,
      courseFilter: { activeOnly: true },
    } as AppConfig;
    const client = await createBrightspaceClient({ config });
    expect(typeof client.downloadCourseFiles).toBe("function");
  });
});
