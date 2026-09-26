Part of #1. Spec: `docs/CONTRACT.md` §2, §5, §7, §8. **Blocked by #2, #3, #4, #5, #6** — start only when all five are merged to `main`.

## Deliverables

1. **Wire the facade.** In `src/client/index.ts`, add the fourteen remaining methods from §5 in the marked block, each the one-line wrap #2 established, importing from the feature modules #3–#6 created. Method names and argument/result types exactly as the §3/§5 tables.
2. **Public types.** In `src/index.ts`, re-export every `*Args` and result type from every feature module so a script can type its variables without deep imports.
3. **Delete the MCP layer.** `src/tools/` (whatever remains — should be only `tool-helpers.ts`), `tests/tools/`, `src/utils/update-checker.ts`, `src/utils/self-update.ts`, `src/utils/install-sites.ts`, `src/utils/mcp-client-cli.ts`, and their tests (`tests/utils/{update-checker,self-update,install-sites,mcp-client-cli}.test.ts`, `tests/tools/tool-helpers*.test.ts`). Grep for any remaining import of them and of `@modelcontextprotocol` — there must be none.
4. **Verify §8.** `npm run build` clean; `npm run test:run` green; `npm pack --dry-run` lists only `build/`, `README.md`, `LICENSE`, `package.json`; from a temp directory, `npm install <tarball>` then `node -e "import('brightspace-api').then(m=>console.log(Object.keys(m)))"` lists `createBrightspaceClient`, `BrightspaceClient`, and every error class; with `D2L_SESSION_DIR` pointed at an empty temp dir and a minimal config, `createBrightspaceClient().then(c=>c.getMyCourses())` rejects with code `BRIGHTSPACE_AUTH_EXPIRED` within a few seconds and opens no browser.
5. **Tests.** `tests/client/facade.test.ts` gains one case per method proving it delegates to its feature and maps errors through `toPublicError` (a table-driven test is fine).
6. `tests/release/npm-pack.test.ts` and `remediation-commands.test.ts`: update expectations for the new package name and bins; keep them.

## Done

All of §8 true on `main`; version stays `0.1.0` (set in #2).
