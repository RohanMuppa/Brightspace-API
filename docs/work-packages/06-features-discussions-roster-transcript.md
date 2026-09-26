Part of #1. Spec: `docs/CONTRACT.md` §3 — follow every numbered rule; `src/features/courses.ts` and `tests/features/courses.test.ts` are the shape to copy.

## Convert

| From (delete) | To (create) | Function | Result type |
|---|---|---|---|
| `src/tools/get-discussions.ts` + `tests/tools/get-discussions.test.ts` | `src/features/discussions.ts` + `tests/features/discussions.test.ts` | `getDiscussions(ctx, args)` | `DiscussionsResult` |
| `src/tools/get-roster.ts` + `tests/tools/get-roster.test.ts` | `src/features/roster.ts` + `tests/features/roster.test.ts` | `getRoster(ctx, args)` | `RosterResult` |
| `src/tools/get-classlist-emails.ts` + `tests/tools/get-classlist-emails.test.ts` | `src/features/classlist-emails.ts` + `tests/features/classlist-emails.test.ts` | `getClasslistEmails(ctx, args)` | `ClasslistEmailsResult` |
| `src/tools/get-video-transcript.ts` + `tests/tools/get-video-transcript.test.ts` | `src/features/transcript.ts` + `tests/features/transcript.test.ts` | `getVideoTranscript(ctx, args)` | `VideoTranscriptResult` |

## Notes per module

- **discussions**: three shapes today (course overview of forums+topics, a forum's topics, a topic's posts) selected by which ids are passed — keep that in one function returning a discriminated union or a result with optional sections, whichever keeps the tool's keys unchanged; posts are markdown-only. Hidden forums handling as today.
- **roster**: keep `limit`, the truncation report, and the field set.
- **classlist-emails**: keep the field set and any filtering.
- **transcript**: uses `src/utils/transcript/*` (unchanged). `NoTranscriptError` / `TranscriptFetchError` propagate (the boundary maps them); keep the platform detection with the exact-host matching from brightspace-mcp-server#48 (already in the seed) and the result keys.

If a test file for one of these does not exist under `tests/tools/`, write a `tests/features/` test that pins the returned shape with a fake `api`.

## Done

The four old files and their tests are deleted; `npx tsc --noEmit` clean on the branch; `npx vitest run tests/features tests/utils/transcript` green with every behaviour the old tests pinned still asserted, now on returned objects or thrown errors.
