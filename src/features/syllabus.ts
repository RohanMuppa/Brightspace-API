/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetSyllabusSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { secureDownload, readBodyCapped } from "../utils/download-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../errors.js";
import { log } from "../utils/logger.js";

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
        const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match?.[1]) {
          attachmentFilename = match[1].replace(/['"]/g, "");
        }

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
    if (error instanceof ApiError && error.status === 404) {
      hasAttachment = false;
    } else {
      log("DEBUG", "Could not fetch syllabus attachment", error);
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

  if (downloadPath !== undefined) {
    if (!attachmentBuffer) {
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
