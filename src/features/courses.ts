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

/** The caller's enrolled course offerings, after the configured course filter. */
export async function getMyCourses(ctx: FeatureContext, args: GetMyCoursesArgs = {}): Promise<Course[]> {
  const { activeOnly: activeOnlyArg } = GetMyCoursesSchema.parse(args);

  // An explicit per-call argument wins; otherwise the configured policy.
  // Resolved once so the API query and the post-fetch filter agree.
  const activeOnly = activeOnlyArg ?? ctx.config.courseFilter.activeOnly;

  // orgUnitTypeId=3 is "Course Offering".
  const path = ctx.api.lp(`/enrollments/myenrollments/?orgUnitTypeId=3${activeOnly ? "&isActive=true" : ""}`);
  const items = await fetchAllItems<EnrollmentItem>(ctx.api, path, { ttl: DEFAULT_CACHE_TTLS.enrollments });

  const courses = applyCourseFilter(
    items.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      role: item.Access.ClasslistRoleName,
      isActive: item.Access.IsActive,
      canAccess: item.Access.CanAccess,
      lastAccessed: item.Access.LastAccessed,
    })),
    { ...ctx.config.courseFilter, activeOnly },
  );

  log("INFO", `getMyCourses: ${courses.length} courses`);
  return courses;
}
