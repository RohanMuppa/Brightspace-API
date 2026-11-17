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
import { isAuthUnavailable } from "../api/errors.js";
import { toPublicError, type BrightspaceErrorCode } from "../errors.js";

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

/**
 * A course left out of the all-courses result because its announcements could
 * not be read (a 403, a 5xx, a network error, a malformed payload). It is
 * "unknown", never "no announcements". A sign-in problem throws instead.
 */
export interface UnreadAnnouncementsCourse {
  courseId: number;
  courseName: string;
  /** The HTTP status Brightspace answered with, when it answered at all (403 means no access). */
  status?: number;
  /** The stable public error code the failure maps to (e.g. `BRIGHTSPACE_FORBIDDEN`, `BRIGHTSPACE_API_ERROR`, `BRIGHTSPACE_NETWORK`). */
  code: BrightspaceErrorCode;
}

/**
 * What `getAnnouncements` returns without `modifiedSince`: the usual
 * `Announcement[]`, plus `unreadCourses` and `notice` properties that are
 * present only when, without `courseId`, at least one course's announcements
 * could not be read. They are properties on the array, not elements, so
 * iterating, `.length`, and `JSON.stringify` see exactly the announcements.
 */
export type AnnouncementsList = Announcement[] & {
  unreadCourses?: UnreadAnnouncementsCourse[];
  notice?: string;
};

export interface AnnouncementsFiltered {
  announcements: Announcement[];
  modifiedSince: string;
  returned: number;
  filteredOut: number;
  /**
   * Present only when, without `courseId`, at least one course could not be
   * read: its announcements are missing from `announcements`, not absent.
   */
  unreadCourses?: UnreadAnnouncementsCourse[];
  /** A sentence naming the unread courses; present only with `unreadCourses`. */
  notice?: string;
}

function unreadCoursesNotice(unreadCourses: UnreadAnnouncementsCourse[]): string {
  return (
    `Announcements for ${unreadCourses.length} course(s) could not be read from Brightspace ` +
    `(${unreadCourses.map((c) => `"${c.courseName}" ${c.courseId}${c.status !== undefined ? ` (HTTP ${c.status})` : ""}`).join(", ")}), ` +
    "so they are missing from this list. Do not read those courses as having no announcements: " +
    "call getAnnouncements again with that courseId, or check Brightspace."
  );
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
): Promise<AnnouncementsList | AnnouncementsFiltered> {
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

  // Every failure, a 403 included, rejects here and is named in unreadCourses
  // below; a sign-in problem fails the whole call.
  // **Why:** a 403 came back as [] and anything else vanished inside
  // allSettled, so "anything new?" read an unread course as nothing new
  // (#114, port of brightspace-mcp-server#456).
  const announcementPromises = filteredEnrollments.map(async (item) => {
    const path = ctx.api.le(item.OrgUnit.Id, "/news/");
    const newsItems = await ctx.api.get<NewsItem[]>(path, { ttl: DEFAULT_CACHE_TTLS.announcements });

    return newsItems.filter(isPublishedNewsItem).map((newsItem) => ({
      ...mapNewsItem(newsItem),
      courseId: item.OrgUnit.Id,
      courseName: item.OrgUnit.Name,
    }));
  });

  const results = await Promise.allSettled(announcementPromises);
  // A course that could not sign in is not a course with no announcements.
  const authFailure = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected" && isAuthUnavailable(r.reason),
  );
  if (authFailure) throw authFailure.reason;

  const allAnnouncements = results
    .filter((r): r is PromiseFulfilledResult<Array<Announcement & { courseId: number; courseName: string }>> => r.status === "fulfilled")
    .flatMap((r) => r.value);

  const unreadCourses = results.flatMap((r, i): UnreadAnnouncementsCourse[] => {
    if (r.status !== "rejected") return [];
    const item = filteredEnrollments[i];
    log("INFO", `getAnnouncements: could not read course ${item.OrgUnit.Id} (${item.OrgUnit.Name})`, r.reason);
    const status: unknown = (r.reason as { status?: unknown } | null)?.status;
    return [{
      courseId: item.OrgUnit.Id,
      courseName: item.OrgUnit.Name,
      ...(typeof status === "number" ? { status } : {}),
      code: toPublicError(r.reason).code,
    }];
  });
  const unread = unreadCourses.length > 0 ? { unreadCourses, notice: unreadCoursesNotice(unreadCourses) } : null;

  const allMatched = cutoff ? allAnnouncements.filter((a) => matchesModifiedSince(a.lastModified, cutoff)) : allAnnouncements;

  const announcements = allMatched.sort(newestFirst).slice(0, count);

  log(
    "INFO",
    `getAnnouncements: ${announcements.length} announcements (out of ${allAnnouncements.length} total across ${enrollmentItems.length} courses` +
      `${unread ? `, ${unreadCourses.length} unread` : ""})`,
  );
  if (modifiedSince) {
    return {
      announcements,
      modifiedSince,
      returned: announcements.length,
      filteredOut: allAnnouncements.length - allMatched.length,
      ...(unread ?? {}),
    };
  }
  return unread ? Object.assign(announcements, unread) : announcements;
}
