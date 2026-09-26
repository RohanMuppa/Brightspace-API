Part of #1. Spec: `docs/CONTRACT.md` §3 — follow every numbered rule; `src/features/courses.ts` and `tests/features/courses.test.ts` are the shape to copy.

## Convert

| From (delete) | To (create) | Function | Result type |
|---|---|---|---|
| `src/tools/get-assignments.ts` + `tests/tools/get-assignments.test.ts` | `src/features/assignments.ts` + `tests/features/assignments.test.ts` | `getAssignments(ctx, args?)` | `AssignmentsResult` |
| `src/tools/get-assignment-files.ts` + `tests/tools/get-assignment-files.test.ts` | `src/features/assignment-files.ts` + `tests/features/assignment-files.test.ts` | `getAssignmentFiles(ctx, args)` | `AssignmentFilesResult` |
| `src/tools/download-file.ts` + `tests/tools/download-file.test.ts` | `src/features/download.ts` + `tests/features/download.test.ts` | `downloadFile(ctx, args)` | `DownloadResult` |

## Notes per module

- **assignments**: `fetchCourseAssignments` is already an exported, MCP-free helper — keep it exported from the new module (it is the bulk of the logic). Preserve the per-folder submissions/feedback lookups, quiz attempts with the 403 short-circuit, rubric output, `gradeOnly` items, enrollment pagination and `activeOnly`. Export the item types (dropbox item, quiz item, gradeOnly item) with the same keys.
- **assignment-files**: uses `src/features/attachment-reader.ts` (already moved). Keep `extractText`, `maxChars`, `truncated` semantics and the `fileKind` export.
- **download**: three sources — `topicId`, `folderId`+`fileId`, `newsId`+`fileId` — through `secureDownload`, `MAX_FILE_SIZE` checks before and after the body, `Content-Disposition` via `parseContentDispositionFilename` (keep that export). Where the tool returned `errorResponse(...)` for a bad argument combination, throw `BrightspaceInvalidArgumentError([...])`; for "file ID not found … Available files: …" throw `BrightspaceNotFoundError(thatMessage)`; a `DownloadError` from `secureDownload` propagates untouched. `DownloadResult` = `{ success: true, filePath, fileSize, mimeType, originalFilename, message }` as today.

## Done

The three old files and their tests are deleted; `npx tsc --noEmit` clean on the branch; `npx vitest run tests/features` green with every behaviour the old tests pinned (including the path-traversal and oversize refusals) still asserted, now on returned objects or thrown errors.
