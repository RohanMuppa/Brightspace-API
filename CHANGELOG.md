# Changelog

All notable changes to `brightspace-api` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Fixed

- `getDiscussions` `postCount` now counts only the posts it returns, excluding deleted posts (fixes [#31](https://github.com/RohanMuppa/Brightspace-API/issues/31)).

- With `onAuthExpired: "login"`, a parallel batch of calls against an expired session got the
  same MFA number and the same full instructions back from every call. Now the first call in a
  batch to report a challenge carries it in full (`BrightspaceMfaPendingError` with `numberMatch`
  and the usual guidance); every other call reporting that same challenge gets a short
  `BrightspaceMfaPendingError` saying a sign-in is already in progress, without the number. A call
  arriving after the first report is treated as a retry and gets the number in full again, which
  keeps [#201](https://github.com/RohanMuppa/brightspace-mcp-server/pull/201)'s guarantee that the
  digits always reach someone. Ported from
  [RohanMuppa/brightspace-mcp-server#213](https://github.com/RohanMuppa/brightspace-mcp-server/pull/213)
  (fixes [#27](https://github.com/RohanMuppa/Brightspace-API/issues/27)).

### Added

- Opt-in automatic answering of Microsoft Entra verification-code MFA. `setup` optionally saves an
  authenticator setup key or `otpauth://` link (hidden input, Enter to skip) in the native
  credential store under a `totp:`-prefixed account, read back by `loadConfig` as `totpUri`
  whenever a username is configured (`D2L_TOTP_SECRET` overrides it, for CI and containers with no
  keychain). With `totpUri` set, the Entra MFA loop switches Microsoft to its "Use a verification
  code" method (falling back to "sign in another way", each control clicked at most once per
  login), verifies the account Microsoft is showing before typing anything, and submits an RFC
  6238 code generated locally (`src/auth/totp.ts`) — waiting out a code's remaining lifetime
  rather than submitting one with under five seconds left or resubmitting a rejected one. The gate
  is the identity provider and the challenge on screen, never a school URL: it never engages off
  `login.microsoftonline.com`, after a Duo challenge, or on Microsoft's passwordless approval view,
  and gives up and falls back to the ordinary announce-and-approve path if Entra offers no way to
  reach a code within 30 seconds. A new `automaticPending` failure kind (and
  `BrightspaceAutomaticPendingError`) tells a caller "no phone approval is being requested" instead
  of sending it looking for an approval that will never arrive. Ported from
  [RohanMuppa/brightspace-mcp-server#207](https://github.com/RohanMuppa/brightspace-mcp-server/pull/207)
  (fixes [#33](https://github.com/RohanMuppa/Brightspace-API/issues/33)).

- An opt-in `rememberMfa` setting (`D2L_REMEMBER_MFA` env var, or `rememberMfa` in `config.json`;
  off by default) for remembering this device so later sign-ins can skip the second factor.
  `setup` now asks "Remember this device so later sign-ins can skip the second factor? Not for
  shared computers." (default no) after the MFA step, and `loadConfig` resolves it the same way
  as every other setting: env var, then `config.json`, then `false`. Left unanswered on a repeat
  run, the saved choice for the same school is kept, and dropped when the school changes. Ported
  from [RohanMuppa/brightspace-mcp-server#179](https://github.com/RohanMuppa/brightspace-mcp-server/pull/179)
  (fixes [#12](https://github.com/RohanMuppa/Brightspace-API/issues/12)).

- An opt-in `passwordless` setting (`D2L_PASSWORDLESS` env var, or `passwordless` in
  `config.json`; off by default) signs in with Microsoft Entra's passwordless phone approval
  instead of a saved password. `setup` asks the question before the password step (default no),
  and a yes skips the password prompt and deletes any password saved earlier for the same
  account. `loadConfig` then reads no saved password, the default Entra flow (and the SUNY and
  Western flows that wrap it) submits only the username and waits on Microsoft's approval view
  as an MFA challenge, announcing its number like number match. Every sign-in then needs a phone
  approval, so it suits interactive use, not unattended or scheduled jobs; if Microsoft asks for
  a password anyway, sign-in fails at once with an error naming `D2L_PASSWORDLESS` instead of
  waiting out the timeout. Ported from
  [RohanMuppa/brightspace-mcp-server#206](https://github.com/RohanMuppa/brightspace-mcp-server/pull/206).

- TU Delft NetID sign-in via SURFconext: `--tudelft` in the setup wizard selects
  `https://brightspace.tudelft.nl` and prompts for a NetID instead of an email address. The
  flow is headless username/password sign-in only, including automatic re-authentication when
  the saved session expires; it does not support MFA or any other interactive step. Ported
  from [RohanMuppa/brightspace-mcp-server#65](https://github.com/RohanMuppa/brightspace-mcp-server/pull/65).

### Fixed

- With `onAuthExpired: "login"`, a background sign-in whose MFA number nobody saw (the error was
  swallowed, the script exited, or the call sat in a parallel batch) no longer holds its browser
  and the session's `.auth.lock` for the full 5-minute MFA window. It is stopped 45 seconds after
  the last call that polled it was answered, without starting the MFA cooldown, so the next call
  starts a fresh sign-in. Processes sharing one session directory now share the pending number too:
  the lock owner writes it to `challenge.json` in the lock directory, and a sign-in in another
  process that loses the lock race throws `BrightspaceMfaPendingError` with that number instead of
  `BrightspaceAuthFailedError` (`kind: "busy"`); relaying it keeps the owner's sign-in alive. The
  `BrightspaceMfaPendingError` message now also asks callers not to run Brightspace calls in
  parallel until the sign-in completes. Ported from
  [RohanMuppa/brightspace-mcp-server#201](https://github.com/RohanMuppa/brightspace-mcp-server/pull/201).

- Automatic re-authentication (`onAuthExpired: "login"`) now answers every caller within 55
  seconds of that call starting, including while Chromium is still launching or silent SSO is
  still waiting. Before, a slow sign-in could hold a call for up to 8 minutes. When the budget
  runs out, the call fails with `BrightspaceAuthFailedError` (`kind: "inProgress"`) and the
  sign-in keeps running in the background. Retrying right away joins it, so no second MFA
  prompt is sent. Ported from
  [RohanMuppa/brightspace-mcp-server#189](https://github.com/RohanMuppa/brightspace-mcp-server/pull/189).

- `getVideoTranscript` no longer treats a URL that carries userinfo
  (`https://user:pw@purdue.brightspace.com/d2l/...`) as a link into the configured Brightspace,
  and `D2LApiClient.getPage()` refuses such a URL before it reads the session cookie. Only a
  relative `/d2l/` link or an absolute URL on exactly the configured origin, with no userinfo, is
  requested with the session. Ported from
  [RohanMuppa/brightspace-mcp-server#190](https://github.com/RohanMuppa/brightspace-mcp-server/issues/190).

- A 429 whose `Retry-After` asks for more than 30 seconds now fails at once with
  `BrightspaceRateLimitedError` instead of blocking the call for that long (an hour-long
  `Retry-After` used to stall a call for up to two hours across retries). Shorter waits are still
  honoured as before. The error message now states the wait Brightspace asked for
  (`Rate limited by Brightspace. Retry after 3600s.`) so the caller can decide whether to wait it
  out. The ceiling is `maxRetryAfterMs` in the internal retry settings (default 30 000 ms); it is
  not exposed through `createBrightspaceClient`. Ported from
  [RohanMuppa/brightspace-mcp-server#191](https://github.com/RohanMuppa/brightspace-mcp-server/issues/191).

- `getAssignmentFiles` and `getAnnouncementFiles` text extraction, and the `getSyllabus`
  attachment read, no longer buffer an unbounded response body. They used `arrayBuffer()`, so a
  missing or understated `Content-Length` let any size of body be held in memory before a size
  check ran. A shared `readBodyCapped` helper counts the bytes actually received and cancels the
  stream as soon as they pass the 50 MB in-memory limit. Attachment extraction also skips the
  fetch entirely when the file's listed `Size` is already over the limit; either way the result
  is `text: null` with a note to save the file with `downloadFile` (`brightspace download`)
  instead. `getSyllabus` reports its existing "Attachment too large" note, or throws
  `BrightspaceInvalidArgumentError` when `downloadPath` was given. The note for a file type that
  cannot be read as text now names `downloadFile` rather than the MCP server's `download_file`
  tool. Ported from
  [RohanMuppa/brightspace-mcp-server#186](https://github.com/RohanMuppa/brightspace-mcp-server/issues/186).

- `downloadFile` no longer refuses plain text, CSV, or JSON files over 50 MB. A file with no
  magic-byte signature was rejected as an undetectable type once it passed the 50 MB in-memory
  limit, even though disk downloads allow 2 GB, so a large text file was streamed to disk and then
  deleted. Such files are now checked a chunk at a time (a streaming strict UTF-8 decode plus a NUL
  byte scan, keeping only the leading text needed to recognise HTML and SVG), so memory stays
  bounded at any size. Ported from
  [RohanMuppa/brightspace-mcp-server#184](https://github.com/RohanMuppa/brightspace-mcp-server/issues/184).

- Two concurrent `downloadFile` calls that save the same file name no longer lose one of the
  files. The finished temporary file was renamed onto a name `resolveFilenameConflict` had just
  reported free, and `rename()` overwrites, so both downloads could pick `deck.pdf` and the later
  one silently replaced the earlier. The file is now published with a hard link (or a copy with
  `COPYFILE_EXCL` on filesystems without hard links), which fails instead of overwriting, and the
  next free name (`deck(1).pdf`) is tried. The temporary file is removed on every path. Ported from
  [RohanMuppa/brightspace-mcp-server#183](https://github.com/RohanMuppa/brightspace-mcp-server/issues/183).

- `getVideoTranscript` (and `brightspace transcript`) now resolves Brightspace LTI quickLinks such
  as BoilerCast's `/d2l/common/dialogs/quickLink/quickLink.d2l?type=lti&rcode=...`, which named no
  video and came back as an unknown platform. The link is requested with the saved session cookie
  through the new `D2LApiClient.getPage()` (it never starts a sign-in), and the LTI launch page is
  read for the video URL in its form action, iframe, or hidden fields; a school-branded Kaltura KAF
  URL that carries only the entry ID gets its partner ID from `oauth_consumer_key`, and a quickLink
  page that only frames a Brightspace tool launch is followed one page further. When the launch
  names no video (an LTI 1.3 tool, say), the result is `hasTranscript: false` with a message saying
  the LTI link could not be resolved, distinct from an unsupported platform. An absolute URL on the
  configured Brightspace origin with a `/d2l/` path is handled the same as a relative one, while
  the session is never sent to another origin: redirects are followed by hand within the
  Brightspace origin only, and a redirect elsewhere is read as a candidate video URL without
  credentials. D2L session query parameters (`d2lSessionVal`, `d2lSecureSessionVal`, any case) are
  stripped from every returned URL and message, keeping routing parameters such as `ou`, `type`,
  and `rcode`. Ported from
  [RohanMuppa/brightspace-mcp-server#163](https://github.com/RohanMuppa/brightspace-mcp-server/pull/163).
- With `onAuthExpired: "login"`, a retry after `BrightspaceMfaPendingError` now waits for the
  approval instead of throwing the same error again after 5 seconds. The retry joins the sign-in
  still running in the background and polls it for up to 45 seconds (never more than 55 seconds
  from the start of that call), returning the original result as soon as the approval lands. The
  error message now says to retry right away rather than wait, and the README example no longer
  sleeps between retries. This applies to a long-lived client in one process; each `brightspace`
  CLI invocation is a new process and is unchanged. Ported from
  [RohanMuppa/brightspace-mcp-server#176](https://github.com/RohanMuppa/brightspace-mcp-server/pull/176).
- `downloadFile` (and `brightspace download`) can now save files over 50 MB, such as large
  lecture decks. The body is streamed to a hidden `.download-<uuid>.part` file in the download
  directory, its type is checked there against the same allowlist, and it is then renamed into
  place (with the usual `name(1).ext` conflict handling); a refused or failed download leaves no
  partial file behind. The cap is now 2 GB, checked against the listed size, `Content-Length`,
  and the bytes actually received; a body that grows past it mid-stream fails with
  `BrightspaceDownloadError` kind `tooLarge`. File downloads also time out only when the transfer
  stalls for the request timeout, not when it simply takes longer than that in total. In-memory
  reads (`getSyllabus` text extraction) keep the 50 MB limit. Ported from
  [RohanMuppa/brightspace-mcp-server#164](https://github.com/RohanMuppa/brightspace-mcp-server/pull/164).
- A malformed `D2L_TOKEN_TTL` (`abc`, `0`, `-5`, `1h`) no longer makes every saved token look
  expired and re-mint on each call. Only a positive whole number of seconds is honoured; anything
  else is ignored with a warning on stderr and falls back to `tokenTtl` in `config.json`, then
  `3600`. A hand-edited `tokenTtl` in `config.json` gets the same check, and a `TokenManager`
  constructed with an invalid `tokenTtl` (directly or through `createBrightspaceClient({ config })`)
  warns and uses `3600`. Ported from
  [RohanMuppa/brightspace-mcp-server#55](https://github.com/RohanMuppa/brightspace-mcp-server/issues/55).
- A 429 whose `Retry-After` is an HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`) is no longer
  retried almost immediately. The header is now read as RFC 9110 allows: delta-seconds, or an
  HTTP-date converted to the seconds remaining, rounded up. A date that has already passed, or a
  value that is neither form (`10abc`), is ignored and the normal backoff applies instead of a
  misread wait. JSON requests and file downloads share the same parser, and the `RateLimitError`
  message states the wait for the date form too. Ported from
  [RohanMuppa/brightspace-mcp-server#57](https://github.com/RohanMuppa/brightspace-mcp-server/issues/57).
- `D2L_HEADLESS` and `D2L_ACTIVE_ONLY` are now read as real booleans: `true`/`1`/`yes`/`on` and
  `false`/`0`/`no`/`off`, case-insensitive with surrounding whitespace ignored. Previously
  anything other than the exact string `false` (including `0`, `no`, `False`, and typos) was read
  as true. An empty value counts as unset, and an unrecognized value is ignored with a
  `[config] Ignoring …` warning on stderr so `config.json` or the default applies
  ([RohanMuppa/brightspace-mcp-server#67](https://github.com/RohanMuppa/brightspace-mcp-server/issues/67)).

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
