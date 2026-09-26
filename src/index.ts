/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

export { createBrightspaceClient, BrightspaceClient } from "./client/index.js";
export type { BrightspaceClientOptions } from "./client/index.js";
export * from "./errors.js";
export type { Course, GetMyCoursesArgs } from "./features/courses.js";
export type { AppConfig, TokenData } from "./types/index.js";
