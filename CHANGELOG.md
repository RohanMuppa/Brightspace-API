# Changelog

All notable changes to `brightspace-api` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Added

- `downloadFile()` can now fetch a file an instructor linked by path inside a module description
  instead of adding as a content topic, via the new `coursePath` argument (a course file path such
  as `Notes/Lecture 1.pdf`, or the `quickLink.d2l?...type=coursefile` URL). `get_course_content`'s
  modules now carry `courseFiles`, the paths to pass. `coursePath` fetches through the saved
  session cookie (a new `D2LApiClient.getPageRaw()`), so it needs a signed-in browser session; the
  CLI's `download` command gained a matching `--course-path` flag. Ported from
  [RohanMuppa/brightspace-mcp-server#259](https://github.com/RohanMuppa/brightspace-mcp-server/pull/259)
  (fixes [#54](https://github.com/RohanMuppa/Brightspace-API/issues/54)).

- `setup` asked the two opt-in ways to be asked for 2FA less often (an authenticator setup key,
  then a separate "remember this device" yes/no) as two unrelated-looking prompts at different
  points in the wizard. They are now one multiple-choice question, "How often do you want to
  approve sign-ins on your phone?", asked right after the MFA method choice; picking 1, 2, or 3
  turns the shortcuts on or off together and, on a rerun, shows what is currently on as the
  default. Picking 1 or 2 while a key is saved now offers to remove it from the credential store.
  The wording is shared from the new `src/utils/two-factor-shortcuts.ts`. Ported from
  [RohanMuppa/brightspace-mcp-server#254](https://github.com/RohanMuppa/brightspace-mcp-server/pull/254)
  (fixes [#52](https://github.com/RohanMuppa/Brightspace-API/issues/52)).

### Fixed

- `fetchAllObjects()`, the `{ Objects, Next }` pager behind the paged classlist and quiz lists,
  threw `TypeError: Invalid URL` when a page's `Next` started with `http://` or `https://` but
  could not be parsed (`https://`, an unclosed `[` host, a host with a space), losing every page
  already fetched. It now stops paginating, logs a WARN with the first path (not the raw `Next`,
  which can carry a `d2lSessionVal=` token), and returns the objects collected so far. Ported from
  [RohanMuppa/brightspace-mcp-server#325](https://github.com/RohanMuppa/brightspace-mcp-server/pull/325)
  (fixes [RohanMuppa/brightspace-mcp-server#323](https://github.com/RohanMuppa/brightspace-mcp-server/issues/323)).

- `getAssignments()` (`brightspace assignments`) treated a dropbox folder whose feedback request
  failed with a 403, a 5xx or a network error the same as one with no feedback yet: it logged the
  failure at DEBUG (a 403 not at all) and returned `feedback: null`, so a graded assignment whose
  feedback could not be read looked ungraded. A 404 still means no feedback yet. Any other failure
  now adds a `feedbackUnavailable` field (`AssignmentDataUnavailable`: `code`, `status?`,
  `notice`) to that assignment, so its `feedback: null` reads as unknown. Ported from
  [RohanMuppa/brightspace-mcp-server#277](https://github.com/RohanMuppa/brightspace-mcp-server/pull/277)
  (fixes [RohanMuppa/brightspace-mcp-server#276](https://github.com/RohanMuppa/brightspace-mcp-server/issues/276)).

- `getAssignments()` logged a course whose quiz list failed to load (a 403, a 5xx, a network error)
  at DEBUG and listed only the quizzes it found through the course content, so the course's other
  quizzes silently went missing and read as "no quiz". Such a course now carries a
  `quizzesUnavailable` field (`AssignmentDataUnavailable`) on the single-course result and on its
  `CourseAssignments` entry in the all-courses result. A 404 still means the course has no quiz
  tool and is not reported. Both fields are additive and absent whenever the read succeeded, so
  the usual shape is unchanged. Ported from
  [RohanMuppa/brightspace-mcp-server#279](https://github.com/RohanMuppa/brightspace-mcp-server/pull/279)
  (fixes [RohanMuppa/brightspace-mcp-server#278](https://github.com/RohanMuppa/brightspace-mcp-server/issues/278)).

- An email username saved in one case and typed in another (`Student@purdue.edu` vs
  `student@purdue.edu`) named two different accounts, so the saved password, authenticator
  enrollment and session were not found and sign-in started over. An email username is now
  trimmed and lowercased before it names an account, so every casing shares one saved password,
  one enrollment and one session directory; a plain username is only trimmed and keeps its case,
  since a school may treat it as case-sensitive. Secrets saved under the exact-case username by
  earlier versions are still read, moved to the shared key once the copy reads back intact (a
  store that refuses keeps the old entry), and removed along with it on delete; an existing
  exact-case session directory keeps being used. `setup` saves a new email username lowercased,
  and keeps the saved spelling when the same account is typed again in another case. Ported from
  [RohanMuppa/brightspace-mcp-server#269](https://github.com/RohanMuppa/brightspace-mcp-server/pull/269)
  (fixes [RohanMuppa/brightspace-mcp-server#267](https://github.com/RohanMuppa/brightspace-mcp-server/issues/267)).

- `downloadFile()`'s `coursePath` and `get_course_content`'s `courseFiles` could lose part of a
  file name at the first apostrophe (`Notes/Bob` for `Notes/Bob's notes.pdf`), because the
  attribute reader stopped a quoted href at the first embedded quote character. Links are now
  read with the quote-aware, entity-decoding attribute parser already used for LTI launch pages
  (moved into the new shared `src/utils/html-attributes.ts`). A `coursePath` is now treated as a
  link only when it starts with `/` or names a URL scheme, so a plain file name that happens to
  mention `quickLink.d2l` is no longer misread as one, and an absolute quickLink URL must resolve
  to this same Brightspace's origin. `downloadFile()` also refuses an HTML page Brightspace sends
  back in place of a missing or inaccessible course file, instead of saving that page under the
  file's name, and its no-session error now covers an expired session cookie as well as a missing
  one. Ported from
  [RohanMuppa/brightspace-mcp-server#264](https://github.com/RohanMuppa/brightspace-mcp-server/pull/264)
  (fixes [#57](https://github.com/RohanMuppa/Brightspace-API/issues/57)).

- `setup` no longer asks whether to sign in without a saved password: it always saves one, and a
  rerun now clears any `passwordless` value carried over from an earlier `config.json`.
  Passwordless sign-in is unchanged and still available by setting `D2L_PASSWORDLESS=true` (or
  hand-editing `passwordless` into `config.json`). Ported from
  [RohanMuppa/brightspace-mcp-server#264](https://github.com/RohanMuppa/brightspace-mcp-server/pull/264)
  (fixes [#57](https://github.com/RohanMuppa/Brightspace-API/issues/57)).

- `getDiscussions()` (`brightspace discussions`) logged a forum whose topics failed to load (forum
  overview, `courseId` only) or a topic whose posts failed to load (forum detail, with `forumId`)
  at DEBUG and returned it with `topics: []` / `posts: []`, indistinguishable from a forum with no
  topics or a topic with no posts. Such a forum or topic is still listed, with the empty list, plus
  an additive `topicsUnavailable` / `postsUnavailable` field (`DiscussionContentsUnavailable`:
  `code`, `status?`, `notice`), absent on everything that was read, so the usual shape and the
  `DiscussionsResult` type are unchanged. This now includes a 403, which was skipped quietly
  before; it is reported with `code: "BRIGHTSPACE_FORBIDDEN"` and `status: 403`, since the caller
  otherwise reads the forum as empty. A sign-in problem (an unrecovered 401, a pending MFA sign-in,
  a failed token refresh) used to read as an empty forum too; it now fails the whole call, as
  `getAssignments` already does. Ported from
  [RohanMuppa/brightspace-mcp-server#256](https://github.com/RohanMuppa/brightspace-mcp-server/issues/256).

- `getUpcomingDueDates()` (`brightspace due`) logged a course whose dropbox folders, quizzes, or
  discussions failed to load (a 404, a 5xx, a dropped connection) at DEBUG and left its items out,
  so the array looked complete and a missing course read as "nothing due"; with `courseId` set it
  returned `[]`, indistinguishable from an empty course. The result is still an `UpcomingItem[]`,
  now typed `UpcomingDueDates`, which adds a `failedCourses` property on the array
  (`UpcomingDueDatesFailure`: `courseId`, `courseName`, `sources`, `code`, `status?`, `notice`),
  present only when something failed, so iterating, `.length`, and the JSON are unchanged. A
  forum whose topics fail with anything but a 403 is reported the same way. A sign-in problem
  raised mid-batch (an unrecovered 401, a pending MFA sign-in, a failed token refresh) used to
  read as an empty course too; it now fails the whole call with `BrightspaceAuthExpiredError` /
  `BrightspaceMfaPendingError`, as `getAssignments` already does. A 403 is still skipped. The CLI
  keeps stdout the bare array and writes `{"failedCourses":[…]}` to stderr. Ported from
  [RohanMuppa/brightspace-mcp-server#262](https://github.com/RohanMuppa/brightspace-mcp-server/issues/262).

- `getSyllabus()` read the attachment's name from `Content-Disposition` with its own regex, which
  did not understand the RFC 5987 `filename*=UTF-8''…` form, so with `downloadPath` set a syllabus
  sent as `filename*=UTF-8''Course%20Syllabus.pdf` was saved as `UTF-8Course%20Syllabus.pdf`. It now
  uses the shared `parseContentDispositionFilename`, as `downloadFile()` already does. Ported from
  [RohanMuppa/brightspace-mcp-server#247](https://github.com/RohanMuppa/brightspace-mcp-server/issues/247).

- `getMyGrades()` without a `courseId` (`brightspace grades`) silently dropped any course whose
  grade request failed with anything other than a 403 — a 404, a 5xx, a dropped connection — so a
  script read the array as every course's grades with one missing. Such a course now stays in the
  array, in enrollment order, with `grades: []` and an additive `failed` field
  (`CourseGradesFailure`: `code`, `status?`, `gradeUrl`, `notice`); `failed` is absent on every
  course that was read, so the usual shape and the `CourseGrades[]` return type are unchanged. A
  sign-in problem raised mid-batch (an unrecovered 401, a pending MFA sign-in, a failed token
  refresh) used to drop the course the same way; it now fails the whole call with
  `BrightspaceAuthExpiredError` / `BrightspaceMfaPendingError`, as `getAssignments` already does.
  A 403 course is still skipped. Ported from
  [RohanMuppa/brightspace-mcp-server#245](https://github.com/RohanMuppa/brightspace-mcp-server/issues/245)
  (fixes [#48](https://github.com/RohanMuppa/Brightspace-API/issues/48)).

- A dropbox folder that D2L sent without a `GroupTypeId` key was reported as a group assignment
  (`isGroup: true`), because only an explicit `null` counted as individual. A missing
  `GroupTypeId` now means an individual folder, the same as `null`. Ported from
  [RohanMuppa/brightspace-mcp-server#240](https://github.com/RohanMuppa/brightspace-mcp-server/issues/240).

- When Entra's MFA number expired and the background sign-in asked for a new one, a caller
  already waiting on that sign-in only heard the new number when its 45-second poll ended, while
  the user kept trying the old one. A caller polling this process's sign-in is now answered the
  moment it reports a number that caller was not told (a changed number, or the first number after
  an automatic code sign-in falls back to one), and a retry joining with such a number is answered
  at once. A caller waiting on another process's sign-in is answered as soon as that sign-in's
  number changes. When the sign-in's MFA loop gives up (exit 7), a caller still waiting is now
  told about the cooldown it just recorded instead of to enter a number that no longer works.
  Ported from
  [RohanMuppa/brightspace-mcp-server#229](https://github.com/RohanMuppa/brightspace-mcp-server/issues/229).

- `auth --logout` used to leave a script or process that was already running holding its old
  access token and cached API responses for up to an hour, even after the saved session was
  deleted. `TokenManager` now checks the saved session file's identity (a stat, never a decrypt)
  before trusting its in-memory token, and `D2LApiClient` does the same before serving a cached
  response, so every process sharing a session notices a sign-out — or a different account signing
  in over it — on its very next call instead of needing a restart. Ported the shared session-store
  and token-manager plumbing from
  [RohanMuppa/brightspace-mcp-server#233](https://github.com/RohanMuppa/brightspace-mcp-server/pull/233)
  (fixes [#43](https://github.com/RohanMuppa/Brightspace-API/issues/43)); the `sign_out` MCP tool
  itself does not apply here, since this package has no MCP tool surface — `auth --logout` is its
  equivalent entry point.

- A call queued right behind another call that was just answered with an MFA number — a caller
  that serializes its own Brightspace calls against an expired session sends them one after
  another, so each lands moments after the previous one answered — used to be treated as a retry
  and wait up to 45 seconds for an approval it could not yet act on. It is now answered at once,
  in full, as its sibling's queue (chained for up to 20 seconds, so a tight loop of calls still has
  to wait like a real retry). Separately, a caller whose sign-in found another process's
  background sign-in holding the lock before that sign-in had even reached its MFA challenge used
  to be told "busy" right away; it now waits on that sign-in the same way a retry already waited on
  a published challenge, and is answered with the number as soon as one appears. An explicit
  `brightspace-auth` run in a terminal, which never publishes a challenge, is unaffected and still
  answers "busy". Ported from
  [RohanMuppa/brightspace-mcp-server#228](https://github.com/RohanMuppa/brightspace-mcp-server/pull/228)
  (fixes [#41](https://github.com/RohanMuppa/Brightspace-API/issues/41)).

- A retry whose sign-in found ANOTHER process holding the cross-process lock (two scripts sharing
  one session store, say) now waits on that process's sign-in instead of repeating its number
  every time. A relayed `BrightspaceMfaPendingError` (or `BrightspaceAutomaticPendingError`) used
  to be re-thrown at once on every retry, so a caller retrying in a loop made several calls in
  quick succession and could conclude the five-minute approval window had closed while the other
  sign-in was still waiting. A retry now polls the lock for up to 45 seconds (never past 55
  seconds total), relaying the challenge on each look so the owner's abandonment watcher is not
  tripped, and resolves as soon as the owner releases the lock. The first call for a given
  challenge is still answered immediately, as before. Ported from
  [RohanMuppa/brightspace-mcp-server#225](https://github.com/RohanMuppa/brightspace-mcp-server/pull/225)
  (fixes [#37](https://github.com/RohanMuppa/Brightspace-API/issues/37)).

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

- `auth --logout` (`brightspace-auth --logout`, or `npx -y brightspace-api@latest auth --logout`)
  ends the saved Brightspace session on this computer early, so the next request does a full
  sign-in. It resolves the session directory the same way sign-in does (`resolveSessionLocation()`
  shares `loadConfig`'s account resolution), deletes `session.json` and
  `storage-state.encrypted.json` there, plus a plaintext `storage-state.json` left by a
  pre-encryption install, and prints the names it removed. It never touches the saved password,
  `config.json`, or any credential-store entry (the session encryption key stays and is reused by
  the next sign-in), holds the sign-in lock while deleting, and exits 2 without deleting anything
  if a sign-in is already in progress. Ported from
  [RohanMuppa/brightspace-mcp-server#215](https://github.com/RohanMuppa/brightspace-mcp-server/pull/215)
  (fixes [#36](https://github.com/RohanMuppa/Brightspace-API/issues/36)).

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
