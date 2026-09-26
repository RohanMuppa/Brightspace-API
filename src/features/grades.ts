/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import { GetMyGradesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { log } from "../utils/logger.js";

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

export interface CourseGrades {
  courseId: number;
  courseName?: string;
  grades: GradeItem[];
}

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

/** The caller's grade breakdown for a specific course, or every enrolled course. */
export async function getMyGrades(ctx: FeatureContext, args: GetMyGradesArgs = {}): Promise<CourseGrades[]> {
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

  const filteredEnrollments = applyCourseFilter(
    enrollmentItems.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      isActive: item.Access.IsActive,
      canAccess: item.Access.CanAccess,
      ...item,
    })),
    ctx.config.courseFilter,
  );

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
      throw error; // Re-throw other errors
    }
  });

  const results = await Promise.allSettled(gradePromises);
  const courses = results
    .filter((r): r is PromiseFulfilledResult<CourseGrades> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);

  log("INFO", `getMyGrades: Retrieved grades for ${courses.length} courses (out of ${enrollmentItems.length} enrolled)`);
  return courses;
}
