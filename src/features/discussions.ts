/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { GetDiscussionsSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { BrightspaceInvalidArgumentError } from "../errors.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

export type GetDiscussionsArgs = z.input<typeof GetDiscussionsSchema>;

interface D2LForum {
  ForumId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  AllowAnonymous: boolean;
  RequiresApproval: boolean;
}

interface D2LTopic {
  ForumId: number;
  TopicId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  AllowAnonymousPosts: boolean;
  MustPostToParticipate: boolean;
  RequiresApproval: boolean;
  ScoreOutOf: number | null;
}

interface D2LPost {
  ForumId: number;
  TopicId: number;
  PostId: number;
  ThreadId: number;
  ParentPostId: number | null;
  Subject: string;
  Message: { Text: string; Html: string };
  PostingUserId: number | null;
  PostingUserDisplayName: string;
  DatePosted: string;
  IsAnonymous: boolean;
  IsDeleted: boolean;
  LastEditedDate: string | null;
  ReplyPostIds: number[];
  WordCount: number;
  AttachmentCount: number;
  IsRead: boolean;
}

export interface DiscussionTopicSummary {
  topicId: number;
  forumId: number;
  name: string;
  description: string | null;
  dueDate: string | null;
  isLocked: boolean;
  isHidden: boolean;
  mustPostToParticipate: boolean;
  scoreOutOf: number | null;
}

export interface DiscussionForumSummary {
  forumId: number;
  name: string;
  description: string | null;
  isLocked: boolean;
  isHidden: boolean;
  topics: DiscussionTopicSummary[];
}

export interface DiscussionPost {
  postId: number;
  threadId: number;
  parentPostId: number | null;
  subject: string;
  message: string;
  author: string;
  datePosted: string;
  lastEditedDate: string | null;
  replyCount: number;
  wordCount: number;
  attachmentCount: number;
  isRead: boolean;
}

export interface DiscussionTopicDetail {
  topicId: number;
  name: string;
  description: string | null;
  dueDate: string | null;
  isLocked: boolean;
  mustPostToParticipate: boolean;
  scoreOutOf: number | null;
  postCount: number;
  posts: DiscussionPost[];
}

export interface DiscussionsForumsOverview {
  courseId: number;
  forumCount: number;
  forums: DiscussionForumSummary[];
}

export interface DiscussionsForumDetail {
  courseId: number;
  forum: {
    forumId: number;
    name: string;
    description: string | null;
    isLocked: boolean;
    isHidden: boolean;
  };
  topicCount: number;
  topics: DiscussionTopicDetail[];
}

export interface DiscussionsTopicPosts {
  courseId: number;
  forumId: number;
  topic: {
    topicId: number;
    name: string;
    description: string | null;
    dueDate: string | null;
    isLocked: boolean;
    mustPostToParticipate: boolean;
    scoreOutOf: number | null;
  };
  postCount: number;
  posts: DiscussionPost[];
}

export type DiscussionsResult = DiscussionsForumsOverview | DiscussionsForumDetail | DiscussionsTopicPosts;

function formatPosts(posts: D2LPost[]): DiscussionPost[] {
  return posts
    .filter((p) => !p.IsDeleted)
    .map((p) => ({
      postId: p.PostId,
      threadId: p.ThreadId,
      parentPostId: p.ParentPostId,
      subject: p.Subject,
      message: p.Message?.Html ? convertHtmlToMarkdown(p.Message.Html).markdown : p.Message?.Text ?? "",
      author: p.IsAnonymous ? "Anonymous" : p.PostingUserDisplayName,
      datePosted: p.DatePosted,
      lastEditedDate: p.LastEditedDate,
      replyCount: p.ReplyPostIds?.length ?? 0,
      wordCount: p.WordCount,
      attachmentCount: p.AttachmentCount,
      isRead: p.IsRead,
    }))
    .sort((a, b) => new Date(a.datePosted).getTime() - new Date(b.datePosted).getTime());
}

async function getForumsOverview(api: D2LApiClient, courseId: number): Promise<DiscussionsForumsOverview> {
  const forumsPath = api.le(courseId, "/discussions/forums/");
  const forums = await api.get<D2LForum[]>(forumsPath, { ttl: DEFAULT_CACHE_TTLS.courseContent });

  const result: DiscussionForumSummary[] = [];

  for (const forum of forums) {
    let topics: D2LTopic[] = [];
    try {
      const topicsPath = api.le(courseId, `/discussions/forums/${forum.ForumId}/topics/`);
      topics = await api.get<D2LTopic[]>(topicsPath, { ttl: DEFAULT_CACHE_TTLS.courseContent });
    } catch (error: any) {
      if (error?.status === 403) {
        log("DEBUG", `No access to topics for forum ${forum.ForumId}, skipping`);
      } else {
        log("DEBUG", `Failed to fetch topics for forum ${forum.ForumId}`, error);
      }
    }

    result.push({
      forumId: forum.ForumId,
      name: forum.Name,
      description: forum.Description?.Text ?? null,
      isLocked: forum.IsLocked,
      isHidden: forum.IsHidden,
      topics: topics.map((t) => ({
        topicId: t.TopicId,
        forumId: t.ForumId,
        name: t.Name,
        description: t.Description?.Text ?? null,
        dueDate: t.DueDate,
        isLocked: t.IsLocked,
        isHidden: t.IsHidden,
        mustPostToParticipate: t.MustPostToParticipate,
        scoreOutOf: t.ScoreOutOf,
      })),
    });
  }

  log("INFO", `getDiscussions: Retrieved ${forums.length} forums for course ${courseId}`);

  return { courseId, forumCount: result.length, forums: result };
}

async function getForumDetail(api: D2LApiClient, courseId: number, forumId: number): Promise<DiscussionsForumDetail> {
  const forumPath = api.le(courseId, `/discussions/forums/${forumId}`);
  const forum = await api.get<D2LForum>(forumPath, { ttl: DEFAULT_CACHE_TTLS.courseContent });

  const topicsPath = api.le(courseId, `/discussions/forums/${forumId}/topics/`);
  const topics = await api.get<D2LTopic[]>(topicsPath, { ttl: DEFAULT_CACHE_TTLS.courseContent });

  const topicsWithPosts: DiscussionTopicDetail[] = [];
  for (const topic of topics) {
    let posts: D2LPost[] = [];
    try {
      const postsPath = api.le(courseId, `/discussions/forums/${forumId}/topics/${topic.TopicId}/posts/`);
      posts = await api.get<D2LPost[]>(postsPath, { ttl: DEFAULT_CACHE_TTLS.announcements });
    } catch (error: any) {
      if (error?.status === 403) {
        log("DEBUG", `No access to posts for topic ${topic.TopicId}, skipping`);
      } else {
        log("DEBUG", `Failed to fetch posts for topic ${topic.TopicId}`, error);
      }
    }

    const formattedPosts = formatPosts(posts);
    topicsWithPosts.push({
      topicId: topic.TopicId,
      name: topic.Name,
      description: topic.Description?.Html ? convertHtmlToMarkdown(topic.Description.Html).markdown : topic.Description?.Text ?? null,
      dueDate: topic.DueDate,
      isLocked: topic.IsLocked,
      mustPostToParticipate: topic.MustPostToParticipate,
      scoreOutOf: topic.ScoreOutOf,
      postCount: formattedPosts.length,
      posts: formattedPosts,
    });
  }

  log("INFO", `getDiscussions: Retrieved forum ${forumId} with ${topics.length} topics for course ${courseId}`);

  return {
    courseId,
    forum: {
      forumId: forum.ForumId,
      name: forum.Name,
      description: forum.Description?.Text ?? null,
      isLocked: forum.IsLocked,
      isHidden: forum.IsHidden,
    },
    topicCount: topicsWithPosts.length,
    topics: topicsWithPosts,
  };
}

async function getTopicPosts(api: D2LApiClient, courseId: number, forumId: number, topicId: number): Promise<DiscussionsTopicPosts> {
  const topicPath = api.le(courseId, `/discussions/forums/${forumId}/topics/${topicId}`);
  const topic = await api.get<D2LTopic>(topicPath, { ttl: DEFAULT_CACHE_TTLS.courseContent });

  const postsPath = api.le(courseId, `/discussions/forums/${forumId}/topics/${topicId}/posts/`);
  const posts = await api.get<D2LPost[]>(postsPath, { ttl: DEFAULT_CACHE_TTLS.announcements });

  const formattedPosts = formatPosts(posts);

  log("INFO", `getDiscussions: Retrieved ${formattedPosts.length} posts for topic ${topicId} in forum ${forumId}`);

  return {
    courseId,
    forumId,
    topic: {
      topicId: topic.TopicId,
      name: topic.Name,
      description: topic.Description?.Html ? convertHtmlToMarkdown(topic.Description.Html).markdown : topic.Description?.Text ?? null,
      dueDate: topic.DueDate,
      isLocked: topic.IsLocked,
      mustPostToParticipate: topic.MustPostToParticipate,
      scoreOutOf: topic.ScoreOutOf,
    },
    postCount: formattedPosts.length,
    posts: formattedPosts,
  };
}

/**
 * Discussion board content for a course. courseId alone lists every forum
 * and its topics; add forumId for that forum's topics and posts; add both
 * forumId and topicId for one topic's posts. Posts come back as markdown.
 */
export async function getDiscussions(ctx: FeatureContext, args: GetDiscussionsArgs): Promise<DiscussionsResult> {
  const { courseId, forumId, topicId } = GetDiscussionsSchema.parse(args);

  if (topicId !== undefined && forumId === undefined) {
    throw new BrightspaceInvalidArgumentError([
      "topicId requires forumId. Provide both forumId and topicId to get posts for a specific topic.",
    ]);
  }

  if (forumId !== undefined && topicId !== undefined) {
    return getTopicPosts(ctx.api, courseId, forumId, topicId);
  }

  if (forumId !== undefined) {
    return getForumDetail(ctx.api, courseId, forumId);
  }

  return getForumsOverview(ctx.api, courseId);
}
