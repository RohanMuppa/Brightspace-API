/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import { GetAnnouncementsSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { matchesModifiedSince } from "../utils/modified-since.js";
import { log } from "../utils/logger.js";

export type GetAnnouncementsArgs = z.input<typeof GetAnnouncementsSchema>;

export interface NewsItem {
  Id: number;
  Title: string;
  Body: { Text: string; Html: string } | null;
  CreatedBy: { Identifier: string; DisplayName: string } | null;
  CreatedDate: string | null;
  LastModifiedBy: { Identifier: string; DisplayName: string };
  LastModifiedDate: string;
  StartDate: string | null;
  EndDate: string | null;
  IsPublished?: boolean;
  IsPinned: boolean;
  IsGlobal: boolean;
  Attachments?: Array<{ FileId: number; FileName: string; Size: number }> | null;
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

export interface Announcement {
  id: number;
  title: string;
  body: string;
  createdBy: string;
  date: string | null;
  isPinned: boolean;
  lastModified: string | null;
  attachments?: Array<{ fileId: number; fileName: string; size: number }>;
  courseId?: number;
  courseName?: string;
}

export interface AnnouncementsFiltered {
  announcements: Announcement[];
  modifiedSince: string;
  returned: number;
  filteredOut: number;
}

/**
 * A date the runtime can actually order, or null. Unreadable and absent are the
 * same answer, so a caller can fall through to the next best.
 */
function readableDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

/**
 * The date a post was actually scheduled for. StartDate is when the instructor
 * scheduled it, which is the honest date whenever there is one; CreatedDate is
 * the fallback for a post nobody scheduled.
 */
export function effectiveDate(item: NewsItem): string | null {
  return readableDate(item.StartDate) ?? readableDate(item.CreatedDate);
}

/**
 * False only for a draft the instructor has not posted. The test is an explicit
 * false, never a falsy read: an item that omits the field is a shape the tenant
 * has never sent, and treating unknown as unpublished would empty the section
 * the day D2L renames or drops the field.
 */
export function isPublishedNewsItem(item: NewsItem): boolean {
  return item.IsPublished !== false;
}

/**
 * Newest first by the scheduled date, undated last. An undated item sorts to
 * the end rather than to 1970, where a null read as an epoch would put it:
 * ahead of nothing, but behind everything real. Equal dates return 0 and keep
 * the server's own order, which is what makes the slice deterministic when a
 * course posts twice in one minute.
 */
export function newestFirst(a: { date: string | null }, b: { date: string | null }): number {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return new Date(b.date).getTime() - new Date(a.date).getTime();
}

/**
 * Map a raw D2L news item to a clean announcement object.
 */
export function mapNewsItem(item: NewsItem): Announcement {
  const attachments = (item.Attachments ?? []).map((file) => ({
    fileId: file.FileId,
    fileName: file.FileName,
    size: file.Size,
  }));
  return {
    id: item.Id,
    title: item.Title,
    body: item.Body?.Text ?? "",
    createdBy: item.CreatedBy?.DisplayName ?? "Unknown",
    date: effectiveDate(item),
    isPinned: item.IsPinned,
    lastModified: item.LastModifiedDate ?? null,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** Recent announcements, filtered to one course or across every enrolled course. */
export async function getAnnouncements(
  ctx: FeatureContext,
  args: GetAnnouncementsArgs = {},
): Promise<Announcement[] | AnnouncementsFiltered> {
  const { courseId, count, modifiedSince } = GetAnnouncementsSchema.parse(args);
  const cutoff = modifiedSince ? new Date(modifiedSince) : null;

  if (courseId) {
    const path = ctx.api.le(courseId, "/news/");
    const newsItems = await ctx.api.get<NewsItem[]>(path, { ttl: DEFAULT_CACHE_TTLS.announcements });

    const published = newsItems.filter(isPublishedNewsItem).map(mapNewsItem);
    const matched = cutoff ? published.filter((a) => matchesModifiedSince(a.lastModified, cutoff)) : published;
    const announcements = matched.sort(newestFirst).slice(0, count);

    log("INFO", `getAnnouncements: ${announcements.length} announcements for course ${courseId}`);
    return modifiedSince
      ? {
          announcements,
          modifiedSince,
          returned: announcements.length,
          filteredOut: published.length - matched.length,
        }
      : announcements;
  }

  // All courses: isActive=true is the configured policy, not a constant.
  // With activeOnly off the caller asked to see past courses, and the server
  // would otherwise drop them before applyCourseFilter ever saw them.
  const enrollmentPath = ctx.api.lp(
    `/enrollments/myenrollments/?orgUnitTypeId=3${ctx.config.courseFilter.activeOnly ? "&isActive=true" : ""}`,
  );
  // myenrollments is bookmark-paged; reading only the first page hides every
  // course past it, and with it every announcement they carry.
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

  const announcementPromises = filteredEnrollments.map(async (item) => {
    try {
      const path = ctx.api.le(item.OrgUnit.Id, "/news/");
      const newsItems = await ctx.api.get<NewsItem[]>(path, { ttl: DEFAULT_CACHE_TTLS.announcements });

      return newsItems.filter(isPublishedNewsItem).map((newsItem) => ({
        ...mapNewsItem(newsItem),
        courseId: item.OrgUnit.Id,
        courseName: item.OrgUnit.Name,
      }));
    } catch (error: any) {
      // 403 means no access (past course, etc) - log and skip
      if (error?.status === 403) {
        log("DEBUG", `getAnnouncements: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - skipping`);
        return [];
      }
      throw error;
    }
  });

  const results = await Promise.allSettled(announcementPromises);
  const allAnnouncements = results
    .filter((r): r is PromiseFulfilledResult<Array<Announcement & { courseId: number; courseName: string }>> => r.status === "fulfilled")
    .flatMap((r) => r.value);

  const allMatched = cutoff ? allAnnouncements.filter((a) => matchesModifiedSince(a.lastModified, cutoff)) : allAnnouncements;

  const announcements = allMatched.sort(newestFirst).slice(0, count);

  log(
    "INFO",
    `getAnnouncements: ${announcements.length} announcements (out of ${allAnnouncements.length} total across ${enrollmentItems.length} courses)`,
  );
  return modifiedSince
    ? {
        announcements,
        modifiedSince,
        returned: announcements.length,
        filteredOut: allAnnouncements.length - allMatched.length,
      }
    : announcements;
}
