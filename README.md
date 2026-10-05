# brightspace-api

> **By [Rohan Muppa](https://github.com/rohanmuppa), ECE @ Purdue**

A documented, read-only, programmatic client for D2L Brightspace. Scripts, cron jobs, and
other Node programs import it directly to read courses, grades, due dates, assignments,
announcements, syllabus, discussions, roster, and course content — no chat client in the way.
It shares its configuration and saved sign-in session with
[`brightspace-mcp-server`](https://github.com/RohanMuppa/brightspace-mcp-server) (see
[Relationship to brightspace-mcp-server](#relationship-to-brightspace-mcp-server)), so a user
who has already run that project's `setup` wizard can start scripting immediately.

Connects to D2L Brightspace. Automatic login supports Purdue's Microsoft Entra flow, SUNY
campus selection, and TU Delft NetID via SURFconext. Other schools need a compatible automated
sign-in flow; unsupported login pages return an actionable error.

## Install

**You need:** [Node.js 20+](https://nodejs.org/) and an available native credential store:
macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux requires
`secret-tool` and an unlocked desktop keyring (install `libsecret-tools` on Debian/Ubuntu).

```bash
npm install brightspace-api
```

Run the setup wizard once, from a terminal, to save your school URL and credentials:

```bash
npx brightspace-setup            # after npm install
npx -y brightspace-api@latest setup   # without installing first
```

Purdue students can add `--purdue` to skip entering the school URL; SUNY campuses can add
`--suny`; TU Delft students can add `--tudelft` (use your NetID, not your student email
address). If you already run `brightspace-mcp-server` on this machine, you can skip this step —
the two packages read the same `~/.brightspace-mcp/config.json` and the same session under
`~/.d2l-session/`.

## Quick start

```ts
import { createBrightspaceClient, BrightspaceAuthExpiredError } from "brightspace-api";

const client = await createBrightspaceClient();

try {
  const dueDates = await client.getUpcomingDueDates({ daysAhead: 7 });

  if (dueDates.length === 0) {
    console.log("Nothing due in the next 7 days.");
  } else {
    for (const item of dueDates) {
      const due = new Date(item.dueDate).toLocaleString();
      console.log(`${due}  [${item.type}]  ${item.title}  (${item.courseName ?? item.courseId})`);
    }
  }
} catch (error) {
  if (error instanceof BrightspaceAuthExpiredError) {
    console.error(error.message); // tells the operator to run `brightspace-auth`
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

## The cron story

By default (`onAuthExpired: "fail"`, which is what `createBrightspaceClient()` uses with no
options), a call that needs a session which has expired and cannot be silently renewed over
HTTPS throws `BrightspaceAuthExpiredError` immediately — no browser is opened, nothing hangs.
This is the mode a scheduled job should use: a cron job cannot answer a phone.

```ts
import { createBrightspaceClient, BrightspaceAuthExpiredError } from "brightspace-api";

const client = await createBrightspaceClient(); // onAuthExpired: "fail" is the default

try {
  const courses = await client.getMyCourses();
  console.log(JSON.stringify(courses));
} catch (error) {
  if (error instanceof BrightspaceAuthExpiredError) {
    // error.message already tells the operator which command re-authenticates
    // (npx brightspace-auth) — print it and let the next scheduled run retry.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
```

A process that is allowed to open a browser (an interactive script, not a cron job) can pass
`onAuthExpired: "login"` instead. The call then throws `BrightspaceMfaPendingError` as soon as
an MFA challenge appears — the sign-in keeps running in the background, and a retry after you
approve it on your phone succeeds:

```ts
import { createBrightspaceClient, BrightspaceMfaPendingError } from "brightspace-api";

const client = await createBrightspaceClient({
  onAuthExpired: "login",
  onMfaChallenge: (numberMatch) => {
    console.log(numberMatch ? `Enter ${numberMatch} in Microsoft Authenticator` : "Approve the push notification");
  },
});

async function getCoursesRetrying() {
  try {
    return await client.getMyCourses();
  } catch (error) {
    if (error instanceof BrightspaceMfaPendingError) {
      console.log(error.message);
      await new Promise((r) => setTimeout(r, 15_000));
      return getCoursesRetrying(); // retry after approving on your phone
    }
    throw error;
  }
}
```

## CLI

Three executables ship in `node_modules/.bin`: `brightspace` (the read-only JSON CLI, described
below), `brightspace-auth` (interactive re-authentication), and `brightspace-setup` (first-time
configuration). Each subcommand below maps 1:1 to a `BrightspaceClient` method, prints the
method's JSON result to stdout, and exits `0`.

| Command | Maps to |
|---|---|
| `brightspace courses [--all]` | `getMyCourses({ activeOnly: !all })` |
| `brightspace due [--days N] [--course ID]` | `getUpcomingDueDates` |
| `brightspace grades [--course ID]` | `getMyGrades` |
| `brightspace assignments [--course ID]` | `getAssignments` |
| `brightspace announcements [--course ID] [--count N] [--since ISO]` | `getAnnouncements` |
| `brightspace announcement-files --course ID --news ID [--file ID] [--max-chars N]` | `getAnnouncementFiles` |
| `brightspace assignment-files --course ID --folder ID [--file ID] [--max-chars N]` | `getAssignmentFiles` |
| `brightspace content --course ID [--type T] [--module TITLE] [--depth N] [--since ISO]` | `getCourseContent` |
| `brightspace syllabus --course ID` | `getSyllabus` |
| `brightspace discussions --course ID [--forum ID] [--topic ID]` | `getDiscussions` |
| `brightspace roster --course ID [--limit N]` | `getRoster` |
| `brightspace emails --course ID` | `getClasslistEmails` |
| `brightspace download --course ID (--topic ID \| --folder ID --file ID \| --news ID --file ID) --dir PATH [--name NAME]` | `downloadFile` |
| `brightspace transcript --course ID --topic ID` (or `--url URL`) | `getVideoTranscript` |
| `brightspace info` | `getInfo` |
| `brightspace auth` | sign in once (opens the MFA flow); same as `brightspace-auth` |
| `brightspace setup` | save school and credentials; same as `brightspace-setup` |
| `brightspace --help` / `<command> --help` | usage |

Errors go to **stderr** as `{"error":{"code":…,"message":…}}`, and stdout carries only the
JSON result — safe to pipe into `jq`:

```bash
brightspace due --days 3 | jq -r '.[] | "\(.dueDate)\t\(.title)"'
```

Exit codes: `2` for `BRIGHTSPACE_AUTH_EXPIRED`, `3` for `BRIGHTSPACE_MFA_PENDING`, `4` for
`BRIGHTSPACE_INVALID_ARGUMENT`, `1` for anything else. Add `--login` to any command to switch
to `onAuthExpired: "login"` and print the MFA number to stderr as it arrives.

> The CLI (`src/cli.ts`) was still landing on a separate branch as this document was written.
> Re-check the flags above against `src/cli.ts` once it merges — this table is transcribed
> from `docs/CONTRACT.md` §6, not from the executable.

## API reference

All methods live on the object `createBrightspaceClient()` resolves to. Every method throws a
`BrightspaceError` subclass (see [Errors](#errors)) instead of returning one.

| Method | Args | Result |
|---|---|---|
| `getMyCourses(args?)` | `GetMyCoursesArgs` — `activeOnly?: boolean` | `Course[]` |
| `getUpcomingDueDates(args?)` | `GetUpcomingDueDatesArgs` — `daysAhead?: number` (default 7), `courseId?: number` | `UpcomingItem[]` |
| `getMyGrades(args?)` | `GetMyGradesArgs` — `courseId?: number` | `CourseGrades[]` |
| `getAssignments(args?)` | `GetAssignmentsArgs` — `courseId?: number` | `AssignmentsResult` |
| `getAssignmentFiles(args)` | `GetAssignmentFilesArgs` — `courseId`, `folderId?`, `fileId?`, `extractText?` (default true), `maxChars?` (default 12000) | `AssignmentFilesResult` |
| `downloadFile(args)` | `DownloadFileArgs` — `courseId`, `topicId?` \| `folderId?`/`fileId?` \| `newsId?`/`fileId?`, `downloadPath`, `customFilename?` | `DownloadResult` |
| `getAnnouncements(args?)` | `GetAnnouncementsArgs` — `courseId?: number`, `count?` (default 10), `modifiedSince?: string` | `Announcement[] \| AnnouncementsFiltered` |
| `getAnnouncementFiles(args)` | `GetAnnouncementFilesArgs` — `courseId`, `newsId?`, `fileId?`, `extractText?` (default true), `maxChars?` (default 12000) | `AnnouncementFilesResult` |
| `getCourseContent(args)` | `GetCourseContentArgs` — `courseId`, `typeFilter?` (default `"all"`), `moduleTitle?`, `maxDepth?`, `modifiedSince?` | `CourseContentResult` |
| `getSyllabus(args)` | `GetSyllabusArgs` — `courseId`, `downloadPath?` | `SyllabusResult` |
| `getDiscussions(args)` | `GetDiscussionsArgs` — `courseId`, `forumId?`, `topicId?` | `DiscussionsResult` |
| `getRoster(args)` | `GetRosterArgs` — `courseId`, `includeStudents?` (default false), `searchTerm?`, `limit?` (default 100) | `RosterResult` |
| `getClasslistEmails(args)` | `GetClasslistEmailsArgs` — `courseId` | `ClasslistEmailsResult` |
| `getVideoTranscript(args)` | `GetVideoTranscriptArgs` — `courseId?`, `topicId?`, `videoUrl?`, `offset?` (default 0), `maxChars?` (default 12000) | `VideoTranscriptResult` |
| `getInfo()` | — | `ClientInfo` |

Every argument and result type is exported from `brightspace-api`'s root entry point. The
`api` property on the returned client (`client.api`, type `D2LApiClient`) is an escape hatch
for making raw, authenticated D2L API calls the facade doesn't cover — it is not part of the
stable contract in the same way the 15 methods above are.

## Errors

Every error the client or CLI throws is a `BrightspaceError` subclass with a stable `code`.
Scripts should branch on `code`; people should read `message`.

| Code | Class | When |
|---|---|---|
| `BRIGHTSPACE_AUTH_EXPIRED` | `BrightspaceAuthExpiredError` | The saved session is gone and the call was not allowed to open a browser (`onAuthExpired: "fail"`, the default). |
| `BRIGHTSPACE_MFA_PENDING` | `BrightspaceMfaPendingError` | With `onAuthExpired: "login"`, a browser sign-in is waiting on an MFA approval or number match. `numberMatch` carries the digits when the tenant shows one. |
| `BRIGHTSPACE_AUTH_FAILED` | `BrightspaceAuthFailedError` | A browser sign-in ran and did not produce a session. `kind` says why (`busy`, `cooldown`, `unsupported`, `secureStorage`, `transport`, `timeout`, `failed`). |
| `BRIGHTSPACE_NOT_FOUND` | `BrightspaceNotFoundError` | The course or item doesn't exist, you don't have access, or (for `getVideoTranscript`) no transcript is available. |
| `BRIGHTSPACE_FORBIDDEN` | `BrightspaceForbiddenError` | Brightspace returned HTTP 403 for the request. |
| `BRIGHTSPACE_RATE_LIMITED` | `BrightspaceRateLimitedError` | Brightspace rate-limited the request. |
| `BRIGHTSPACE_NETWORK` | `BrightspaceNetworkError` | The connection to Brightspace (or, for transcripts, the video platform) failed, or a token could not be silently renewed. |
| `BRIGHTSPACE_INVALID_ARGUMENT` | `BrightspaceInvalidArgumentError` | Arguments failed schema validation. `issues` is an array of `"path: message"` strings. |
| `BRIGHTSPACE_DOWNLOAD_FAILED` | `BrightspaceDownloadError` | `downloadFile` or `getSyllabus` refused to save a file. `kind` says why (`unsupportedType`, `undetectableType`, `badFilename`, `pathTraversal`, `tooLarge`). |
| `BRIGHTSPACE_API_ERROR` | `BrightspaceApiError` | Brightspace returned some other non-2xx status. `status` carries the HTTP code. |
| `BRIGHTSPACE_UNEXPECTED` | `BrightspaceError` | Anything else. |

`toPublicError`, exported from `brightspace-api/errors`, is the function that performs this
mapping; you should not normally need to call it yourself.

## Configuration

The client reads the same configuration as `brightspace-mcp-server`, resolved in this order
(environment variable, then `~/.brightspace-mcp/config.json`, then a built-in default):

| Setting | Env override | Config key | Default |
|---|---|---|---|
| School URL | `D2L_BASE_URL` | `baseUrl` | `https://purdue.brightspace.com` |
| Username | `D2L_USERNAME` | `username` | — |
| Session directory | `D2L_SESSION_DIR` | `sessionDir` | `~/.d2l-session` |
| Headless sign-in | `D2L_HEADLESS` | `headless` | `true` |
| Token TTL (seconds) | `D2L_TOKEN_TTL` | `tokenTtl` | `3600` |
| Only active courses | `D2L_ACTIVE_ONLY` | `activeOnly` | `true` |
| Include only these course IDs | `D2L_INCLUDE_COURSES` (comma-separated) | `includeCourses` | — |
| Exclude these course IDs | `D2L_EXCLUDE_COURSES` (comma-separated) | `excludeCourses` | — |
| Campus (SUNY) | `D2L_CAMPUS` | `campus` | — |

The saved password lives in the OS credential store (macOS Keychain, Windows Credential
Manager, Linux Secret Service), never in `config.json` or an environment variable. A script
can also skip config-file/env resolution entirely by passing a fully-built `AppConfig` as
`createBrightspaceClient({ config })` — there is no `password` option; credentials never enter
through the client's options.

## Schools supported

Automatic sign-in supports Purdue's Microsoft Entra flow, the shared SUNY Brightspace site
(with campus selection), and TU Delft NetID sign-in via SURFconext. Other D2L schools can
still be used — point `baseUrl` at your school's Brightspace URL — but an unsupported login
page returns an actionable `BrightspaceAuthFailedError` (`kind: "unsupported"`) rather than
hanging.

## Security notes

- **Read-only.** No method or CLI command submits, posts, grades, or modifies anything in
  Brightspace.
- **No password option.** Credentials are never accepted through `createBrightspaceClient()`;
  they are only ever read from the native OS credential store, written there by
  `brightspace-setup`.
- **Nothing secret in errors or logs.** `toPublicError` only ever produces text this package
  writes itself, from a closed set of `kind`/status values — never a token, cookie, raw
  Brightspace response body, or child-process output. `log()` writes to stderr only; nothing
  is ever written to stdout except a method's JSON result.

## Relationship to brightspace-mcp-server

`brightspace-api` is the data layer: a typed, read-only client extracted from
[`brightspace-mcp-server`](https://github.com/RohanMuppa/brightspace-mcp-server) 3.6.1 so it
can be used outside of an MCP client. `brightspace-mcp-server` is the chat-client wrapper — it
depends on the Model Context Protocol SDK and exposes these same operations as MCP tools to
Claude Desktop, Claude Code, Cursor, and similar assistants. The two packages share
configuration (`~/.brightspace-mcp/config.json`) and saved session state (`~/.d2l-session/`),
so setting up one lets the other run without a second sign-in.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Rohan Muppa.
