/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { ApiError, isAuthUnavailable } from "../api/errors.js";
import { fetchAllItems } from "../api/paginate.js";
import { toPublicError, type BrightspaceErrorCode } from "../errors.js";
import { GetMyGradesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { applyCourseFilter, coursesHiddenBySettings, type CourseFilterSetting } from "../utils/course-filter.js";
import { log } from "../utils/logger.js";
import { gradebookUrl } from "../utils/deep-links.js";

export type GetMyGradesArgs = z.input<typeof GetMyGradesSchema>;

export interface GradeItem {
  name: string;
  displayGrade: string;
  pointsNumerator: number | null;
  pointsDenominator: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
  comments: string | null;
  lastModified: string;
}

/**
 * Why a course's grades could not be read in the all-courses form of
 * `getMyGrades`. Present only on a course whose grade request failed; its
 * `grades` is then `[]`, which means "unknown", never "no grades".
 */
export interface CourseGradesFailure {
  /** The stable public error code the failure maps to (e.g. `BRIGHTSPACE_API_ERROR`, `BRIGHTSPACE_NETWORK`). */
  code: BrightspaceErrorCode;
  /** The HTTP status Brightspace answered with, when it answered at all. */
  status?: number;
  /** The course's gradebook page, so a person can open the grades directly. */
  gradeUrl: string;
  /** A sentence saying the grades could not be read and what to do instead. */
  notice: string;
}

export interface CourseGrades {
  courseId: number;
  courseName?: string;
  grades: GradeItem[];
  /**
   * Set only when this course's grades could not be read (all-courses form
   * only). Absent on every course that was read successfully.
   */
  failed?: CourseGradesFailure;
}

/**
 * What `getMyGrades` returns: the usual `CourseGrades[]`, plus
 * `hiddenCourseIds`, `hiddenBy` and `notice` properties that are present only
 * when, in the all-courses form, the configured include/exclude course lists
 * hid at least one enrolled course, so its grades were not read. They are
 * properties on the array, not elements, so iterating, `.length`, and
 * `JSON.stringify` see exactly the courses.
 */
export type MyGradesResult = CourseGrades[] & {
  /** Ids of enrolled courses the include/exclude course settings left out. */
  hiddenCourseIds?: number[];
  /** Which of those settings hid them. */
  hiddenBy?: CourseFilterSetting[];
  /** Set with `hiddenCourseIds`: how many were hidden, by what, and that `courseId` still reads them. */
  notice?: string;
};

interface GradeValue {
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  DisplayedGrade: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator: number | null;
  WeightedDenominator: number | null;
  Comments: { Text: string; Html: string } | null;
  PrivateComments: { Text: string; Html: string } | null;
  LastModified: string;
  ReleasedDate: string | null;
}

interface EnrollmentItem {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string;
  };
  Access: {
    ClasslistRoleName: string;
    IsActive: boolean;
    CanAccess?: boolean;
    LastAccessed: string | null;
  };
}

async function fetchGrades(api: D2LApiClient, courseId: number): Promise<GradeItem[]> {
  const path = api.le(courseId, "/grades/values/myGradeValues/");
  const gradeValues = await api.get<GradeValue[]>(path, { ttl: DEFAULT_CACHE_TTLS.grades });

  return gradeValues.map((gv) => ({
    name: gv.GradeObjectName,
    displayGrade: gv.DisplayedGrade,
    pointsNumerator: gv.PointsNumerator,
    pointsDenominator: gv.PointsDenominator,
    weightedNumerator: gv.WeightedNumerator,
    weightedDenominator: gv.WeightedDenominator,
    comments: gv.Comments?.Text || null,
    lastModified: gv.LastModified,
  }));
}

function failedCourse(baseUrl: string, courseId: number, courseName: string, error: unknown): CourseGrades {
  const publicError = toPublicError(error);
  const gradeUrl = gradebookUrl(baseUrl, courseId);
  return {
    courseId,
    courseName,
    grades: [],
    failed: {
      code: publicError.code,
      ...(error instanceof ApiError ? { status: error.status } : {}),
      gradeUrl,
      notice:
        `Grades for course ${courseId} could not be read from Brightspace, so its empty grades list ` +
        `means unknown, not no grades. Open ${gradeUrl}, or call getMyGrades again with this courseId.`,
    },
  };
}

/** The caller's grade breakdown for a specific course, or every enrolled course. */
export async function getMyGrades(ctx: FeatureContext, args: GetMyGradesArgs = {}): Promise<MyGradesResult> {
  const { courseId } = GetMyGradesSchema.parse(args);

  if (courseId) {
    const grades = await fetchGrades(ctx.api, courseId);
    log("INFO", `getMyGrades: Retrieved ${grades.length} grade items for course ${courseId}`);
    return [{ courseId, grades }];
  }

  // isActive=true has to track the configured policy rather than being pinned
  // on: a user who set activeOnly:false is asking to see archived courses, and
  // a query that withholds them leaves applyCourseFilter nothing to let
  // through.
  const enrollmentPath = ctx.api.lp(
    `/enrollments/myenrollments/?orgUnitTypeId=3${ctx.config.courseFilter.activeOnly ? "&isActive=true" : ""}`,
  );
  // Enrollments arrive one page at a time; follow the bookmark chain so a
  // long enrollment history does not silently lose its later courses.
  const enrollmentItems = await fetchAllItems<EnrollmentItem>(ctx.api, enrollmentPath, {
    ttl: DEFAULT_CACHE_TTLS.enrollments,
  });

  const enrolled = enrollmentItems.map((item) => ({
    id: item.OrgUnit.Id,
    name: item.OrgUnit.Name,
    code: item.OrgUnit.Code,
    isActive: item.Access.IsActive,
    canAccess: item.Access.CanAccess,
    ...item,
  }));
  const filteredEnrollments = applyCourseFilter(enrolled, ctx.config.courseFilter);

  const gradePromises = filteredEnrollments.map(async (item): Promise<CourseGrades | null> => {
    try {
      const grades = await fetchGrades(ctx.api, item.OrgUnit.Id);
      return { courseId: item.OrgUnit.Id, courseName: item.OrgUnit.Name, grades };
    } catch (error: any) {
      // 403 means no access (past course, etc) - log and skip
      if (error?.status === 403) {
        log("DEBUG", `getMyGrades: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - skipping`);
        return null;
      }
      // A session that cannot sign in fails the whole call, as in getAssignments.
      if (isAuthUnavailable(error)) throw error;
      // Anything else (a 404, a 5xx, a dropped connection) must not make the
      // course vanish: the caller would read the array as every course's
      // grades with one silently missing (brightspace-mcp-server#245).
      log("DEBUG", `getMyGrades: grades unavailable for course ${item.OrgUnit.Id} (${item.OrgUnit.Name})`, error);
      return failedCourse(ctx.config.baseUrl, item.OrgUnit.Id, item.OrgUnit.Name, error);
    }
  });

  const results = await Promise.allSettled(gradePromises);
  // A course that could not sign in is not a course with no grades.
  const authFailure = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected" && isAuthUnavailable(r.reason),
  );
  if (authFailure) throw authFailure.reason;
  const courses: MyGradesResult = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value === null ? [] : [r.value];
    // Defensive: the per-course catch above only rethrows auth failures.
    const item = filteredEnrollments[i];
    return [failedCourse(ctx.config.baseUrl, item.OrgUnit.Id, item.OrgUnit.Name, r.reason)];
  });
  const failedCount = courses.filter((c) => c.failed).length;

  log(
    "INFO",
    `getMyGrades: Retrieved grades for ${courses.length - failedCount} courses` +
      `${failedCount > 0 ? `, ${failedCount} failed` : ""} (out of ${enrollmentItems.length} enrolled)`,
  );

  // A course the include/exclude settings hid was never asked for its grades.
  // The caller may never have seen those settings, so say which courses they
  // hid rather than let one read as a course with no grades or one the user
  // is not in (#124, port of brightspace-mcp-server#486). The courseId form
  // above skips the filter, so it does read a hidden course.
  const hidden = coursesHiddenBySettings(enrolled, filteredEnrollments, ctx.config.courseFilter);
  if (hidden) {
    const are = hidden.ids.length === 1 ? "course is" : "courses are";
    courses.hiddenCourseIds = hidden.ids;
    courses.hiddenBy = hidden.by;
    courses.notice =
      `${hidden.ids.length} enrolled ${are} hidden by this client's course settings ` +
      `(${hidden.by.join(", ")}), so their grades were not read: ${hidden.ids.join(", ")}. A course ` +
      "missing from this list is not one with no grades or one the user is not enrolled in. Call " +
      "getMyGrades again with that courseId, which reads a hidden course.";
  }
  return courses;
}
