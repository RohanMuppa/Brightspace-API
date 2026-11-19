import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSyllabus } from "../../src/features/syllabus.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ApiError } from "../../src/api/index.js";
import { NetworkError, TokenRefreshError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";
import {
  BrightspaceApiError,
  BrightspaceForbiddenError,
  BrightspaceInvalidArgumentError,
  BrightspaceNetworkError,
  BrightspaceNotFoundError,
} from "../../src/errors.js";
import { oversizeBody, CHUNKS_AT_CAP } from "./oversize-body.js";

/**
 * The syllabus feature exposes the course overview as markdown and, when the
 * overview carries a PDF attachment, the text extracted from it. With
 * downloadPath it also saves that attachment to disk — the overview
 * attachment lives at /overview/attachment, a path downloadFile has no way
 * to address, so this is the only place that can save it.
 */

const COURSE_ID = 101;

/** The smallest one-page PDF that really renders the given text. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

function headersFrom(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

/** A route's answer: a value to return, or an error to throw. */
type Route = unknown | (() => never);

const answer = (route: Route): unknown => (typeof route === "function" ? (route as () => never)() : route);

function setup({
  overview,
  attachment,
  ltiLinks = [],
  ltiAdvantageLinks = { Objects: [], Next: null },
  toc = { Modules: [] },
}: {
  overview: Route;
  attachment?: { headers?: Record<string, string>; body: Buffer | ReadableStream<Uint8Array> } | (() => never);
  /** LTI 1.1 links (/lti/link/{ou}/); an empty list by default. */
  ltiLinks?: Route;
  /** LTI Advantage (1.3) links (/ltiadvantage/links/orgunit/{ou}/); an empty page by default. */
  ltiAdvantageLinks?: Route;
  /** The content table of contents; no modules by default. */
  toc?: Route;
}) {
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    leGlobal: (p: string) => `/d2l/api/le/1.0${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith(`/${COURSE_ID}/overview`)) return answer(overview);
      if (p.endsWith(`/lti/link/${COURSE_ID}/`)) return answer(ltiLinks);
      if (p.endsWith(`/ltiadvantage/links/orgunit/${COURSE_ID}/`)) return answer(ltiAdvantageLinks);
      if (p.endsWith("/content/toc")) return answer(toc);
      throw new ApiError(404, p, "Not Found");
    }),
    getRaw: vi.fn(async () => {
      if (!attachment) throw new ApiError(404, "/overview/attachment", "File not found");
      if (typeof attachment === "function") return (attachment as () => never)();
      const body = attachment.body instanceof ReadableStream ? attachment.body : new Uint8Array(attachment.body);
      return new Response(body, { status: 200, headers: headersFrom(attachment.headers ?? {}) });
    }),
  };
  const ctx = { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx };
}

describe("getSyllabus", () => {
  it("converts the overview description to markdown", async () => {
    const { ctx } = setup({ overview: { Description: { Text: "plain", Html: "<p>Office hours are <strong>Tuesdays</strong>.</p>" } } });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.courseId).toBe(COURSE_ID);
    expect(result.description).toContain("Office hours");
    expect(result.description).toContain("**Tuesdays**");
  });

  it("reports a null description when there is no overview at all (404)", async () => {
    const { ctx } = setup({
      overview: () => {
        throw new ApiError(404, "/overview", "not found");
      },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result).toMatchObject({ courseId: COURSE_ID, description: null, hasAttachment: false });
    // Nothing was found, but the course navbar can't be checked, so this is not "no syllabus" (brightspace-mcp-server#449).
    expect(result.message).not.toBe("No syllabus/overview found for this course.");
    expect(result.message).toMatch(/navbar/);
    expect(result.externalSyllabusDiscovery?.notChecked).toEqual(["course-navbar"]);
  });

  it("reports hasAttachment:false when the overview has no Description and no attachment", async () => {
    const { ctx } = setup({ overview: { Description: null } });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.description).toBeNull();
    expect(result.hasAttachment).toBe(false);
  });

  it("extracts text and page count from a PDF attachment", async () => {
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Disposition": 'attachment; filename="syllabus.pdf"' }, body: minimalPdf("Grading is 40 percent exams") },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.syllabusText).toContain("Grading is 40 percent exams");
    expect(result.totalPages).toBe(1);
    expect(result).not.toHaveProperty("hasAttachment");
  });

  it("reports hasAttachment:true without syllabusText for a non-PDF attachment", async () => {
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Disposition": 'attachment; filename="syllabus.docx"' }, body: Buffer.from("not a pdf") },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.hasAttachment).toBe(true);
    expect(result.syllabusText).toBeUndefined();
  });

  it("reports hasAttachment:false when the attachment fetch itself 404s", async () => {
    const { ctx } = setup({ overview: { Description: null } });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.hasAttachment).toBe(false);
    expect(result).not.toHaveProperty("attachmentUnreadable");
    expect(result).not.toHaveProperty("notice");
  });

  it.each([
    ["a 403", () => new ApiError(403, "/overview/attachment", "Forbidden")],
    ["a 500", () => new ApiError(500, "/overview/attachment", "Internal Server Error")],
    ["a network failure", () => new NetworkError("fetch failed")],
    ["a timeout", () => new NetworkError("Request timed out")],
  ])("says the attachment could not be read, not that there is none, on %s", async (_label, makeError) => {
    const { ctx } = setup({
      overview: { Description: { Text: "plain", Html: "<p>Welcome</p>" } },
      attachment: () => {
        throw makeError();
      },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.description).toContain("Welcome");
    expect(result.hasAttachment).toBe(false);
    expect(result.attachmentUnreadable).toBe(true);
    expect(result.notice).toMatch(/could not be read from Brightspace/);
    expect(result.notice).toMatch(/may still have a syllabus file/);
    expect(result.notice).toMatch(/Do not report the course as having no syllabus attachment/);
  });

  it("leaves attachmentUnreadable and notice off when the attachment was read", async () => {
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Disposition": 'attachment; filename="syllabus.docx"' }, body: Buffer.from("not a pdf") },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result).not.toHaveProperty("attachmentUnreadable");
    expect(result).not.toHaveProperty("notice");
  });

  it.each([
    ["a pending MFA sign-in", () => new AuthProcessError("mfaPending", "MFA approval pending")],
    ["a token that could not be renewed", () => new TokenRefreshError("HTTP 503")],
    ["an unrecovered 401", () => new ApiError(401, "/overview/attachment", "Session expired")],
  ])("throws on %s instead of reporting an unreadable attachment", async (_label, makeError) => {
    const error = makeError();
    const { ctx } = setup({
      overview: { Description: null },
      attachment: () => {
        throw error;
      },
    });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID })).rejects.toBe(error);
  });
});

describe("getSyllabus downloadPath", () => {
  let root: string;
  let targetDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "syllabus-"));
    targetDir = path.join(root, "a", "b");
    await fs.mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Everything that landed anywhere under root, relative to root. */
  async function walk(dir: string, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
      else out.push(rel);
    }
    return out;
  }

  it("saves the attachment and reports the saved path, size, and mime type", async () => {
    const pdf = minimalPdf("Grading is 40 percent exams");
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Disposition": 'attachment; filename="syllabus.pdf"' }, body: pdf },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir });

    expect(result.download).toEqual({
      success: true,
      filePath: path.join(targetDir, "syllabus.pdf"),
      fileSize: pdf.length,
      mimeType: "application/pdf",
    });
    expect(await fs.readFile(path.join(targetDir, "syllabus.pdf"))).toEqual(pdf);
  });

  it("decodes an RFC 5987 filename* attachment name when saving", async () => {
    const pdf = minimalPdf("Grading is 40 percent exams");
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Disposition": "attachment; filename*=UTF-8''Course%20Syllabus.pdf" }, body: pdf },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir });

    expect(result.download?.filePath).toBe(path.join(targetDir, "Course Syllabus.pdf"));
    expect(await fs.readFile(path.join(targetDir, "Course Syllabus.pdf"))).toEqual(pdf);
  });

  it("does not write outside the download directory for a path-traversal Content-Disposition filename", async () => {
    const pdf = minimalPdf("irrelevant");
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Disposition": 'attachment; filename="../../pwned.pdf"' }, body: pdf },
    });

    try {
      await getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir });
    } catch {
      // Refusing outright is as acceptable as sanitizing the name; either way
      // nothing may land outside targetDir.
    }

    const written = await walk(root);
    expect(written).not.toContain("pwned.pdf");
    expect(written).not.toContain("a/pwned.pdf");
    for (const file of written) {
      expect(file.startsWith("a/b/")).toBe(true);
    }
  });

  it("throws BrightspaceInvalidArgumentError, and saves nothing, when the attachment is too large", async () => {
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { "Content-Length": String(60 * 1024 * 1024) }, body: Buffer.alloc(0) },
    });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toBeInstanceOf(BrightspaceInvalidArgumentError);
    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toMatchObject({
      message: expect.stringMatching(/Attachment too large/),
    });
    expect(await walk(root)).toEqual([]);
  });

  it.each([
    ["no Content-Length", {}],
    ["Content-Length: 1", { "Content-Length": "1" }],
  ])("stops reading an attachment body past 50 MB with %s", async (_label, headers) => {
    const { stream, state } = oversizeBody();
    const { ctx } = setup({
      overview: { Description: null },
      attachment: { headers: { ...headers, "Content-Disposition": 'attachment; filename="syllabus.pdf"' }, body: stream },
    });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toMatchObject({
      message: expect.stringMatching(/Attachment too large/),
    });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(CHUNKS_AT_CAP + 2);
    expect(state.pulled).toBeLessThan(state.totalChunks);
    expect(await walk(root)).toEqual([]);
  });

  it("notes an oversize attachment body instead of failing when only reading", async () => {
    const { stream, state } = oversizeBody();
    const { ctx } = setup({ overview: { Description: null }, attachment: { body: stream } });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.note).toMatch(/Attachment too large/);
    expect(result.syllabusText).toBeUndefined();
    expect(state.cancelled).toBe(true);
  });

  it("validates the download directory before ever fetching anything", async () => {
    const { ctx } = setup({ overview: { Description: null } });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: "relative/path" })).rejects.toBeInstanceOf(
      BrightspaceInvalidArgumentError,
    );
    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: path.join(root, "does-not-exist") })).rejects.toBeInstanceOf(
      BrightspaceInvalidArgumentError,
    );
  });

  it("throws BrightspaceNotFoundError when downloadPath is given but there is no attachment", async () => {
    const { ctx } = setup({ overview: { Description: null } });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toBeInstanceOf(BrightspaceNotFoundError);
    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toMatchObject({
      message: "No attachment found for this course's syllabus.",
    });
  });

  it.each([
    ["a 403", () => new ApiError(403, "/overview/attachment", "Forbidden"), BrightspaceForbiddenError, "BRIGHTSPACE_FORBIDDEN"],
    ["a 500", () => new ApiError(500, "/overview/attachment", "Internal Server Error"), BrightspaceApiError, "BRIGHTSPACE_API_ERROR"],
    ["a network failure", () => new NetworkError("fetch failed"), BrightspaceNetworkError, "BRIGHTSPACE_NETWORK"],
  ])("says the attachment could not be read, not that there is none, when downloading on %s", async (_label, makeError, errorClass, code) => {
    const { ctx } = setup({
      overview: { Description: null },
      attachment: () => {
        throw makeError();
      },
    });

    const failure = await getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(errorClass);
    expect(failure).not.toBeInstanceOf(BrightspaceNotFoundError);
    expect(failure).toMatchObject({ code, message: expect.stringMatching(/could not be read from Brightspace, so nothing was saved/) });
    expect((failure as Error).message).not.toMatch(/No attachment found/);
    expect(await walk(root)).toEqual([]);
  });

  it("keeps the HTTP status on the download error for a 5xx", async () => {
    const { ctx } = setup({
      overview: { Description: null },
      attachment: () => {
        throw new ApiError(503, "/overview/attachment", "Service Unavailable");
      },
    });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toMatchObject({ status: 503 });
  });

  it("lets a sign-in problem through when downloading", async () => {
    const error = new AuthProcessError("mfaPending", "MFA approval pending");
    const { ctx } = setup({
      overview: { Description: null },
      attachment: () => {
        throw error;
      },
    });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID, downloadPath: targetDir })).rejects.toBe(error);
  });
});

describe("getSyllabus external LTI syllabus sources", () => {
  const EMPTY_OVERVIEW = { Description: null };
  const tocWith = (topics: unknown[]) => ({ Modules: [{ ModuleId: 1, Title: "Start Here", Modules: [], Topics: topics }] });

  it("lists a visible syllabus LTI 1.1 link without its query string", async () => {
    const { ctx } = setup({
      overview: EMPTY_OVERVIEW,
      ltiLinks: [
        { LtiLinkId: 7, Title: "Simple Syllabus", Url: "https://s.example/lti?oauth_token=secret", IsVisible: true },
        { LtiLinkId: 8, Title: "Hidden Syllabus", Url: "https://h.example/lti", IsVisible: false },
        { LtiLinkId: 9, Title: "Zoom", Url: "https://zoom.example/lti", IsVisible: true },
      ],
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.externalSyllabusSources).toEqual([{ title: "Simple Syllabus", location: "lti-link", url: "https://s.example/lti" }]);
    expect(result.externalSyllabusNote).toMatch(/LTI tools cannot be launched/);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports an enabled syllabus LTI Advantage link, such as a navbar Simple Syllabus (brightspace-mcp-server#449)", async () => {
    const { ctx } = setup({
      overview: EMPTY_OVERVIEW,
      ltiAdvantageLinks: {
        Objects: [
          {
            LinkId: 9,
            IsEnabled: true,
            IsAvailable: true,
            Name: "Simple Syllabus",
            URL: "https://purdue.simplesyllabus.com/api2/lti13?ctx=abc",
            CustomParameters: [{ Name: "secret", Value: "do-not-echo" }],
          },
        ],
        Next: null,
      },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.externalSyllabusSources).toEqual([
      { title: "Simple Syllabus", location: "lti-link", url: "https://purdue.simplesyllabus.com/api2/lti13" },
    ]);
    expect(result.externalSyllabusDiscovery).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
  });

  it("skips LTI Advantage links that are disabled or unavailable", async () => {
    const { ctx } = setup({
      overview: EMPTY_OVERVIEW,
      ltiAdvantageLinks: {
        Objects: [
          { LinkId: 9, IsEnabled: false, IsAvailable: true, Name: "Syllabus", URL: "https://a.example/lti13" },
          { LinkId: 10, IsEnabled: true, IsAvailable: false, Name: "Syllabus", URL: "https://b.example/lti13" },
        ],
        Next: null,
      },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.externalSyllabusSources).toBeUndefined();
  });

  it("lists a syllabus LTI launch in the course content, keeping routing params but not the session", async () => {
    const { ctx } = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([
        { Title: "Course Syllabus", Url: "/d2l/le/lti/101/toolLaunch/5?ou=101&d2lSessionVal=abc123" },
        { Title: "Syllabus.pdf", Url: "/content/enforced/101/Syllabus.pdf" },
      ]),
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.externalSyllabusSources).toEqual([
      { title: "Course Syllabus", location: "content", url: "/d2l/le/lti/101/toolLaunch/5?ou=101" },
    ]);
  });

  it("reports a forbidden or failed lookup as unavailable, not as nothing found", async () => {
    const { ctx } = setup({
      overview: EMPTY_OVERVIEW,
      ltiLinks: () => {
        throw new ApiError(403, "/lti/link/101/", "Forbidden");
      },
      ltiAdvantageLinks: () => {
        throw new ApiError(500, "/ltiadvantage/links/orgunit/101/", "Server Error");
      },
      toc: () => {
        throw new NetworkError("fetch failed");
      },
    });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.externalSyllabusDiscovery?.complete).toBe(false);
    expect(result.externalSyllabusDiscovery?.unavailable).toEqual([
      { lookup: "lti-links", reason: "permission-denied", status: 403 },
      { lookup: "content-toc", reason: "request-failed" },
      { lookup: "lti-advantage-links", reason: "request-failed", status: 500 },
    ]);
    expect(result.externalSyllabusDiscovery?.note).toMatch(/LTI Advantage links: request failed \(HTTP 500\)/);
    expect(result.externalSyllabusDiscovery?.note).toMatch(/does not mean the course has no syllabus/);
  });

  it("says the course navbar was not checked when every lookup succeeds with nothing found (brightspace-mcp-server#449)", async () => {
    const { ctx } = setup({ overview: { Description: { Text: "Hi", Html: "<p>Hi</p>" } } });

    const result = await getSyllabus(ctx, { courseId: COURSE_ID });
    expect(result.description).toContain("Hi");
    expect(result.externalSyllabusSources).toBeUndefined();
    expect(result.externalSyllabusDiscovery).toMatchObject({ complete: false, unavailable: [], notChecked: ["course-navbar"] });
    expect(result.externalSyllabusDiscovery?.note).toMatch(/navbar/);
  });

  it("lets a sign-in problem on a discovery lookup fail the call", async () => {
    const signIn = new AuthProcessError("failed", "Sign-in failed");
    const { ctx } = setup({
      overview: EMPTY_OVERVIEW,
      ltiAdvantageLinks: () => {
        throw signIn;
      },
    });

    await expect(getSyllabus(ctx, { courseId: COURSE_ID })).rejects.toBe(signIn);
  });
});
