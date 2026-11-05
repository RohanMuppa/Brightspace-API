/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { isAuthUnavailable } from "../api/errors.js";
import { GetSyllabusSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { secureDownload, readBodyCapped } from "../utils/download-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import {
  BrightspaceApiError,
  BrightspaceForbiddenError,
  BrightspaceInvalidArgumentError,
  BrightspaceNetworkError,
  BrightspaceNotFoundError,
  type BrightspaceError,
} from "../errors.js";
import { log } from "../utils/logger.js";
import { parseContentDispositionFilename } from "./download.js";

export type GetSyllabusArgs = z.input<typeof GetSyllabusSchema>;

// D2L Overview API response shape
interface CourseOverview {
  Description: { Text: string; Html: string } | null;
}

export interface SyllabusDownload {
  success: true;
  filePath: string;
  fileSize: number;
  mimeType: string;
}

export interface SyllabusResult {
  courseId: number;
  description: string | null;
  hasAttachment?: boolean;
  /**
   * Set when the attachment request failed with anything but a 404 (a 403, a
   * 5xx, a timeout, a network error): an attachment may exist but could not
   * be read, so `hasAttachment: false` is then not proof the course has no
   * syllabus file. Absent when the attachment was read or is known missing.
   */
  attachmentUnreadable?: true;
  /** Set with `attachmentUnreadable`: says an attachment may exist and must not be reported as missing. */
  notice?: string;
  syllabusText?: string;
  totalPages?: number;
  message?: string;
  note?: string;
  download?: SyllabusDownload;
}

/**
 * The same directory checks the seed tool ran before touching the network:
 * an absolute path that already exists as a directory. Business conditions,
 * so they throw BrightspaceInvalidArgumentError rather than propagate the
 * raw fs error.
 */
async function validateDownloadDirectory(downloadPath: string): Promise<void> {
  if (!path.isAbsolute(downloadPath)) {
    throw new BrightspaceInvalidArgumentError([
      "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)",
    ]);
  }
  try {
    const stats = await fs.stat(downloadPath);
    if (!stats.isDirectory()) {
      throw new BrightspaceInvalidArgumentError([`Download path is not a directory: ${downloadPath}`]);
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new BrightspaceInvalidArgumentError([`Download directory does not exist: ${downloadPath}`]);
    }
    throw error;
  }
}

const ATTACHMENT_UNREADABLE_NOTICE =
  "The syllabus attachment could not be read from Brightspace, so this course may still have a syllabus " +
  "file. Do not report the course as having no syllabus attachment: retry getSyllabus, or check the " +
  "course overview in Brightspace.";

const ATTACHMENT_UNREADABLE_DOWNLOAD =
  "The syllabus attachment could not be read from Brightspace, so nothing was saved. " +
  "Try again, or download it from the course overview in Brightspace.";

/**
 * The error a download throws when the attachment request failed (anything
 * but a 404). Keeps the public code the failure itself would have had —
 * forbidden, an HTTP status, or a network problem — but never says "not
 * found", since an attachment may well exist.
 */
function attachmentUnreadableError(cause: unknown): BrightspaceError {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return new BrightspaceForbiddenError(ATTACHMENT_UNREADABLE_DOWNLOAD);
    return new BrightspaceApiError(cause.status, ATTACHMENT_UNREADABLE_DOWNLOAD);
  }
  return new BrightspaceNetworkError(ATTACHMENT_UNREADABLE_DOWNLOAD, { cause });
}

/**
 * The syllabus/overview text and, when a PDF attachment exists, its
 * extracted text. With downloadPath, also saves the overview attachment to
 * disk — the attachment lives at /overview/attachment, not on a content
 * topic or a dropbox folder, so downloadFile has no way to reach it.
 */
export async function getSyllabus(ctx: FeatureContext, args: GetSyllabusArgs): Promise<SyllabusResult> {
  const { courseId, downloadPath } = GetSyllabusSchema.parse(args);

  if (downloadPath !== undefined) {
    await validateDownloadDirectory(downloadPath);
  }

  let overview: CourseOverview | null = null;
  try {
    overview = await ctx.api.get<CourseOverview>(ctx.api.le(courseId, "/overview"), {
      ttl: DEFAULT_CACHE_TTLS.courseContent,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        courseId,
        description: null,
        hasAttachment: false,
        message: "No syllabus/overview found for this course.",
      };
    }
    throw error;
  }

  const description = overview?.Description?.Html ? convertHtmlToMarkdown(overview.Description.Html).markdown : null;

  // Always attempt to fetch the attachment so its PDF text can be extracted
  // (and so it is on hand to save, when downloadPath is given).
  let attachmentBuffer: Buffer | null = null;
  let attachmentFilename = "syllabus";
  let hasAttachment = false;
  let tooLargeMessage: string | undefined;
  // The failure, when the attachment request failed for any reason but a
  // 404, so a failed read is never reported as "this course has no attachment".
  let unreadableCause: unknown;
  let attachmentUnreadable = false;

  try {
    const response = await ctx.api.getRaw(ctx.api.le(courseId, "/overview/attachment"));

    if (response.ok) {
      hasAttachment = true;

      // Check Content-Length before downloading the body.
      const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
      if (contentLength > MAX_FILE_SIZE) {
        tooLargeMessage = `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
      } else {
        // Get filename from Content-Disposition header.
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const parsed = parseContentDispositionFilename(disposition);
        if (parsed) attachmentFilename = parsed;

        // Capped read: Content-Length can be missing or understated.
        try {
          attachmentBuffer = await readBodyCapped(response, MAX_FILE_SIZE);
        } catch (error) {
          if (!(error instanceof DownloadError && error.kind === "tooLarge")) throw error;
          tooLargeMessage = `Attachment too large (over ${MAX_FILE_SIZE / 1024 / 1024}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
        }
      }
    }
  } catch (error) {
    // A pending or expired sign-in fails the call; it must not read as an
    // unreadable (or missing) attachment.
    if (isAuthUnavailable(error)) throw error;
    if (error instanceof ApiError && error.status === 404) {
      hasAttachment = false;
    } else {
      attachmentUnreadable = true;
      unreadableCause = error;
      log("INFO", `getSyllabus: syllabus attachment for course ${courseId} could not be read`, error);
    }
  }

  // A caller asking to save the file needs to know nothing was written;
  // a caller only reading text is fine with a note instead of a hard stop.
  let note: string | undefined;
  if (tooLargeMessage) {
    if (downloadPath !== undefined) {
      throw new BrightspaceInvalidArgumentError([tooLargeMessage]);
    }
    note = tooLargeMessage;
  }

  // Extract text from PDF attachment if available.
  let syllabusText: string | null = null;
  let totalPages: number | undefined;
  if (attachmentBuffer && attachmentFilename.toLowerCase().endsWith(".pdf")) {
    const extracted = await extractPdfText(attachmentBuffer);
    if (extracted) {
      syllabusText = extracted.text;
      totalPages = extracted.totalPages;
    }
  }

  log("INFO", `getSyllabus: retrieved overview for course ${courseId}`);

  const result: SyllabusResult = { courseId, description };
  if (syllabusText) {
    result.syllabusText = syllabusText;
    if (totalPages) result.totalPages = totalPages;
  } else {
    result.hasAttachment = hasAttachment;
  }
  if (note) result.note = note;
  if (attachmentUnreadable) {
    result.attachmentUnreadable = true;
    result.notice = ATTACHMENT_UNREADABLE_NOTICE;
  }

  if (downloadPath !== undefined) {
    if (!attachmentBuffer) {
      if (attachmentUnreadable) throw attachmentUnreadableError(unreadableCause);
      throw new BrightspaceNotFoundError("No attachment found for this course's syllabus.");
    }
    // A DownloadError (bad filename, path traversal, unsupported or
    // undetectable type) propagates untouched, same as any other business
    // condition the download helpers themselves throw.
    const saved = await secureDownload({
      targetDir: downloadPath,
      filename: attachmentFilename,
      data: attachmentBuffer,
    });
    log("INFO", `Syllabus attachment downloaded: ${saved.path} (${saved.size} bytes)`);
    result.download = {
      success: true,
      filePath: saved.path,
      fileSize: saved.size,
      mimeType: saved.mime,
    };
  }

  return result;
}
