import { describe, it, expect, vi } from "vitest";
import { getCourseContent } from "../../src/features/content.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ZodError } from "zod";

/**
 * A module whose structure lists itself is a cycle, and with no maxDepth the
 * tree builder followed it forever. Descent now stops at a hard ceiling.
 */

const COURSE_ID = 101;

const SELF_REFERENCING_MODULE = {
  Id: 1,
  Title: "Week 1",
  ShortTitle: null,
  Type: 0,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

function makeCtx(get: (path: string) => Promise<unknown>): FeatureContext {
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(get),
  };
  return { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
}

function setup() {
  const requested: string[] = [];
  const ctx = makeCtx(async (path: string) => {
    requested.push(path);
    if (path.endsWith("/content/userprogress/")) return [];
    return [SELF_REFERENCING_MODULE];
  });
  return { ctx, requested };
}

/**
 * The tree used to emit isHidden, isLocked, dueDate, and completedDate on
 * every node even when false/null, padding every response with fields that
 * carry no information. They should appear only when they say something.
 */
describe("getCourseContent sparse flags", () => {
  function setupWithRoot(rootItems: unknown[], progress: unknown[] = []) {
    return makeCtx(async (path: string) => {
      if (path.endsWith("/content/userprogress/")) return progress;
      if (path.endsWith("/content/root/")) return rootItems;
      return [];
    });
  }

  it("omits isHidden, isLocked, dueDate, and completedDate when they carry no signal", async () => {
    const ctx = setupWithRoot([
      {
        Id: 5,
        Title: "Syllabus",
        ShortTitle: null,
        Type: 1,
        TopicType: 1,
        Description: null,
        IsHidden: false,
        IsLocked: false,
        DueDate: null,
        LastModifiedDate: null,
      },
    ]);

    const result = await getCourseContent(ctx, { courseId: COURSE_ID });
    const topic = result.contentTree[0] as any;

    expect(topic).not.toHaveProperty("isHidden");
    expect(topic).not.toHaveProperty("isLocked");
    expect(topic).not.toHaveProperty("dueDate");
    expect(topic).not.toHaveProperty("completedDate");
  });

  it("keeps isHidden, isLocked, dueDate, and completedDate when true/set", async () => {
    const ctx = setupWithRoot(
      [
        {
          Id: 6,
          Title: "Locked reading",
          ShortTitle: null,
          Type: 1,
          TopicType: 1,
          Description: null,
          IsHidden: true,
          IsLocked: true,
          DueDate: "2026-10-01T00:00:00.000Z",
          LastModifiedDate: null,
        },
      ],
      [{ UserId: 1, ContentObjectId: 6, IsRead: true, DateCompleted: "2026-09-20T00:00:00.000Z" }],
    );

    const result = await getCourseContent(ctx, { courseId: COURSE_ID });
    const topic = result.contentTree[0] as any;

    expect(topic.isHidden).toBe(true);
    expect(topic.isLocked).toBe(true);
    expect(topic.dueDate).toBe("2026-10-01T00:00:00.000Z");
    expect(topic.completedDate).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("getCourseContent recursion cap", () => {
  it("terminates on a self-referencing module structure", async () => {
    const { ctx, requested } = setup();

    const result = await getCourseContent(ctx, { courseId: COURSE_ID });

    // Twelve levels of descent: the root module plus twelve nested copies.
    expect(result.moduleCount).toBe(13);
    expect(requested.filter((p) => p.includes("/structure/"))).toHaveLength(12);
  });

  it("still honours a smaller maxDepth", async () => {
    const { ctx, requested } = setup();

    const result = await getCourseContent(ctx, { courseId: COURSE_ID, maxDepth: 2 });

    expect(result.moduleCount).toBe(3);
    expect(requested.filter((p) => p.includes("/structure/"))).toHaveLength(2);
  });
});

describe("getCourseContent modifiedSince (#34)", () => {
  const CUTOFF = "2026-09-15T00:00:00.000Z";
  const NEW = "2026-09-20T00:00:00.000Z";
  const OLD = "2026-01-01T00:00:00.000Z";

  const module = (id: number, lastModified: string | null) => ({
    Id: id,
    Title: `Module ${id}`,
    ShortTitle: null,
    Type: 0,
    Description: null,
    ModuleStartDate: null,
    ModuleEndDate: null,
    ModuleDueDate: null,
    IsHidden: false,
    IsLocked: false,
    LastModifiedDate: lastModified,
  });

  const topic = (id: number, lastModified: string | null) => ({
    Id: id,
    Title: `Topic ${id}`,
    ShortTitle: null,
    Type: 1,
    TopicType: 1,
    Description: null,
    ModuleStartDate: null,
    ModuleEndDate: null,
    ModuleDueDate: null,
    IsHidden: false,
    IsLocked: false,
    LastModifiedDate: lastModified,
  });

  /**
   * Module A: an old module containing one new topic and one old topic.
   * Module B: a newly-touched module containing one topic with no timestamp.
   */
  function setupTree() {
    const requested: string[] = [];
    const ctx = makeCtx(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/content/userprogress/")) return [];
      if (path.endsWith("/content/root/")) return [module(10, OLD), module(20, NEW)];
      if (path.includes("/content/modules/10/structure/")) return [topic(1, NEW), topic(2, OLD)];
      if (path.includes("/content/modules/20/structure/")) return [topic(3, null)];
      return [];
    });
    return { ctx, requested };
  }

  it("emits lastModified on modules and topics", async () => {
    const { ctx } = setupTree();
    const result = await getCourseContent(ctx, { courseId: COURSE_ID });

    const moduleA = result.contentTree.find((m: any) => m.id === 10) as any;
    expect(moduleA.lastModified).toBe(OLD);
    expect(moduleA.children.find((t: any) => t.id === 1).lastModified).toBe(NEW);
  });

  it("keeps only topics at or after modifiedSince, dropping the rest", async () => {
    const { ctx } = setupTree();
    const result = await getCourseContent(ctx, { courseId: COURSE_ID, modifiedSince: CUTOFF });

    const moduleA = result.contentTree.find((m: any) => m.id === 10) as any;
    expect(moduleA.children.map((t: any) => t.id)).toEqual([1]);
  });

  it("retains a module whose own timestamp matches even if no child matched on its own merits", async () => {
    const { ctx } = setupTree();
    const result = await getCourseContent(ctx, { courseId: COURSE_ID, modifiedSince: CUTOFF });

    const moduleB = result.contentTree.find((m: any) => m.id === 20);
    expect(moduleB).toBeDefined();
  });

  it("includes a topic with a null timestamp rather than silently dropping it", async () => {
    const { ctx } = setupTree();
    const result = await getCourseContent(ctx, { courseId: COURSE_ID, modifiedSince: CUTOFF });

    const moduleB = result.contentTree.find((m: any) => m.id === 20) as any;
    expect(moduleB.children.map((t: any) => t.id)).toEqual([3]);
  });

  it("reports returned and filteredOut counts alongside the echoed modifiedSince", async () => {
    const { ctx } = setupTree();
    const result = await getCourseContent(ctx, { courseId: COURSE_ID, modifiedSince: CUTOFF });

    // Topic 2 (old, under module A) is the only one filtered out.
    expect(result.modifiedSince).toBe(CUTOFF);
    expect(result.returned).toBe(2);
    expect(result.filteredOut).toBe(1);
  });

  it("omits the filter summary entirely when modifiedSince is not passed", async () => {
    const { ctx } = setupTree();
    const result = await getCourseContent(ctx, { courseId: COURSE_ID });

    expect(result).not.toHaveProperty("modifiedSince");
    expect(result).not.toHaveProperty("filteredOut");
  });

  it("rejects a malformed modifiedSince with a ZodError naming the expected format", async () => {
    const { ctx } = setupTree();

    await expect(getCourseContent(ctx, { courseId: COURSE_ID, modifiedSince: "not-a-date" })).rejects.toBeInstanceOf(ZodError);
    await expect(getCourseContent(ctx, { courseId: COURSE_ID, modifiedSince: "not-a-date" })).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringMatching(/modifiedSince must be an ISO 8601 datetime/) })],
    });
  });
});

/**
 * /content/root/ already embeds each module's immediate children in Structure.
 * When the dedicated /structure/ call fails — a locked module, a momentary
 * 403 — the children were dropped on the floor and the module was reported as
 * empty. Under a typeFilter the module disappeared from the tree entirely,
 * because inclusion is decided by whether it has matching children.
 */

const FILE_TOPIC = {
  Id: 7,
  Title: "Lecture 1 slides",
  ShortTitle: null,
  Type: 1,
  TopicType: 1,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

const MODULE_WITH_EMBEDDED_STRUCTURE = {
  ...SELF_REFERENCING_MODULE,
  Id: 2,
  Title: "Week 1",
  Structure: [FILE_TOPIC],
};

/** Root answers with one module; its /structure/ call always fails. */
function setupBrokenStructure(rootModule: unknown): FeatureContext {
  return makeCtx(async (path: string) => {
    if (path.endsWith("/content/userprogress/")) return [];
    if (path.includes("/structure/")) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return [rootModule];
  });
}

describe("getCourseContent embedded structure fallback", () => {
  it("keeps the children the root listing already carried when /structure/ fails", async () => {
    const ctx = setupBrokenStructure(MODULE_WITH_EMBEDDED_STRUCTURE);

    const result = await getCourseContent(ctx, { courseId: COURSE_ID });

    expect(result.topicCount).toBe(1);
    expect((result.contentTree[0] as any).children[0]).toMatchObject({ type: "topic", topicType: "file", title: "Lecture 1 slides" });
  });

  it("does not drop the module under a typeFilter when /structure/ fails", async () => {
    const ctx = setupBrokenStructure(MODULE_WITH_EMBEDDED_STRUCTURE);

    const result = await getCourseContent(ctx, { courseId: COURSE_ID, typeFilter: "file" });

    expect(result.moduleCount).toBe(1);
    expect(result.topicCount).toBe(1);
  });

  it("still reports an empty module as empty when nothing was embedded", async () => {
    const ctx = setupBrokenStructure(SELF_REFERENCING_MODULE);

    const result = await getCourseContent(ctx, { courseId: COURSE_ID });

    expect(result.moduleCount).toBe(1);
    expect((result.contentTree[0] as any).children).toEqual([]);
  });
});
