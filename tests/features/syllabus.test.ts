import { describe, it, expect, vi } from "vitest";
import { getSyllabus } from "../../src/features/syllabus.js";
import type { FeatureContext } from "../../src/features/context.js";
import { ApiError } from "../../src/api/index.js";

/**
 * The syllabus feature exposes the course overview as markdown and, when the
 * overview carries a PDF attachment, the text extracted from it. There is no
 * download-to-disk side effect here — a caller that wants the raw file uses
 * downloadFile.
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
  attachment?: { headers?: Record<string, string>; body: Buffer } | (() => never);
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
      return {
        ok: true,
        status: 200,
        headers: headersFrom(attachment.headers ?? {}),
        arrayBuffer: async () => attachment.body.buffer.slice(attachment.body.byteOffset, attachment.body.byteOffset + attachment.body.byteLength),
      };
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
