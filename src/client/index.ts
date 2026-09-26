/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../utils/config.js";
import { setLogLevel } from "../utils/logger.js";
import { TokenManager, AuthRunner } from "../auth/index.js";
import { AuthProcessError } from "../auth/auth-runner.js";
import { D2LApiClient } from "../api/index.js";
import { toPublicError } from "../errors.js";
import type { AppConfig, LogLevel } from "../types/index.js";
import type { FeatureContext } from "../features/context.js";
import { getMyCourses } from "../features/courses.js";
import { getMyGrades, type GetMyGradesArgs, type CourseGrades } from "../features/grades.js";
import { getUpcomingDueDates, type GetUpcomingDueDatesArgs, type UpcomingItem } from "../features/due-dates.js";
import { getInfo, type ClientInfo } from "../features/info.js";
import { getAssignments, type GetAssignmentsArgs, type AssignmentsResult } from "../features/assignments.js";
import { getAssignmentFiles, type GetAssignmentFilesArgs, type AssignmentFilesResult } from "../features/assignment-files.js";
import { downloadFile, type DownloadFileArgs, type DownloadResult } from "../features/download.js";
import { getDiscussions, type GetDiscussionsArgs, type DiscussionsResult } from "../features/discussions.js";
import { getRoster, type GetRosterArgs, type RosterResult } from "../features/roster.js";
import { getClasslistEmails, type GetClasslistEmailsArgs, type ClasslistEmailsResult } from "../features/classlist-emails.js";
import { getVideoTranscript, type GetVideoTranscriptArgs, type VideoTranscriptResult } from "../features/transcript.js";
import { getAnnouncements, type GetAnnouncementsArgs, type Announcement, type AnnouncementsFiltered } from "../features/announcements.js";
import { getAnnouncementFiles, type GetAnnouncementFilesArgs, type AnnouncementFilesResult } from "../features/announcement-files.js";
import { getCourseContent, type GetCourseContentArgs, type CourseContentResult } from "../features/content.js";
import { getSyllabus, type GetSyllabusArgs, type SyllabusResult } from "../features/syllabus.js";
import type { Course, GetMyCoursesArgs } from "../features/courses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface BrightspaceClientOptions {
  /** Use this config instead of loading ~/.brightspace-mcp/config.json and the environment. */
  config?: AppConfig;
  /**
   * What to do when the saved session is gone and cannot be renewed over HTTP.
   * "fail" (default): throw BrightspaceAuthExpiredError. A cron job cannot answer a phone.
   * "login": run the browser sign-in the way the MCP server does (AuthRunner → auth-cli
   * --automatic). The call then throws BrightspaceMfaPendingError as soon as the challenge
   * appears (with the number to enter, when there is one); the sign-in keeps running in the
   * background and a retry after approval succeeds.
   */
  onAuthExpired?: "fail" | "login";
  /** Receives the number-match digits (or null for a plain push) the moment they appear. Only with "login". */
  onMfaChallenge?: (numberMatch: string | null) => void;
  /** Progress lines from the sign-in child, for a script that wants to show them. */
  onProgress?: (line: string) => void;
  /** Logger threshold for this process; default "WARN" so a library caller's stderr stays quiet. */
  logLevel?: LogLevel;
}

/**
 * Construction mirrors the MCP server's src/index.ts at the seed commit:
 * loadConfig(), a TokenManager reading the cached session, and a D2LApiClient
 * whose onAuthExpired callback is either absent ("fail") or an AuthRunner
 * ("login"). Nothing here reaches Brightspace — the first request that needs
 * a token authenticates on its own.
 */
export async function createBrightspaceClient(options: BrightspaceClientOptions = {}): Promise<BrightspaceClient> {
  setLogLevel(options.logLevel ?? "WARN");

  const config = options.config ?? (await loadConfig({ tolerateCredentialStore: true }));
  const tokenManager = new TokenManager({
    sessionDir: config.sessionDir,
    baseUrl: config.baseUrl,
    tokenTtl: config.tokenTtl,
  });

  let onAuthExpired: (() => Promise<boolean>) | undefined;
  if (options.onAuthExpired === "login") {
    const authRunner = new AuthRunner({ onProgress: options.onProgress });
    onAuthExpired = async () => {
      try {
        return await authRunner.run();
      } catch (error) {
        // AuthRunner exposes the challenge only through this rejection today;
        // report it to the caller before it is rethrown and mapped to
        // BrightspaceMfaPendingError at the facade boundary.
        if (error instanceof AuthProcessError && error.kind === "mfaPending") {
          options.onMfaChallenge?.(error.numberMatch ?? null);
        }
        throw error;
      }
    };
  }

  const api = new D2LApiClient({ baseUrl: config.baseUrl, tokenManager, onAuthExpired });
  const ctx: FeatureContext = { api, config, version: PKG_VERSION };
  return new BrightspaceClient(ctx);
}

export class BrightspaceClient {
  readonly config: AppConfig;
  readonly api: D2LApiClient;
  private readonly ctx: FeatureContext;

  constructor(ctx: FeatureContext) {
    this.ctx = ctx;
    this.config = ctx.config;
    this.api = ctx.api;
  }

  /**
   * Every method is one line through this: run the feature function against
   * this client's context and map whatever it throws to the public error
   * contract. Kept here so each method below stays trivial.
   */
  private async run<Args, Result>(fn: (ctx: FeatureContext, args: Args) => Promise<Result>, args: Args): Promise<Result> {
    try {
      return await fn(this.ctx, args);
    } catch (e) {
      throw toPublicError(e);
    }
  }

  getMyCourses(args?: GetMyCoursesArgs): Promise<Course[]> {
    return this.run(getMyCourses, args);
  }

  getUpcomingDueDates(args?: GetUpcomingDueDatesArgs): Promise<UpcomingItem[]> {
    return this.run(getUpcomingDueDates, args);
  }

  getMyGrades(args?: GetMyGradesArgs): Promise<CourseGrades[]> {
    return this.run(getMyGrades, args);
  }

  getAssignments(args?: GetAssignmentsArgs): Promise<AssignmentsResult> {
    return this.run(getAssignments, args);
  }

  getAssignmentFiles(args: GetAssignmentFilesArgs): Promise<AssignmentFilesResult> {
    return this.run(getAssignmentFiles, args);
  }

  downloadFile(args: DownloadFileArgs): Promise<DownloadResult> {
    return this.run(downloadFile, args);
  }

  getClasslistEmails(args: GetClasslistEmailsArgs): Promise<ClasslistEmailsResult> {
    return this.run(getClasslistEmails, args);
  }

  getRoster(args: GetRosterArgs): Promise<RosterResult> {
    return this.run(getRoster, args);
  }

  getDiscussions(args: GetDiscussionsArgs): Promise<DiscussionsResult> {
    return this.run(getDiscussions, args);
  }

  getVideoTranscript(args: GetVideoTranscriptArgs): Promise<VideoTranscriptResult> {
    return this.run(getVideoTranscript, args);
  }

  getInfo(): Promise<ClientInfo> {
    return this.run(getInfo, undefined);
  }

  getAnnouncements(args?: GetAnnouncementsArgs): Promise<Announcement[] | AnnouncementsFiltered> {
    return this.run(getAnnouncements, args);
  }

  getAnnouncementFiles(args: GetAnnouncementFilesArgs): Promise<AnnouncementFilesResult> {
    return this.run(getAnnouncementFiles, args);
  }

  getCourseContent(args: GetCourseContentArgs): Promise<CourseContentResult> {
    return this.run(getCourseContent, args);
  }

  getSyllabus(args: GetSyllabusArgs): Promise<SyllabusResult> {
    return this.run(getSyllabus, args);
  }
}
