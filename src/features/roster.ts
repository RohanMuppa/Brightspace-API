/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import { isAuthUnavailable } from "../api/errors.js";
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

/** The staff roles the default view reads, one classlist route each. */
export type RosterStaffRole = "instructors" | "TAs";

export interface RosterResult {
  courseId: number;
  total: number;
  returned: number;
  truncated: boolean;
  note?: string;
  users: RosterUser[];
  /**
   * Staff roles whose classlist route failed (a 404, a 5xx, a dropped
   * connection), so they may be missing from `users`. Absent when every
   * role was read; a 403 is not listed.
   */
  unavailable?: RosterStaffRole[];
  /** Set with `unavailable`: says those roles may be missing and must not be reported as empty. */
  notice?: string;
}

/** 403: the classlist is restricted for that role, which is not a failure to report. */
function isForbidden(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 403;
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
 *
 * In the staff view, a role route that fails with anything but a 403 is
 * named in `unavailable` (with a `notice`), so a missing TA list never reads
 * as a course with no TAs. A sign-in problem fails the whole call.
 */
export async function getRoster(ctx: FeatureContext, args: GetRosterArgs): Promise<RosterResult> {
  const { courseId, includeStudents, searchTerm, limit } = GetRosterSchema.parse(args);

  const allUsers: ClasslistUser[] = [];
  const unavailable: RosterStaffRole[] = [];

  if (!includeStudents) {
    const [instructorResult, taResult] = await Promise.allSettled([
      fetchClasslistUsers(ctx.api, courseId, { roleId: INSTRUCTOR_ROLE_ID, searchTerm }),
      fetchClasslistUsers(ctx.api, courseId, { roleId: TA_ROLE_ID, searchTerm }),
    ]);

    // A course that could not sign in is not a course with no staff.
    for (const result of [instructorResult, taResult]) {
      if (result.status === "rejected" && isAuthUnavailable(result.reason)) throw result.reason;
    }

    // Any other failure but a 403 leaves a hole the caller would read as
    // "this course has no TAs", so it is named in the payload.
    const roles: [RosterStaffRole, PromiseSettledResult<ClasslistUser[]>][] = [
      ["instructors", instructorResult],
      ["TAs", taResult],
    ];
    for (const [role, result] of roles) {
      if (result.status === "fulfilled") {
        allUsers.push(...result.value);
        continue;
      }
      log("WARN", `getRoster: Failed to fetch ${role}`, { error: result.reason });
      if (!isForbidden(result.reason)) unavailable.push(role);
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
    ...(unavailable.length > 0
      ? {
          unavailable,
          notice:
            `The ${unavailable.join(" and ")} for this course could not be read from Brightspace, so they ` +
            `may be missing from this list. Do not report this course as having no ` +
            `${unavailable.join(" or ")}; call getRoster again to retry.`,
        }
      : {}),
  };
}
