/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { ApiError, isAuthUnavailable } from "../api/errors.js";
import { fetchAllItems, fetchAllObjects } from "../api/paginate.js";
import { toPublicError, type BrightspaceErrorCode } from "../errors.js";
import { GetUpcomingDueDatesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { assignmentUrl, quizUrl, discussionUrl } from "../utils/deep-links.js";
import { log } from "../utils/logger.js";
import type { AppConfig } from "../types/index.js";

export type GetUpcomingDueDatesArgs = z.input<typeof GetUpcomingDueDatesSchema>;

export interface UpcomingItem {
  type: "assignment" | "quiz" | "discussion";
  id: number;
  title: string;
  courseId: number;
  courseName: string | null;
  dueDate: string;
  startDate: string | null;
  endDate: string | null;
  url: string;
}

/** A due-date source read per course: dropbox folders, quizzes, or graded discussion topics. */
export type UpcomingDueDatesSource = "assignments" | "quizzes" | "discussions";

/**
 * A course whose due dates could not be read in full. Its items from the
 * failed sources are missing from the result, so a course listed here with
 * nothing in the array means "unknown", never "nothing due".
 */
export interface UpcomingDueDatesFailure {
  courseId: number;
  courseName: string | null;
  /** Which sources failed; items from any other source of this course are still in the array. */
  sources: UpcomingDueDatesSource[];
  /** The stable public error code the (first) failure maps to (e.g. `BRIGHTSPACE_API_ERROR`, `BRIGHTSPACE_NETWORK`). */
  code: BrightspaceErrorCode;
  /** The HTTP status Brightspace answered with, when it answered at all. */
  status?: number;
  /** A sentence saying what could not be read and what to do instead. */
  notice: string;
}

/**
 * What `getUpcomingDueDates` returns: the usual `UpcomingItem[]`, plus a
 * `failedCourses` property that is present only when at least one course's
 * due dates could not be read. It is a property on the array, not an element,
 * so iterating, `.length`, and `JSON.stringify` see exactly the items.
 */
export type UpcomingDueDates = UpcomingItem[] & { failedCourses?: UpcomingDueDatesFailure[] };

interface DropboxFolder {
  Id: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
}

interface QuizReadData {
  QuizId: number;
  Name: string;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsActive: boolean;
}

interface DiscussionForum {
  ForumId: number;
  Name: string;
  IsHidden: boolean;
}

interface DiscussionTopic {
  TopicId: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
}

interface EnrollmentItem {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string;
  };
  Access: {
    IsActive: boolean;
    CanAccess?: boolean;
  };
}

interface CourseRef {
  id: number;
  name: string | null;
}

/** D2L list endpoints return either a paged { Objects: [...] } or a flat array. */
function unwrapList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : ((raw as any)?.Objects ?? []);
}

/**
 * Resolve which courses to query, and their names.
 *
 * An explicit courseId bypasses the configured course filter, but enrollments
 * are still fetched so the course can be named.
 */
async function resolveCourses(api: D2LApiClient, config: AppConfig, courseId?: number): Promise<CourseRef[]> {
  let items: EnrollmentItem[] = [];

  try {
    // isActive=true tracks the configured policy rather than being pinned on:
    // a user who set activeOnly:false is asking to see archived courses, and a
    // query that withholds them leaves applyCourseFilter nothing to let
    // through. Enrollments are paged, so follow the bookmark chain — a long
    // enrollment history would otherwise lose every course past the first page,
    // and every deadline in those courses with it.
    items = await fetchAllItems<EnrollmentItem>(
      api,
      api.lp(`/enrollments/myenrollments/?orgUnitTypeId=3${config.courseFilter.activeOnly ? "&isActive=true" : ""}`),
      { ttl: DEFAULT_CACHE_TTLS.enrollments },
    );
  } catch (error) {
    // Without enrollments there is no course list to walk, so only the explicit
    // single-course case can continue (with an unnamed course).
    if (!courseId) throw error;
    log("DEBUG", "getUpcomingDueDates: could not fetch enrollments for course name", error);
  }

  if (courseId) {
    const match = items.find((item) => item.OrgUnit.Id === courseId);
    return [{ id: courseId, name: match?.OrgUnit.Name ?? null }];
  }

  const filtered = applyCourseFilter(
    items.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      isActive: item.Access.IsActive,
      canAccess: item.Access.CanAccess,
    })),
    config.courseFilter,
  );

  return filtered.map((course) => ({ id: course.id, name: course.name }));
}

/**
 * Collect every graded, dated discussion topic for one course.
 *
 * Forums carry no due date themselves; it lives on each topic. A hidden forum
 * hides everything inside it, however visible its topics claim to be, so it is
 * skipped without asking for its topics at all. A forum whose topics fail to
 * load is skipped rather than failing the whole course; anything but a 403
 * (no access) is passed to onTopicsFailure so the loss can be reported.
 */
async function fetchDiscussionDueTopics(
  api: D2LApiClient,
  courseId: number,
  onTopicsFailure: (error: unknown) => void,
): Promise<DiscussionTopic[]> {
  const forums = await api.get<{ Objects: DiscussionForum[] } | DiscussionForum[]>(api.le(courseId, "/discussions/forums/"), {
    ttl: DEFAULT_CACHE_TTLS.assignments,
  });

  const topics: DiscussionTopic[] = [];
  for (const forum of unwrapList<DiscussionForum>(forums)) {
    if (forum.IsHidden === true) continue;

    try {
      const forumTopics = await api.get<{ Objects: DiscussionTopic[] } | DiscussionTopic[]>(
        api.le(courseId, `/discussions/forums/${forum.ForumId}/topics/`),
        { ttl: DEFAULT_CACHE_TTLS.assignments },
      );
      topics.push(...unwrapList<DiscussionTopic>(forumTopics));
    } catch (error) {
      // A session that cannot sign in fails the whole call.
      if (isAuthUnavailable(error)) throw error;
      log("DEBUG", `getUpcomingDueDates: failed to fetch topics for forum ${forum.ForumId} in course ${courseId}`, error);
      if (!isForbidden(error)) onTopicsFailure(error);
    }
  }

  return topics;
}

/** 403: one resource refusing (a past course, a locked tool), which is not a failure to report. */
function isForbidden(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 403;
}

interface CourseDueItems {
  items: UpcomingItem[];
  failure: UpcomingDueDatesFailure | null;
}

function courseFailure(course: CourseRef, sources: UpcomingDueDatesSource[], error: unknown): UpcomingDueDatesFailure {
  const publicError = toPublicError(error);
  return {
    courseId: course.id,
    courseName: course.name,
    sources,
    code: publicError.code,
    ...(error instanceof ApiError ? { status: error.status } : {}),
    notice:
      `Due dates (${sources.join(", ")}) for course ${course.id} could not be read from Brightspace, so ` +
      "they are missing from this list; do not read this course as having nothing due. " +
      "Call getUpcomingDueDates again with this courseId.",
  };
}

/**
 * Collect every dated assignment, quiz, and graded discussion topic for one
 * course.
 *
 * No submissions or attempts: the due date lives on the item itself, which is
 * what makes this cheap enough to run across all enrolled courses. A
 * discussion topic counts only when it has a DueDate — an ungraded chat forum
 * has none and should not clutter the list.
 */
async function fetchCourseDueItems(api: D2LApiClient, baseUrl: string, course: CourseRef): Promise<CourseDueItems> {
  let topicsError: unknown = undefined;
  const [dropboxResult, quizResult, discussionResult] = await Promise.allSettled([
    api.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(api.le(course.id, "/dropbox/folders/"), {
      ttl: DEFAULT_CACHE_TTLS.assignments,
    }),
    // Quizzes are paged; a course with many of them spills past page one.
    fetchAllObjects<QuizReadData>(api, api.le(course.id, "/quizzes/"), {
      ttl: DEFAULT_CACHE_TTLS.assignments,
    }),
    fetchDiscussionDueTopics(api, course.id, (error) => {
      topicsError ??= error;
    }),
  ]);

  // Each source may fail on its own without costing the others, but a failed
  // sign-in means none of them answered: report that, not an empty course.
  for (const result of [dropboxResult, quizResult, discussionResult]) {
    if (result.status === "rejected" && isAuthUnavailable(result.reason)) throw result.reason;
  }

  // Anything but a 403 that loses a source's items must not pass for "nothing
  // due" (brightspace-mcp-server#262).
  const failedSources: UpcomingDueDatesSource[] = [];
  let firstError: unknown = undefined;
  const noteFailure = (source: UpcomingDueDatesSource, error: unknown) => {
    if (isForbidden(error)) return;
    failedSources.push(source);
    if (failedSources.length === 1) firstError = error;
  };

  const items: UpcomingItem[] = [];

  if (dropboxResult.status === "fulfilled") {
    for (const folder of unwrapList<DropboxFolder>(dropboxResult.value)) {
      if (folder.IsHidden === true) continue;
      if (!folder.DueDate) continue;

      items.push({
        type: "assignment",
        id: folder.Id,
        title: folder.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate: folder.DueDate,
        startDate: null,
        endDate: null,
        url: assignmentUrl(baseUrl, course.id, folder.Id),
      });
    }
  } else {
    // 403 for past courses and similar: log and keep the other courses.
    log("DEBUG", `getUpcomingDueDates: failed to fetch dropbox folders for course ${course.id}`, dropboxResult.reason);
    noteFailure("assignments", dropboxResult.reason);
  }

  if (quizResult.status === "fulfilled") {
    for (const quiz of quizResult.value) {
      if (quiz.IsActive === false) continue;

      // Many instructors set only an End Date, which is the effective deadline.
      const dueDate = quiz.DueDate ?? quiz.EndDate;
      if (!dueDate) continue;

      items.push({
        type: "quiz",
        id: quiz.QuizId,
        title: quiz.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate,
        startDate: quiz.StartDate ?? null,
        endDate: quiz.EndDate ?? null,
        url: quizUrl(baseUrl, course.id, quiz.QuizId),
      });
    }
  } else {
    log("DEBUG", `getUpcomingDueDates: failed to fetch quizzes for course ${course.id}`, quizResult.reason);
    noteFailure("quizzes", quizResult.reason);
  }

  if (discussionResult.status === "fulfilled") {
    for (const topic of discussionResult.value) {
      if (topic.IsHidden === true) continue;
      if (!topic.DueDate) continue;

      items.push({
        type: "discussion",
        id: topic.TopicId,
        title: topic.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate: topic.DueDate,
        startDate: null,
        endDate: null,
        url: discussionUrl(baseUrl, course.id, topic.TopicId),
      });
    }
  } else {
    log("DEBUG", `getUpcomingDueDates: failed to fetch discussions for course ${course.id}`, discussionResult.reason);
    noteFailure("discussions", discussionResult.reason);
  }
  if (discussionResult.status === "fulfilled" && topicsError !== undefined) noteFailure("discussions", topicsError);

  return { items, failure: failedSources.length > 0 ? courseFailure(course, failedSources, firstError) : null };
}

/**
 * Upcoming due dates across the caller's courses, derived from the due dates
 * on assignments (dropbox folders), quizzes, and graded discussion topics
 * themselves.
 *
 * A course whose due dates could not be read (anything but a 403) is named in
 * the array's `failedCourses` property; a sign-in problem fails the call.
 */
export async function getUpcomingDueDates(
  ctx: FeatureContext,
  args: GetUpcomingDueDatesArgs = {},
): Promise<UpcomingDueDates> {
  const { daysAhead, courseId } = GetUpcomingDueDatesSchema.parse(args);

  const now = Date.now();
  const windowEnd = now + daysAhead * 24 * 60 * 60 * 1000;

  const courses = await resolveCourses(ctx.api, ctx.config, courseId);
  log("DEBUG", `getUpcomingDueDates: querying ${courses.length} course(s), window=${daysAhead} days`);

  // Fetch every course in parallel; the API client rate limits itself
  const results = await Promise.allSettled(courses.map((course) => fetchCourseDueItems(ctx.api, ctx.config.baseUrl, course)));

  // A course that could not sign in is not a course with nothing due.
  const authFailure = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected" && isAuthUnavailable(r.reason),
  );
  if (authFailure) throw authFailure.reason;

  const failedCourses: UpcomingDueDatesFailure[] = [];
  const items = results.flatMap((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value.failure) failedCourses.push(result.value.failure);
      return result.value.items;
    }
    // Defensive: fetchCourseDueItems settles every source itself and only
    // rethrows auth failures, handled above. Report rather than drop.
    log("DEBUG", `getUpcomingDueDates: due dates unavailable for course ${courses[i].id}`, result.reason);
    if (!isForbidden(result.reason)) {
      failedCourses.push(courseFailure(courses[i], ["assignments", "quizzes", "discussions"], result.reason));
    }
    return [];
  });

  // Keep what falls inside the window, soonest first
  const upcoming: UpcomingDueDates = items
    .filter((item) => {
      const due = new Date(item.dueDate).getTime();
      return Number.isFinite(due) && due >= now && due <= windowEnd;
    })
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  log(
    "INFO",
    `getUpcomingDueDates: Retrieved ${upcoming.length} items across ${courses.length} courses` +
      (failedCourses.length > 0 ? ` (${failedCourses.length} failed)` : ""),
  );
  // Only when something failed, so the usual result is a plain array.
  if (failedCourses.length > 0) upcoming.failedCourses = failedCourses;
  return upcoming;
}
