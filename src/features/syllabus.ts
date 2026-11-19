/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { isAuthUnavailable } from "../api/errors.js";
import { fetchAllObjects } from "../api/paginate.js";
import { GetSyllabusSchema } from "./schemas.js";
import type { FeatureContext } from "./context.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { secureDownload, readBodyCapped } from "../utils/download-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import {
  BrightspaceApiError,
  BrightspaceForbiddenError,
  BrightspaceInvalidArgumentError,
  BrightspaceNetworkError,
  BrightspaceNotFoundError,
  type BrightspaceError,
} from "../errors.js";
import { log } from "../utils/logger.js";
import { stripSessionParams } from "../utils/session-params.js";
import { parseContentDispositionFilename } from "./download.js";

export type GetSyllabusArgs = z.input<typeof GetSyllabusSchema>;

// D2L Overview API response shape
interface CourseOverview {
  Description: { Text: string; Html: string } | null;
}

// D2L content table of contents (/content/toc), trimmed to what is read
interface TocModule {
  Modules?: TocModule[];
  Topics?: { Title: string; Url?: string | null }[];
}

// D2L LtiLinkData (LTI 1.1), trimmed to what is read (Key/PlainSecret are never touched)
interface LtiLink {
  Title: string;
  Url: string;
  IsVisible: boolean;
}

// D2L LTIAdvantageLinkData (LTI 1.3), trimmed to what is read (CustomParameters are never touched)
interface LtiAdvantageLink {
  Name: string;
  URL: string;
  IsEnabled: boolean;
  IsAvailable: boolean;
}

/** A syllabus tool (e.g. Simple Syllabus) the course links through LTI. Its contents cannot be read. */
export interface ExternalSyllabusSource {
  title: string;
  /** `lti-link`: one of the course's LTI 1.1 or LTI Advantage (1.3) links; `content`: an LTI launch in the course content. */
  location: "lti-link" | "content";
  /** Launch URL without its query string (LTI links) or without session parameters (content). */
  url: string;
}

export type SyllabusDiscoveryLookup = "lti-links" | "lti-advantage-links" | "content-toc";

/** A place an external syllabus may be linked that could not be read. */
export interface UnavailableSyllabusLookup {
  lookup: SyllabusDiscoveryLookup;
  reason: "permission-denied" | "request-failed";
  /** HTTP status when the server answered; absent for transport failures. */
  status?: number;
}

/**
 * Present when external syllabus discovery is not proof the course has no
 * external syllabus: a lookup failed (`unavailable`), or nothing was found and
 * a place no API exposes was never checked (`notChecked`).
 */
export interface ExternalSyllabusDiscovery {
  complete: false;
  unavailable: UnavailableSyllabusLookup[];
  /** Places that cannot be checked at all; set only when no source was found. */
  notChecked?: "course-navbar"[];
  note: string;
}

export interface SyllabusDownload {
  success: true;
  filePath: string;
  fileSize: number;
  mimeType: string;
}

export interface SyllabusResult {
  courseId: number;
  description: string | null;
  hasAttachment?: boolean;
  /**
   * Set when the attachment request failed with anything but a 404 (a 403, a
   * 5xx, a timeout, a network error): an attachment may exist but could not
   * be read, so `hasAttachment: false` is then not proof the course has no
   * syllabus file. Absent when the attachment was read or is known missing.
   */
  attachmentUnreadable?: true;
  /** Set with `attachmentUnreadable`: says an attachment may exist and must not be reported as missing. */
  notice?: string;
  syllabusText?: string;
  totalPages?: number;
  message?: string;
  note?: string;
  download?: SyllabusDownload;
  /** Syllabus tools the course links through LTI (e.g. Simple Syllabus); absent when none were found. */
  externalSyllabusSources?: ExternalSyllabusSource[];
  /** Set with `externalSyllabusSources`: their contents cannot be read here. */
  externalSyllabusNote?: string;
  /** Set when discovery was incomplete, so missing sources do not mean the course has no syllabus. */
  externalSyllabusDiscovery?: ExternalSyllabusDiscovery;
}

const SYLLABUS_PATTERN = /syllab/i;
const LTI_LAUNCH_PATTERN = /[?&]type=lti\b|\/d2l\/le\/lti\//i;

const EXTERNAL_SYLLABUS_NOTE =
  "This course links its syllabus through an external LTI tool. These sources are listed but LTI tools cannot be " +
  "launched here, so their contents are not included; open the link in Brightspace to read it.";

/** Launch URL without its query string, which can carry launch parameters. */
function stripQuery(url: string): string {
  return url.split(/[?#]/)[0];
}

/**
 * Pick the syllabus-related LTI sources out of the course's LTI links and
 * content tree. Pure: the caller fetches, this only decides.
 */
function findExternalSyllabusSources(
  ltiLinks: LtiLink[],
  advantageLinks: LtiAdvantageLink[],
  toc: TocModule[]
): ExternalSyllabusSource[] {
  const sources: ExternalSyllabusSource[] = [
    ...ltiLinks.filter((l) => l?.IsVisible !== false).map((l) => ({ title: l?.Title, url: l?.Url })),
    ...advantageLinks
      .filter((l) => l?.IsEnabled !== false && l?.IsAvailable !== false)
      .map((l) => ({ title: l?.Name, url: l?.URL })),
  ]
    .filter((l) => typeof l.url === "string" && (SYLLABUS_PATTERN.test(l.title ?? "") || SYLLABUS_PATTERN.test(l.url)))
    .map((l) => ({ title: l.title ?? "", location: "lti-link", url: stripQuery(l.url) }));

  const walk = (modules: TocModule[]): void => {
    for (const m of modules) {
      for (const t of m.Topics ?? []) {
        if (t.Url && LTI_LAUNCH_PATTERN.test(t.Url) && SYLLABUS_PATTERN.test(t.Title ?? "")) {
          // Keep routing params (ou, type, rcode) so the link still opens the
          // right tool, but never echo D2L session tokens.
          sources.push({ title: t.Title, location: "content", url: stripSessionParams(t.Url) });
        }
      }
      walk(m.Modules ?? []);
    }
  };
  walk(toc);
  return sources;
}

const LOOKUP_LABELS: Record<SyllabusDiscoveryLookup, string> = {
  "lti-links": "course LTI links",
  "lti-advantage-links": "course LTI Advantage links",
  "content-toc": "course content table of contents",
};

type LookupOutcome<T> = { ok: true; value: T } | { ok: false; unavailable: UnavailableSyllabusLookup };

/**
 * Run a lookup that students may not be permitted to make. A failure is
 * reported as unavailable rather than folded into "nothing found". Only the
 * HTTP status is kept; raw error bodies never reach the result.
 */
async function tryLookup<T>(lookup: SyllabusDiscoveryLookup, fetch: () => Promise<T>): Promise<LookupOutcome<T>> {
  try {
    return { ok: true, value: await fetch() };
  } catch (error) {
    // A pending or refused sign-in is not a permission the student lacks:
    // the lookup never ran, so the call fails with the sign-in's error.
    if (isAuthUnavailable(error)) throw error;
    log("DEBUG", `getSyllabus: could not read ${LOOKUP_LABELS[lookup]}`, error);
    if (error instanceof ApiError) {
      const reason = error.status === 403 ? "permission-denied" : "request-failed";
      return { ok: false, unavailable: { lookup, reason, status: error.status } };
    }
    return { ok: false, unavailable: { lookup, reason: "request-failed" } };
  }
}

function describeUnavailable(u: UnavailableSyllabusLookup): string {
  const why =
    u.reason === "permission-denied"
      ? "permission denied"
      : u.status !== undefined
        ? `request failed (HTTP ${u.status})`
        : "request failed (network error)";
  return `${LOOKUP_LABELS[u.lookup]}: ${why}`;
}

const NOT_CHECKED_NOTE =
  "The course navbar was not checked: Brightspace has no API for reading its links, so a syllabus tool linked " +
  "only there (e.g. Simple Syllabus) does not appear here.";

type ExternalSyllabusFields = Pick<
  SyllabusResult,
  "externalSyllabusSources" | "externalSyllabusNote" | "externalSyllabusDiscovery"
>;

/**
 * Look for a syllabus the course links through an LTI tool. Never presents an
 * empty search as complete: a failed lookup is named in `unavailable`, and
 * when nothing is found the course navbar, which no API exposes, is named in
 * `notChecked`.
 */
async function discoverExternalSyllabusSources(ctx: FeatureContext, courseId: number): Promise<ExternalSyllabusFields> {
  const ttl = DEFAULT_CACHE_TTLS.courseContent;
  const [lti, toc, advantage] = await Promise.all([
    tryLookup("lti-links", () => ctx.api.get<LtiLink[]>(ctx.api.leGlobal(`/lti/link/${courseId}/`), { ttl })),
    tryLookup("content-toc", () => ctx.api.get<{ Modules?: TocModule[] }>(ctx.api.le(courseId, "/content/toc"), { ttl })),
    tryLookup("lti-advantage-links", () =>
      fetchAllObjects<LtiAdvantageLink>(ctx.api, ctx.api.leGlobal(`/ltiadvantage/links/orgunit/${courseId}/`), { ttl })
    ),
  ]);
  const ltiLinks = lti.ok && Array.isArray(lti.value) ? lti.value : [];
  const modules = toc.ok && Array.isArray(toc.value?.Modules) ? toc.value.Modules : [];
  const advantageLinks = advantage.ok ? advantage.value : [];
  const sources = findExternalSyllabusSources(ltiLinks, advantageLinks, modules);
  const unavailable = [lti, toc, advantage].flatMap((o) => (o.ok ? [] : [o.unavailable]));
  // With a source in hand the unread navbar no longer hides the syllabus; with
  // none, it might, so an empty result is never presented as complete.
  const notChecked: "course-navbar"[] = sources.length === 0 ? ["course-navbar"] : [];

  const fields: ExternalSyllabusFields = {};
  if (sources.length > 0) {
    fields.externalSyllabusSources = sources;
    fields.externalSyllabusNote = EXTERNAL_SYLLABUS_NOTE;
  }
  if (unavailable.length > 0 || notChecked.length > 0) {
    const failed =
      unavailable.length > 0
        ? `Could not check every place an external syllabus may be linked (${unavailable.map(describeUnavailable).join("; ")}). `
        : "";
    fields.externalSyllabusDiscovery = {
      complete: false,
      unavailable,
      ...(notChecked.length > 0 ? { notChecked } : {}),
      note:
        failed +
        (notChecked.length > 0 ? `${NOT_CHECKED_NOTE} ` : "") +
        "Missing external sources here does not mean the course has no syllabus.",
    };
  }
  return fields;
}

/**
 * The same directory checks the seed tool ran before touching the network:
 * an absolute path that already exists as a directory. Business conditions,
 * so they throw BrightspaceInvalidArgumentError rather than propagate the
 * raw fs error.
 */
async function validateDownloadDirectory(downloadPath: string): Promise<void> {
  if (!path.isAbsolute(downloadPath)) {
    throw new BrightspaceInvalidArgumentError([
      "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)",
    ]);
  }
  try {
    const stats = await fs.stat(downloadPath);
    if (!stats.isDirectory()) {
      throw new BrightspaceInvalidArgumentError([`Download path is not a directory: ${downloadPath}`]);
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new BrightspaceInvalidArgumentError([`Download directory does not exist: ${downloadPath}`]);
    }
    throw error;
  }
}

const ATTACHMENT_UNREADABLE_NOTICE =
  "The syllabus attachment could not be read from Brightspace, so this course may still have a syllabus " +
  "file. Do not report the course as having no syllabus attachment: retry getSyllabus, or check the " +
  "course overview in Brightspace.";

const ATTACHMENT_UNREADABLE_DOWNLOAD =
  "The syllabus attachment could not be read from Brightspace, so nothing was saved. " +
  "Try again, or download it from the course overview in Brightspace.";

/**
 * The error a download throws when the attachment request failed (anything
 * but a 404). Keeps the public code the failure itself would have had —
 * forbidden, an HTTP status, or a network problem — but never says "not
 * found", since an attachment may well exist.
 */
function attachmentUnreadableError(cause: unknown): BrightspaceError {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return new BrightspaceForbiddenError(ATTACHMENT_UNREADABLE_DOWNLOAD);
    return new BrightspaceApiError(cause.status, ATTACHMENT_UNREADABLE_DOWNLOAD);
  }
  return new BrightspaceNetworkError(ATTACHMENT_UNREADABLE_DOWNLOAD, { cause });
}

/**
 * The syllabus/overview text and, when a PDF attachment exists, its
 * extracted text. With downloadPath, also saves the overview attachment to
 * disk — the attachment lives at /overview/attachment, not on a content
 * topic or a dropbox folder, so downloadFile has no way to reach it.
 */
export async function getSyllabus(ctx: FeatureContext, args: GetSyllabusArgs): Promise<SyllabusResult> {
  const { courseId, downloadPath } = GetSyllabusSchema.parse(args);

  if (downloadPath !== undefined) {
    await validateDownloadDirectory(downloadPath);
  }

  let overview: CourseOverview | null = null;
  try {
    overview = await ctx.api.get<CourseOverview>(ctx.api.le(courseId, "/overview"), {
      ttl: DEFAULT_CACHE_TTLS.courseContent,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const external = await discoverExternalSyllabusSources(ctx, courseId);
      return {
        courseId,
        description: null,
        hasAttachment: false,
        message: external.externalSyllabusDiscovery
          ? "No course overview found, but external syllabus discovery was incomplete (the course navbar, for one, " +
            "cannot be checked), so the course may still have a syllabus elsewhere."
          : "No course overview found; the course links its syllabus through an external tool (see externalSyllabusSources).",
        ...external,
      };
    }
    throw error;
  }

  const description = overview?.Description?.Html ? convertHtmlToMarkdown(overview.Description.Html).markdown : null;

  // Always attempt to fetch the attachment so its PDF text can be extracted
  // (and so it is on hand to save, when downloadPath is given).
  let attachmentBuffer: Buffer | null = null;
  let attachmentFilename = "syllabus";
  let hasAttachment = false;
  let tooLargeMessage: string | undefined;
  // The failure, when the attachment request failed for any reason but a
  // 404, so a failed read is never reported as "this course has no attachment".
  let unreadableCause: unknown;
  let attachmentUnreadable = false;

  try {
    const response = await ctx.api.getRaw(ctx.api.le(courseId, "/overview/attachment"));

    if (response.ok) {
      hasAttachment = true;

      // Check Content-Length before downloading the body.
      const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
      if (contentLength > MAX_FILE_SIZE) {
        tooLargeMessage = `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
      } else {
        // Get filename from Content-Disposition header.
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const parsed = parseContentDispositionFilename(disposition);
        if (parsed) attachmentFilename = parsed;

        // Capped read: Content-Length can be missing or understated.
        try {
          attachmentBuffer = await readBodyCapped(response, MAX_FILE_SIZE);
        } catch (error) {
          if (!(error instanceof DownloadError && error.kind === "tooLarge")) throw error;
          tooLargeMessage = `Attachment too large (over ${MAX_FILE_SIZE / 1024 / 1024}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
        }
      }
    }
  } catch (error) {
    // A pending or expired sign-in fails the call; it must not read as an
    // unreadable (or missing) attachment.
    if (isAuthUnavailable(error)) throw error;
    if (error instanceof ApiError && error.status === 404) {
      hasAttachment = false;
    } else {
      attachmentUnreadable = true;
      unreadableCause = error;
      log("INFO", `getSyllabus: syllabus attachment for course ${courseId} could not be read`, error);
    }
  }

  // A caller asking to save the file needs to know nothing was written;
  // a caller only reading text is fine with a note instead of a hard stop.
  let note: string | undefined;
  if (tooLargeMessage) {
    if (downloadPath !== undefined) {
      throw new BrightspaceInvalidArgumentError([tooLargeMessage]);
    }
    note = tooLargeMessage;
  }

  // Extract text from PDF attachment if available.
  let syllabusText: string | null = null;
  let totalPages: number | undefined;
  if (attachmentBuffer && attachmentFilename.toLowerCase().endsWith(".pdf")) {
    const extracted = await extractPdfText(attachmentBuffer);
    if (extracted) {
      syllabusText = extracted.text;
      totalPages = extracted.totalPages;
    }
  }

  log("INFO", `getSyllabus: retrieved overview for course ${courseId}`);

  const result: SyllabusResult = { courseId, description };
  if (syllabusText) {
    result.syllabusText = syllabusText;
    if (totalPages) result.totalPages = totalPages;
  } else {
    result.hasAttachment = hasAttachment;
  }
  if (note) result.note = note;
  if (attachmentUnreadable) {
    result.attachmentUnreadable = true;
    result.notice = ATTACHMENT_UNREADABLE_NOTICE;
  }
  Object.assign(result, await discoverExternalSyllabusSources(ctx, courseId));

  if (downloadPath !== undefined) {
    if (!attachmentBuffer) {
      if (attachmentUnreadable) throw attachmentUnreadableError(unreadableCause);
      throw new BrightspaceNotFoundError("No attachment found for this course's syllabus.");
    }
    // A DownloadError (bad filename, path traversal, unsupported or
    // undetectable type) propagates untouched, same as any other business
    // condition the download helpers themselves throw.
    const saved = await secureDownload({
      targetDir: downloadPath,
      filename: attachmentFilename,
      data: attachmentBuffer,
    });
    log("INFO", `Syllabus attachment downloaded: ${saved.path} (${saved.size} bytes)`);
    result.download = {
      success: true,
      filePath: saved.path,
      fileSize: saved.size,
      mimeType: saved.mime,
    };
  }

  return result;
}
