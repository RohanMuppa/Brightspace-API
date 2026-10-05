import { describe, it, expect, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { getAssignmentFiles, fileKind } from "../../src/features/assignment-files.js";
import type { FeatureContext } from "../../src/features/context.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../../src/errors.js";
import { oversizeBody, CHUNKS_AT_CAP } from "./oversize-body.js";

/**
 * Reading the spec document attached to an assignment was the one student
 * workflow with no tool at all: instructions text was surfaced, the attached
 * PDF or DOCX never was.
 *
 * Shapes here match what a live Purdue course returned: attachments embedded
 * in the folder object as { FileId, FileName, Size }, and a per-file download
 * that answers with the real bytes and content type.
 */

const BASE = "https://brightspace.example.edu";
const COURSE = 101;

const attachment = (fileId: number, fileName: string, size = 1024) => ({
  FileId: fileId,
  FileName: fileName,
  Size: size,
});

const folder = (
  id: number,
  name: string,
  attachments: unknown[] = [],
  extra: Record<string, unknown> = {}
) => ({
  Id: id,
  Name: name,
  DueDate: "2026-09-30T03:59:00.000Z",
  IsHidden: false,
  Attachments: attachments,
  ...extra,
});

/** A minimal but genuine DOCX: one deflated word/document.xml in a real zip. */
function docxBuffer(text: string): Buffer {
  const xml = `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const content = Buffer.from(xml, "utf-8");
  const stored = deflateRawSync(content);
  const name = Buffer.from("word/document.xml", "utf-8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localBlock = Buffer.concat([local, name, stored]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(stored.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralBlock = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

interface Setup {
  folders: unknown;
  file?: Buffer | (() => never) | ReadableStream<Uint8Array>;
}

function setup({ folders, file }: Setup) {
  const requested: string[] = [];
  const rawRequested: string[] = [];

  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return folders;
    }),
    getRaw: vi.fn(async (path: string) => {
      rawRequested.push(path);
      if (typeof file === "function") file();
      if (file instanceof ReadableStream) {
        return new Response(file, { status: 200, headers: { "Content-Length": "1" } });
      }
      return new Response(new Uint8Array(file as Buffer), { status: 200 });
    }),
  };

  const config = { baseUrl: BASE } as any;
  const ctx = { api, config, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx, requested, rawRequested };
}

describe("fileKind", () => {
  it("maps the extensions that matter and defaults to other", () => {
    expect(fileKind("spec.pdf")).toBe("pdf");
    expect(fileKind("Lab4.DOCX")).toBe("docx");
    expect(fileKind("data.xlsx")).toBe("xlsx");
    expect(fileKind("deck.pptx")).toBe("pptx");
    expect(fileKind("diagram.png")).toBe("image");
    expect(fileKind("notes.md")).toBe("text");
    expect(fileKind("archive.zip")).toBe("other");
    expect(fileKind("noextension")).toBe("other");
  });
});

describe("getAssignmentFiles discovery", () => {
  it("lists only assignments that have attachments, and downloads nothing", async () => {
    const { ctx, rawRequested } = setup({
      folders: [
        folder(1, "Lab 4", [attachment(11, "spec.pdf", 2048)]),
        folder(2, "Reading", []),
        folder(3, "Project", [attachment(31, "starter.xlsx"), attachment(32, "rubric.docx")]),
      ],
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE });
    if (!("assignments" in result)) throw new Error("expected the discovery shape");

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments[0]).toMatchObject({
      folderId: 1,
      folderName: "Lab 4",
      url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=1&grpid=0&ou=${COURSE}`,
    });
    expect(result.assignments[0].attachments[0]).toEqual({
      fileId: 11,
      fileName: "spec.pdf",
      size: 2048,
      kind: "pdf",
    });
    expect(result.assignments[1].attachments.map((a) => a.kind)).toEqual(["xlsx", "docx"]);
    expect(rawRequested).toEqual([]);
  });

  it("excludes hidden folders", async () => {
    const { ctx } = setup({
      folders: [
        folder(1, "Visible", [attachment(11, "a.pdf")]),
        folder(2, "Hidden", [attachment(21, "b.pdf")], { IsHidden: true }),
      ],
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE });
    if (!("assignments" in result)) throw new Error("expected the discovery shape");
    expect(result.assignments.map((a) => a.folderId)).toEqual([1]);
  });

  it("accepts the paged envelope as well as a bare array", async () => {
    const { ctx } = setup({
      folders: { Objects: [folder(1, "Lab 4", [attachment(11, "spec.pdf")])] },
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE });
    if (!("assignments" in result)) throw new Error("expected the discovery shape");
    expect(result.assignments).toHaveLength(1);
  });

  it("says so plainly when no assignment has a file", async () => {
    const { ctx } = setup({ folders: [folder(1, "Reading", [])] });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE });
    if (!("assignments" in result)) throw new Error("expected the discovery shape");
    expect(result.assignments).toEqual([]);
    expect(result.note).toMatch(/no assignment/i);
  });

  it("narrows to one folder when folderId is given", async () => {
    const { ctx } = setup({
      folders: [
        folder(1, "Lab 4", [attachment(11, "spec.pdf")]),
        folder(2, "Project", [attachment(21, "rubric.docx")]),
      ],
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE, folderId: 2 });
    if (!("assignments" in result)) throw new Error("expected the discovery shape");
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].folderName).toBe("Project");
  });
});

describe("getAssignmentFiles reading one file", () => {
  it("returns the text of a DOCX attachment", async () => {
    const { ctx, rawRequested } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.docx")])],
      file: docxBuffer("Build a parser and submit the source"),
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE, folderId: 1, fileId: 11 });
    if (!("file" in result)) throw new Error("expected the file-read shape");

    expect(result.file.text).toContain("Build a parser");
    expect(result.file.truncated).toBe(false);
    expect(result.file.kind).toBe("docx");
    expect(rawRequested).toEqual(["/d2l/api/le/1.0/101/dropbox/folders/1/attachments/11"]);
  });

  it("truncates at maxChars and says it did", async () => {
    const { ctx } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.docx")])],
      file: docxBuffer("x".repeat(500)),
    });

    const result = await getAssignmentFiles(ctx, {
      courseId: COURSE,
      folderId: 1,
      fileId: 11,
      maxChars: 50,
    });
    if (!("file" in result)) throw new Error("expected the file-read shape");

    expect(result.file.text).toHaveLength(50);
    expect(result.file.truncated).toBe(true);
  });

  it("reads plain text directly", async () => {
    const { ctx } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "readme.txt")])],
      file: Buffer.from("Answer all six questions.", "utf-8"),
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE, folderId: 1, fileId: 11 });
    if (!("file" in result)) throw new Error("expected the file-read shape");
    expect(result.file.text).toBe("Answer all six questions.");
  });

  it("reports a type it cannot read instead of failing", async () => {
    const { ctx } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "diagram.png")])],
      file: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE, folderId: 1, fileId: 11 });
    if (!("file" in result)) throw new Error("expected the file-read shape");
    expect(result.file.text).toBeNull();
    expect(result.file.note).toMatch(/downloadFile/);
  });

  it("skips the download when extractText is false", async () => {
    const { ctx, rawRequested } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.docx")])],
      file: docxBuffer("unused"),
    });

    const result = await getAssignmentFiles(ctx, {
      courseId: COURSE,
      folderId: 1,
      fileId: 11,
      extractText: false,
    });
    if (!("file" in result)) throw new Error("expected the file-read shape");

    expect(result.file.text).toBeNull();
    expect(rawRequested).toEqual([]);
  });

  it("stops reading an attachment whose body runs past the extraction limit", async () => {
    // Content-Length: 1 and a listed Size of 1, but the body keeps going.
    const { stream, state } = oversizeBody();
    const { ctx } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.pdf", 1)])],
      file: stream,
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE, folderId: 1, fileId: 11 });
    if (!("file" in result)) throw new Error("expected the file-read shape");

    expect(result.file).toMatchObject({ fileId: 11, text: null });
    expect(result.file.note).toMatch(/extraction limit.*downloadFile/);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(CHUNKS_AT_CAP + 2);
    expect(state.pulled).toBeLessThan(state.totalChunks);
  });

  it("refuses an attachment listed over the extraction limit without fetching it", async () => {
    const { ctx, rawRequested } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "huge.pdf", 3 * 1024 * 1024 * 1024)])],
    });

    const result = await getAssignmentFiles(ctx, { courseId: COURSE, folderId: 1, fileId: 11 });
    if (!("file" in result)) throw new Error("expected the file-read shape");

    expect(result.file.note).toMatch(/extraction limit/);
    expect(rawRequested).toEqual([]);
  });

  it("names the available files when the fileId is wrong", async () => {
    const { ctx } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.pdf")])],
      file: Buffer.alloc(0),
    });

    const error: Error = await getAssignmentFiles(ctx, {
      courseId: COURSE,
      folderId: 1,
      fileId: 999,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceNotFoundError);
    expect(error.message).toMatch(/no attachment with id 999/i);
    expect(error.message).toContain("spec.pdf (ID: 11)");
  });

  it("reports a missing assignment clearly", async () => {
    const { ctx } = setup({ folders: [folder(1, "Lab 4", [])] });

    await expect(getAssignmentFiles(ctx, { courseId: COURSE, folderId: 42 })).rejects.toBeInstanceOf(
      BrightspaceNotFoundError
    );
    await expect(getAssignmentFiles(ctx, { courseId: COURSE, folderId: 42 })).rejects.toMatchObject({
      message: expect.stringMatching(/no visible assignment with id 42/i),
    });
  });

  it("requires folderId when fileId is given", async () => {
    const { ctx } = setup({ folders: [folder(1, "Lab 4", [attachment(11, "a.pdf")])] });

    await expect(getAssignmentFiles(ctx, { courseId: COURSE, fileId: 11 })).rejects.toBeInstanceOf(
      BrightspaceInvalidArgumentError
    );
    await expect(getAssignmentFiles(ctx, { courseId: COURSE, fileId: 11 })).rejects.toMatchObject({
      message: expect.stringMatching(/folderId is required/i),
    });
  });
});
