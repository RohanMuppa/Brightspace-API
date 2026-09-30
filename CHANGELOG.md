# Changelog

All notable changes to `brightspace-api` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Fixed

- A malformed `D2L_TOKEN_TTL` (`abc`, `0`, `-5`, `1h`) no longer makes every saved token look
  expired and re-mint on each call. Only a positive whole number of seconds is honoured; anything
  else is ignored with a warning on stderr and falls back to `tokenTtl` in `config.json`, then
  `3600`. A hand-edited `tokenTtl` in `config.json` gets the same check, and a `TokenManager`
  constructed with an invalid `tokenTtl` (directly or through `createBrightspaceClient({ config })`)
  warns and uses `3600`. Ported from
  [RohanMuppa/brightspace-mcp-server#55](https://github.com/RohanMuppa/brightspace-mcp-server/issues/55).

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
