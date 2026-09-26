/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

export { createBrightspaceClient, BrightspaceClient } from "./client/index.js";
export type { BrightspaceClientOptions } from "./client/index.js";
export * from "./errors.js";
export type { AppConfig, TokenData } from "./types/index.js";

export type { Course, GetMyCoursesArgs } from "./features/courses.js";
export type { GetMyGradesArgs, GradeItem, CourseGrades } from "./features/grades.js";
export type { GetUpcomingDueDatesArgs, UpcomingItem } from "./features/due-dates.js";
export type { ClientInfo } from "./features/info.js";
export type {
  GetAssignmentsArgs,
  AssignmentRubricLevel,
  AssignmentRubricCriterion,
  AssignmentRubric,
  AssignmentSubmissionFile,
  AssignmentSubmission,
  AssignmentFeedback,
  DropboxAssignmentItem,
  QuizAssignmentItem,
  GradeOnlyAssignmentItem,
  AssignmentItem,
  CourseAssignments,
  AssignmentsResult,
} from "./features/assignments.js";
export type {
  GetAssignmentFilesArgs,
  AssignmentAttachmentSummary,
  AssignmentWithFiles,
  AssignmentFilesDiscovery,
  AssignmentFileRead,
  AssignmentFilesResult,
} from "./features/assignment-files.js";
export type { DownloadFileArgs, DownloadResult } from "./features/download.js";
export type {
  GetDiscussionsArgs,
  DiscussionTopicSummary,
  DiscussionForumSummary,
  DiscussionPost,
  DiscussionTopicDetail,
  DiscussionsForumsOverview,
  DiscussionsForumDetail,
  DiscussionsTopicPosts,
  DiscussionsResult,
} from "./features/discussions.js";
export type { GetRosterArgs, RosterUser, RosterResult } from "./features/roster.js";
export type { GetClasslistEmailsArgs, ClasslistEmailEntry, ClasslistEmailsResult } from "./features/classlist-emails.js";
export type {
  GetVideoTranscriptArgs,
  VideoTranscriptUnavailable,
  VideoTranscriptAvailable,
  VideoTranscriptResult,
} from "./features/transcript.js";
export type { GetAnnouncementsArgs, Announcement, AnnouncementsFiltered } from "./features/announcements.js";
export type {
  GetAnnouncementFilesArgs,
  AnnouncementAttachmentInfo,
  AnnouncementFileListing,
  AnnouncementFilesResult,
} from "./features/announcement-files.js";
export type { GetCourseContentArgs, ContentModule, ContentTopic, ContentNode, CourseContentResult } from "./features/content.js";
export type { GetSyllabusArgs, SyllabusDownload, SyllabusResult } from "./features/syllabus.js";
