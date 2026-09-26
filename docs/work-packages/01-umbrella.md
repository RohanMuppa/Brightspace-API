## Goal

Turn this repo — seeded from `brightspace-mcp-server` 3.6.1 — into **`brightspace-api`**: a documented, read-only programmatic client for D2L Brightspace that scripts and cron jobs import directly, with no MCP client and no model in the loop. Origin: RohanMuppa/brightspace-mcp-server#35.

The spec is [`docs/CONTRACT.md`](docs/CONTRACT.md) on `main`. Every issue below cites its sections. `src/features/courses.ts` + `tests/features/courses.test.ts` are the worked example every feature conversion copies.

## Work packages

Parallel now (disjoint files, each on its own branch, each PR says `Fixes #N`):

- [ ] #2 core — client facade, error boundary wiring, package identity, MCP removal in `auth-cli`/`setup` (§1, §4, §5, §7)
- [ ] #3 features — `grades`, `due-dates`, `info` (§3)
- [ ] #4 features — `assignments`, `assignment-files`, `download` (§3)
- [ ] #5 features — `announcements`, `announcement-files`, `content`, `syllabus` (§3)
- [ ] #6 features — `discussions`, `roster`, `classlist-emails`, `transcript` (§3)

After all five land:

- [ ] #7 integration — wire every feature into the facade, delete `src/tools/` and the MCP-only utils, verify §8 (§2, §7, §8)

After #7:

- [ ] #8 the `brightspace` CLI (§6)
- [ ] #9 README, CHANGELOG, CI workflow (§8)

## Rules that apply to every package

- Read `docs/CONTRACT.md` first; it wins over any memory of the MCP server.
- Behaviour parity: same data the MCP tool returned, as real objects. Refactor, not redesign.
- Read-only. Nothing submits, posts, or modifies anything in Brightspace.
- Credentials never enter through options or arguments.
- `npx tsc --noEmit` and the tests you own must be green on your branch; the full suite is checked at integration. The tree may not type-check globally while other packages are in flight — that is expected.
- No commit trailers.

## Done

`npm run build` clean, `npm run test:run` green, no `src/tools/`, no `@modelcontextprotocol/sdk`, README with a runnable example, version `0.1.0`.
