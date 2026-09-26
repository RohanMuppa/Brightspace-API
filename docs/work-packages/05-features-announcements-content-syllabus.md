Part of #1. Spec: `docs/CONTRACT.md` §3 — follow every numbered rule; `src/features/courses.ts` and `tests/features/courses.test.ts` are the shape to copy.

## Convert

| From (delete) | To (create) | Function | Result type |
|---|---|---|---|
| `src/tools/get-announcements.ts` + `tests/tools/get-announcements.test.ts` | `src/features/announcements.ts` + `tests/features/announcements.test.ts` | `getAnnouncements(ctx, args?)` | `Announcement[] \| AnnouncementsFiltered` |
| `src/tools/get-announcement-files.ts` + `tests/tools/get-announcement-files.test.ts` | `src/features/announcement-files.ts` + `tests/features/announcement-files.test.ts` | `getAnnouncementFiles(ctx, args)` | `AnnouncementFilesResult` |
| `src/tools/get-course-content.ts` + `tests/tools/get-course-content.test.ts` | `src/features/content.ts` + `tests/features/content.test.ts` | `getCourseContent(ctx, args)` | `CourseContentResult` |
| `src/tools/get-syllabus.ts` + `tests/tools/get-syllabus.test.ts` | `src/features/syllabus.ts` + `tests/features/syllabus.test.ts` | `getSyllabus(ctx, args)` | `SyllabusResult` |

## Notes per module

- **announcements**: keep the exported helpers (`mapNewsItem`, `isPublishedNewsItem`, `effectiveDate`, `newestFirst`), the `attachments` field (omitted when empty), `lastModified`, and the `modifiedSince` behaviour: without it the result is a bare `Announcement[]`; with it, `AnnouncementsFiltered { announcements, modifiedSince, returned, filteredOut }`. Both the single-course and all-courses paths, enrollment pagination, `activeOnly`.
- **announcement-files**: uses `src/features/attachment-reader.ts`; keep the draft filter (`isPublishedNewsItem`), `extractText`/`maxChars`/`truncated`, and throw `BrightspaceNotFoundError` where the tool returned a not-found error response.
- **content**: keep `typeFilter`, `moduleTitle`, `maxDepth`, `modifiedSince` (with `filterTreeByModifiedSince` and the `returned`/`filteredOut` fields), the `/structure/` fallback to the embedded `Structure`, the markdown-only `content` field, and the spread-in-only-when-truthy flags (`isHidden`, `isLocked`, `dueDate`, `completedDate`) with `lastModified` always present. Export `ContentModule`/`ContentTopic` types.
- **syllabus**: keep the overview description as markdown, the attachment fetch + PDF text extraction, `null`-on-absence fields.

## Done

The four old files and their tests are deleted; `npx tsc --noEmit` clean on the branch; `npx vitest run tests/features` green with every behaviour the old tests pinned still asserted, now on returned objects or thrown errors.
