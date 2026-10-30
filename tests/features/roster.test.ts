import { describe, it, expect, vi } from "vitest";
import { getRoster } from "../../src/features/roster.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ApiError, NetworkError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";

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

/**
 * In the default staff view a role route that failed for any reason was only
 * logged, so a 500 on the TA route returned the instructors alone and read as
 * "this course has no TAs" (port of brightspace-mcp-server#388). The result
 * now names the roles that could not be read.
 */
describe("getRoster when a role route fails", () => {
  const serverError = () => new ApiError(500, "/classlist", "Internal Server Error");
  const staff = (name: string) => ({ ...user(name), ClasslistRoleDisplayName: "Instructor" });

  it("marks TAs unavailable when the TA route fails with a 5xx", async () => {
    const { ctx } = setup((path) => {
      if (path.includes("roleId=135")) throw serverError();
      return { Objects: [staff("prof")], Next: null };
    });

    const result = await getRoster(ctx, { courseId: COURSE_ID });

    expect(result.users.map((u) => u.name)).toEqual(["prof"]);
    expect(result.unavailable).toEqual(["TAs"]);
    expect(result.notice).toMatch(/TAs .*could not be read/);
    expect(result.notice).toMatch(/no TAs/);
  });

  it("marks instructors unavailable when the instructor route drops the connection", async () => {
    const { ctx } = setup((path) => {
      if (path.includes("roleId=109")) throw new NetworkError("socket hang up");
      return { Objects: [staff("ta")], Next: null };
    });

    const result = await getRoster(ctx, { courseId: COURSE_ID });

    expect(result.users.map((u) => u.name)).toEqual(["ta"]);
    expect(result.unavailable).toEqual(["instructors"]);
  });

  it("names both roles when both routes fail", async () => {
    const { ctx } = setup(() => {
      throw serverError();
    });

    const result = await getRoster(ctx, { courseId: COURSE_ID });

    expect(result.users).toEqual([]);
    expect(result.unavailable).toEqual(["instructors", "TAs"]);
    expect(result.notice).toContain("instructors and TAs");
    expect(result.notice).toContain("no instructors or TAs");
  });

  it("stays quiet on a 403, which means the role list is restricted", async () => {
    const { ctx } = setup((path) => {
      if (path.includes("roleId=135")) throw new ApiError(403, "/classlist", "Forbidden");
      return { Objects: [staff("prof")], Next: null };
    });

    const result = await getRoster(ctx, { courseId: COURSE_ID });

    expect(result.users.map((u) => u.name)).toEqual(["prof"]);
    expect(result).not.toHaveProperty("unavailable");
    expect(result).not.toHaveProperty("notice");
  });

  it("adds nothing when both routes succeed", async () => {
    const { ctx } = setup((path) =>
      path.includes("roleId=109") ? { Objects: [staff("prof")], Next: null } : { Objects: [], Next: null },
    );

    const result = await getRoster(ctx, { courseId: COURSE_ID });

    expect(result.users.map((u) => u.name)).toEqual(["prof"]);
    expect(result).not.toHaveProperty("unavailable");
    expect(result).not.toHaveProperty("notice");
  });

  it.each([
    ["an unrecovered 401", new ApiError(401, "/classlist", "expired")],
    ["a pending MFA sign-in", new AuthProcessError("mfaPending", "MFA approval pending")],
  ])("throws instead of returning a partial roster on %s", async (_label, error) => {
    const { ctx } = setup((path) => {
      if (path.includes("roleId=135")) throw error;
      return { Objects: [staff("prof")], Next: null };
    });

    await expect(getRoster(ctx, { courseId: COURSE_ID })).rejects.toBe(error);
  });
});
