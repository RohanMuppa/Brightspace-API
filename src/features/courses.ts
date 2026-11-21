/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import { GetMyCoursesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { log } from "../utils/logger.js";

export type GetMyCoursesArgs = z.input<typeof GetMyCoursesSchema>;

export interface Course {
  id: number;
  name: string;
  code: string;
  role: string;
  isActive: boolean;
  canAccess?: boolean;
  lastAccessed: string | null;
}

interface EnrollmentItem {
  OrgUnit: { Id: number; Name: string; Code: string };
  Access: {
    ClasslistRoleName: string;
    IsActive: boolean;
    CanAccess?: boolean;
    LastAccessed: string | null;
  };
}

/** A course setting that can hide an enrolled course from `getMyCourses`. */
export type CourseFilterSetting = "D2L_INCLUDE_COURSES" | "D2L_EXCLUDE_COURSES";

/**
 * What `getMyCourses` returns: the usual `Course[]`, plus `hiddenCourseIds`,
 * `hiddenBy` and `notice` properties that are present only when the
 * configured include/exclude course lists hid at least one enrolled course.
 * They are properties on the array, not elements, so iterating, `.length`,
 * and `JSON.stringify` see exactly the courses.
 */
export type MyCoursesResult = Course[] & {
  /** Ids of enrolled courses the include/exclude course settings left out. */
  hiddenCourseIds?: number[];
  /** Which of those settings hid them. */
  hiddenBy?: CourseFilterSetting[];
  /** Set with `hiddenCourseIds`: how many were hidden, by what, and that they are still readable by id. */
  notice?: string;
};

/** The caller's enrolled course offerings, after the configured course filter. */
export async function getMyCourses(ctx: FeatureContext, args: GetMyCoursesArgs = {}): Promise<MyCoursesResult> {
  const { activeOnly: activeOnlyArg } = GetMyCoursesSchema.parse(args);

  // An explicit per-call argument wins; otherwise the configured policy.
  // Resolved once so the API query and the post-fetch filter agree.
  const activeOnly = activeOnlyArg ?? ctx.config.courseFilter.activeOnly;

  // orgUnitTypeId=3 is "Course Offering".
  const path = ctx.api.lp(`/enrollments/myenrollments/?orgUnitTypeId=3${activeOnly ? "&isActive=true" : ""}`);
  const items = await fetchAllItems<EnrollmentItem>(ctx.api, path, { ttl: DEFAULT_CACHE_TTLS.enrollments });

  const enrolled: Course[] = items.map((item) => ({
    id: item.OrgUnit.Id,
    name: item.OrgUnit.Name,
    code: item.OrgUnit.Code,
    role: item.Access.ClasslistRoleName,
    isActive: item.Access.IsActive,
    canAccess: item.Access.CanAccess,
    lastAccessed: item.Access.LastAccessed,
  }));
  const courses: MyCoursesResult = applyCourseFilter(enrolled, { ...ctx.config.courseFilter, activeOnly });

  log("INFO", `getMyCourses: ${courses.length} courses`);

  // A course the include/exclude settings hid must not read as one the user
  // is not enrolled in: the caller may never have seen those settings. Port
  // of brightspace-mcp-server#484. Only when something was hidden, so the
  // usual result is a plain array.
  const hidden = settingsHidden(enrolled, courses, activeOnly, ctx.config.courseFilter);
  if (hidden) {
    const are = hidden.ids.length === 1 ? "course is" : "courses are";
    courses.hiddenCourseIds = hidden.ids;
    courses.hiddenBy = hidden.by;
    courses.notice =
      `${hidden.ids.length} enrolled ${are} hidden by this client's course settings ` +
      `(${hidden.by.join(", ")}), so not listed: ${hidden.ids.join(", ")}. A course missing from this ` +
      "list is not necessarily one the user is not enrolled in. Methods that take a courseId still " +
      "read a hidden course.";
  }
  return courses;
}

/**
 * The enrolled courses D2L_INCLUDE_COURSES or D2L_EXCLUDE_COURSES removed, or
 * null when they removed none. Courses dropped by activeOnly alone are not
 * counted: the caller can lift that with activeOnly:false, and with it on the
 * enrollments query never returns them anyway.
 */
function settingsHidden(
  enrolled: Course[],
  shown: Course[],
  activeOnly: boolean,
  filter: FeatureContext["config"]["courseFilter"],
): { ids: number[]; by: CourseFilterSetting[] } | null {
  const by: CourseFilterSetting[] = [];
  if (filter.includeCourseIds && filter.includeCourseIds.length > 0) by.push("D2L_INCLUDE_COURSES");
  if (filter.excludeCourseIds && filter.excludeCourseIds.length > 0) by.push("D2L_EXCLUDE_COURSES");
  if (by.length === 0) return null;

  const shownIds = new Set(shown.map((course) => course.id));
  const ids = applyCourseFilter(enrolled, { activeOnly })
    .map((course) => course.id)
    .filter((id) => !shownIds.has(id));
  return ids.length > 0 ? { ids, by } : null;
}
