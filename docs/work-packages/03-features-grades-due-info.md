Part of #1. Spec: `docs/CONTRACT.md` §3 — follow every numbered rule; `src/features/courses.ts` and `tests/features/courses.test.ts` are the shape to copy.

## Convert

| From (delete) | To (create) | Function | Result type |
|---|---|---|---|
| `src/tools/get-my-grades.ts` + `tests/tools/get-my-grades.test.ts` | `src/features/grades.ts` + `tests/features/grades.test.ts` | `getMyGrades(ctx, args?)` | `CourseGrades[]` |
| `src/tools/get-upcoming-due-dates.ts` + `tests/tools/get-upcoming-due-dates.test.ts` | `src/features/due-dates.ts` + `tests/features/due-dates.test.ts` | `getUpcomingDueDates(ctx, args?)` | `UpcomingItem[]` |
| `src/tools/get-server-info.ts` + `tests/tools/get-server-info.test.ts` | `src/features/info.ts` + `tests/features/info.test.ts` | `getInfo(ctx)` | `ClientInfo` |

## Notes per module

- **grades**: the tool paginates enrollments and honours `activeOnly` (fixed in brightspace-mcp-server#43) — keep that; export `CourseGrades` and the nested grade item type with the same keys the tool emitted.
- **due-dates**: keep the three sources (dropbox folders, quizzes `DueDate ?? EndDate`, discussion topics with a `DueDate`, hidden forums excluded), the `daysAhead` window, the sort, and `UpcomingItem { type: "assignment" | "quiz" | "discussion", id, name, url, courseId, courseName, dueDate }`. Per-course failures stay isolated (`allSettled`) exactly as today.
- **info**: the tool reported version, runtime, and config location for support. Rename the result `ClientInfo`; drop anything MCP-specific (tool counts, server name); `version` comes from `ctx.version`.

Schemas already live in `src/features/schemas.ts` (`GetMyGradesSchema`, `GetUpcomingDueDatesSchema`, `GetServerInfoSchema` — rename the last to `GetInfoSchema` if you touch it, updating its one import).

## Done

The three old files and their tests are deleted; `npx tsc --noEmit` clean on the branch; `npx vitest run tests/features` green with every behaviour the old tests pinned still asserted, now on returned objects.
