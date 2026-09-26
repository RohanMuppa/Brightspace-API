Part of #1. Spec: `docs/CONTRACT.md` §1, §4, §5, §7.

## Deliverables

1. **`src/client/index.ts`** — `createBrightspaceClient(options?)` and `class BrightspaceClient` exactly as §5 specifies.
   - Construction mirrors the MCP server's `src/index.ts` at the seed commit (`eb5b491`, see `git show eb5b491:src/index.ts`): `loadConfig()` unless `options.config` is given; `new TokenManager({ sessionDir, baseUrl, tokenTtl })`; `new D2LApiClient({ baseUrl, tokenManager, onAuthExpired })`.
   - `onAuthExpired: "fail"` (default) → pass `undefined` to the API client so its 401 `ApiError` propagates; the boundary maps it to `BrightspaceAuthExpiredError`. `"login"` → `new AuthRunner({ onProgress })` and `onAuthExpired: () => authRunner.run()`. `onMfaChallenge` is not something `AuthRunner` exposes today: derive it from the runner's rejection (`AuthProcessError` kind `mfaPending`, `numberMatch`) and call it before rethrowing; if a cleaner hook needs one small addition to `AuthRunner`, make it, keep its tests green.
   - `logLevel` → `setLogLevel()` from `src/utils/logger.ts`; default `"WARN"`.
   - Build one `FeatureContext` (`{ api, config, version }`; version read from `package.json` the way `src/index.ts` did) and keep it on the instance.
   - Wire **only `getMyCourses`** now (the reference feature exists). Leave a single clearly marked block where #7 adds the other fourteen methods; every method is one line: `try { return await fn(this.ctx, args) } catch (e) { throw toPublicError(e) }`. Put that wrapping in one private helper so #7's lines are trivial.
   - `readonly config`, `readonly api` exposed as §5 says.
2. **`src/index.ts`** — the public entry: re-export `createBrightspaceClient`, `BrightspaceClient`, `BrightspaceClientOptions`, everything from `./errors.js`, `Course`/`GetMyCoursesArgs` from `./features/courses.js`, and `AppConfig`/`TokenData` from `./types/index.js`. (#7 adds the other feature types.)
3. **`package.json`** — `name: "brightspace-api"`, `version: "0.1.0"`, description for a library, `exports` map from §1 (`"."`, `"./errors"`, `"./auth"`, `"./package.json"`), `main`/`types` → `build/index.js`/`build/index.d.ts` (turn `declaration` back on in `tsconfig.json` — this is a library now; keep `sourceMap`/`declarationMap` off), `bin` = `brightspace-auth`, `brightspace-setup` (the `brightspace` bin is added by #8), remove `@modelcontextprotocol/sdk` from `dependencies` (`npm uninstall`), drop the `start` script, keep `postinstall`. `files`: `build`, `README.md`, `LICENSE`. Regenerate `package-lock.json`.
4. **`src/utils/commands.ts`** — `PACKAGE_NAME = "brightspace-api"`. Fix any test that hard-codes the old name (grep `brightspace-mcp-server` in `tests/`; the ones that read the constant need nothing).
5. **`src/auth-cli.ts`** — remove the `reexecLatestIfStale`, `initUpdateChecker`/`peekUpdateNotice`, and `detectSkew` calls and their imports (those utils are deleted in #7; just stop using them here). Everything else stays.
6. **`src/setup.ts`** — remove the MCP-client configuration step (`configureMcpClient` and the Claude/Cursor/Codex config writes) and the `./utils/mcp-client-cli.js` import; the wizard still saves school, username, password (native store), MFA choice. Update `tests/utils/setup-wizard.test.ts` accordingly (drop the client-config cases, keep the rest).
7. **Tests** — `tests/client/facade.test.ts`: with a fake `loadConfig`/injected `config` and a fake API client, `getMyCourses` returns objects; an `ApiError(401)` from the API becomes `BrightspaceAuthExpiredError` with code `BRIGHTSPACE_AUTH_EXPIRED` under `"fail"`; under `"login"` an `AuthProcessError("mfaPending", …, "47")` from the runner becomes `BrightspaceMfaPendingError` with `numberMatch "47"` and `onMfaChallenge` is called with `"47"`; a `ZodError` becomes `BrightspaceInvalidArgumentError`. `tests/client/errors.test.ts`: one case per branch of `toPublicError` (codes, no raw message leakage — assert the mapped message does not contain the internal error's text). No network anywhere.

## Do not touch

`src/tools/*` (other packages convert and delete them), `src/utils/{update-checker,self-update,install-sites,mcp-client-cli}.ts` and their tests (deleted in #7), `src/features/*` other than reading `courses.ts`.

## Done

`npx tsc --noEmit` clean on the branch; `npx vitest run tests/client tests/features tests/utils/setup-wizard.test.ts tests/auth` green; `node -e "import('./build/index.js').then(m=>console.log(Object.keys(m)))"` after `npm run build` lists `createBrightspaceClient`, `BrightspaceClient`, and the error classes.
