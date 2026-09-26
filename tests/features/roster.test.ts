import { describe, it, expect, vi } from "vitest";
import { getRoster } from "../../src/features/roster.js";
import type { FeatureContext } from "../../src/features/context.js";

/**
 * The roster reads the same paged classlist endpoint, so it dropped users past
 * the first page too. A full class can easily outrun one page.
 *
 * It also capped the result at 100 users and said so only in a log line the
 * model never sees, so a 340 person lecture looked like a 100 person one. The
 * cap is still there, because an enormous roster would swamp the response, but
 * it is now reported in the payload and the caller can raise it.
 */

const COURSE_ID = 101;

const user = (name: string) => ({
  Identifier: name.length,
  DisplayName: name,
  Email: `${name}@example.edu`,
  FirstName: name,
  LastName: null,
  RoleId: null,
  ClasslistRoleDisplayName: "Student",
  IsOnline: false,
  LastAccessed: null,
});

function setup(respond: (path: string) => unknown) {
  const requested: string[] = [];
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };
  const ctx = { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx, requested };
}

describe("getRoster pagination", () => {
  it("returns students across both pages", async () => {
    const { ctx, requested } = setup((path) =>
      path.includes("bookmark=b1") ? { Objects: [user("grace")], Next: null } : { Objects: [user("ada")], Next: "b1" },
    );

    const result = await getRoster(ctx, { courseId: COURSE_ID, includeStudents: true });

    expect(result.users.map((r) => r.name)).toEqual(["ada", "grace"]);
    expect(requested).toHaveLength(2);
  });
});

describe("getRoster truncation", () => {
  const manyUsers = (count: number) => Array.from({ length: count }, (_, i) => user(`student${i}`));

  it("reports the total and the truncation rather than hiding it", async () => {
    const { ctx } = setup(() => ({ Objects: manyUsers(340), Next: null }));

    const result = await getRoster(ctx, { courseId: COURSE_ID, includeStudents: true });

    expect(result.total).toBe(340);
    expect(result.returned).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.users).toHaveLength(100);
    expect(result.note).toMatch(/limit/i);
  });

  it("is not truncated when the class fits", async () => {
    const { ctx } = setup(() => ({ Objects: manyUsers(12), Next: null }));

    const result = await getRoster(ctx, { courseId: COURSE_ID, includeStudents: true });

    expect(result.total).toBe(12);
    expect(result.returned).toBe(12);
    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it("honors an explicit limit", async () => {
    const { ctx } = setup(() => ({ Objects: manyUsers(340), Next: null }));

    const result = await getRoster(ctx, { courseId: COURSE_ID, includeStudents: true, limit: 250 });

    expect(result.returned).toBe(250);
    expect(result.truncated).toBe(true);
  });
});
