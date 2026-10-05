/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { DownloadFileSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { log } from "../utils/logger.js";
// Path containment and magic-byte checks belong to secureStreamDownload, which
// every download path below goes through; importing them here only made it
// look as though this module validated anything itself.
import { DownloadError } from "../utils/download-errors.js";
import { secureStreamDownload } from "../utils/download-helpers.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../errors.js";

export type DownloadFileArgs = z.input<typeof DownloadFileSchema>;

export interface DownloadResult {
  success: true;
  filePath: string;
  fileSize: number;
  mimeType: string;
  originalFilename: string;
  message: string;
}

/**
 * Extract a filename from a Content-Disposition header.
 */
export function parseContentDispositionFilename(disposition: string): string | null {
  const extended = disposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended?.[1]) {
    const value = extended[1].trim();
    const parts = value.split("'");
    const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const plain = disposition.match(/filename\s*=\s*("([^"]*)"|[^;\n]*)/i);
  if (plain) {
    const value = (plain[2] ?? plain[1] ?? "").trim();
    if (value) return value;
  }

  return null;
}

/**
 * Maximum bytes of a file downloadFile will save. Downloads stream straight to
 * the file, so memory no longer bounds them the way MAX_FILE_SIZE (50 MB)
 * bounds in-memory reads such as getSyllabus's text extraction; this only
 * stops a runaway body filling the disk. Lecture decks and recordings
 * routinely pass 50 MB.
 */
export const DISK_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

const oversizeMessage = (bytes: number) =>
  `File too large (${Math.round(bytes / 1024 / 1024)}MB). Maximum allowed: ${DISK_MAX_FILE_SIZE / 1024 / 1024}MB`;

/**
 * Finish a download once the response is in hand: refuse it on its
 * Content-Length, then stream the body to disk under the size cap.
 */
async function finishDownload(
  response: Response,
  originalFilename: string,
  downloadPath: string,
  customFilename: string | undefined,
  sourceLabel: string
): Promise<DownloadResult> {
  // Check Content-Length BEFORE reading the body
  const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > DISK_MAX_FILE_SIZE) {
    throw new DownloadError("tooLarge", oversizeMessage(contentLength));
  }

  if (!response.body) {
    throw new DownloadError("undetectableType", "File is empty (0 bytes)");
  }

  // Streams to disk with path traversal prevention, file type validation,
  // conflict resolution, and the size cap
  const result = await secureStreamDownload({
    targetDir: downloadPath,
    filename: customFilename || originalFilename,
    body: response.body,
    maxBytes: DISK_MAX_FILE_SIZE,
  });

  log("INFO", `${sourceLabel} downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`);

  return {
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `File downloaded successfully to ${result.path}`,
  };
}

/**
 * Download a file from course content, a dropbox submission, or an
 * announcement's attachments, to a local directory.
 */
export async function downloadFile(ctx: FeatureContext, args: DownloadFileArgs): Promise<DownloadResult> {
  const { courseId, topicId, folderId, newsId, fileId, downloadPath, customFilename } =
    DownloadFileSchema.parse(args);

  if (!path.isAbsolute(downloadPath)) {
    throw new BrightspaceInvalidArgumentError(
      ["downloadPath: must be an absolute path"],
      "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
    );
  }

  const stats = await fs.stat(downloadPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new BrightspaceInvalidArgumentError(
        ["downloadPath: does not exist"],
        `Download directory does not exist: ${downloadPath}`
      );
    }
    throw error;
  });
  if (!stats.isDirectory()) {
    throw new BrightspaceInvalidArgumentError(
      ["downloadPath: not a directory"],
      `Download path is not a directory: ${downloadPath}`
    );
  }

  if (topicId !== undefined) {
    return downloadContentFile(ctx, courseId, topicId, downloadPath, customFilename);
  } else if (folderId !== undefined && fileId !== undefined) {
    return downloadSubmissionFile(ctx, courseId, folderId, fileId, downloadPath, customFilename);
  } else if (newsId !== undefined && fileId !== undefined) {
    return downloadNewsAttachment(ctx, courseId, newsId, fileId, downloadPath, customFilename);
  }

  throw new BrightspaceInvalidArgumentError(
    ["topicId | folderId+fileId | newsId+fileId"],
    "Either topicId (for content files), both folderId and fileId (for submission files), or both newsId and fileId (for announcement attachments) must be provided"
  );
}

/**
 * Download a content file using topicId
 */
async function downloadContentFile(
  ctx: FeatureContext,
  courseId: number,
  topicId: number,
  downloadPath: string,
  customFilename?: string
): Promise<DownloadResult> {
  log("INFO", `Downloading content file: courseId=${courseId}, topicId=${topicId}`);

  const apiPath = ctx.api.le(courseId, `/content/topics/${topicId}/file`);
  const response = await ctx.api.getRaw(apiPath);

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(disposition) ?? "download";
  log("DEBUG", `Content-Disposition filename: ${filename}`);

  return finishDownload(response, filename, downloadPath, customFilename, "Content file");
}

interface DropboxSubmission {
  Id: number;
  Files: Array<{ FileId: number; FileName: string; Size: number }>;
}

/**
 * Download a submission/feedback file using folderId + fileId
 */
async function downloadSubmissionFile(
  ctx: FeatureContext,
  courseId: number,
  folderId: number,
  fileId: number,
  downloadPath: string,
  customFilename?: string
): Promise<DownloadResult> {
  log("INFO", `Downloading submission file: courseId=${courseId}, folderId=${folderId}, fileId=${fileId}`);

  // D2L API pattern for submission file downloads:
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/mysubmissions/
  // Then find the file by fileId and construct its download URL
  const submissionsPath = ctx.api.le(courseId, `/dropbox/folders/${folderId}/submissions/mysubmissions/`);
  const submissions = await ctx.api.get<DropboxSubmission[]>(submissionsPath);

  if (!submissions || submissions.length === 0) {
    throw new BrightspaceNotFoundError("No submissions found for this assignment. Upload a submission first.");
  }

  // Find the file across every submission.
  //
  // A resubmitted assignment answers with one entry per submission, each with
  // its own Files. Reading submissions[0] alone reported "not found" for a file
  // the same response had just returned, and the download URL below needs the
  // id of the submission the file actually belongs to, not the first one's.
  // Files is absent on a submission with no attachments, so it is not assumed.
  let submission: DropboxSubmission | undefined;
  let file: DropboxSubmission["Files"][number] | undefined;

  for (const candidate of submissions) {
    const match = (candidate.Files ?? []).find((f) => f.FileId === fileId);
    if (match) {
      submission = candidate;
      file = match;
      break;
    }
  }

  if (!submission || !file) {
    const available = submissions.flatMap((s) => s.Files ?? []);
    throw new BrightspaceNotFoundError(
      `File ID ${fileId} not found in submission. Available files: ${available
        .map((f) => `${f.FileName} (ID: ${f.FileId})`)
        .join(", ")}`
    );
  }

  // Check file size before downloading
  if (file.Size > DISK_MAX_FILE_SIZE) {
    throw new DownloadError("tooLarge", oversizeMessage(file.Size));
  }

  // D2L file download URL pattern for submission files
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/(submissionId)/files/(fileId)/download
  const downloadApiPath = ctx.api.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${fileId}/download`
  );
  const response = await ctx.api.getRaw(downloadApiPath);

  return finishDownload(response, file.FileName, downloadPath, customFilename, "Submission file");
}

interface NewsItem {
  Attachments?: Array<{ FileId: number; FileName: string; Size: number }> | null;
}

/**
 * Download an announcement attachment using newsId + fileId
 */
async function downloadNewsAttachment(
  ctx: FeatureContext,
  courseId: number,
  newsId: number,
  fileId: number,
  downloadPath: string,
  customFilename?: string
): Promise<DownloadResult> {
  log("INFO", `Downloading announcement attachment: courseId=${courseId}, newsId=${newsId}, fileId=${fileId}`);

  // The news item lists its attachments, so an unknown fileId can name the
  // real ones and an oversize file is refused before a byte is fetched.
  const newsItem = await ctx.api.get<NewsItem>(ctx.api.le(courseId, `/news/${newsId}`));
  const attachments = newsItem?.Attachments ?? [];
  const file = attachments.find((f) => f.FileId === fileId);

  if (!file) {
    throw new BrightspaceNotFoundError(
      `File ID ${fileId} not found on this announcement. Available files: ${attachments
        .map((f) => `${f.FileName} (ID: ${f.FileId})`)
        .join(", ")}`
    );
  }

  if (file.Size > DISK_MAX_FILE_SIZE) {
    throw new DownloadError("tooLarge", oversizeMessage(file.Size));
  }

  // GET /d2l/api/le/(version)/(orgUnitId)/news/(newsItemId)/attachments/(fileId)
  const response = await ctx.api.getRaw(ctx.api.le(courseId, `/news/${newsId}/attachments/${fileId}`));

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(disposition) ?? file.FileName;

  return finishDownload(response, filename, downloadPath, customFilename, "Announcement attachment");
}
