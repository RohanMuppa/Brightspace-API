/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAssignmentFilesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import {
  describeAttachment,
  readAttachment,
  fileKind,
  type D2LFileAttachment,
} from "./attachment-reader.js";
import { assignmentUrl } from "../utils/deep-links.js";
import { log } from "../utils/logger.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../errors.js";

export { fileKind } from "./attachment-reader.js";

export type GetAssignmentFilesArgs = z.input<typeof GetAssignmentFilesSchema>;

/**
 * The files an instructor attached to an assignment: the spec PDF, the starter
 * workbook, the rubric. Brightspace embeds these in the dropbox folder object
 * itself. The dedicated /attachments/ listing endpoint answers 404 on the
 * tenant this was measured against, so the embedded list is the only index,
 * and the per-file download path is what actually serves the bytes.
 *
 * This returns content. downloadFile saves content to disk. A student asking
 * what they have to do wants the former.
 */

interface DropboxFolder {
  Id: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
  Attachments: D2LFileAttachment[] | null;
}

export interface AssignmentAttachmentSummary {
  fileId: number;
  fileName: string;
  size: number;
  kind: ReturnType<typeof fileKind>;
}

export interface AssignmentWithFiles {
  folderId: number;
  folderName: string;
  dueDate: string | null;
  url: string | null;
  attachments: AssignmentAttachmentSummary[];
}

export interface AssignmentFilesDiscovery {
  courseId: number;
  assignments: AssignmentWithFiles[];
  note?: string;
}

export interface AssignmentFileRead {
  courseId: number;
  folderId: number;
  folderName: string;
  url: string | null;
  file: Record<string, unknown>;
}

export type AssignmentFilesResult = AssignmentFilesDiscovery | AssignmentFileRead;

/** D2L list endpoints return either a paged { Objects: [...] } or a flat array. */
function unwrapList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : ((raw as any)?.Objects ?? []);
}

/** Every visible folder in the course that has at least one attachment. */
async function listFolders(
  ctx: FeatureContext,
  courseId: number,
  folderId?: number
): Promise<DropboxFolder[]> {
  const raw = await ctx.api.get<unknown>(ctx.api.le(courseId, "/dropbox/folders/"), {
    ttl: DEFAULT_CACHE_TTLS.assignments,
  });
  return unwrapList<DropboxFolder>(raw)
    .filter((folder) => folder.IsHidden !== true)
    .filter((folder) => (folderId === undefined ? true : folder.Id === folderId));
}

export async function getAssignmentFiles(
  ctx: FeatureContext,
  args: GetAssignmentFilesArgs
): Promise<AssignmentFilesResult> {
  const { courseId, folderId, fileId, extractText, maxChars } = GetAssignmentFilesSchema.parse(args);

  const folders = await listFolders(ctx, courseId, folderId);

  if (folderId !== undefined && folders.length === 0) {
    throw new BrightspaceNotFoundError(`No visible assignment with id ${folderId} in course ${courseId}.`);
  }

  // Read one file.
  if (fileId !== undefined) {
    if (folderId === undefined) {
      throw new BrightspaceInvalidArgumentError(
        ["fileId: requires folderId"],
        "folderId is required when fileId is given."
      );
    }
    const folder = folders[0];
    const attachment = (folder.Attachments ?? []).find((a) => a.FileId === fileId);
    if (!attachment) {
      const available = folder.Attachments ?? [];
      throw new BrightspaceNotFoundError(
        `No attachment with id ${fileId} on assignment "${folder.Name}". Available files: ${available
          .map((a) => `${a.FileName} (ID: ${a.FileId})`)
          .join(", ")}`
      );
    }
    const file = await readAttachment(
      ctx.api,
      ctx.api.le(courseId, `/dropbox/folders/${folderId}/attachments/${fileId}`),
      attachment,
      extractText,
      maxChars
    );
    return {
      courseId,
      folderId,
      folderName: folder.Name,
      url: ctx.config.baseUrl ? assignmentUrl(ctx.config.baseUrl, courseId, folderId) : null,
      file,
    };
  }

  // Discovery: which assignments have files, without downloading any.
  const withFiles: AssignmentWithFiles[] = folders
    .filter((folder) => (folder.Attachments ?? []).length > 0)
    .map((folder) => ({
      folderId: folder.Id,
      folderName: folder.Name,
      dueDate: folder.DueDate,
      url: ctx.config.baseUrl ? assignmentUrl(ctx.config.baseUrl, courseId, folder.Id) : null,
      attachments: (folder.Attachments ?? []).map(describeAttachment),
    }));

  log("INFO", `getAssignmentFiles: ${withFiles.length} assignments with attachments in course ${courseId}`);

  return {
    courseId,
    assignments: withFiles,
    ...(withFiles.length === 0 ? { note: "No assignment in this course has an attached file." } : {}),
  };
}
