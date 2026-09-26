/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import { GetClasslistEmailsSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { log } from "../utils/logger.js";

export type GetClasslistEmailsArgs = z.input<typeof GetClasslistEmailsSchema>;

interface ClasslistUser {
  Identifier: number;
  DisplayName: string;
  Email: string | null;
  ClasslistRoleDisplayName: string;
}

export interface ClasslistEmailEntry {
  name: string;
  email: string;
  role: string;
}

export type ClasslistEmailsResult = ClasslistEmailEntry[];

/** Every email address in a course — instructors, TAs, and students — with privacy-hidden nulls filtered out. */
export async function getClasslistEmails(ctx: FeatureContext, args: GetClasslistEmailsArgs): Promise<ClasslistEmailsResult> {
  const { courseId } = GetClasslistEmailsSchema.parse(args);

  const path = ctx.api.le(courseId, "/classlist/paged/");
  const users = await fetchAllObjects<ClasslistUser>(ctx.api, path, { ttl: DEFAULT_CACHE_TTLS.roster });

  const emails = users
    .filter((user) => user.Email)
    .map((user) => ({
      name: user.DisplayName,
      email: user.Email as string,
      role: user.ClasslistRoleDisplayName,
    }));

  log("INFO", `getClasslistEmails: ${emails.length} emails from ${users.length} users in course ${courseId}`);
  return emails;
}
