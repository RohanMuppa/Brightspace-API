# Brightspace API — build contract

The spec for turning the seed (a verbatim copy of `brightspace-mcp-server` 3.6.1) into
`brightspace-api`: a documented, read-only, programmatic client for D2L Brightspace that
scripts and scheduled jobs import directly. Origin: `RohanMuppa/brightspace-mcp-server#35`.

Every issue on this repo cites a section below. An implementer works from this file, not
from memory of the MCP server. When this file and an issue disagree, this file wins.

## 1. What ships

- npm package `brightspace-api`, ESM, Node 20+, TypeScript compiled to `build/`.
- Public entry points, declared in `package.json` `exports` and nothing else:
  - `"."` → `build/index.js` — `createBrightspaceClient`, `BrightspaceClient`, every public type, every public error.
  - `"./errors"` → `build/errors.js` — the error classes and `toPublicError`.
  - `"./auth"` → `build/auth/index.js` — `TokenManager`, `BrowserAuth`, `AuthRunner` for callers who need the raw pieces.
  - `"./package.json"`.
- Three executables: `brightspace` (JSON CLI, §6), `brightspace-auth`, `brightspace-setup`.
- Reads the **same** config and session material as the MCP server — `~/.brightspace-mcp/config.json`,
  the native credential store entries, `~/.d2l-session/` — so a user of the MCP server can script
  immediately without a second sign-in. Do not rename these paths or keychain service names.
- Read-only. No method or command submits, posts, grades, or modifies anything in Brightspace.

## 2. Layout

```
src/
  index.ts             public entry: re-exports client, features' arg/result types, errors
  errors.ts            BrightspaceError family + toPublicError()   (done)
  client/
    index.ts           createBrightspaceClient(), BrightspaceClient
  features/            one module per capability; pure typed functions   (§3)
    context.ts         FeatureContext                                    (done)
    schemas.ts         zod schemas (moved from tools/)                   (done)
    attachment-reader.ts                                                 (done)
    courses.ts         the reference implementation — copy its shape    (done)
  cli.ts               the `brightspace` command                         (§6)
  api/  auth/  utils/  unchanged from the seed unless an issue says otherwise
  auth-cli.ts  setup.ts  kept; stripped of MCP-client configuration and self-update
tests/
  features/            one test file per feature module (ported from tests/tools/)
  client/              facade, error boundary, CLI
  api/ auth/ utils/ release/   unchanged unless the module they cover changed
```

`src/tools/` is deleted when the last feature is converted. Nothing may import from it.

## 3. Feature modules

Each `src/features/<name>.ts` exports exactly:

| Module | Function | Args type (`z.input` of the schema) | Result type |
|---|---|---|---|
| `courses.ts` | `getMyCourses(ctx, args?)` | `GetMyCoursesArgs` | `Course[]` |
| `grades.ts` | `getMyGrades(ctx, args?)` | `GetMyGradesArgs` | `CourseGrades[]` |
| `due-dates.ts` | `getUpcomingDueDates(ctx, args?)` | `GetUpcomingDueDatesArgs` | `UpcomingItem[]` |
| `info.ts` | `getInfo(ctx)` | — | `ClientInfo` |
| `assignments.ts` | `getAssignments(ctx, args?)` | `GetAssignmentsArgs` | `AssignmentsResult` |
| `assignment-files.ts` | `getAssignmentFiles(ctx, args)` | `GetAssignmentFilesArgs` | `AssignmentFilesResult` |
| `download.ts` | `downloadFile(ctx, args)` | `DownloadFileArgs` | `DownloadResult` |
| `announcements.ts` | `getAnnouncements(ctx, args?)` | `GetAnnouncementsArgs` | `Announcement[] \| AnnouncementsFiltered` |
| `announcement-files.ts` | `getAnnouncementFiles(ctx, args)` | `GetAnnouncementFilesArgs` | `AnnouncementFilesResult` |
| `content.ts` | `getCourseContent(ctx, args)` | `GetCourseContentArgs` | `CourseContentResult` |
| `syllabus.ts` | `getSyllabus(ctx, args)` | `GetSyllabusArgs` | `SyllabusResult` |
| `discussions.ts` | `getDiscussions(ctx, args)` | `GetDiscussionsArgs` | `DiscussionsResult` |
| `roster.ts` | `getRoster(ctx, args)` | `GetRosterArgs` | `RosterResult` |
| `classlist-emails.ts` | `getClasslistEmails(ctx, args)` | `GetClasslistEmailsArgs` | `ClasslistEmailsResult` |
| `transcript.ts` | `getVideoTranscript(ctx, args)` | `GetVideoTranscriptArgs` | `VideoTranscriptResult` |

Rules, all of them:

1. **Signature** `async function <fn>(ctx: FeatureContext, args: <Args> = {}): Promise<<Result>>`.
   Validate with `<Schema>.parse(args)` first; a `ZodError` propagates (the boundary maps it).
2. **Same data as the tool returned.** The result object has the same keys and values the MCP
   tool's JSON had — this is a refactor, not a redesign. Keys the tool omitted stay omitted.
3. **Real objects, never strings.** No `JSON.stringify`, no `toolResponse`, no `content[0].text`.
4. **Explicit result types.** Export an `interface`/`type` for every result and nested item; no
   `any` at the boundary. Raw D2L payload types stay private to the module.
5. **Errors are thrown, never returned.** Where the tool did `return errorResponse("…")` for a
   business condition, throw the matching class from `src/errors.ts`: not found →
   `BrightspaceNotFoundError(message)`, bad argument combination →
   `BrightspaceInvalidArgumentError([message])`, download refusal → let `DownloadError`
   propagate (the boundary maps it). Internal errors (`ApiError`, `NetworkError`, …) propagate
   untouched. Never call `sanitizeError`.
6. **No logging to stdout.** `log()` from `utils/logger.js` only (it writes to stderr).
7. **Tests** move from `tests/tools/<tool>.test.ts` to `tests/features/<module>.test.ts`, call the
   function with a fake `ctx` (`{ api, config, version }`), assert on the returned object, and
   assert thrown errors with `rejects.toBeInstanceOf(...)`. Keep every behaviour the old test pinned.
8. Delete `src/tools/<tool>.ts` and the old test in the same commit. Leave `src/tools/tool-helpers.ts`
   alone; the core issue removes it last.

`courses.ts` and `tests/features/courses.test.ts` are the worked example.

## 4. Errors

`src/errors.ts` is complete. Public code paths throw only `BrightspaceError` subclasses; the facade
and the CLI wrap every call in `try { … } catch (e) { throw toPublicError(e) }`. Stable codes:

`BRIGHTSPACE_AUTH_EXPIRED` · `BRIGHTSPACE_MFA_PENDING` (`numberMatch?`) · `BRIGHTSPACE_AUTH_FAILED`
(`kind`) · `BRIGHTSPACE_NOT_FOUND` · `BRIGHTSPACE_FORBIDDEN` · `BRIGHTSPACE_RATE_LIMITED` ·
`BRIGHTSPACE_NETWORK` · `BRIGHTSPACE_INVALID_ARGUMENT` (`issues`) · `BRIGHTSPACE_DOWNLOAD_FAILED`
(`kind`) · `BRIGHTSPACE_API_ERROR` (`status`) · `BRIGHTSPACE_UNEXPECTED`.

Messages never contain tokens, cookies, child-process output, or raw response text.

## 5. The client facade

```ts
import { createBrightspaceClient } from "brightspace-api";

const client = await createBrightspaceClient();               // ~/.brightspace-mcp/config.json + env
const courses = await client.getMyCourses();
const due = await client.getUpcomingDueDates({ daysAhead: 7 });
```

```ts
export interface BrightspaceClientOptions {
  /** Use this config instead of loading ~/.brightspace-mcp/config.json and the environment. */
  config?: AppConfig;
  /**
   * What to do when the saved session is gone and cannot be renewed over HTTP.
   * "fail" (default): throw BrightspaceAuthExpiredError. A cron job cannot answer a phone.
   * "login": run the browser sign-in the way the MCP server does (AuthRunner → auth-cli
   * --automatic). The call then throws BrightspaceMfaPendingError as soon as the challenge
   * appears (with the number to enter, when there is one); the sign-in keeps running in the
   * background, and a retry joins it and waits up to 45 seconds for the approval.
   */
  onAuthExpired?: "fail" | "login";
  /** Receives the number-match digits (or null for a plain push) the moment they appear. Only with "login". */
  onMfaChallenge?: (numberMatch: string | null) => void;
  /** Progress lines from the sign-in child, for a script that wants to show them. */
  onProgress?: (line: string) => void;
  /** Logger threshold for this process; default "WARN" so a library caller's stderr stays quiet. */
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

export function createBrightspaceClient(options?: BrightspaceClientOptions): Promise<BrightspaceClient>;

export class BrightspaceClient {
  readonly config: AppConfig;
  readonly api: D2LApiClient;                 // escape hatch, documented as such
  getMyCourses(args?): Promise<Course[]>;
  getUpcomingDueDates(args?): Promise<UpcomingItem[]>;
  getMyGrades(args?): Promise<CourseGrades[]>;
  getAnnouncements(args?): Promise<Announcement[] | AnnouncementsFiltered>;
  getAnnouncementFiles(args): Promise<AnnouncementFilesResult>;
  getAssignments(args?): Promise<AssignmentsResult>;
  getAssignmentFiles(args): Promise<AssignmentFilesResult>;
  getCourseContent(args): Promise<CourseContentResult>;
  downloadFile(args): Promise<DownloadResult>;
  getClasslistEmails(args): Promise<ClasslistEmailsResult>;
  getRoster(args): Promise<RosterResult>;
  getSyllabus(args): Promise<SyllabusResult>;
  getDiscussions(args): Promise<DiscussionsResult>;
  getVideoTranscript(args): Promise<VideoTranscriptResult>;
  getInfo(): Promise<ClientInfo>;
}
```

Construction mirrors the MCP server's `src/index.ts` at the seed commit: `loadConfig()`,
`new TokenManager({ sessionDir, baseUrl, tokenTtl })`, `new D2LApiClient({ baseUrl, tokenManager,
onAuthExpired })`. With `"fail"`, `onAuthExpired` is `undefined`, so the API client throws its
401 `ApiError` and the boundary turns it into `BrightspaceAuthExpiredError`. With `"login"`, it is
`() => authRunner.run()` with `AuthRunner({ onProgress })`; the runner's early `mfaPending`
rejection becomes `BrightspaceMfaPendingError`. Each method is
`try { return await feature(this.ctx, args) } catch (e) { throw toPublicError(e) }` — one line of
wrapping, no logic in the facade.

Credentials never enter through options. No `password` option, ever.

## 6. The `brightspace` CLI

`src/cli.ts`, bin `brightspace`. Thin: parse argv → `createBrightspaceClient({ onAuthExpired: "fail" })`
→ one facade method → `JSON.stringify(result)` to stdout → exit 0. Subcommands map 1:1 to methods:

```
brightspace courses [--all]                       getMyCourses({ activeOnly: !all })
brightspace due [--days N] [--course ID]           getUpcomingDueDates
brightspace grades [--course ID]                   getMyGrades
brightspace assignments [--course ID]              getAssignments
brightspace announcements [--course ID] [--count N] [--since ISO]
brightspace announcement-files --course ID --news ID [--file ID] [--max-chars N]
brightspace assignment-files --course ID --folder ID [--file ID] [--max-chars N]
brightspace content --course ID [--type T] [--module TITLE] [--depth N] [--since ISO]
brightspace syllabus --course ID
brightspace discussions --course ID [--forum ID] [--topic ID]
brightspace roster --course ID [--limit N]
brightspace emails --course ID
brightspace download --course ID (--topic ID | --folder ID --file ID | --news ID --file ID) --dir PATH [--name NAME]
brightspace transcript --course ID --topic ID   (or --url URL, whichever the schema takes)
brightspace info
brightspace --help / <cmd> --help
```

Errors: print `{"error":{"code":…,"message":…}}` to **stderr** and exit `2` for
`BRIGHTSPACE_AUTH_EXPIRED`, `3` for `BRIGHTSPACE_MFA_PENDING`, `4` for `BRIGHTSPACE_INVALID_ARGUMENT`,
`1` for everything else. `--login` on any command switches to `onAuthExpired: "login"` and prints
the MFA number on stderr as it arrives. Nothing but the JSON result ever goes to stdout.

## 7. Removals

Gone from this package (they belong to the MCP server's UX, not a library):
`@modelcontextprotocol/sdk` (dependency), `src/tools/` (after conversion), `src/utils/update-checker.ts`,
`src/utils/self-update.ts`, `src/utils/install-sites.ts`, `src/utils/mcp-client-cli.ts`, the MCP-client
configuration step in `setup.ts`, the self-update/skew calls in `auth-cli.ts`, and the tests for each.
`src/utils/commands.ts` `PACKAGE_NAME` becomes `brightspace-api`.

## 8. Done means

- `npm run build` clean, `npm run test:run` green, no `src/tools/`, no MCP SDK in `package.json`.
- `node -e "import('brightspace-api').then(m => console.log(Object.keys(m)))"` from a `npm pack`
  install lists `createBrightspaceClient`, `BrightspaceClient`, the error classes.
- With no saved session and default options, `client.getMyCourses()` rejects with
  `BrightspaceAuthExpiredError` within seconds — no browser, no hang.
- README has a runnable script example and the cron story from §5.
- Version `0.1.0`.
