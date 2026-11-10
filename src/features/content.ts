/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { isAuthUnavailable } from "../api/errors.js";
import { GetCourseContentSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { matchesModifiedSince } from "../utils/modified-since.js";
import { extractCourseFilePaths } from "../utils/course-files.js";
import { log } from "../utils/logger.js";

export type GetCourseContentArgs = z.input<typeof GetCourseContentSchema>;

// D2L Content API response type
interface ContentObject {
  Id: number;
  Title: string;
  ShortTitle: string | null;
  Type: number; // 0 = Module, 1 = Topic
  Description: { Text: string; Html: string } | null;
  ModuleStartDate: string | null;
  ModuleEndDate: string | null;
  ModuleDueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  LastModifiedDate: string | null;
  // Module-specific
  Structure?: ContentObject[];
  // Topic-specific
  TopicType?: number; // 1=File, 2=Link/URL, 3=ExternalLink, etc.
  Url?: string;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
}

// Progress tracking
interface ContentProgress {
  UserId: number;
  ContentObjectId: number;
  IsRead: boolean;
  DateCompleted: string | null;
}

export interface ContentModule {
  type: "module";
  id: number;
  title: string;
  description: string | null;
  courseFiles?: string[];
  dueDate?: string;
  isHidden?: boolean;
  isLocked?: boolean;
  lastModified: string | null;
  /**
   * The module's items, or null when they could not be read (see
   * `childrenUnavailable`). An empty array means the module was read and is
   * empty.
   */
  children: ContentNode[] | null;
  /**
   * Set, with `children: null`, when neither the module's /structure/ call
   * nor the parent listing gave its contents. Absent on every module that
   * was read.
   */
  childrenUnavailable?: ChildrenUnavailable;
}

/** Why a module's children are missing from the tree. */
export interface ChildrenUnavailable {
  /** The HTTP status Brightspace answered with, or null (network error, an answer that was not a list). */
  status: number | null;
  reason: string;
}

export interface ContentTopic {
  type: "topic";
  topicType: string;
  id: number;
  title: string;
  isHidden?: boolean;
  isLocked?: boolean;
  dueDate?: string;
  lastModified: string | null;
  /**
   * Whether the user has completed the topic, or null when the course's
   * progress could not be read (see `progressUnavailable` on the result).
   * Null means unknown, not "not completed".
   */
  isCompleted: boolean | null;
  completedDate?: string;
  description?: string | null;
  topicId?: number;
  url?: string | null;
  content?: string;
}

export type ContentNode = ContentModule | ContentTopic;

export interface CourseContentResult {
  courseId: number;
  typeFilter: string;
  contentTree: ContentNode[];
  topicCount: number;
  moduleCount: number;
  modifiedSince?: string;
  returned?: number;
  filteredOut?: number;
  /**
   * Set when some modules' contents could not be read (they have
   * `children: null` and `childrenUnavailable`): says how many, and that
   * they must not be reported as empty. Absent when every module was read.
   */
  notice?: string;
  /**
   * Set when the user's completion progress could not be read (a 5xx, a
   * timeout, a network error): every topic then has `isCompleted: null`, and
   * topics must not be reported as not completed. Absent when progress was
   * read, or when the course has none for this user (403/404).
   */
  progressUnavailable?: string;
}

// Topic type mapping
const TOPIC_TYPE_MAP: Record<number, string> = {
  1: "file",
  2: "link",
  3: "link", // External link
};

/** Whether a content item matches the requested type filter. */
function matchesTypeFilter(item: ContentObject, filter: string): boolean {
  switch (filter) {
    case "file":
      return item.TopicType === 1;
    case "link":
      return item.TopicType === 2 || item.TopicType === 3;
    case "html":
      return !!item.Description?.Html && item.TopicType !== 1;
    case "video":
      return (item.TopicType === 2 || item.TopicType === 3) && /youtube|vimeo|kaltura|video/i.test(item.Url ?? "");
    default:
      return true;
  }
}

/**
 * How deep the tree builder will descend when the caller names no maxDepth.
 * A module structure that lists itself is a cycle, and without a ceiling the
 * recursion would never come back.
 */
const MAX_CONTENT_DEPTH = 12;

/**
 * Fetch a single module's structure, or say why it couldn't be read (locked
 * module, transient error, an answer that is not a list) so the caller can
 * fall back to whatever structure the parent listing already embedded. A
 * pending or expired sign-in is rethrown: it fails every module the same way,
 * and must fail the call instead of showing a course whose every module looks
 * empty.
 */
async function fetchModuleStructure(
  ctx: FeatureContext,
  courseId: number,
  moduleId: number,
): Promise<ContentObject[] | ChildrenUnavailable> {
  let structure: unknown;
  try {
    structure = await ctx.api.get<ContentObject[]>(ctx.api.le(courseId, `/content/modules/${moduleId}/structure/`), {
      ttl: DEFAULT_CACHE_TTLS.courseContent,
    });
  } catch (error) {
    if (isAuthUnavailable(error)) throw error;
    log("DEBUG", `Failed to fetch children for module ${moduleId}: falling back to the embedded structure`, error);
    const raw = (error as { status?: unknown } | null)?.status;
    const status = typeof raw === "number" ? raw : null;
    return {
      status,
      reason:
        status === 403
          ? "Brightspace refused this account's request for this module's contents. It may hold items; open the module in a browser to see what this account can read."
          : `Couldn't read this module's contents${status !== null ? ` (Brightspace answered ${status})` : ""}. It may hold items; try again.`,
    };
  }
  if (Array.isArray(structure)) return structure;
  log("DEBUG", `Module ${moduleId} structure was not a list: falling back to the embedded structure`);
  return {
    status: null,
    reason: "Brightspace answered with something other than a list of this module's contents. It may hold items; try again.",
  };
}

/** Recursively build the content tree with progress tracking. */
async function buildContentTree(
  ctx: FeatureContext,
  courseId: number,
  modules: ContentObject[],
  progressMap: Map<number, ContentProgress> | null,
  typeFilter: string,
  maxDepth?: number,
  currentDepth: number = 0,
): Promise<ContentNode[]> {
  const tree: ContentNode[] = [];
  const depthLimit = Math.min(maxDepth ?? MAX_CONTENT_DEPTH, MAX_CONTENT_DEPTH);

  for (const item of modules) {
    if (item.Type === 0) {
      // Module: fetch children recursively (unless the depth limit is reached)
      let processedChildren: ContentNode[] = [];
      let childrenUnavailable: ChildrenUnavailable | undefined;

      if (currentDepth < depthLimit) {
        // The parent listing already embeds this module's immediate children
        // in Structure. The dedicated endpoint is still asked first because it
        // is the authoritative copy, but a module whose structure call fails —
        // or answers with something that is not an array — must fall back to
        // what the parent already handed us. Falling through to an empty list
        // made a locked or erroring module look like an empty one, and under a
        // typeFilter it dropped the module from the tree with no trace.
        // When neither copy is readable, the module's children are reported
        // as null with a reason, never as [], so it can't pass for an empty
        // module, and the module is kept under any typeFilter because nothing
        // says it holds no matching items.
        const structure = await fetchModuleStructure(ctx, courseId, item.Id);
        let children: ContentObject[] | null = null;
        if (Array.isArray(structure)) {
          children = structure;
        } else if (Array.isArray(item.Structure)) {
          children = item.Structure;
        } else {
          childrenUnavailable = structure;
        }

        if (children) {
          processedChildren = await buildContentTree(ctx, courseId, children, progressMap, typeFilter, maxDepth, currentDepth + 1);
        }
      } else if (currentDepth >= MAX_CONTENT_DEPTH) {
        log("DEBUG", `Content depth ceiling of ${MAX_CONTENT_DEPTH} reached at module ${item.Id}: not descending further`);
      }

      const courseFiles = item.Description?.Html
        ? extractCourseFilePaths(item.Description.Html, courseId, ctx.api.origin)
        : [];

      // Only include module if it has matching children (or filter is 'all')
      if (typeFilter === "all" || processedChildren.length > 0 || childrenUnavailable) {
        tree.push({
          type: "module",
          id: item.Id,
          title: item.Title,
          description: item.Description?.Text ?? null,
          ...(courseFiles.length > 0 ? { courseFiles } : {}),
          ...(item.ModuleDueDate ? { dueDate: item.ModuleDueDate } : {}),
          ...(item.IsHidden ? { isHidden: item.IsHidden } : {}),
          ...(item.IsLocked ? { isLocked: item.IsLocked } : {}),
          lastModified: item.LastModifiedDate ?? null,
          ...(childrenUnavailable ? { childrenUnavailable } : {}),
          children: childrenUnavailable ? null : processedChildren,
        });
      }
    } else if (item.Type === 1) {
      // Topic — process based on TopicType
      const topicType = TOPIC_TYPE_MAP[item.TopicType ?? 0] ?? "other";

      if (typeFilter !== "all" && !matchesTypeFilter(item, typeFilter)) {
        continue;
      }

      // A null map means progress couldn't be read: completion is unknown,
      // not false, so a failed read can't pass for "nothing completed".
      const topicProgress = progressMap?.get(item.Id);

      const topic: ContentTopic = {
        type: "topic",
        topicType,
        id: item.Id,
        title: item.Title,
        ...(item.IsHidden ? { isHidden: item.IsHidden } : {}),
        ...(item.IsLocked ? { isLocked: item.IsLocked } : {}),
        ...(item.DueDate ? { dueDate: item.DueDate } : {}),
        lastModified: item.LastModifiedDate ?? null,
        isCompleted: progressMap === null ? null : (topicProgress?.IsRead ?? false),
        ...(topicProgress?.DateCompleted ? { completedDate: topicProgress.DateCompleted } : {}),
      };

      // Add type-specific content
      if (item.TopicType === 1) {
        // File topic — include description
        topic.description = item.Description?.Text ?? null;
        topic.topicId = item.Id; // Useful for downloadFile
      } else if (item.TopicType === 2 || item.TopicType === 3) {
        // Link topic — include URL
        topic.url = item.Url ?? null;
      }

      // HTML content — include body converted to markdown
      if (item.Description?.Html) {
        topic.content = convertHtmlToMarkdown(item.Description.Html).markdown;
      }

      tree.push(topic);
    }
  }

  return tree;
}

/**
 * Filter a content tree to items modified at or after cutoff.
 *
 * A module is kept when its own timestamp matches OR any descendant matched
 * (even with zero matching children after recursion) — a matched topic with
 * no surrounding module would be a result with no context.
 */
function filterTreeByModifiedSince(tree: ContentNode[], cutoff: Date): ContentNode[] {
  const result: ContentNode[] = [];
  for (const item of tree) {
    if (item.type === "topic") {
      if (matchesModifiedSince(item.lastModified, cutoff)) {
        result.push(item);
      }
    } else if (item.childrenUnavailable) {
      // A module whose children couldn't be read stays in, children null:
      // nothing says none of them changed since the cutoff.
      result.push(item);
    } else {
      const filteredChildren = filterTreeByModifiedSince(item.children ?? [], cutoff);
      const moduleMatches = matchesModifiedSince(item.lastModified, cutoff);
      if (moduleMatches || filteredChildren.length > 0) {
        result.push({ ...item, children: filteredChildren });
      }
    }
  }
  return result;
}

function countTopics(tree: ContentNode[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === "topic") {
      count++;
    } else if (item.children) {
      count += countTopics(item.children);
    }
  }
  return count;
}

function countModules(tree: ContentNode[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === "module") {
      count++;
      if (item.children) {
        count += countModules(item.children);
      }
    }
  }
  return count;
}

/** Count modules whose children couldn't be read (for the notice). */
function countUnreadableModules(tree: ContentNode[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === "module") {
      if (item.childrenUnavailable) count++;
      if (item.children) count += countUnreadableModules(item.children);
    }
  }
  return count;
}

/** The content tree for a course: modules, topics, files, and links. */
export async function getCourseContent(ctx: FeatureContext, args: GetCourseContentArgs): Promise<CourseContentResult> {
  const { courseId, typeFilter = "all", moduleTitle, maxDepth, modifiedSince } = GetCourseContentSchema.parse(args);

  let rootModules = await ctx.api.get<ContentObject[]>(ctx.api.le(courseId, "/content/root/"), {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });

  if (moduleTitle) {
    const searchTerm = moduleTitle.toLowerCase();
    rootModules = rootModules.filter((m) => m.Title.toLowerCase().includes(searchTerm));
  }

  // Fetch user progress for the course (graceful degradation). 403/404 means
  // this course has no progress data for the user. Any other failure leaves
  // completion unknown, so the map stays null and every topic reports
  // isCompleted: null rather than false. A sign-in problem fails the call.
  let progressMap: Map<number, ContentProgress> | null = new Map();
  try {
    const progressArray = await ctx.api.get<ContentProgress[]>(ctx.api.le(courseId, "/content/userprogress/"), {
      ttl: DEFAULT_CACHE_TTLS.courseContent,
    });
    for (const p of Array.isArray(progressArray) ? progressArray : []) {
      progressMap.set(p.ContentObjectId, p);
    }
  } catch (error: any) {
    if (isAuthUnavailable(error)) throw error;
    if (error?.status !== 404 && error?.status !== 403) {
      log("INFO", `Failed to fetch progress for course ${courseId}: completion reported as unknown`, error);
      progressMap = null;
    }
  }

  let contentTree = await buildContentTree(ctx, courseId, rootModules, progressMap, typeFilter, maxDepth);

  // Apply modifiedSince filter, if requested, after the tree is built: a
  // module's own timestamp may not change when a child topic does, so
  // filtering has to see the whole tree to know which modules to keep.
  let filteredOut = 0;
  if (modifiedSince) {
    const topicCountBeforeFilter = countTopics(contentTree);
    const cutoff = new Date(modifiedSince);
    contentTree = filterTreeByModifiedSince(contentTree, cutoff);
    filteredOut = topicCountBeforeFilter - countTopics(contentTree);
  }

  const topicCount = countTopics(contentTree);
  const moduleCount = countModules(contentTree);

  const unreadable = countUnreadableModules(contentTree);

  log(
    "INFO",
    `getCourseContent: ${moduleCount} modules and ${topicCount} topics for course ${courseId} (filter: ${typeFilter})` +
      (unreadable > 0 ? `, ${unreadable} module(s) unreadable` : "") +
      (progressMap === null ? ", progress unavailable" : ""),
  );

  return {
    courseId,
    typeFilter,
    contentTree,
    topicCount,
    moduleCount,
    ...(modifiedSince ? { modifiedSince, returned: topicCount, filteredOut } : {}),
    ...(progressMap === null
      ? {
          progressUnavailable:
            "Couldn't read this user's completion progress, so every topic has isCompleted null. " +
            "Do not report topics as not completed; try again later.",
        }
      : {}),
    ...(unreadable > 0
      ? {
          notice:
            `The contents of ${unreadable} module(s) couldn't be read; they have children null and a ` +
            "childrenUnavailable reason. topicCount leaves out whatever they hold. Do not report " +
            "those modules as empty.",
        }
      : {}),
  };
}
