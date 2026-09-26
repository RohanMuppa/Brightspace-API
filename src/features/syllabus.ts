/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetSyllabusSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { log } from "../utils/logger.js";

export type GetSyllabusArgs = z.input<typeof GetSyllabusSchema>;

// D2L Overview API response shape
interface CourseOverview {
  Description: { Text: string; Html: string } | null;
}

export interface SyllabusResult {
  courseId: number;
  description: string | null;
  hasAttachment?: boolean;
  syllabusText?: string;
  totalPages?: number;
  message?: string;
  note?: string;
}

/** The syllabus/overview text and, when a PDF attachment exists, its extracted text. */
export async function getSyllabus(ctx: FeatureContext, args: GetSyllabusArgs): Promise<SyllabusResult> {
  const { courseId } = GetSyllabusSchema.parse(args);

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

  // Always attempt to fetch the attachment so its PDF text can be extracted.
  let attachmentBuffer: Buffer | null = null;
  let attachmentFilename = "syllabus";
  let hasAttachment = false;
  let note: string | undefined;

  try {
    const response = await ctx.api.getRaw(ctx.api.le(courseId, "/overview/attachment"));

    if (response.ok) {
      hasAttachment = true;

      // Check Content-Length before downloading the body.
      const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
      if (contentLength > MAX_FILE_SIZE) {
        note = `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB) to extract text from. Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB.`;
      } else {
        // Get filename from Content-Disposition header.
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match?.[1]) {
          attachmentFilename = match[1].replace(/['"]/g, "");
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE) {
          note = `Attachment too large (${Math.round(buffer.length / 1024 / 1024)}MB) to extract text from. Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB.`;
        } else {
          attachmentBuffer = buffer;
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
  return result;
}
