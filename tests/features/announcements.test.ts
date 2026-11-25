import { describe, it, expect, vi } from "vitest";
import { getAnnouncements } from "../../src/features/announcements.js";
import type { FeatureContext } from "../../src/features/context.js";
import type { AppConfig } from "../../src/types/index.js";
import { ZodError } from "zod";
import { ApiError, TokenRefreshError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";

/**
 * getAnnouncements used to show every news item the API returned, sorted by
 * CreatedDate. Both are wrong against a live tenant: an item with
 * IsPublished false is a draft the instructor has not posted, and CreatedDate
 * is when the instructor started typing, not when the post was scheduled to
 * appear. StartDate is the honest date whenever there is one.
 *
 * Both rules have to hold on the single-course path and the all-courses path,
 * which sort and slice at separate call sites.
 */

const BASE = "https://brightspace.example.edu";

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

function makeConfig(activeOnly = true): AppConfig {
  return {
    baseUrl: BASE,
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

type Responder = (path: string) => unknown;

function setup(respond: Responder, config: AppConfig = makeConfig()) {
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

const enrollmentItem = (c: typeof COURSE_A, isActive = true) => ({
  OrgUnit: c,
  Access: { ClasslistRoleName: "Student", IsActive: isActive, LastAccessed: null },
});

const enrollments = (...courses: Array<typeof COURSE_A>) => ({
  Items: courses.map((c) => enrollmentItem(c)),
});

/** A news item with only the fields a case cares about; the rest are D2L's usual shape. */
const news = (item: Record<string, unknown>) => ({
  Title: "Announcement",
  Body: { Text: "body", Html: "<p>body</p>" },
  CreatedBy: { Identifier: "1", DisplayName: "Prof" },
  LastModifiedBy: { Identifier: "1", DisplayName: "Prof" },
  LastModifiedDate: "2026-09-01T00:00:00.000Z",
  EndDate: null,
  IsPinned: false,
  IsGlobal: false,
  Attachments: [],
  ...item,
});

/** Serves one course's news on the single-course path. */
const oneCourse = (items: unknown[]) => () => items;

/** Serves enrollments plus a per-course news payload on the all-courses path. */
const manyCourses = (byCourse: Record<number, unknown[]>): Responder => (path) => {
  if (path.includes("/enrollments/")) {
    return enrollments(...Object.keys(byCourse).map((id) => (Number(id) === COURSE_A.Id ? COURSE_A : COURSE_B)));
  }
  const match = path.match(/\/le\/1\.0\/(\d+)\//);
  return match ? byCourse[Number(match[1])] ?? [] : [];
};

describe("getAnnouncements", () => {
  describe("unpublished drafts", () => {
    it("excludes an item with IsPublished false", async () => {
      const { ctx } = setup(
        oneCourse([
          news({ Id: 1, Title: "Posted", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true }),
          news({ Id: 2, Title: "Draft", CreatedDate: "2026-09-02T00:00:00.000Z", StartDate: "2026-09-02T00:00:00.000Z", IsPublished: false }),
        ]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items.map((i) => i.title)).toEqual(["Posted"]);
    });

    it("keeps an item that carries no IsPublished field at all", async () => {
      const { ctx } = setup(
        oneCourse([news({ Id: 1, Title: "No flag", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z" })]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items.map((i) => i.title)).toEqual(["No flag"]);
    });

    it("keeps an item with IsPublished true", async () => {
      const { ctx } = setup(
        oneCourse([news({ Id: 1, Title: "Posted", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true })]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items.map((i) => i.title)).toEqual(["Posted"]);
    });
  });

  describe("scheduled-date ordering", () => {
    it("sorts by StartDate even when CreatedDate would give the opposite order", async () => {
      const writtenFriday = news({
        Id: 1,
        Title: "Scheduled Monday",
        CreatedDate: "2026-09-04T09:00:00.000Z",
        StartDate: "2026-09-07T09:00:00.000Z",
        IsPublished: true,
      });
      const writtenSaturday = news({
        Id: 2,
        Title: "Scheduled Sunday",
        CreatedDate: "2026-09-05T09:00:00.000Z",
        StartDate: "2026-09-06T09:00:00.000Z",
        IsPublished: true,
      });

      const { ctx } = setup(oneCourse([writtenFriday, writtenSaturday]));
      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];

      expect(items.map((i) => i.title)).toEqual(["Scheduled Monday", "Scheduled Sunday"]);
      expect(items.map((i) => i.date)).toEqual(["2026-09-07T09:00:00.000Z", "2026-09-06T09:00:00.000Z"]);
    });

    it("falls back to CreatedDate when an item has no StartDate", async () => {
      const { ctx } = setup(
        oneCourse([
          news({ Id: 1, Title: "No start", CreatedDate: "2026-09-10T00:00:00.000Z", StartDate: null, IsPublished: true }),
          news({ Id: 2, Title: "Scheduled", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-05T00:00:00.000Z", IsPublished: true }),
        ]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items.map((i) => i.title)).toEqual(["No start", "Scheduled"]);
      expect(items[0].date).toBe("2026-09-10T00:00:00.000Z");
    });

    it("sorts an item with neither date last, not to 1970", async () => {
      const { ctx } = setup(
        oneCourse([
          news({ Id: 1, Title: "Undated", CreatedDate: null, StartDate: null, IsPublished: true }),
          news({ Id: 2, Title: "Oldest real", CreatedDate: "2020-01-01T00:00:00.000Z", StartDate: null, IsPublished: true }),
          news({ Id: 3, Title: "Newest real", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: null, IsPublished: true }),
        ]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items.map((i) => i.title)).toEqual(["Newest real", "Oldest real", "Undated"]);
      expect(items[2].date).toBeNull();
    });

    it("keeps the server's own order when two items share a date", async () => {
      const same = "2026-09-01T12:00:00.000Z";
      const { ctx } = setup(
        oneCourse([
          news({ Id: 1, Title: "First posted", CreatedDate: same, StartDate: same, IsPublished: true }),
          news({ Id: 2, Title: "Second posted", CreatedDate: same, StartDate: same, IsPublished: true }),
        ]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items.map((i) => i.title)).toEqual(["First posted", "Second posted"]);
    });
  });

  it("omits createdDate and startDate, keeping only the effective date", async () => {
    const { ctx } = setup(
      oneCourse([news({ Id: 1, Title: "Posted", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-02T00:00:00.000Z", IsPublished: true })]),
    );

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0]).not.toHaveProperty("createdDate");
    expect(items[0]).not.toHaveProperty("startDate");
    expect(items[0].date).toBe("2026-09-02T00:00:00.000Z");
  });

  it("applies the count slice after filtering and sorting", async () => {
    const { ctx } = setup(
      oneCourse([
        news({ Id: 1, Title: "Draft newest", CreatedDate: "2026-09-09T00:00:00.000Z", StartDate: "2026-09-09T00:00:00.000Z", IsPublished: false }),
        news({ Id: 2, Title: "Third", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true }),
        news({ Id: 3, Title: "First", CreatedDate: "2026-09-08T00:00:00.000Z", StartDate: "2026-09-08T00:00:00.000Z", IsPublished: true }),
        news({ Id: 4, Title: "Second", CreatedDate: "2026-09-05T00:00:00.000Z", StartDate: "2026-09-05T00:00:00.000Z", IsPublished: true }),
      ]),
    );

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id, count: 2 })) as any[];
    // The draft is gone before the slice, so the cap is spent on real posts.
    expect(items.map((i) => i.title)).toEqual(["First", "Second"]);
  });

  describe("the all-courses path", () => {
    it("filters drafts and sorts by StartDate across courses", async () => {
      const { ctx } = setup(
        manyCourses({
          [COURSE_A.Id]: [
            news({ Id: 1, Title: "A draft", CreatedDate: "2026-09-09T00:00:00.000Z", StartDate: "2026-09-09T00:00:00.000Z", IsPublished: false }),
            news({ Id: 2, Title: "A scheduled Monday", CreatedDate: "2026-09-04T00:00:00.000Z", StartDate: "2026-09-07T00:00:00.000Z", IsPublished: true }),
          ],
          [COURSE_B.Id]: [
            news({ Id: 3, Title: "B scheduled Sunday", CreatedDate: "2026-09-05T00:00:00.000Z", StartDate: "2026-09-06T00:00:00.000Z", IsPublished: true }),
            news({ Id: 4, Title: "B no flag", CreatedDate: "2026-09-02T00:00:00.000Z", StartDate: null, IsPublished: undefined }),
          ],
        }),
      );

      const items = (await getAnnouncements(ctx, {})) as any[];
      expect(items.map((i) => i.title)).toEqual(["A scheduled Monday", "B scheduled Sunday", "B no flag"]);
      expect(items[0]).toMatchObject({ courseId: COURSE_A.Id, courseName: COURSE_A.Name });
      expect(items[2]).toMatchObject({ courseId: COURSE_B.Id, date: "2026-09-02T00:00:00.000Z" });
    });

    /**
     * myenrollments is bookmark-paged. Reading only the first page hides every
     * course past it — on a real Purdue account 44 enrollments come back over
     * several pages, so the later courses' announcements simply vanished.
     */
    it("follows the enrollment bookmark chain instead of stopping at page one", async () => {
      const newsByCourse: Record<number, unknown[]> = {
        [COURSE_A.Id]: [news({ Id: 1, Title: "A post", CreatedDate: "2026-09-08T00:00:00.000Z", StartDate: null, IsPublished: true })],
        [COURSE_B.Id]: [news({ Id: 2, Title: "B post", CreatedDate: "2026-09-03T00:00:00.000Z", StartDate: null, IsPublished: true })],
      };

      const { ctx, requested } = setup((path) => {
        if (path.includes("/enrollments/")) {
          return path.includes("bookmark=")
            ? { Items: [enrollmentItem(COURSE_B)], PagingInfo: { HasMoreItems: false } }
            : { Items: [enrollmentItem(COURSE_A)], PagingInfo: { HasMoreItems: true, Bookmark: "page-2" } };
        }
        const match = path.match(/\/le\/1\.0\/(\d+)\//);
        return match ? newsByCourse[Number(match[1])] ?? [] : [];
      });

      const items = (await getAnnouncements(ctx, {})) as any[];
      expect(items.map((i) => i.title)).toEqual(["A post", "B post"]);
      expect(requested.filter((p) => p.includes("/enrollments/"))).toHaveLength(2);
    });

    /**
     * activeOnly is a configured policy, not a constant. With it off the caller
     * asked to see past courses; hard-coding isActive=true into the query made
     * the server drop them before the filter ever saw them.
     */
    it("drops isActive=true from the query when activeOnly is off", async () => {
      const respond: Responder = (path) => {
        if (path.includes("/enrollments/")) {
          const items = path.includes("isActive=true") ? [enrollmentItem(COURSE_A)] : [enrollmentItem(COURSE_A), enrollmentItem(COURSE_B, false)];
          return { Items: items };
        }
        const match = path.match(/\/le\/1\.0\/(\d+)\//);
        if (!match) return [];
        return [news({ Id: Number(match[1]), Title: `post ${match[1]}`, CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: null, IsPublished: true })];
      };

      const { ctx, requested } = setup(respond, { ...makeConfig(), courseFilter: { activeOnly: false } } as AppConfig);

      const items = (await getAnnouncements(ctx, {})) as any[];
      expect(requested[0]).not.toContain("isActive=true");
      expect(items.map((i) => i.courseId).sort()).toEqual([COURSE_A.Id, COURSE_B.Id]);
    });

    it("still asks only for active enrollments under the default policy", async () => {
      const { ctx, requested } = setup(manyCourses({ [COURSE_A.Id]: [] }));
      await getAnnouncements(ctx, {});
      expect(requested[0]).toContain("isActive=true");
    });

    it("sorts an undated item last and honours count across courses", async () => {
      const { ctx } = setup(
        manyCourses({
          [COURSE_A.Id]: [
            news({ Id: 1, Title: "A undated", CreatedDate: null, StartDate: null, IsPublished: true }),
            news({ Id: 2, Title: "A newest", CreatedDate: "2026-09-08T00:00:00.000Z", StartDate: null, IsPublished: true }),
          ],
          [COURSE_B.Id]: [news({ Id: 3, Title: "B middle", CreatedDate: "2026-09-03T00:00:00.000Z", StartDate: null, IsPublished: true })],
        }),
      );

      const all = (await getAnnouncements(ctx, {})) as any[];
      expect(all.map((i) => i.title)).toEqual(["A newest", "B middle", "A undated"]);

      const capped = (await getAnnouncements(ctx, { count: 2 })) as any[];
      expect(capped.map((i) => i.title)).toEqual(["A newest", "B middle"]);
    });
  });

  describe("modifiedSince (#34)", () => {
    const CUTOFF = "2026-09-15T00:00:00.000Z";

    it("emits lastModified on every announcement", async () => {
      const { ctx } = setup(
        oneCourse([
          news({
            Id: 1,
            Title: "A",
            CreatedDate: "2026-09-01T00:00:00.000Z",
            StartDate: "2026-09-01T00:00:00.000Z",
            LastModifiedDate: "2026-09-10T00:00:00.000Z",
            IsPublished: true,
          }),
        ]),
      );

      const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
      expect(items[0].lastModified).toBe("2026-09-10T00:00:00.000Z");
    });

    it("returns a bare array, unchanged, when modifiedSince is omitted", async () => {
      const { ctx } = setup(
        oneCourse([news({ Id: 1, Title: "A", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true })]),
      );

      const result = await getAnnouncements(ctx, { courseId: COURSE_A.Id });
      expect(Array.isArray(result)).toBe(true);
    });

    it("filters out announcements modified before the cutoff, on the single-course path", async () => {
      const { ctx } = setup(
        oneCourse([
          news({
            Id: 1,
            Title: "New",
            CreatedDate: "2026-09-01T00:00:00.000Z",
            StartDate: "2026-09-01T00:00:00.000Z",
            LastModifiedDate: "2026-09-20T00:00:00.000Z",
            IsPublished: true,
          }),
          news({
            Id: 2,
            Title: "Old",
            CreatedDate: "2026-09-02T00:00:00.000Z",
            StartDate: "2026-09-02T00:00:00.000Z",
            LastModifiedDate: "2026-01-01T00:00:00.000Z",
            IsPublished: true,
          }),
        ]),
      );

      const result = (await getAnnouncements(ctx, { courseId: COURSE_A.Id, modifiedSince: CUTOFF })) as any;

      expect(result.announcements.map((a: any) => a.title)).toEqual(["New"]);
      expect(result.modifiedSince).toBe(CUTOFF);
      expect(result.returned).toBe(1);
      expect(result.filteredOut).toBe(1);
    });

    it("filters across courses on the all-courses path", async () => {
      const { ctx } = setup(
        manyCourses({
          [COURSE_A.Id]: [
            news({
              Id: 1,
              Title: "A new",
              CreatedDate: "2026-09-01T00:00:00.000Z",
              StartDate: "2026-09-01T00:00:00.000Z",
              LastModifiedDate: "2026-09-20T00:00:00.000Z",
              IsPublished: true,
            }),
          ],
          [COURSE_B.Id]: [
            news({
              Id: 2,
              Title: "B old",
              CreatedDate: "2026-09-01T00:00:00.000Z",
              StartDate: "2026-09-01T00:00:00.000Z",
              LastModifiedDate: "2026-01-01T00:00:00.000Z",
              IsPublished: true,
            }),
          ],
        }),
      );

      const result = (await getAnnouncements(ctx, { modifiedSince: CUTOFF })) as any;

      expect(result.announcements.map((a: any) => a.title)).toEqual(["A new"]);
      expect(result.filteredOut).toBe(1);
    });

    it("keeps an announcement with no LastModifiedDate rather than dropping it", async () => {
      const { ctx } = setup(
        oneCourse([
          news({
            Id: 1,
            Title: "No timestamp",
            CreatedDate: "2026-09-01T00:00:00.000Z",
            StartDate: "2026-09-01T00:00:00.000Z",
            LastModifiedDate: null as any,
            IsPublished: true,
          }),
        ]),
      );

      const result = (await getAnnouncements(ctx, { courseId: COURSE_A.Id, modifiedSince: CUTOFF })) as any;
      expect(result.announcements.map((a: any) => a.title)).toEqual(["No timestamp"]);
      expect(result.filteredOut).toBe(0);
    });

    it("rejects a malformed modifiedSince with a ZodError naming the expected format", async () => {
      const { ctx } = setup(oneCourse([]));

      await expect(getAnnouncements(ctx, { courseId: COURSE_A.Id, modifiedSince: "yesterday" })).rejects.toBeInstanceOf(ZodError);
      await expect(getAnnouncements(ctx, { courseId: COURSE_A.Id, modifiedSince: "yesterday" })).rejects.toMatchObject({
        issues: [expect.objectContaining({ message: expect.stringMatching(/modifiedSince must be an ISO 8601 datetime/) })],
      });
    });
  });
});

describe("getAnnouncements attachments", () => {
  it("lists an announcement's attached files by fileId, fileName and size", async () => {
    const { ctx } = setup(
      oneCourse([
        news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Attachments: [{ FileId: 77, FileName: "Field notes prompts.docx", Size: 20480 }] }),
      ]),
    );

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0].attachments).toEqual([{ fileId: 77, fileName: "Field notes prompts.docx", size: 20480 }]);
  });

  it("omits the attachments key on an announcement with no files", async () => {
    const { ctx } = setup(oneCourse([news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Attachments: [] })]));

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0]).not.toHaveProperty("attachments");
  });

  it("omits the attachments key when the tenant sends no Attachments field", async () => {
    const { ctx } = setup(oneCourse([news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Attachments: undefined })]));

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0]).not.toHaveProperty("attachments");
  });

  it("carries the courseId beside attachments on the all-courses path", async () => {
    const { ctx } = setup(
      manyCourses({
        [COURSE_A.Id]: [news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Attachments: [{ FileId: 77, FileName: "rubric.pdf", Size: 100 }] })],
      }),
    );

    const items = (await getAnnouncements(ctx, {})) as any[];
    expect(items[0]).toMatchObject({ courseId: COURSE_A.Id, attachments: [{ fileId: 77, fileName: "rubric.pdf", size: 100 }] });
  });
});

/**
 * In the all-courses form, a course whose /news/ read failed used to vanish:
 * a 403 came back as [] and anything else was swallowed by allSettled, so
 * "anything new?" read an unread course as "nothing new" (#114, port of
 * brightspace-mcp-server#456). Such a course is now named in unreadCourses
 * with a notice; a sign-in problem fails the whole call.
 */
describe("getAnnouncements unread courses (#114)", () => {
  const posted = news({ Id: 1, Title: "A post", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z" });

  /** COURSE_A answers with one post; COURSE_B's news route throws `failure`. */
  const bFails = (failure: () => unknown): Responder => (path) => {
    if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
    if (path.includes(`/${COURSE_B.Id}/news/`)) throw failure();
    return [posted];
  };

  it("names a 5xx course on the bare array, which keeps its shape", async () => {
    const { ctx } = setup(bFails(() => new ApiError(503, "/news/", "unavailable")));

    const result = (await getAnnouncements(ctx)) as any;
    expect(Array.isArray(result)).toBe(true);
    expect(result.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(JSON.parse(JSON.stringify(result))).toHaveLength(1);
    expect(result.unreadCourses).toEqual([
      { courseId: COURSE_B.Id, courseName: COURSE_B.Name, status: 503, code: "BRIGHTSPACE_API_ERROR" },
    ]);
    expect(result.notice).toContain(`"${COURSE_B.Name}" ${COURSE_B.Id} (HTTP 503)`);
    expect(result.notice).toContain("Do not read those courses as having no announcements");
  });

  it("names a 5xx course on the modifiedSince object", async () => {
    const { ctx } = setup(bFails(() => new ApiError(500, "/news/", "boom")));

    const result = (await getAnnouncements(ctx, { modifiedSince: "2026-01-01T00:00:00Z" })) as any;
    expect(result.announcements.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(result.returned).toBe(1);
    expect(result.unreadCourses).toEqual([
      { courseId: COURSE_B.Id, courseName: COURSE_B.Name, status: 500, code: "BRIGHTSPACE_API_ERROR" },
    ]);
    expect(result.notice).toContain(`"${COURSE_B.Name}" ${COURSE_B.Id}`);
  });

  it("names a course whose read failed without a status, leaving status out", async () => {
    const { ctx } = setup(bFails(() => new TypeError("fetch failed")));

    const result = (await getAnnouncements(ctx)) as any;
    expect(result.unreadCourses).toHaveLength(1);
    expect(result.unreadCourses[0]).not.toHaveProperty("status");
    expect(result.unreadCourses[0].courseId).toBe(COURSE_B.Id);
    expect(result.notice).not.toContain("HTTP");
  });

  it("names a 403 course too, instead of reading it as no announcements", async () => {
    const { ctx } = setup(bFails(() => new ApiError(403, "/news/", "forbidden")));

    const result = (await getAnnouncements(ctx)) as any;
    expect(result.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(result.unreadCourses).toEqual([
      { courseId: COURSE_B.Id, courseName: COURSE_B.Name, status: 403, code: "BRIGHTSPACE_FORBIDDEN" },
    ]);
    expect(result.notice).toContain("(HTTP 403)");
  });

  it("adds neither field when every course was read", async () => {
    const { ctx } = setup(manyCourses({ [COURSE_A.Id]: [posted], [COURSE_B.Id]: [] }));

    const list = (await getAnnouncements(ctx)) as any;
    expect(list).not.toHaveProperty("unreadCourses");
    expect(list).not.toHaveProperty("notice");

    const filtered = (await getAnnouncements(ctx, { modifiedSince: "2026-01-01T00:00:00Z" })) as any;
    expect(filtered).not.toHaveProperty("unreadCourses");
    expect(filtered).not.toHaveProperty("notice");
  });

  it.each([
    ["an unrecovered 401", () => new ApiError(401, "/news/", "expired")],
    ["a pending MFA sign-in", () => new AuthProcessError("mfaPending", "MFA approval pending")],
    ["a token refresh failure", () => new TokenRefreshError("down")],
  ])("throws instead of returning an empty list when every course fails with %s", async (_label, failure) => {
    const error = failure();
    const { ctx } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      throw error;
    });

    await expect(getAnnouncements(ctx)).rejects.toBe(error);
    await expect(getAnnouncements(ctx, { modifiedSince: "2026-01-01T00:00:00Z" })).rejects.toBe(error);
  });

  it("throws when only one course fails sign-in", async () => {
    const auth = new ApiError(401, "/news/", "expired");
    const { ctx } = setup(bFails(() => auth));
    await expect(getAnnouncements(ctx)).rejects.toBe(auth);
  });
});

/**
 * D2L RichText.Text is plaintext only, with no link URLs, and may be empty
 * while Html holds the post. The body is read from Html as markdown, falling
 * back to Text (#121).
 */
describe("getAnnouncements body read from Html (#121)", () => {
  it("keeps the link of an Html-only announcement body", async () => {
    const { ctx } = setup(
      oneCourse([
        news({
          Id: 1,
          StartDate: "2026-09-18T00:00:00.000Z",
          Body: { Text: "", Html: '<p>Slides are <a href="https://example.edu/slides.pdf">here</a>.</p>' },
        }),
      ]),
    );

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0].body).toContain("here");
    expect(items[0].body).toContain("https://example.edu/slides.pdf");
  });

  it("falls back to Text when Html converts to nothing readable", async () => {
    const { ctx } = setup(
      oneCourse([news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Body: { Text: "Plain body", Html: "<p>&nbsp;</p>" } })]),
    );

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0].body).toBe("Plain body");
  });

  it("keeps body an empty string when the item has no Body", async () => {
    const { ctx } = setup(oneCourse([news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Body: null })]));

    const items = (await getAnnouncements(ctx, { courseId: COURSE_A.Id })) as any[];
    expect(items[0].body).toBe("");
  });
});

/**
 * A course the include/exclude settings hid was never asked for its news, and
 * the caller may never have seen those settings, so it must not read as a
 * course with no announcements (#129, port of brightspace-mcp-server#490).
 */
describe("getAnnouncements reports courses hidden by course settings (#129)", () => {
  const posted = news({ Id: 1, Title: "A post", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z" });
  const SINCE = "2026-01-01T00:00:00Z";

  function configWith(filter: Partial<AppConfig["courseFilter"]>, activeOnly = true): AppConfig {
    const config = makeConfig(activeOnly);
    config.courseFilter = { ...config.courseFilter, ...filter };
    return config;
  }

  const respond = (active = true): Responder => (path) => {
    if (path.includes("/enrollments/")) {
      return { Items: [enrollmentItem(COURSE_A, active), enrollmentItem(COURSE_B, active)] };
    }
    return [posted];
  };

  it("names the course D2L_EXCLUDE_COURSES hid on the bare array, which keeps its shape", async () => {
    const { ctx, requested } = setup(respond(), configWith({ excludeCourseIds: [COURSE_B.Id] }));

    const result = (await getAnnouncements(ctx)) as any;
    expect(Array.isArray(result)).toBe(true);
    expect(result.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(JSON.parse(JSON.stringify(result))).toHaveLength(1);
    expect(requested.some((p) => p.includes(`/${COURSE_B.Id}/`))).toBe(false);
    expect(result.hiddenCourseIds).toEqual([COURSE_B.Id]);
    expect(result.hiddenBy).toEqual(["D2L_EXCLUDE_COURSES"]);
    expect(result.notice).toContain("1 enrolled course is hidden");
    expect(result.notice).toContain(`announcements were not read: ${COURSE_B.Id}.`);
    expect(result.notice).toContain("getAnnouncements again with that courseId");
    expect(result).not.toHaveProperty("unreadCourses");
  });

  it("names the hidden course on the modifiedSince object", async () => {
    const { ctx } = setup(respond(), configWith({ excludeCourseIds: [COURSE_B.Id] }));

    const result = (await getAnnouncements(ctx, { modifiedSince: SINCE })) as any;
    expect(result.announcements.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(result.returned).toBe(1);
    expect(result.modifiedSince).toBe(SINCE);
    expect(result.hiddenCourseIds).toEqual([COURSE_B.Id]);
    expect(result.hiddenBy).toEqual(["D2L_EXCLUDE_COURSES"]);
    expect(result.notice).toContain("1 enrolled course is hidden");
    expect(result).not.toHaveProperty("unreadCourses");
  });

  it("names D2L_INCLUDE_COURSES when it hides courses", async () => {
    const { ctx } = setup(respond(), configWith({ includeCourseIds: [COURSE_A.Id] }));

    const result = (await getAnnouncements(ctx)) as any;
    expect(result.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(result.hiddenCourseIds).toEqual([COURSE_B.Id]);
    expect(result.hiddenBy).toEqual(["D2L_INCLUDE_COURSES"]);
  });

  it("does not count courses that activeOnly removed", async () => {
    // activeOnly:true drops both inactive courses; the exclude list names one
    // of them, but it hid nothing activeOnly had not already removed.
    const { ctx } = setup(respond(false), configWith({ excludeCourseIds: [COURSE_B.Id] }));

    const result = (await getAnnouncements(ctx)) as any;
    expect(result).toEqual([]);
    expect(result).not.toHaveProperty("hiddenCourseIds");
    expect(result).not.toHaveProperty("notice");
  });

  it("adds nothing when a setting is on but hides no enrolled course", async () => {
    const { ctx } = setup(respond(), configWith({ excludeCourseIds: [999] }));

    const list = (await getAnnouncements(ctx)) as any;
    expect(list.map((a: any) => a.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
    expect(list).not.toHaveProperty("hiddenCourseIds");
    expect(list).not.toHaveProperty("hiddenBy");
    expect(list).not.toHaveProperty("notice");

    const filtered = (await getAnnouncements(ctx, { modifiedSince: SINCE })) as any;
    expect(filtered).not.toHaveProperty("hiddenCourseIds");
    expect(filtered).not.toHaveProperty("notice");
  });

  it("does not count a course that answered 403 as hidden; it is unread instead", async () => {
    const { ctx } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes(`/${COURSE_B.Id}/news/`)) throw new ApiError(403, "/news/", "forbidden");
      return [posted];
    }, configWith({ excludeCourseIds: [999] }));

    const result = (await getAnnouncements(ctx)) as any;
    expect(result.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(result.unreadCourses.map((c: any) => c.courseId)).toEqual([COURSE_B.Id]);
    expect(result).not.toHaveProperty("hiddenCourseIds");
    expect(result.notice).not.toContain("hidden by this client's course settings");
  });

  it("joins the unread-course and hidden-course notices", async () => {
    const extra = { Id: 303, Name: "PHYS 172", Code: "phys172" };
    const { ctx } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B, extra);
      if (path.includes(`/${COURSE_B.Id}/news/`)) throw new ApiError(500, "/news/", "boom");
      return [posted];
    }, configWith({ excludeCourseIds: [extra.Id] }));

    const result = (await getAnnouncements(ctx)) as any;
    expect(result.map((a: any) => a.courseId)).toEqual([COURSE_A.Id]);
    expect(result.unreadCourses.map((c: any) => c.courseId)).toEqual([COURSE_B.Id]);
    expect(result.hiddenCourseIds).toEqual([extra.Id]);
    expect(result.notice).toMatch(/^Announcements for 1 course\(s\) could not be read/);
    expect(result.notice).toContain("or check Brightspace. 1 enrolled course is hidden");
  });

  it("still reads a hidden course's announcements when given its courseId", async () => {
    const { ctx } = setup(oneCourse([posted]), configWith({ excludeCourseIds: [COURSE_B.Id] }));

    const result = (await getAnnouncements(ctx, { courseId: COURSE_B.Id })) as any;
    expect(result.map((a: any) => a.title)).toEqual(["A post"]);
    expect(result).not.toHaveProperty("hiddenCourseIds");
  });
});
