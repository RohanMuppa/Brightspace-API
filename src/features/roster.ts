/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import { GetRosterSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { log } from "../utils/logger.js";

export type GetRosterArgs = z.input<typeof GetRosterSchema>;

interface ClasslistUser {
  Identifier: number;
  DisplayName: string;
  Email: string | null;
  FirstName: string | null;
  LastName: string | null;
  RoleId: number | null;
  ClasslistRoleDisplayName: string;
  IsOnline: boolean;
  LastAccessed: string | null;
}

// Purdue-specific role IDs. These are institution-specific values.
// If using at another institution, you may need to adjust these.
// Discover by fetching classlist for a known course and inspecting RoleId values.
const INSTRUCTOR_ROLE_ID = 109;
const TA_ROLE_ID = 135;

export interface RosterUser {
  name: string;
  email: string | null;
  role: string;
}

export interface RosterResult {
  courseId: number;
  total: number;
  returned: number;
  truncated: boolean;
  note?: string;
  users: RosterUser[];
}

async function fetchClasslistUsers(
  api: D2LApiClient,
  courseId: number,
  options?: { roleId?: number; searchTerm?: string },
): Promise<ClasslistUser[]> {
  const params = new URLSearchParams();

  if (options?.roleId !== undefined) {
    params.append("roleId", options.roleId.toString());
  }

  if (options?.searchTerm) {
    params.append("searchTerm", options.searchTerm);
  }

  const queryString = params.toString();
  const path = api.le(courseId, `/classlist/paged/${queryString ? "?" + queryString : ""}`);

  return fetchAllObjects<ClasslistUser>(api, path, { ttl: DEFAULT_CACHE_TTLS.roster });
}

/**
 * The course roster. By default only instructors and TAs, for privacy;
 * includeStudents pulls the full class list. A very large roster would
 * swamp the response, so it is capped at `limit` — the cap is reported in
 * the payload rather than only in a log line, so a 340 person lecture
 * doesn't silently look like a 100 person one.
 */
export async function getRoster(ctx: FeatureContext, args: GetRosterArgs): Promise<RosterResult> {
  const { courseId, includeStudents, searchTerm, limit } = GetRosterSchema.parse(args);

  const allUsers: ClasslistUser[] = [];

  if (!includeStudents) {
    const [instructorResult, taResult] = await Promise.allSettled([
      fetchClasslistUsers(ctx.api, courseId, { roleId: INSTRUCTOR_ROLE_ID, searchTerm }),
      fetchClasslistUsers(ctx.api, courseId, { roleId: TA_ROLE_ID, searchTerm }),
    ]);

    if (instructorResult.status === "fulfilled") {
      allUsers.push(...instructorResult.value);
    } else {
      log("WARN", "getRoster: Failed to fetch instructors", { error: instructorResult.reason });
    }

    if (taResult.status === "fulfilled") {
      allUsers.push(...taResult.value);
    } else {
      log("WARN", "getRoster: Failed to fetch TAs", { error: taResult.reason });
    }
  } else {
    allUsers.push(...(await fetchClasslistUsers(ctx.api, courseId, { searchTerm })));
  }

  const total = allUsers.length;
  const truncated = total > limit;
  const kept = truncated ? allUsers.slice(0, limit) : allUsers;

  if (truncated) {
    log("WARN", "getRoster: Result set exceeds the limit, truncating", { total, returned: kept.length });
  }

  const users = kept.map((user) => ({
    name: user.DisplayName,
    email: user.Email || null,
    role: user.ClasslistRoleDisplayName,
  }));

  log("INFO", `getRoster: Retrieved ${users.length} users for course ${courseId}`);

  return {
    courseId,
    total,
    returned: users.length,
    truncated,
    ...(truncated ? { note: `Showing ${users.length} of ${total}. Raise the limit argument to see more.` } : {}),
    users,
  };
}
