import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMyCourses } from "../../src/features/courses.js";
import type { FeatureContext } from "../../src/features/context.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * activeOnly resolution: the argument shapes the myenrollments query string,
 * and the fetched rows then pass through applyCourseFilter. Both must use the
 * same resolved value, or activeOnly:false fetches inactive courses and throws
 * them away again.
 */

const COURSES = [
  { id: 15853, name: "Sandbox", code: "sandbox", isActive: true },
  { id: 319544, name: "IDSN-532", code: "20263_34066", isActive: false },
];

function makeConfig(activeOnly: boolean): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

function setup(config: AppConfig) {
  const requested: string[] = [];
  const api = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      const activeOnlyQuery = path.includes("isActive=true");
      const items = COURSES.filter((c) => !activeOnlyQuery || c.isActive);
      return {
        Items: items.map((c) => ({
          OrgUnit: { Id: c.id, Name: c.name, Code: c.code },
          Access: { ClasslistRoleName: "Instructor", IsActive: c.isActive, LastAccessed: null },
        })),
      };
    }),
  };
  const ctx = { api, config, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx, requested };
}

const idsOf = (courses: Array<{ id: number }>) => courses.map((c) => c.id);

describe("getMyCourses activeOnly resolution", () => {
  let config: AppConfig;

  beforeEach(() => {
    config = makeConfig(true);
  });

  it("returns inactive courses when the caller passes activeOnly:false", async () => {
    const { ctx, requested } = setup(config);
    const result = await getMyCourses(ctx, { activeOnly: false });
    expect(requested[0]).not.toContain("isActive=true");
    expect(idsOf(result)).toEqual([15853, 319544]);
  });

  it("filters to active courses when the caller passes activeOnly:true", async () => {
    const { ctx, requested } = setup(config);
    const result = await getMyCourses(ctx, { activeOnly: true });
    expect(requested[0]).toContain("isActive=true");
    expect(idsOf(result)).toEqual([15853]);
  });

  it("falls back to the configured policy when the argument is omitted", async () => {
    const { ctx } = setup(makeConfig(false));
    expect(idsOf(await getMyCourses(ctx))).toEqual([15853, 319544]);
  });

  it("honours a configured activeOnly:true when the argument is omitted", async () => {
    const { ctx } = setup(makeConfig(true));
    expect(idsOf(await getMyCourses(ctx, {}))).toEqual([15853]);
  });

  it("returns plain objects with the documented fields", async () => {
    const { ctx } = setup(makeConfig(true));
    const [course] = await getMyCourses(ctx);
    expect(course).toEqual({
      id: 15853,
      name: "Sandbox",
      code: "sandbox",
      role: "Instructor",
      isActive: true,
      canAccess: undefined,
      lastAccessed: null,
    });
  });
});

/** Enrollments arrive one page at a time; every page must be read. */
describe("getMyCourses pagination", () => {
  it("returns courses from every page of enrollments", async () => {
    const requested: string[] = [];
    const page = (id: number, bookmark?: string) => ({
      Items: [
        {
          OrgUnit: { Id: id, Name: `Course ${id}`, Code: `c${id}` },
          Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
        },
      ],
      PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark ?? "" },
    });
    const api = {
      lp: (p: string) => `/d2l/api/lp/1.0${p}`,
      get: vi.fn(async (path: string) => {
        requested.push(path);
        return path.includes("bookmark=b1") ? page(2) : page(1, "b1");
      }),
    };
    const ctx = { api, config: makeConfig(true), version: "0.0.0-test" } as unknown as FeatureContext;

    const result = await getMyCourses(ctx);

    expect(idsOf(result)).toEqual([1, 2]);
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("bookmark=b1");
  });
});
