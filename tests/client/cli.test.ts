import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, type CliDeps, type BrightspaceClientLike } from "../../src/cli.js";
import {
  BrightspaceAuthExpiredError,
  BrightspaceMfaPendingError,
  BrightspaceInvalidArgumentError,
  BrightspaceNotFoundError,
} from "../../src/errors.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeDeps(client: Partial<BrightspaceClientLike> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const createClient = vi.fn(async () => client as BrightspaceClientLike);
  const deps: CliDeps = {
    createClient,
    stdout: { write: (s: string) => stdout.push(s) },
    stderr: { write: (s: string) => stderr.push(s) },
  };
  return { deps, createClient, stdout, stderr };
}

describe("brightspace CLI argv parsing", () => {
  it("courses [--all] maps to getMyCourses({ activeOnly: !all })", async () => {
    const getMyCourses = vi.fn(async () => [{ id: 1 }]);
    const { deps, stdout, stderr } = makeDeps({ getMyCourses });

    expect(await main(["courses"], deps)).toBe(0);
    expect(getMyCourses).toHaveBeenCalledWith({ activeOnly: true });

    await main(["courses", "--all"], deps);
    expect(getMyCourses).toHaveBeenCalledWith({ activeOnly: false });

    expect(stdout.join("")).toBe(`${JSON.stringify([{ id: 1 }])}\n${JSON.stringify([{ id: 1 }])}\n`);
    expect(stderr).toEqual([]);
  });

  it("due [--days N] [--course ID] maps to getUpcomingDueDates", async () => {
    const getUpcomingDueDates = vi.fn(async () => []);
    const { deps } = makeDeps({ getUpcomingDueDates });
    await main(["due", "--days", "3", "--course", "42"], deps);
    expect(getUpcomingDueDates).toHaveBeenCalledWith({ daysAhead: 3, courseId: 42 });
  });

  it("grades [--course ID] maps to getMyGrades", async () => {
    const getMyGrades = vi.fn(async () => []);
    const { deps } = makeDeps({ getMyGrades });
    await main(["grades", "--course", "7"], deps);
    expect(getMyGrades).toHaveBeenCalledWith({ courseId: 7 });
  });

  it("assignments [--course ID] maps to getAssignments", async () => {
    const getAssignments = vi.fn(async () => ({ courses: [] }));
    const { deps } = makeDeps({ getAssignments });
    await main(["assignments", "--course", "7"], deps);
    expect(getAssignments).toHaveBeenCalledWith({ courseId: 7 });
  });

  it("announcements [--course ID] [--count N] [--since ISO] maps to getAnnouncements", async () => {
    const getAnnouncements = vi.fn(async () => []);
    const { deps } = makeDeps({ getAnnouncements });
    await main(["announcements", "--course", "7", "--count", "5", "--since", "2026-01-01T00:00:00Z"], deps);
    expect(getAnnouncements).toHaveBeenCalledWith({ courseId: 7, count: 5, modifiedSince: "2026-01-01T00:00:00Z" });
  });

  it("announcement-files --course ID --news ID [--file ID] [--max-chars N] maps to getAnnouncementFiles", async () => {
    const getAnnouncementFiles = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getAnnouncementFiles });
    await main(["announcement-files", "--course", "7", "--news", "9", "--file", "3", "--max-chars", "500"], deps);
    expect(getAnnouncementFiles).toHaveBeenCalledWith({ courseId: 7, newsId: 9, fileId: 3, maxChars: 500 });
  });

  it("assignment-files --course ID --folder ID [--file ID] [--max-chars N] maps to getAssignmentFiles", async () => {
    const getAssignmentFiles = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getAssignmentFiles });
    await main(["assignment-files", "--course", "7", "--folder", "11", "--file", "3", "--max-chars", "500"], deps);
    expect(getAssignmentFiles).toHaveBeenCalledWith({ courseId: 7, folderId: 11, fileId: 3, maxChars: 500 });
  });

  it("content --course ID [--type T] [--module TITLE] [--depth N] [--since ISO] maps to getCourseContent", async () => {
    const getCourseContent = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getCourseContent });
    await main(
      ["content", "--course", "7", "--type", "file", "--module", "Labs", "--depth", "2", "--since", "2026-01-01T00:00:00Z"],
      deps,
    );
    expect(getCourseContent).toHaveBeenCalledWith({
      courseId: 7,
      typeFilter: "file",
      moduleTitle: "Labs",
      maxDepth: 2,
      modifiedSince: "2026-01-01T00:00:00Z",
    });
  });

  it("syllabus --course ID maps to getSyllabus", async () => {
    const getSyllabus = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getSyllabus });
    await main(["syllabus", "--course", "7"], deps);
    expect(getSyllabus).toHaveBeenCalledWith({ courseId: 7 });
  });

  it("discussions --course ID [--forum ID] [--topic ID] maps to getDiscussions", async () => {
    const getDiscussions = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getDiscussions });
    await main(["discussions", "--course", "7", "--forum", "1", "--topic", "2"], deps);
    expect(getDiscussions).toHaveBeenCalledWith({ courseId: 7, forumId: 1, topicId: 2 });
  });

  it("roster --course ID [--limit N] maps to getRoster", async () => {
    const getRoster = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getRoster });
    await main(["roster", "--course", "7", "--limit", "50"], deps);
    expect(getRoster).toHaveBeenCalledWith({ courseId: 7, limit: 50 });
  });

  it("emails --course ID maps to getClasslistEmails", async () => {
    const getClasslistEmails = vi.fn(async () => []);
    const { deps } = makeDeps({ getClasslistEmails });
    await main(["emails", "--course", "7"], deps);
    expect(getClasslistEmails).toHaveBeenCalledWith({ courseId: 7 });
  });

  it("download --course ID --topic ID --dir PATH [--name NAME] maps to downloadFile", async () => {
    const downloadFile = vi.fn(async () => ({ success: true }));
    const { deps } = makeDeps({ downloadFile });
    await main(["download", "--course", "7", "--topic", "9", "--dir", "/tmp/out", "--name", "f.pdf"], deps);
    expect(downloadFile).toHaveBeenCalledWith({
      courseId: 7,
      topicId: 9,
      folderId: undefined,
      fileId: undefined,
      newsId: undefined,
      downloadPath: "/tmp/out",
      customFilename: "f.pdf",
    });
  });

  it("download --folder ID --file ID variant maps folderId/fileId", async () => {
    const downloadFile = vi.fn(async () => ({ success: true }));
    const { deps } = makeDeps({ downloadFile });
    await main(["download", "--course", "7", "--folder", "11", "--file", "3", "--dir", "/tmp/out"], deps);
    expect(downloadFile).toHaveBeenCalledWith({ courseId: 7, folderId: 11, fileId: 3, downloadPath: "/tmp/out" });
  });

  it("transcript --course ID --topic ID (or --url URL) maps to getVideoTranscript", async () => {
    const getVideoTranscript = vi.fn(async () => ({}));
    const { deps } = makeDeps({ getVideoTranscript });
    await main(["transcript", "--course", "7", "--topic", "9"], deps);
    expect(getVideoTranscript).toHaveBeenCalledWith({ courseId: 7, topicId: 9, videoUrl: undefined });

    await main(["transcript", "--url", "https://example.com/v"], deps);
    expect(getVideoTranscript).toHaveBeenCalledWith({ courseId: undefined, topicId: undefined, videoUrl: "https://example.com/v" });
  });

  it("info maps to getInfo with no arguments", async () => {
    const getInfo = vi.fn(async () => ({ version: "0.1.0" }));
    const { deps, stdout } = makeDeps({ getInfo });
    expect(await main(["info"], deps)).toBe(0);
    expect(getInfo).toHaveBeenCalledWith();
    expect(stdout).toEqual([`${JSON.stringify({ version: "0.1.0" })}\n`]);
  });
});

describe("brightspace CLI stdout/stderr split and exit codes", () => {
  it("writes only JSON to stdout and nothing to stderr on success", async () => {
    const { deps, stdout, stderr } = makeDeps({ getInfo: vi.fn(async () => ({ ok: true })) });
    const code = await main(["info"], deps);
    expect(code).toBe(0);
    expect(stdout).toEqual([`${JSON.stringify({ ok: true })}\n`]);
    expect(stderr).toEqual([]);
  });

  it("writes only the JSON error to stderr and nothing to stdout on failure, exit 2 for BRIGHTSPACE_AUTH_EXPIRED", async () => {
    const { deps, stdout, stderr } = makeDeps({
      getMyCourses: vi.fn(async () => {
        throw new BrightspaceAuthExpiredError();
      }),
    });
    const code = await main(["courses"], deps);
    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    const [line] = stderr;
    expect(JSON.parse(line)).toEqual({ error: { code: "BRIGHTSPACE_AUTH_EXPIRED", message: expect.any(String) } });
  });

  it("exits 3 for BRIGHTSPACE_MFA_PENDING", async () => {
    const { deps, stderr } = makeDeps({
      getMyCourses: vi.fn(async () => {
        throw new BrightspaceMfaPendingError("47");
      }),
    });
    const code = await main(["courses"], deps);
    expect(code).toBe(3);
    expect(JSON.parse(stderr[0]).error.code).toBe("BRIGHTSPACE_MFA_PENDING");
  });

  it("exits 4 for BRIGHTSPACE_INVALID_ARGUMENT", async () => {
    const { deps, stderr } = makeDeps({
      getMyCourses: vi.fn(async () => {
        throw new BrightspaceInvalidArgumentError(["courseId: required"]);
      }),
    });
    const code = await main(["courses"], deps);
    expect(code).toBe(4);
    expect(JSON.parse(stderr[0]).error.code).toBe("BRIGHTSPACE_INVALID_ARGUMENT");
  });

  it("exits 1 for any other BrightspaceError", async () => {
    const { deps, stderr } = makeDeps({
      getMyCourses: vi.fn(async () => {
        throw new BrightspaceNotFoundError();
      }),
    });
    const code = await main(["courses"], deps);
    expect(code).toBe(1);
    expect(JSON.parse(stderr[0]).error.code).toBe("BRIGHTSPACE_NOT_FOUND");
  });

  it("exits 4 with a usage line for an unknown subcommand", async () => {
    const { deps, stdout, stderr } = makeDeps();
    const code = await main(["frobnicate"], deps);
    expect(code).toBe(4);
    expect(stdout).toEqual([]);
    const parsed = JSON.parse(stderr[0]);
    expect(parsed.error.code).toBe("BRIGHTSPACE_INVALID_ARGUMENT");
    expect(parsed.error.message).toContain("Unknown command");
  });

  it("exits 4 with a usage line for an unknown flag", async () => {
    const { deps, stdout, stderr } = makeDeps({ getMyCourses: vi.fn() });
    const code = await main(["courses", "--bogus"], deps);
    expect(code).toBe(4);
    expect(stdout).toEqual([]);
    const parsed = JSON.parse(stderr[0]);
    expect(parsed.error.code).toBe("BRIGHTSPACE_INVALID_ARGUMENT");
    expect(parsed.error.message).toContain("Usage: brightspace courses");
  });
});

describe("brightspace CLI --help", () => {
  const commandNames = [
    "courses",
    "due",
    "grades",
    "assignments",
    "announcements",
    "announcement-files",
    "assignment-files",
    "content",
    "syllabus",
    "discussions",
    "roster",
    "emails",
    "download",
    "transcript",
    "info",
  ];

  it("top-level --help names every command", async () => {
    const { deps, stdout, stderr } = makeDeps();
    const code = await main(["--help"], deps);
    expect(code).toBe(0);
    const text = stdout.join("");
    for (const name of commandNames) {
      expect(text).toContain(`brightspace ${name}`);
    }
    expect(stderr).toEqual([]);
  });

  it("bare invocation with no arguments shows the same help", async () => {
    const { deps, stdout } = makeDeps();
    const code = await main([], deps);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("brightspace courses");
  });

  it("per-command --help shows that command's usage without calling the client", async () => {
    const getMyCourses = vi.fn();
    const { deps, createClient, stdout } = makeDeps({ getMyCourses });
    const code = await main(["courses", "--help"], deps);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("brightspace courses [--all]");
    expect(getMyCourses).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("brightspace CLI --login", () => {
  it("switches to onAuthExpired: 'login' and prints the MFA number on stderr via onMfaChallenge", async () => {
    let seenOptions: Parameters<CliDeps["createClient"]>[0];
    const { deps, stdout, stderr } = makeDeps({ getInfo: vi.fn(async () => ({ ok: true })) });
    deps.createClient = vi.fn(async (options) => {
      seenOptions = options;
      options?.onMfaChallenge?.("47");
      return { getInfo: async () => ({ ok: true }) };
    });

    const code = await main(["info", "--login"], deps);

    expect(code).toBe(0);
    expect(seenOptions?.onAuthExpired).toBe("login");
    expect(stderr).toEqual(["MFA number: 47\n"]);
    expect(stdout).toEqual([`${JSON.stringify({ ok: true })}\n`]);
  });

  it("prints an approve-on-phone line when there is no number match", async () => {
    const { deps, stderr } = makeDeps();
    deps.createClient = vi.fn(async (options) => {
      options?.onMfaChallenge?.(null);
      return { getInfo: async () => ({}) };
    });

    await main(["info", "--login"], deps);

    expect(stderr).toEqual(["Approve the sign-in request on your phone.\n"]);
  });

  it("without --login, uses onAuthExpired: 'fail'", async () => {
    let seenOptions: Parameters<CliDeps["createClient"]>[0];
    const { deps } = makeDeps({ getInfo: vi.fn(async () => ({})) });
    deps.createClient = vi.fn(async (options) => {
      seenOptions = options;
      return { getInfo: async () => ({}) };
    });

    await main(["info"], deps);

    expect(seenOptions?.onAuthExpired).toBe("fail");
  });
});

describe("brightspace CLI auth/setup dispatch", () => {
  it("main([\"auth\"]) dispatches to the injected auth loader instead of parsing flags", async () => {
    const runAuthCli = vi.fn(async () => undefined);
    const { deps, createClient, stdout, stderr } = makeDeps();
    deps.runAuthCli = runAuthCli;

    const code = await main(["auth", "--automatic"], deps);

    expect(runAuthCli).toHaveBeenCalledTimes(1);
    expect(code).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("main([\"setup\"]) dispatches to the injected setup loader instead of parsing flags", async () => {
    const runSetupCli = vi.fn(async () => undefined);
    const { deps, createClient } = makeDeps();
    deps.runSetupCli = runSetupCli;

    const code = await main(["setup", "--purdue", "--visible"], deps);

    expect(runSetupCli).toHaveBeenCalledTimes(1);
    expect(code).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("--help lists auth and setup", async () => {
    const { deps, stdout } = makeDeps();
    await main(["--help"], deps);
    const text = stdout.join("");
    expect(text).toContain("brightspace auth");
    expect(text).toContain("brightspace setup");
  });
});

describe("brightspace CLI real process", () => {
  const bin = resolve(root, "build", "cli.js");

  it("info needs no session: prints a JSON result on stdout and exits 0", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-cli-info-"));
    try {
      const result = spawnSync(process.execPath, [bin, "info"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          D2L_SESSION_DIR: sessionDir,
          D2L_BASE_URL: "https://purdue.brightspace.com",
          D2L_USERNAME: "nobody",
        },
      });

      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toHaveProperty("version");
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("courses without a saved session exits 2 with a JSON auth-expired error on stderr and nothing on stdout", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-cli-courses-"));
    try {
      const result = spawnSync(process.execPath, [bin, "courses"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          D2L_SESSION_DIR: sessionDir,
          D2L_BASE_URL: "https://purdue.brightspace.com",
          D2L_USERNAME: "nobody",
        },
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      const errorLine = result.stderr.trim().split("\n").pop() ?? "";
      expect(JSON.parse(errorLine)).toEqual({
        error: { code: "BRIGHTSPACE_AUTH_EXPIRED", message: expect.any(String) },
      });
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
});
