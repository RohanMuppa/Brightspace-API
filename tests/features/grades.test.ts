import { describe, it, expect, vi } from "vitest";
import { getMyGrades } from "../../src/features/grades.js";
import type { FeatureContext } from "../../src/features/context.js";
import type { AppConfig } from "../../src/types/index.js";
import { ApiError, NetworkError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";

/**
 * The all-courses branch of getMyGrades resolves its course list from the
 * same paged myenrollments endpoint getMyCourses reads, and it has to respect
 * the same activeOnly policy. Reading a single page drops the courses after it;
 * pinning isActive=true into the query drops archived courses even when the
 * user configured activeOnly:false to ask for them.
 */

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

function makeConfig(activeOnly: boolean): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

type Responder = (path: string) => unknown;

function setup(respond: Responder, config: AppConfig = makeConfig(true)) {
  const requested: string[] = [];
  const api = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };
  const ctx = { api, config, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx, requested };
}

const grade = (name: string) => ({
  GradeObjectIdentifier: name,
  GradeObjectName: name,
  DisplayedGrade: "95 %",
  PointsNumerator: 95,
  PointsDenominator: 100,
  WeightedNumerator: null,
  WeightedDenominator: null,
  Comments: null,
  PrivateComments: null,
  LastModified: "2026-09-01T00:00:00.000Z",
  ReleasedDate: null,
});

const enrollmentPage = (course: typeof COURSE_A, isActive: boolean, bookmark?: string) => ({
  Items: [
    {
      OrgUnit: course,
      Access: { ClasslistRoleName: "Student", IsActive: isActive, LastAccessed: null },
    },
  ],
  PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark ?? "" },
});

describe("getMyGrades all-courses course resolution", () => {
  it("returns grades for courses on every page of enrollments", async () => {
    const { ctx } = setup((path) => {
      if (path.includes("/enrollments/")) {
        return path.includes("bookmark=b1") ? enrollmentPage(COURSE_B, true) : enrollmentPage(COURSE_A, true, "b1");
      }
      if (path.includes(`/${COURSE_A.Id}/grades/`)) return [grade("Exam 1")];
      if (path.includes(`/${COURSE_B.Id}/grades/`)) return [grade("Quiz 2")];
      return [];
    });

    const result = await getMyGrades(ctx);
    expect(result.map((c) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
  });

  it("honours a configured activeOnly:false instead of forcing isActive=true", async () => {
    // Stand in for the server: isActive=true really does withhold the archived
    // course, so a hardcoded filter loses it before applyCourseFilter is asked.
    const { ctx, requested } = setup(
      (path) => {
        if (path.includes("/enrollments/")) {
          if (path.includes("isActive=true")) return { Items: [] };
          return enrollmentPage(COURSE_B, false);
        }
        if (path.includes(`/${COURSE_B.Id}/grades/`)) return [grade("Final")];
        return [];
      },
      makeConfig(false),
    );

    const result = await getMyGrades(ctx);
    expect(requested[0]).not.toContain("isActive=true");
    expect(result.map((c) => c.courseId)).toEqual([COURSE_B.Id]);
  });

  it("keeps asking for isActive=true under the default policy", async () => {
    const { ctx, requested } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollmentPage(COURSE_A, true);
      return [grade("Exam 1")];
    });

    await getMyGrades(ctx);
    expect(requested[0]).toContain("isActive=true");
  });

  it("returns a single course's grades without touching enrollments", async () => {
    const { ctx, requested } = setup(() => [grade("Homework 1")]);

    const result = await getMyGrades(ctx, { courseId: COURSE_A.Id });
    expect(result).toHaveLength(1);
    expect(result[0].courseId).toBe(COURSE_A.Id);
    expect(result[0].grades).toHaveLength(1);
    expect(requested.some((p) => p.includes("/enrollments/"))).toBe(false);
  });
});

/**
 * A course whose grade request fails with anything but a 403 used to vanish
 * from the all-courses result, because the per-course promise rethrew and
 * Promise.allSettled filtered the rejection out (brightspace-mcp-server#245).
 */
describe("getMyGrades all-courses failed courses", () => {
  const twoCourses = {
    Items: [COURSE_A, COURSE_B].map((course) => ({
      OrgUnit: course,
      Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
    })),
    PagingInfo: { HasMoreItems: false, Bookmark: "" },
  };

  function failingB(error: unknown) {
    return setup((path) => {
      if (path.includes("/enrollments/")) return twoCourses;
      if (path.includes(`/${COURSE_A.Id}/grades/`)) return [grade("Exam 1")];
      if (path.includes(`/${COURSE_B.Id}/grades/`)) throw error;
      return [];
    });
  }

  it.each([
    ["a 404", new ApiError(404, "/grades", "missing"), "BRIGHTSPACE_NOT_FOUND", 404],
    ["a 500", new ApiError(500, "/grades", "boom"), "BRIGHTSPACE_API_ERROR", 500],
    ["a network error", new NetworkError("socket hang up"), "BRIGHTSPACE_NETWORK", undefined],
  ])("keeps a course whose grades fail with %s and marks it failed", async (_label, error, code, status) => {
    const { ctx } = failingB(error);

    const result = await getMyGrades(ctx);
    expect(result.map((c) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);

    const [a, b] = result;
    expect(a.grades).toHaveLength(1);
    expect(a).not.toHaveProperty("failed");

    expect(b.courseName).toBe(COURSE_B.Name);
    expect(b.grades).toEqual([]);
    const gradeUrl = `https://brightspace.example.edu/d2l/lms/grades/my_grades/main.d2l?ou=${COURSE_B.Id}`;
    expect(b.failed).toEqual({
      code,
      ...(status === undefined ? {} : { status }),
      gradeUrl,
      notice: expect.stringContaining(gradeUrl),
    });
    expect(b.failed?.notice).toContain("not no grades");
  });

  it("leaves every course unmarked when nothing failed", async () => {
    const { ctx } = setup((path) => {
      if (path.includes("/enrollments/")) return twoCourses;
      return [grade("Exam 1")];
    });

    const result = await getMyGrades(ctx);
    expect(result).toHaveLength(2);
    for (const course of result) expect(course).not.toHaveProperty("failed");
  });

  it("still skips a 403 course without marking it", async () => {
    const { ctx } = failingB(new ApiError(403, "/grades", "forbidden"));

    const result = await getMyGrades(ctx);
    expect(result.map((c) => c.courseId)).toEqual([COURSE_A.Id]);
  });

  it.each([
    ["an unrecovered 401", new ApiError(401, "/grades", "expired")],
    ["a pending MFA sign-in", new AuthProcessError("mfaPending", "MFA approval pending")],
  ])("throws instead of reporting a course when %s", async (_label, error) => {
    const { ctx } = failingB(error);

    await expect(getMyGrades(ctx)).rejects.toBe(error);
  });
});
