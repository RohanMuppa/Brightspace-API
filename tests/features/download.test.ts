import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadFile, parseContentDispositionFilename } from "../../src/features/download.js";
import type { FeatureContext } from "../../src/features/context.js";
import { BrightspaceInvalidArgumentError, BrightspaceNotFoundError } from "../../src/errors.js";

/**
 * download_file had no test of its own. Both of the things it gets from the
 * remote side — the Content-Disposition filename and the dropbox submission
 * list — are covered here, because both were wrong.
 */

const COURSE = 101;

/** A buffer file-type recognises as a PDF, so the allowlist lets it through. */
function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512)]);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface Setup {
  /** Content-Disposition header returned for a content-topic download. */
  disposition?: string;
  /** What GET .../mysubmissions/ answers with. */
  submissions?: unknown;
  /** What GET .../news/(newsId) answers with. */
  newsItem?: unknown;
  /** Content-Length header on the raw download. */
  contentLength?: number;
  body?: Buffer | ReadableStream<Uint8Array>;
}

/**
 * A PDF of `megabytes` MB delivered in 1 MB chunks, so a test can push a file
 * past the old 50 MB cap without ever holding it in one buffer.
 */
function largePdfStream(megabytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === megabytes) return controller.close();
      controller.enqueue(sent === 0 ? Buffer.concat([Buffer.from("%PDF-1.4\n"), chunk.subarray(9)]) : chunk);
      sent += 1;
    },
  });
}

function setup({ disposition, submissions, newsItem, contentLength, body = pdfBuffer() }: Setup) {
  const rawRequested: string[] = [];

  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (p: string) => (p.includes("/news/") ? newsItem : submissions)),
    getRaw: vi.fn(async (p: string) => {
      rawRequested.push(p);
      return new Response(body instanceof Buffer ? toArrayBuffer(body) : body, {
        status: 200,
        headers: {
          ...(disposition ? { "Content-Disposition": disposition } : {}),
          ...(contentLength !== undefined ? { "Content-Length": String(contentLength) } : {}),
        },
      });
    }),
  };

  const ctx = { api, config: {} as any, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx, rawRequested };
}

let root: string;
let targetDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "download-file-"));
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

describe("parseContentDispositionFilename", () => {
  it("reads quoted, bare and RFC 5987 forms, preferring the extended one", () => {
    expect(parseContentDispositionFilename('attachment; filename="report.pdf"')).toBe(
      "report.pdf"
    );
    expect(parseContentDispositionFilename("attachment; filename=Lecture 7.pdf")).toBe(
      "Lecture 7.pdf"
    );
    expect(
      parseContentDispositionFilename("attachment; filename*=UTF-8''Lecture%207.pdf")
    ).toBe("Lecture 7.pdf");
    expect(
      parseContentDispositionFilename(
        "attachment; filename=\"a.pdf\"; filename*=UTF-8''b.pdf"
      )
    ).toBe("b.pdf");
    expect(parseContentDispositionFilename("inline")).toBeNull();
  });

  // Not a bug in the parser — the point is that it faithfully hands the
  // separators on, so whatever writes the file is the thing that has to be safe.
  it("passes a traversal-shaped name through verbatim", () => {
    expect(parseContentDispositionFilename('attachment; filename="../../pwned.pdf"')).toBe(
      "../../pwned.pdf"
    );
  });
});

describe("downloadFile: filenames from Brightspace stay inside the download directory", () => {
  it("does not write above the download directory for a traversing Content-Disposition", async () => {
    const { ctx } = setup({ disposition: 'attachment; filename="../../pwned.pdf"' });

    const result = await downloadFile(ctx, { courseId: COURSE, topicId: 7, downloadPath: targetDir }).catch(
      (e) => e
    );

    // Nothing may exist outside a/b, whether the download succeeded under a
    // sanitized name or was refused outright.
    const written = await walk(root);
    expect(written).not.toContain("pwned.pdf");
    expect(written).not.toContain("a/pwned.pdf");

    if (!(result instanceof Error)) {
      expect(
        path.resolve(result.filePath).startsWith(path.resolve(targetDir) + path.sep)
      ).toBe(true);
    }
  });

  it("does not write above the download directory for a traversing customFilename", async () => {
    const { ctx } = setup({ disposition: 'attachment; filename="notes.pdf"' });

    await downloadFile(ctx, {
      courseId: COURSE,
      topicId: 7,
      downloadPath: targetDir,
      customFilename: "../../custom.pdf",
    }).catch(() => {});

    const written = await walk(root);
    expect(written).not.toContain("custom.pdf");
    expect(written).not.toContain("a/custom.pdf");
  });

  it("does not write into a subdirectory named by the remote filename", async () => {
    // path.join would happily aim at a/b/sub/nested.pdf, which does not exist,
    // and the raw ENOENT used to surface as an opaque unexpected error.
    const { ctx } = setup({ disposition: 'attachment; filename="sub/nested.pdf"' });

    const result = await downloadFile(ctx, { courseId: COURSE, topicId: 7, downloadPath: targetDir }).catch(
      (e) => e
    );

    if (result instanceof Error) {
      expect(result.message).not.toContain("An unexpected error occurred");
    } else {
      expect(path.dirname(result.filePath)).toBe(targetDir);
    }
  });

  it("still saves an ordinary file under its own name and reports it", async () => {
    const { ctx } = setup({ disposition: 'attachment; filename="Lecture 7.pdf"' });

    const result = await downloadFile(ctx, { courseId: COURSE, topicId: 7, downloadPath: targetDir });

    expect(result.success).toBe(true);
    expect(result.filePath).toBe(path.join(targetDir, "Lecture 7.pdf"));
    expect(result.originalFilename).toBe("Lecture 7.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(await fs.readFile(result.filePath)).toHaveLength(521);
  });

  it("appends a counter rather than overwriting an existing file", async () => {
    await fs.writeFile(path.join(targetDir, "Lecture 7.pdf"), "already here");
    const { ctx } = setup({ disposition: 'attachment; filename="Lecture 7.pdf"' });

    const result = await downloadFile(ctx, { courseId: COURSE, topicId: 7, downloadPath: targetDir });

    expect(path.basename(result.filePath)).toBe("Lecture 7(1).pdf");
    expect(await fs.readFile(path.join(targetDir, "Lecture 7.pdf"), "utf-8")).toBe(
      "already here"
    );
  });
});

describe("downloadFile: dropbox submissions", () => {
  const submission = (id: number, files: unknown[]) => ({ Id: id, Files: files });
  const file = (fileId: number, fileName: string, size = 1024) => ({
    FileId: fileId,
    FileName: fileName,
    Size: size,
  });

  it("finds a file in a later submission, not just the first", async () => {
    // A resubmitted assignment answers with one entry per submission. Reading
    // only submissions[0] reported "not found" for a file the API had just
    // returned, and would have downloaded it under the wrong submission id.
    const { ctx, rawRequested } = setup({
      submissions: [
        submission(900, [file(11, "draft.pdf")]),
        submission(901, [file(22, "final.pdf")]),
      ],
    });

    const result = await downloadFile(ctx, {
      courseId: COURSE,
      folderId: 5,
      fileId: 22,
      downloadPath: targetDir,
    });

    expect(result.originalFilename).toBe("final.pdf");
    expect(rawRequested[0]).toContain("/submissions/901/files/22/download");
  });

  it("lists every submission's files when the id really is absent", async () => {
    const { ctx } = setup({
      submissions: [
        submission(900, [file(11, "draft.pdf")]),
        submission(901, [file(22, "final.pdf")]),
      ],
    });

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      folderId: 5,
      fileId: 99,
      downloadPath: targetDir,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceNotFoundError);
    expect(error.message).toContain("draft.pdf");
    expect(error.message).toContain("final.pdf");
  });

  it("does not crash on a submission that carries no Files array", async () => {
    const { ctx } = setup({
      submissions: [submission(900, undefined as any), submission(901, [file(22, "final.pdf")])],
    });

    const result = await downloadFile(ctx, {
      courseId: COURSE,
      folderId: 5,
      fileId: 22,
      downloadPath: targetDir,
    });

    expect(result.originalFilename).toBe("final.pdf");
  });
});

describe("downloadFile: announcement attachments", () => {
  const newsItem = (attachments: unknown[]) => ({ Id: 55, Title: "Field notes", Attachments: attachments });
  const file = (fileId: number, fileName: string, size = 1024) => ({
    FileId: fileId,
    FileName: fileName,
    Size: size,
  });

  it("saves the attachment under the download directory from the news attachment endpoint", async () => {
    const { ctx, rawRequested } = setup({
      newsItem: newsItem([file(77, "prompts.pdf")]),
      disposition: 'attachment; filename="prompts.pdf"',
    });

    const result = await downloadFile(ctx, { courseId: COURSE, newsId: 55, fileId: 77, downloadPath: targetDir });

    expect(result.filePath).toBe(path.join(targetDir, "prompts.pdf"));
    expect(rawRequested).toEqual(["/d2l/api/le/1.0/101/news/55/attachments/77"]);
  });

  it("does not write above the download directory for a traversing Content-Disposition", async () => {
    const { ctx } = setup({
      newsItem: newsItem([file(77, "prompts.pdf")]),
      disposition: 'attachment; filename="../../pwned.pdf"',
    });

    await downloadFile(ctx, { courseId: COURSE, newsId: 55, fileId: 77, downloadPath: targetDir }).catch(() => {});

    const written = await walk(root);
    expect(written.filter((f) => !f.startsWith("a/b/"))).toEqual([]);
  });

  it("refuses an attachment whose listed size is over the limit without downloading it", async () => {
    const { ctx, rawRequested } = setup({
      newsItem: newsItem([file(77, "huge.pdf", 3 * 1024 * 1024 * 1024)]),
    });

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      newsId: 55,
      fileId: 77,
      downloadPath: targetDir,
    }).catch((e) => e);

    expect(error.message).toContain("File too large");
    expect(rawRequested).toEqual([]);
  });

  it("refuses a download whose Content-Length is over the limit", async () => {
    const { ctx } = setup({
      newsItem: newsItem([file(77, "prompts.pdf")]),
      contentLength: 3 * 1024 * 1024 * 1024,
    });

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      newsId: 55,
      fileId: 77,
      downloadPath: targetDir,
    }).catch((e) => e);

    expect(error.message).toContain("File too large");
    expect(await walk(root)).toEqual([]);
  });

  it("names the announcement's files when the fileId is not one of them", async () => {
    const { ctx } = setup({
      newsItem: newsItem([file(77, "prompts.pdf"), file(78, "rubric.docx")]),
    });

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      newsId: 55,
      fileId: 99,
      downloadPath: targetDir,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceNotFoundError);
    expect(error.message).toContain(
      "File ID 99 not found on this announcement. Available files: prompts.pdf (ID: 77), rubric.docx (ID: 78)"
    );
  });

  it("asks for fileId when newsId is given alone", async () => {
    const { ctx } = setup({ newsItem: newsItem([file(77, "prompts.pdf")]) });

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      newsId: 55,
      downloadPath: targetDir,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceInvalidArgumentError);
    expect(error.message).toContain("newsId and fileId");
  });
});

/**
 * brightspace-mcp-server#150: a 150 MB lecture deck was refused because every
 * download was buffered in memory under a 50 MB cap. Downloads now stream to
 * the file under a 2 GB cap.
 */
describe("downloadFile: files over 50 MB", () => {
  it("saves a content file larger than 50 MB to disk at its full size", async () => {
    const { ctx } = setup({
      disposition: 'attachment; filename="Lecture 12.pdf"',
      contentLength: 60 * 1024 * 1024,
      body: largePdfStream(60),
    });

    const result = await downloadFile(ctx, { courseId: COURSE, topicId: 7, downloadPath: targetDir });

    expect((await fs.stat(path.join(targetDir, "Lecture 12.pdf"))).size).toBe(60 * 1024 * 1024);
    expect(result).toMatchObject({ success: true, fileSize: 60 * 1024 * 1024, mimeType: "application/pdf" });
  });

  it("downloads a submission file whose listed size is over 50 MB", async () => {
    const { ctx } = setup({
      submissions: [{ Id: 900, Files: [{ FileId: 22, FileName: "recording.pdf", Size: 150 * 1024 * 1024 }] }],
    });

    const result = await downloadFile(ctx, { courseId: COURSE, folderId: 5, fileId: 22, downloadPath: targetDir });

    expect(result.filePath).toBe(path.join(targetDir, "recording.pdf"));
  });

  it("leaves no partial file behind when the type check refuses a streamed download", async () => {
    const { ctx } = setup({
      disposition: 'attachment; filename="setup.pdf"',
      body: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4096, 0xff)]),
    });

    await downloadFile(ctx, { courseId: COURSE, topicId: 7, downloadPath: targetDir }).catch(() => {});

    expect(await walk(root)).toEqual([]);
  });
});

describe("downloadFile: downloadPath validation", () => {
  it("requires an absolute downloadPath", async () => {
    const { ctx } = setup({});

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      topicId: 7,
      downloadPath: "relative/path",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceInvalidArgumentError);
    expect(error.message).toMatch(/absolute path/i);
  });

  it("rejects a downloadPath that does not exist", async () => {
    const { ctx } = setup({});

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      topicId: 7,
      downloadPath: path.join(root, "does-not-exist"),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceInvalidArgumentError);
    expect(error.message).toMatch(/does not exist/i);
  });

  it("rejects a downloadPath that is not a directory", async () => {
    const filePath = path.join(root, "a-file");
    await fs.writeFile(filePath, "x");
    const { ctx } = setup({});

    const error: Error = await downloadFile(ctx, {
      courseId: COURSE,
      topicId: 7,
      downloadPath: filePath,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceInvalidArgumentError);
    expect(error.message).toMatch(/not a directory/i);
  });
});
