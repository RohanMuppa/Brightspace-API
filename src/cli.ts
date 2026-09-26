#!/usr/bin/env node
/** Brightspace API. Copyright (c) 2026 Rohan Muppa. MIT licensed. */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createBrightspaceClient, type BrightspaceClient, type BrightspaceClientOptions } from "./client/index.js";
import { toPublicError, BrightspaceInvalidArgumentError, type BrightspaceError, type BrightspaceErrorCode } from "./errors.js";
import type { GetCourseContentArgs } from "./features/content.js";

export type BrightspaceClientLike = Pick<
  BrightspaceClient,
  | "getMyCourses"
  | "getUpcomingDueDates"
  | "getMyGrades"
  | "getAssignments"
  | "getAssignmentFiles"
  | "downloadFile"
  | "getClasslistEmails"
  | "getRoster"
  | "getDiscussions"
  | "getVideoTranscript"
  | "getInfo"
  | "getAnnouncements"
  | "getAnnouncementFiles"
  | "getCourseContent"
  | "getSyllabus"
>;

export interface Writer {
  write(chunk: string): void;
}

export interface CliDeps {
  createClient: (options?: BrightspaceClientOptions) => Promise<BrightspaceClientLike>;
  stdout: Writer;
  stderr: Writer;
  /** Injection seam for tests; the real bin loads the actual module. */
  runAuthCli?: () => Promise<unknown>;
  runSetupCli?: () => Promise<unknown>;
}

type FlagSpec = { type: "string" } | { type: "boolean" };
type FlagValues = Record<string, string | boolean | undefined>;

interface CommandSpec {
  usage: string;
  options: Record<string, FlagSpec>;
  run: (client: BrightspaceClientLike, values: FlagValues) => Promise<unknown>;
}

const EXIT_CODES: Partial<Record<BrightspaceErrorCode, number>> = {
  BRIGHTSPACE_AUTH_EXPIRED: 2,
  BRIGHTSPACE_MFA_PENDING: 3,
  BRIGHTSPACE_INVALID_ARGUMENT: 4,
};

const str = (v: FlagValues, key: string): string | undefined => (v[key] === undefined ? undefined : String(v[key]));
const num = (v: FlagValues, key: string): number | undefined => (v[key] === undefined ? undefined : Number(v[key]));

const COMMANDS: Record<string, CommandSpec> = {
  courses: {
    usage: "courses [--all]                       getMyCourses({ activeOnly: !all })",
    options: { all: { type: "boolean" } },
    run: (c, v) => c.getMyCourses({ activeOnly: !v.all }),
  },
  due: {
    usage: "due [--days N] [--course ID]           getUpcomingDueDates",
    options: { days: { type: "string" }, course: { type: "string" } },
    run: (c, v) => c.getUpcomingDueDates({ daysAhead: num(v, "days"), courseId: num(v, "course") }),
  },
  grades: {
    usage: "grades [--course ID]                    getMyGrades",
    options: { course: { type: "string" } },
    run: (c, v) => c.getMyGrades({ courseId: num(v, "course") }),
  },
  assignments: {
    usage: "assignments [--course ID]               getAssignments",
    options: { course: { type: "string" } },
    run: (c, v) => c.getAssignments({ courseId: num(v, "course") }),
  },
  announcements: {
    usage: "announcements [--course ID] [--count N] [--since ISO]   getAnnouncements",
    options: { course: { type: "string" }, count: { type: "string" }, since: { type: "string" } },
    run: (c, v) => c.getAnnouncements({ courseId: num(v, "course"), count: num(v, "count"), modifiedSince: str(v, "since") }),
  },
  "announcement-files": {
    usage: "announcement-files --course ID --news ID [--file ID] [--max-chars N]   getAnnouncementFiles",
    options: { course: { type: "string" }, news: { type: "string" }, file: { type: "string" }, "max-chars": { type: "string" } },
    run: (c, v) => c.getAnnouncementFiles({ courseId: num(v, "course"), newsId: num(v, "news"), fileId: num(v, "file"), maxChars: num(v, "max-chars") }),
  },
  "assignment-files": {
    usage: "assignment-files --course ID --folder ID [--file ID] [--max-chars N]   getAssignmentFiles",
    options: { course: { type: "string" }, folder: { type: "string" }, file: { type: "string" }, "max-chars": { type: "string" } },
    run: (c, v) => c.getAssignmentFiles({ courseId: num(v, "course"), folderId: num(v, "folder"), fileId: num(v, "file"), maxChars: num(v, "max-chars") }),
  },
  content: {
    usage: "content --course ID [--type T] [--module TITLE] [--depth N] [--since ISO]   getCourseContent",
    options: {
      course: { type: "string" },
      type: { type: "string" },
      module: { type: "string" },
      depth: { type: "string" },
      since: { type: "string" },
    },
    run: (c, v) =>
      c.getCourseContent({
        courseId: num(v, "course") as number,
        typeFilter: str(v, "type") as GetCourseContentArgs["typeFilter"],
        moduleTitle: str(v, "module"),
        maxDepth: num(v, "depth"),
        modifiedSince: str(v, "since"),
      }),
  },
  syllabus: {
    usage: "syllabus --course ID                    getSyllabus",
    options: { course: { type: "string" } },
    run: (c, v) => c.getSyllabus({ courseId: num(v, "course") as number }),
  },
  discussions: {
    usage: "discussions --course ID [--forum ID] [--topic ID]   getDiscussions",
    options: { course: { type: "string" }, forum: { type: "string" }, topic: { type: "string" } },
    run: (c, v) => c.getDiscussions({ courseId: num(v, "course") as number, forumId: num(v, "forum"), topicId: num(v, "topic") }),
  },
  roster: {
    usage: "roster --course ID [--limit N]           getRoster",
    options: { course: { type: "string" }, limit: { type: "string" } },
    run: (c, v) => c.getRoster({ courseId: num(v, "course") as number, limit: num(v, "limit") }),
  },
  emails: {
    usage: "emails --course ID                      getClasslistEmails",
    options: { course: { type: "string" } },
    run: (c, v) => c.getClasslistEmails({ courseId: num(v, "course") as number }),
  },
  download: {
    usage:
      "download --course ID (--topic ID | --folder ID --file ID | --news ID --file ID) --dir PATH [--name NAME]   downloadFile",
    options: {
      course: { type: "string" },
      topic: { type: "string" },
      folder: { type: "string" },
      file: { type: "string" },
      news: { type: "string" },
      dir: { type: "string" },
      name: { type: "string" },
    },
    run: (c, v) =>
      c.downloadFile({
        courseId: num(v, "course") as number,
        topicId: num(v, "topic"),
        folderId: num(v, "folder"),
        fileId: num(v, "file"),
        newsId: num(v, "news"),
        downloadPath: str(v, "dir") as string,
        customFilename: str(v, "name"),
      }),
  },
  transcript: {
    usage: "transcript --course ID --topic ID (or --url URL)   getVideoTranscript",
    options: { course: { type: "string" }, topic: { type: "string" }, url: { type: "string" } },
    run: (c, v) => c.getVideoTranscript({ courseId: num(v, "course"), topicId: num(v, "topic"), videoUrl: str(v, "url") }),
  },
  info: {
    usage: "info                                     getInfo",
    options: {},
    run: (c) => c.getInfo(),
  },
};

function topLevelHelp(): string {
  const lines = Object.values(COMMANDS).map((cmd) => `  brightspace ${cmd.usage}`);
  return [
    "Usage: brightspace <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "  brightspace auth                        sign in once (opens the MFA flow)",
    "  brightspace setup                       save school and credentials",
    "",
    "Any command accepts --login (browser sign-in on an expired session) and --help.",
  ].join("\n");
}

function writeError(deps: CliDeps, error: BrightspaceError): number {
  deps.stderr.write(`${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`);
  return EXIT_CODES[error.code] ?? 1;
}

export async function main(argv: string[], deps: CliDeps): Promise<number | null> {
  const [name, ...rest] = argv;

  // Routed before any parsing, exactly like the seed's src/index.ts: these
  // two subcommands scan process.argv themselves (--automatic, --purdue,
  // --visible, …) and manage their own exit code, so argv here is untouched
  // and the caller must not call process.exit on our return value.
  if (name === "auth") {
    await (deps.runAuthCli ?? (() => import("./auth-cli.js")))();
    return null;
  }
  if (name === "setup") {
    await (deps.runSetupCli ?? (() => import("./setup.js")))();
    return null;
  }

  if (!name || name === "--help" || name === "-h") {
    deps.stdout.write(`${topLevelHelp()}\n`);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    return writeError(
      deps,
      new BrightspaceInvalidArgumentError([`command: unknown "${name}"`], `Unknown command "${name}".\n\n${topLevelHelp()}`),
    );
  }

  let values: FlagValues;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { ...command.options, login: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    return writeError(
      deps,
      new BrightspaceInvalidArgumentError([(e as Error).message], `Invalid arguments for "${name}": ${(e as Error).message}\n\nUsage: brightspace ${command.usage}`),
    );
  }

  if (values.help) {
    deps.stdout.write(`Usage: brightspace ${command.usage}\n`);
    return 0;
  }

  const clientOptions: BrightspaceClientOptions = values.login
    ? {
        onAuthExpired: "login",
        onMfaChallenge: (numberMatch) =>
          deps.stderr.write(`${numberMatch ? `MFA number: ${numberMatch}` : "Approve the sign-in request on your phone."}\n`),
      }
    : { onAuthExpired: "fail" };

  try {
    const client = await deps.createClient(clientOptions);
    const result = await command.run(client, values);
    deps.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (e) {
    return writeError(deps, toPublicError(e));
  }
}

async function runCli(): Promise<void> {
  const exitCode = await main(process.argv.slice(2), {
    createClient: createBrightspaceClient,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  // null means a dispatched auth/setup subcommand owns the exit itself;
  // forcing one here would cut off setup.ts's unawaited async work.
  if (exitCode !== null) process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
