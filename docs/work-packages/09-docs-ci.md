Part of #1. Spec: `docs/CONTRACT.md` §1, §5, §6, §8. **Blocked by #7** (CLI docs also need #8; write them against §6 and adjust if #8 changed a flag).

## Deliverables

1. **`README.md`** — rewritten for a library, not an MCP server. Sections, in order: what it is (one paragraph, read-only, shares config/session with `brightspace-mcp-server`); install (`npm install brightspace-api`, Node 20+, `npx brightspace-api setup` / `brightspace-setup` once); a runnable script example (the §5 snippet, extended to print due dates); the cron story — default `onAuthExpired: "fail"` throws `BrightspaceAuthExpiredError`, what the operator runs, and the `"login"` mode with `BrightspaceMfaPendingError` and a retry; the CLI (§6 table, exit codes, a shell example piping `brightspace due --days 3` into `jq`); the API reference table (every method → args → result, one line each, linking to the exported types); errors table (every code, when it is thrown); configuration (the same `~/.brightspace-mcp/config.json`, env overrides, course filters); schools supported; security notes (read-only, no password argument, secrets never in logs); relationship to `brightspace-mcp-server` (this package is the data layer; the MCP server is the chat-client wrapper). Keep the MIT license and author lines.
2. **`CHANGELOG.md`** — `0.1.0`: first release, extracted from brightspace-mcp-server 3.6.1, what is and is not included.
3. **`.github/workflows/ci.yml`** — copy the MCP server's matrix (ubuntu/macos/windows × node 20/22: `npm ci`, `npm run build`, `npm run test:run`), adjusted for this package (no MCP smoke test). No publish workflow in this issue.
4. **`docs/`** — keep `CONTRACT.md` (it is the design record); add nothing else unless the README needs a figure.
5. Remove any remaining sentence anywhere in the repo that says "MCP server" about this package (grep `MCP`), except the relationship paragraph.

## Done

README renders on GitHub with working relative links; `ci.yml` runs green on the matrix for the `main` commit that closes this issue.
