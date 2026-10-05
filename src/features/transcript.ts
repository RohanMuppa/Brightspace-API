/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { GetVideoTranscriptSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { BrightspaceInvalidArgumentError } from "../errors.js";
import { cuesToText, paginateText } from "../utils/transcript/captions.js";
import { detectVideoPlatform, extractKalturaIds, extractYouTubeVideoId, type VideoPlatform } from "../utils/transcript/platform.js";
import { asVideoUrl, readLtiLaunchPage, toBrightspacePath } from "../utils/transcript/lti.js";
import { stripSessionParams } from "../utils/session-params.js";
import { getKalturaTranscript } from "../utils/transcript/kaltura.js";
import { getYouTubeTranscript } from "../utils/transcript/youtube.js";
import type { TranscriptResult } from "../utils/transcript/types.js";
import { log } from "../utils/logger.js";

export type GetVideoTranscriptArgs = z.input<typeof GetVideoTranscriptSchema>;

interface ContentTopic {
  Id: number;
  Title: string;
  Url?: string | null;
}

const UNSUPPORTED_PLATFORM_LABEL: Partial<Record<VideoPlatform, string>> = {
  panopto: "Panopto",
  yuja: "YuJa",
  echo360: "Echo360",
  vimeo: "Vimeo",
};

export interface VideoTranscriptUnavailable {
  courseId?: number;
  topicId?: number;
  videoUrl?: string;
  platform?: VideoPlatform;
  hasTranscript: false;
  message: string;
}

export interface VideoTranscriptAvailable {
  courseId?: number;
  topicId?: number;
  videoUrl: string;
  platform: VideoPlatform;
  hasTranscript: true;
  title: string | null;
  durationSeconds: number | null;
  language: string | null;
  captionFormat: TranscriptResult["format"];
  cueCount: number;
  transcript: string;
  truncated: boolean;
  nextOffset: number | null;
  totalChars: number;
}

export type VideoTranscriptResult = VideoTranscriptUnavailable | VideoTranscriptAvailable;

async function resolveVideoUrl(api: D2LApiClient, courseId: number, topicId: number): Promise<{ url: string } | { error: string }> {
  const topic = await api.get<ContentTopic>(api.le(courseId, `/content/topics/${topicId}`), { ttl: DEFAULT_CACHE_TTLS.courseContent });
  if (!topic.Url) {
    return {
      error:
        `Content topic "${topic.Title}" (id ${topicId}) has no URL Brightspace can resolve to a video. ` +
        "This is common for audio or embedded objects with no direct link. Open it in Brightspace directly.",
    };
  }
  return { url: topic.Url };
}

/** The quickLink itself, plus one Brightspace page it frames (the tool launch). */
const MAX_LTI_PAGES = 2;

/** Request a Brightspace LTI link as the user and read its launch for the video it opens. */
async function followLtiLaunch(api: D2LApiClient, path: string, baseUrl: string | undefined): Promise<string | null> {
  let next = path;
  for (let page = 0; page < MAX_LTI_PAGES; page++) {
    const response = await api.getPage(next);
    if (response === null) return null;
    // Another origin's address is read, never requested with the session.
    if ("redirect" in response) return asVideoUrl(response.redirect);
    const finding = readLtiLaunchPage(response.html, baseUrl);
    if (!finding) return null;
    if ("videoUrl" in finding) return finding.videoUrl;
    next = finding.nextPath;
  }
  return null;
}

async function fetchTranscript(
  platform: VideoPlatform,
  videoUrl: string,
): Promise<{ result: TranscriptResult } | { unsupported: string } | { failed: string }> {
  switch (platform) {
    case "kaltura": {
      const ids = extractKalturaIds(videoUrl);
      if (!ids) {
        return { failed: `Could not find a Kaltura entry ID and partner ID in this URL: ${stripSessionParams(videoUrl)}` };
      }
      return { result: await getKalturaTranscript(ids.partnerId, ids.entryId, fetch) };
    }
    case "youtube": {
      const videoId = extractYouTubeVideoId(videoUrl);
      if (!videoId) {
        return { failed: `Could not find a YouTube video ID in this URL: ${stripSessionParams(videoUrl)}` };
      }
      return { result: await getYouTubeTranscript(videoId, fetch) };
    }
    case "panopto":
    case "yuja":
    case "echo360":
    case "vimeo":
      return {
        unsupported:
          `Video transcripts from ${UNSUPPORTED_PLATFORM_LABEL[platform]} are not supported yet. ` +
          "Open the video in Brightspace directly.",
      };
    default:
      return {
        unsupported: `Could not identify a supported video platform for this URL: ${stripSessionParams(videoUrl)}. Open the video in Brightspace directly.`,
      };
  }
}

/**
 * The transcript of a video embedded in course content. Pass courseId and
 * topicId (from getCourseContent) to look the video up, or videoUrl directly
 * when the link is already known. Supports Kaltura (including a Brightspace
 * LTI quickLink that launches it, read with the user's session cookie on the
 * configured Brightspace origin only) and YouTube; other
 * platforms come back as an unavailable result naming what isn't supported
 * yet. NoTranscriptError / TranscriptFetchError from the adapters propagate
 * untouched — the client boundary maps them.
 */
export async function getVideoTranscript(ctx: FeatureContext, args: GetVideoTranscriptArgs): Promise<VideoTranscriptResult> {
  const { courseId, topicId, videoUrl, offset, maxChars } = GetVideoTranscriptSchema.parse(args);

  let resolvedUrl: string;
  if (videoUrl) {
    resolvedUrl = videoUrl;
  } else if (courseId !== undefined && topicId !== undefined) {
    const resolved = await resolveVideoUrl(ctx.api, courseId, topicId);
    if ("error" in resolved) {
      return { courseId, topicId, hasTranscript: false, message: resolved.error };
    }
    resolvedUrl = resolved.url;
  } else {
    throw new BrightspaceInvalidArgumentError([
      "Provide either videoUrl, or both courseId and topicId to look up the video from course content.",
    ]);
  }

  const brightspacePath = toBrightspacePath(resolvedUrl, ctx.config.baseUrl);
  if (brightspacePath !== null) {
    const launchedUrl = await followLtiLaunch(ctx.api, brightspacePath, ctx.config.baseUrl);
    if (!launchedUrl) {
      const publicPath = stripSessionParams(brightspacePath);
      return {
        courseId,
        topicId,
        videoUrl: publicPath,
        platform: "unknown",
        hasTranscript: false,
        message:
          `This is a Brightspace LTI link (${publicPath}), and its launch did not reveal which video it opens. ` +
          "Some tools only hand over the video after a browser sign-in to the tool itself, which this library " +
          "can't do. The video platform itself may still be supported. Open it in Brightspace directly.",
      };
    }
    resolvedUrl = launchedUrl;
  }

  const platform = detectVideoPlatform(resolvedUrl);
  const outcome = await fetchTranscript(platform, resolvedUrl);
  const publicUrl = stripSessionParams(resolvedUrl);

  if ("unsupported" in outcome) {
    return { courseId, topicId, videoUrl: publicUrl, platform, hasTranscript: false, message: outcome.unsupported };
  }
  if ("failed" in outcome) {
    throw new BrightspaceInvalidArgumentError([outcome.failed]);
  }

  const { result } = outcome;
  const fullText = cuesToText(result.cues);
  const { window, truncated, nextOffset, totalChars } = paginateText(fullText, offset, maxChars);

  log("INFO", `getVideoTranscript: ${platform} transcript for ${publicUrl} (${result.cues.length} cues, ${totalChars} chars)`);

  return {
    courseId,
    topicId,
    videoUrl: publicUrl,
    platform,
    hasTranscript: true,
    title: result.title,
    durationSeconds: result.durationSeconds,
    language: result.language,
    captionFormat: result.format,
    cueCount: result.cues.length,
    transcript: window,
    truncated,
    nextOffset,
    totalChars,
  };
}
