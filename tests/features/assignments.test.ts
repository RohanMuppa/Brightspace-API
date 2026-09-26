import { describe, it, expect, vi } from "vitest";
import { fetchCourseAssignments, getAssignments } from "../../src/features/assignments.js";
import type { FeatureContext } from "../../src/features/context.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * fetchCourseAssignments takes baseUrl as an optional trailing argument so the
 * dropbox and quiz results can carry a deep link back into Brightspace.
 */

const BASE = "https://brightspace.example.edu";
const COURSE_ID = 101;

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });

/** Mocked client: only the folder and quiz listings return rows. */
function makeApiClient() {
  return {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/dropbox/folders/")) {
        return [{ Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null }];
      }
      if (path.endsWith("/quizzes/")) {
        return { Objects: [{ QuizId: 66, Name: "Quiz 1", IsActive: true }] };
      }
      throw notFound();
    }),
  };
}

describe("fetchCourseAssignments", () => {
  it("adds deep-link urls when baseUrl is supplied", async () => {
    const assignments = await fetchCourseAssignments(
      makeApiClient() as any,
      COURSE_ID,
      BASE
    );

    expect(assignments.map((a) => a.url)).toEqual([
      `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=55&grpid=0&ou=101`,
      `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=66&ou=101`,
    ]);
  });

  it("leaves url null when baseUrl is omitted", async () => {
    const assignments = await fetchCourseAssignments(makeApiClient() as any, COURSE_ID);

    expect(assignments).toHaveLength(2);
    expect(assignments.every((a) => a.url === null)).toBe(true);
  });

  it("emits instructions as a plain markdown string, not {markdown, html}", async () => {
    const assignments = await fetchCourseAssignments(makeApiClient() as any, COURSE_ID);
    const [dropbox, quiz] = assignments;

    // Neither fixture supplies HTML instructions, so both fall back to "".
    expect(dropbox.instructions).toBe("");
    expect(quiz.instructions).toBe("");
  });
});

/**
 * The live Purdue tenant sends quiz rich text one level deeper than the flat
 * { Text, Html } this code assumed, calls the time limit SubmissionTimeLimit,
 * and answers /quizzes/{id}/attempts/ with 403 for every student. The mapping
 * has to read the shapes D2L actually sends and stop reporting an unmeasured
 * attempt count as if it were measured.
 */

/** Mocked client over a supplied quiz list, recording every requested path. */
function makeQuizClient(quizzes: any[], onAttempts: (quizId: number) => unknown) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/quizzes/")) return { Objects: quizzes };
      const attempts = path.match(/\/quizzes\/(\d+)\/attempts\/$/);
      if (attempts) return onAttempts(Number(attempts[1]));
      throw notFound();
    }),
  };
  return { apiClient, requested };
}

const quizzesOf = (assignments: any[]) => assignments.filter((a) => a.type === "quiz");

describe("fetchCourseAssignments quiz mapping", () => {
  it("recovers a visible quiz omitted from the quiz listing via the content table of contents", async () => {
    const requested: string[] = [];
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        requested.push(path);
        if (path.endsWith("/dropbox/folders/")) return [];
        if (path.endsWith("/quizzes/")) throw forbidden();
        if (path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) {
          return {
            Modules: [{
              ModuleId: 10,
              Title: "Week 1",
              Modules: [],
              Topics: [{
                TopicId: 21916707,
                Title: "VNOS #1",
                ActivityType: 4,
                ToolItemId: 1408513,
                IsHidden: false,
                IsBroken: false,
                IsExempt: false,
              }],
            }],
          };
        }
        if (path.endsWith("/quizzes/1408513")) {
          return {
            QuizId: 1408513,
            Name: "VNOS #1",
            IsActive: true,
            DueDate: "2026-09-14T03:59:00.000Z",
          };
        }
        if (path.endsWith("/quizzes/1408513/attempts/")) throw forbidden();
        throw notFound();
      }),
    };

    const quizzes = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID, BASE));

    expect(quizzes).toHaveLength(1);
    expect(quizzes[0]).toMatchObject({
      id: 1408513,
      name: "VNOS #1",
      dueDate: "2026-09-14T03:59:00.000Z",
    });
    expect(requested).toContain(`/d2l/api/le/1.0/${COURSE_ID}/quizzes/1408513`);
  });

  it("does not refetch a content-linked quiz already present in the quiz listing", async () => {
    const { apiClient, requested } = makeQuizClient(
      [{ QuizId: 1408513, Name: "VNOS #1", IsActive: true }],
      () => {
        throw forbidden();
      }
    );
    apiClient.get.mockImplementation(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/quizzes/")) {
        return { Objects: [{ QuizId: 1408513, Name: "VNOS #1", IsActive: true }] };
      }
      if (path.endsWith("/content/toc")) {
        return {
          Modules: [{
            Topics: [{ TopicId: 21916707, Title: "VNOS #1", ActivityType: 4, ToolItemId: 1408513 }],
          }],
        };
      }
      if (path.includes("/attempts/")) throw forbidden();
      throw notFound();
    });

    const quizzes = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quizzes).toHaveLength(1);
    expect(requested).not.toContain(`/d2l/api/le/1.0/${COURSE_ID}/quizzes/1408513`);
  });

  it("uses visible content metadata when the individual quiz route is unavailable", async () => {
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/dropbox/folders/")) return [];
        if (path.endsWith("/quizzes/")) return { Objects: [] };
        if (path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) {
          return {
            Modules: [{
              Topics: [{ TopicId: 21916707, Title: "VNOS #1", ActivityType: 4, ToolItemId: 1408513 }],
            }],
          };
        }
        if (path.endsWith("/quizzes/1408513")) throw forbidden();
        if (path.endsWith("/content/topics/21916707")) {
          return {
            TopicId: 21916707,
            Title: "VNOS #1",
            DueDate: "2026-09-14T03:59:00.000Z",
          };
        }
        throw notFound();
      }),
    };

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz).toMatchObject({
      id: 1408513,
      name: "VNOS #1",
      dueDate: "2026-09-14T03:59:00.000Z",
      attemptsAvailable: false,
    });
  });

  it("reads instructions from the nested Description the tenant sends", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          Description: {
            Text: { Text: "Read chapter 3", Html: "<p>Read <b>chapter 3</b></p>" },
            IsDisplayed: true,
          },
        },
      ],
      () => {
        throw notFound();
      }
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.instructions).toContain("**chapter 3**");
  });

  it("still reads instructions from a flat Description", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          Description: { Text: "Read chapter 3", Html: "<p>Read <b>chapter 3</b></p>" },
        },
      ],
      () => {
        throw notFound();
      }
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.instructions).toContain("**chapter 3**");
  });

  it("maps SubmissionTimeLimit onto timeLimit", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Timed",
          IsActive: true,
          SubmissionTimeLimit: { IsEnforced: true, ShowClock: true, TimeLimitValue: 45 },
          SubmissionGracePeriod: 5,
          Password: "letmein",
        },
        {
          QuizId: 2,
          Name: "Untimed",
          IsActive: true,
          SubmissionTimeLimit: { IsEnforced: false, ShowClock: false, TimeLimitValue: 120 },
        },
      ],
      () => []
    );

    const [timed, untimed] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(timed.timeLimit).toBe(45);
    expect(timed.gracePeriodMinutes).toBe(5);
    expect(timed.hasPassword).toBe(true);
    expect(untimed.timeLimit).toBeNull();
    expect(untimed.gracePeriodMinutes).toBeNull();
    expect(untimed.hasPassword).toBe(false);
  });

  it("stops requesting attempts for a course after the first 403", async () => {
    const { apiClient, requested } = makeQuizClient(
      [
        { QuizId: 1, Name: "Quiz 1", IsActive: true, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 } },
        { QuizId: 2, Name: "Quiz 2", IsActive: true, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 } },
      ],
      () => {
        throw forbidden();
      }
    );

    const quizzes = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    const attemptCalls = requested.filter((p) => p.includes("/attempts/"));
    expect(attemptCalls).toEqual([`/d2l/api/le/1.0/${COURSE_ID}/quizzes/1/attempts/`]);
    for (const quiz of quizzes) {
      expect(quiz.attemptsAvailable).toBe(false);
      expect(quiz.attemptsUsed).toBeNull();
      expect(quiz.attemptsRemaining).toBeNull();
      expect(quiz.bestScore).toBeNull();
      expect(quiz.attemptWarning).toBeNull();
    }
    // attemptsAllowed comes off the quiz object, so it survives the 403.
    expect(quizzes[0].attemptsAllowed).toBe(2);
  });

  it("keeps the attempt computation when the endpoint answers", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 },
        },
      ],
      () => ({
        Objects: [
          { AttemptId: 9, AttemptNumber: 1, Score: 17, IsCompleted: true, CompletedDate: null },
        ],
      })
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.attemptsAvailable).toBe(true);
    expect(quiz.attemptsUsed).toBe(1);
    expect(quiz.attemptsRemaining).toBe(1);
    expect(quiz.bestScore).toBe(17);
    expect(quiz.attemptWarning).toBe("WARNING: Only 1 attempt remaining");
  });
});

/**
 * The all-courses path reads the enrollment list itself. myenrollments is
 * bookmark-paged and its isActive filter is server-side, so the list has to be
 * followed to its last page and queried according to the configured
 * activeOnly policy — the same two rules getMyCourses already follows.
 */

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

const enrollmentItem = (c: typeof COURSE_A, isActive = true) => ({
  OrgUnit: c,
  Access: { ClasslistRoleName: "Student", IsActive: isActive, LastAccessed: null },
});

function allCoursesConfig(activeOnly: boolean): AppConfig {
  return {
    baseUrl: BASE,
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

/** Builds a fake FeatureContext over a responder, recording every requested path. */
function setupContext(respond: (path: string) => unknown, config: AppConfig) {
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

/** One dropbox folder per course, named after it; everything else is empty. */
const courseWork = (path: string): unknown => {
  const match = path.match(/\/le\/1\.0\/(\d+)\/dropbox\/folders\/$/);
  if (match) {
    return [{ Id: Number(match[1]), Name: `HW ${match[1]}`, DueDate: null, IsHidden: false, GroupTypeId: null }];
  }
  if (path.endsWith("/quizzes/") || path.endsWith("/grades/")) return [];
  if (path.endsWith("/content/toc")) return { Modules: [] };
  throw notFound();
};

describe("getAssignments across all courses", () => {
  it("follows the enrollment bookmark chain instead of stopping at page one", async () => {
    const { ctx, requested } = setupContext((path) => {
      if (path.includes("/enrollments/")) {
        return path.includes("bookmark=")
          ? { Items: [enrollmentItem(COURSE_B)], PagingInfo: { HasMoreItems: false } }
          : { Items: [enrollmentItem(COURSE_A)], PagingInfo: { HasMoreItems: true, Bookmark: "page-2" } };
      }
      return courseWork(path);
    }, allCoursesConfig(true));

    const result = await getAssignments(ctx);
    if (!("courses" in result)) throw new Error("expected the all-courses shape");
    expect(result.courses.map((c) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
    expect(requested.filter((p) => p.includes("/enrollments/"))).toHaveLength(2);
  });

  it("drops isActive=true from the query when activeOnly is off", async () => {
    const { ctx, requested } = setupContext((path) => {
      if (path.includes("/enrollments/")) {
        // D2L filters server-side, so isActive=true really does hide COURSE_B.
        return {
          Items: path.includes("isActive=true")
            ? [enrollmentItem(COURSE_A)]
            : [enrollmentItem(COURSE_A), enrollmentItem(COURSE_B, false)],
        };
      }
      return courseWork(path);
    }, allCoursesConfig(false));

    const result = await getAssignments(ctx);
    if (!("courses" in result)) throw new Error("expected the all-courses shape");
    expect(requested[0]).not.toContain("isActive=true");
    expect(result.courses.map((c) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
  });

  it("still asks only for active enrollments under the default policy", async () => {
    const { ctx, requested } = setupContext((path) => {
      if (path.includes("/enrollments/")) return { Items: [enrollmentItem(COURSE_A)] };
      return courseWork(path);
    }, allCoursesConfig(true));

    await getAssignments(ctx);
    expect(requested[0]).toContain("isActive=true");
  });
});

/**
 * Gradebook heads-up rows.
 *
 * A course's gradebook carries columns for work that the student's own
 * dropbox and quiz listings cannot see: a proctored midterm, a participation
 * score, an exam administered outside Brightspace. Those columns are the only
 * evidence such work exists, so they are surfaced as items of their own.
 *
 * Two rules decide which columns qualify:
 *   1. Student-scored types only (1 numeric, 2 passfail, 3 selectbox, 4 text).
 *      The bookkeeping types (category, calculated, formula, final) describe
 *      the gradebook's own arithmetic, not work anybody owes.
 *   2. The column must match no already-fetched assignment or quiz, compared
 *      on AssociatedTool.ToolItemId. A linked column whose tool item WAS
 *      fetched is a duplicate; a linked column whose tool item was not is
 *      exactly the case this exists for.
 */

const FOLDER = { Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null };
const QUIZ = { QuizId: 66, Name: "Quiz 1", IsActive: true };

/**
 * @param columns the gradebook payload, a bare array in D2L's own shape
 */
function makeGradebookClient(columns: unknown) {
  return {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/dropbox/folders/")) return [FOLDER];
      if (path.endsWith("/quizzes/")) return { Objects: [QUIZ] };
      if (path.endsWith("/grades/")) {
        if (columns instanceof Error) throw columns;
        return columns;
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }),
  };
}

const headsUp = (items: any[]) => items.filter((i) => i.type === "gradeOnly");

describe("gradebook heads-up rows", () => {
  it("surfaces a student-scored column that matches no fetched item", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient([
        { Id: 900, Name: "Midterm Exam", GradeObjectTypeId: 1, AssociatedTool: null },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([
      {
        type: "gradeOnly",
        id: 900,
        name: "Midterm Exam",
        dueDate: null,
        url: `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=${COURSE_ID}`,
      },
    ]);
  });

  it("drops a column already covered by a fetched quiz or assignment", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient([
        { Id: 901, Name: "Quiz 1", GradeObjectTypeId: 1, AssociatedTool: { ToolItemId: 66 } },
        { Id: 902, Name: "HW 1", GradeObjectTypeId: 1, AssociatedTool: { ToolItemId: 55 } },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([]);
  });

  it("keeps a linked column whose tool item was never fetched", async () => {
    // The whole point: a released midterm's column IS linked, to a quiz the
    // student's own quizzes/ call cannot see.
    const items = await fetchCourseAssignments(
      makeGradebookClient([
        { Id: 903, Name: "Proctored Final", GradeObjectTypeId: 1, AssociatedTool: { ToolItemId: 7777 } },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items).map((i) => i.name)).toEqual(["Proctored Final"]);
  });

  it("keeps every student-scored type and no bookkeeping type", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient([
        { Id: 1, Name: "numeric", GradeObjectTypeId: 1 },
        { Id: 2, Name: "passfail", GradeObjectTypeId: 2 },
        { Id: 3, Name: "selectbox", GradeObjectTypeId: 3 },
        { Id: 4, Name: "text", GradeObjectTypeId: 4 },
        { Id: 5, Name: "category", GradeObjectTypeId: 5 },
        { Id: 6, Name: "calculated", GradeObjectTypeId: 6 },
        { Id: 7, Name: "formula", GradeObjectTypeId: 7 },
        { Id: 8, Name: "final", GradeObjectTypeId: 8 },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items).map((i) => i.name)).toEqual([
      "numeric",
      "passfail",
      "selectbox",
      "text",
    ]);
  });

  it("skips a nameless or id-less column without losing its siblings", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient([
        { Name: "no id", GradeObjectTypeId: 1 },
        { Id: 905, GradeObjectTypeId: 1 },
        { Id: 906, Name: "Attendance", GradeObjectTypeId: 2 },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items).map((i) => i.name)).toEqual(["Attendance"]);
  });

  it("carries a null url when no baseUrl was supplied", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient([{ Id: 907, Name: "Participation", GradeObjectTypeId: 1 }]) as any,
      COURSE_ID
    );

    expect(headsUp(items)[0].url).toBeNull();
  });

  it("a failing gradebook costs only its own rows", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient(Object.assign(new Error("Forbidden"), { status: 403 })) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([]);
    // The assignments and quizzes that did answer are untouched.
    expect(items.map((i) => i.type)).toEqual(["assignment", "quiz"]);
  });

  it("tolerates a gradebook that is not an array", async () => {
    const items = await fetchCourseAssignments(
      makeGradebookClient({ Objects: "not a list" }) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([]);
    expect(items).toHaveLength(2);
  });
});
