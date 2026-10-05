import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSyllabus } from "../../src/features/syllabus.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ApiError } from "../../src/api/index.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../../src/errors.js";
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

function setup({
  overview,
  attachment,
}: {
  overview: unknown | (() => never);
  attachment?: { headers?: Record<string, string>; body: Buffer | ReadableStream<Uint8Array> } | (() => never);
}) {
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async () => {
      if (typeof overview === "function") return (overview as () => never)();
      return overview;
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
    expect(result).toEqual({
      courseId: COURSE_ID,
      description: null,
      hasAttachment: false,
      message: "No syllabus/overview found for this course.",
    });
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
  });
});
