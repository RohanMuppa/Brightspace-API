# Changelog

All notable changes to `brightspace-api` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Added

- TU Delft NetID sign-in via SURFconext: `--tudelft` in the setup wizard selects
  `https://brightspace.tudelft.nl` and prompts for a NetID instead of an email address. The
  flow is headless username/password sign-in only, including automatic re-authentication when
  the saved session expires; it does not support MFA or any other interactive step. Ported
  from [RohanMuppa/brightspace-mcp-server#65](https://github.com/RohanMuppa/brightspace-mcp-server/pull/65).

### Fixed

- `downloadFile` (and `brightspace download`) can now save files over 50 MB, such as large
  lecture decks. The body is streamed to a hidden `.download-<uuid>.part` file in the download
  directory, its type is checked there against the same allowlist, and it is then renamed into
  place (with the usual `name(1).ext` conflict handling); a refused or failed download leaves no
  partial file behind. The cap is now 2 GB, checked against the listed size, `Content-Length`,
  and the bytes actually received; a body that grows past it mid-stream fails with
  `BrightspaceDownloadError` kind `tooLarge`. File downloads also time out only when the transfer
  stalls for the request timeout, not when it simply takes longer than that in total. In-memory
  reads (`getSyllabus` text extraction) keep the 50 MB limit. Ported from
  [RohanMuppa/brightspace-mcp-server#164](https://github.com/RohanMuppa/brightspace-mcp-server/pull/164).
- A malformed `D2L_TOKEN_TTL` (`abc`, `0`, `-5`, `1h`) no longer makes every saved token look
  expired and re-mint on each call. Only a positive whole number of seconds is honoured; anything
  else is ignored with a warning on stderr and falls back to `tokenTtl` in `config.json`, then
  `3600`. A hand-edited `tokenTtl` in `config.json` gets the same check, and a `TokenManager`
  constructed with an invalid `tokenTtl` (directly or through `createBrightspaceClient({ config })`)
  warns and uses `3600`. Ported from
  [RohanMuppa/brightspace-mcp-server#55](https://github.com/RohanMuppa/brightspace-mcp-server/issues/55).
- A 429 whose `Retry-After` is an HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`) is no longer
  retried almost immediately. The header is now read as RFC 9110 allows: delta-seconds, or an
  HTTP-date converted to the seconds remaining, rounded up. A date that has already passed, or a
  value that is neither form (`10abc`), is ignored and the normal backoff applies instead of a
  misread wait. JSON requests and file downloads share the same parser, and the `RateLimitError`
  message states the wait for the date form too. Ported from
  [RohanMuppa/brightspace-mcp-server#57](https://github.com/RohanMuppa/brightspace-mcp-server/issues/57).
- `D2L_HEADLESS` and `D2L_ACTIVE_ONLY` are now read as real booleans: `true`/`1`/`yes`/`on` and
  `false`/`0`/`no`/`off`, case-insensitive with surrounding whitespace ignored. Previously
  anything other than the exact string `false` (including `0`, `no`, `False`, and typos) was read
  as true. An empty value counts as unset, and an unrecognized value is ignored with a
  `[config] Ignoring …` warning on stderr so `config.json` or the default applies
  ([RohanMuppa/brightspace-mcp-server#67](https://github.com/RohanMuppa/brightspace-mcp-server/issues/67)).

## 0.1.0 — first release

Extracted from [`brightspace-mcp-server`](https://github.com/RohanMuppa/brightspace-mcp-server)
3.6.1 ([RohanMuppa/brightspace-mcp-server#35](https://github.com/RohanMuppa/brightspace-mcp-server/issues/35))
into a standalone, programmatic client. See `docs/CONTRACT.md` for the full design record.

### Included

- `createBrightspaceClient()` and `BrightspaceClient`, exposing 15 read-only methods:
  `getMyCourses`, `getUpcomingDueDates`, `getMyGrades`, `getAssignments`, `getAssignmentFiles`,
  `downloadFile`, `getAnnouncements`, `getAnnouncementFiles`, `getCourseContent`, `getSyllabus`,
  `getDiscussions`, `getRoster`, `getClasslistEmails`, `getVideoTranscript`, `getInfo`.
- A stable public error contract (`src/errors.ts`): `BrightspaceError` and its subclasses, each
  with a stable `code`, and `toPublicError()` for mapping internal failures at any boundary.
- Package entry points: `"."`, `"./errors"`, `"./auth"` (`TokenManager`, `BrowserAuth`,
  `AuthRunner`), and `"./package.json"`.
- `brightspace-auth` and `brightspace-setup` executables, carried over from the MCP server for
  interactive re-authentication and first-time configuration.
- Reads the same configuration and saved session as `brightspace-mcp-server`
  (`~/.brightspace-mcp/config.json`, the native credential store, `~/.d2l-session/`), so an
  existing MCP server user can start scripting without signing in again.
- Support for Purdue's Microsoft Entra sign-in flow and the shared SUNY Brightspace site.

### Not included

- The `brightspace` CLI (`src/cli.ts`) — tracked separately; see `docs/CONTRACT.md` §6.
- The Model Context Protocol server and SDK dependency, `src/tools/` (MCP tool wrappers),
  self-update and update-checker utilities, and MCP-client configuration in `setup.ts` — these
  remain in `brightspace-mcp-server` and are not part of this package.
- Any write, submit, grade, or otherwise mutating operation — this package is read-only.
- A publish/release workflow — out of scope for this release.
