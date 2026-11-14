/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DownloadCourseFilesSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { syncCourse, type SyncResult } from "../sync/course-sync.js";

export type DownloadCourseFilesArgs = z.input<typeof DownloadCourseFilesSchema>;

/**
 * Download every file in a course's Content area into `destination`, in
 * sub-folders named after the course's modules. A rerun only fetches what is
 * new, so it works as a sync: files already on disk are left alone by
 * default, and only files a previous call of this function wrote are ever
 * replaced. See syncCourse (src/sync/course-sync.ts) for the full behaviour.
 */
export async function downloadCourseFiles(ctx: FeatureContext, args: DownloadCourseFilesArgs): Promise<SyncResult> {
  const { courseId, destination, existing, moduleId, dryRun, maxFiles, maxTotalMB } = DownloadCourseFilesSchema.parse(args);

  return syncCourse(ctx, {
    courseId,
    destination,
    existing,
    moduleId,
    dryRun,
    maxFiles,
    maxTotalBytes: maxTotalMB * 1024 * 1024,
  });
}
