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

/**
 * What `getClasslistEmails` returns: the usual `ClasslistEmailEntry[]`, plus
 * `hiddenCount` and `notice` properties that are present only when someone in
 * the course has no email visible to this account. They are properties on the
 * array, not elements, so iterating, `.length`, and `JSON.stringify` see
 * exactly the entries.
 */
export type ClasslistEmailsResult = ClasslistEmailEntry[] & {
  /** How many people in the course were left out because Brightspace hides their email. */
  hiddenCount?: number;
  /** Set with `hiddenCount`: says how many of the course's people are not listed, and why. */
  notice?: string;
};

/**
 * Every email address in a course — instructors, TAs, and students. People
 * whose email Brightspace hides are left out, and counted in `hiddenCount`
 * with a `notice`, so a partial list never reads as the whole class.
 */
export async function getClasslistEmails(ctx: FeatureContext, args: GetClasslistEmailsArgs): Promise<ClasslistEmailsResult> {
  const { courseId } = GetClasslistEmailsSchema.parse(args);

  const path = ctx.api.le(courseId, "/classlist/paged/");
  const users = await fetchAllObjects<ClasslistUser>(ctx.api, path, { ttl: DEFAULT_CACHE_TTLS.roster });

  const emails: ClasslistEmailsResult = users
    .filter((user) => user.Email)
    .map((user) => ({
      name: user.DisplayName,
      email: user.Email as string,
      role: user.ClasslistRoleDisplayName,
    }));

  log("INFO", `getClasslistEmails: ${emails.length} emails from ${users.length} users in course ${courseId}`);

  // People whose email Brightspace hides are left out of the list. Say so, or
  // a partial list reads as the whole class and an all-hidden course reads as
  // an empty one. Only when someone is hidden, so the usual result is a plain
  // array.
  const hidden = users.length - emails.length;
  if (hidden > 0) {
    const who = hidden === 1 ? "person" : "people";
    const has = hidden === 1 ? "has" : "have";
    emails.hiddenCount = hidden;
    emails.notice =
      `${hidden} of ${users.length} ${who} in this course ${has} no email visible to you ` +
      "(Brightspace hides it), so they are not listed.";
  }
  return emails;
}
