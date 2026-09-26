/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAnnouncementFilesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { describeAttachment, readAttachment } from "./attachment-reader.js";
import { effectiveDate, isPublishedNewsItem, type NewsItem } from "./announcements.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../errors.js";
import { log } from "../utils/logger.js";

/**
 * The files an instructor attached to an announcement: field-notes prompts,
 * a rubric, an updated schedule. They hang off the news item, not course
 * content, so getCourseContent never lists them. Same shape as
 * getAssignmentFiles: list first, then read one file by id.
 */

export type GetAnnouncementFilesArgs = z.input<typeof GetAnnouncementFilesSchema>;

export interface AnnouncementAttachmentInfo {
  fileId: number;
  fileName: string;
  size: number;
  kind: string;
}

export interface AnnouncementFileListing {
  newsId: number;
  title: string;
  date: string | null;
  attachments: AnnouncementAttachmentInfo[];
}

export interface AnnouncementFilesResult {
  courseId: number;
  announcements?: AnnouncementFileListing[];
  note?: string;
  newsId?: number;
  title?: string;
  file?: Record<string, unknown>;
}

/** Every posted announcement in the course, narrowed to one when newsId is given. */
async function listNews(ctx: FeatureContext, courseId: number, newsId?: number): Promise<NewsItem[]> {
  const items = await ctx.api.get<NewsItem[]>(ctx.api.le(courseId, "/news/"), {
    ttl: DEFAULT_CACHE_TTLS.announcements,
  });
  return items.filter(isPublishedNewsItem).filter((item) => (newsId === undefined ? true : item.Id === newsId));
}

/** The files attached to an announcement: discover which have them, or read one by id. */
export async function getAnnouncementFiles(
  ctx: FeatureContext,
  args: GetAnnouncementFilesArgs,
): Promise<AnnouncementFilesResult> {
  const { courseId, newsId, fileId, extractText, maxChars } = GetAnnouncementFilesSchema.parse(args);

  if (fileId !== undefined && newsId === undefined) {
    throw new BrightspaceInvalidArgumentError(["newsId is required when fileId is given."]);
  }

  const items = await listNews(ctx, courseId, newsId);

  if (newsId !== undefined && items.length === 0) {
    throw new BrightspaceNotFoundError(`No announcement with id ${newsId} in course ${courseId}.`);
  }

  // Read one file.
  if (fileId !== undefined) {
    const item = items[0];
    const attachments = item.Attachments ?? [];
    const attachment = attachments.find((a) => a.FileId === fileId);
    if (!attachment) {
      const available = attachments.map((a) => a.FileId).join(", ") || "none";
      throw new BrightspaceNotFoundError(
        `No attachment with id ${fileId} on announcement "${item.Title}". Available: ${available}.`,
      );
    }
    const file = await readAttachment(
      ctx.api,
      ctx.api.le(courseId, `/news/${item.Id}/attachments/${fileId}`),
      attachment,
      extractText,
      maxChars,
    );
    return { courseId, newsId, title: item.Title, file };
  }

  // Discovery: which announcements have files, without downloading any.
  const withFiles = items
    .filter((item) => (item.Attachments ?? []).length > 0)
    .map((item) => ({
      newsId: item.Id,
      title: item.Title,
      date: effectiveDate(item),
      attachments: (item.Attachments ?? []).map(describeAttachment),
    }));

  log("INFO", `getAnnouncementFiles: ${withFiles.length} announcements with attachments in course ${courseId}`);
  return {
    courseId,
    announcements: withFiles,
    ...(withFiles.length === 0 ? { note: "No announcement in this course has an attached file." } : {}),
  };
}
