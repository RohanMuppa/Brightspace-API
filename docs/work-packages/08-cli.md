Part of #1. Spec: `docs/CONTRACT.md` §6. **Blocked by #7.**

## Deliverables

1. **`src/cli.ts`**, bin `brightspace` in `package.json`. No CLI framework — `node:util` `parseArgs` is enough. Subcommands, flags, and the method each maps to exactly as the §6 table; `--help` at the top level and per command lists them with one line each.
2. **Output contract.** Result → `JSON.stringify(result)` (compact) on **stdout**, exit `0`. Nothing else ever goes to stdout: set the logger to `WARN` and route it to stderr (it already is), and guard `console.log` the way the MCP server's `enableStdoutGuard` did if any dependency is noisy.
3. **Error contract.** Every failure is caught, mapped through `toPublicError`, printed as `{"error":{"code":…,"message":…}}` on **stderr**, and exits `2` for `BRIGHTSPACE_AUTH_EXPIRED`, `3` for `BRIGHTSPACE_MFA_PENDING`, `4` for `BRIGHTSPACE_INVALID_ARGUMENT`, `1` otherwise. Unknown subcommand or bad flag → `4` with a usage line.
4. **`--login`** on any command → `createBrightspaceClient({ onAuthExpired: "login", onMfaChallenge })`, printing `MFA number: NN` (or the approve-on-phone line) on stderr as it arrives.
5. **Tests** — `tests/client/cli.test.ts`: argv parsing for every subcommand (fake the facade with an injected factory so no config or network is touched); the stdout/stderr split; each exit code; `--help` output names every command. Plus one real-process test that spawns `node build/cli.js info` with `D2L_SESSION_DIR` at an empty temp dir and asserts a JSON result on stdout (info needs no session) and `node build/cli.js courses` exits `2` with a JSON error on stderr.

## Done

`npm run build`, full suite green; `npx brightspace --help` from a `npm pack` install prints the command list; the two real-process tests pass on the CI matrix.
