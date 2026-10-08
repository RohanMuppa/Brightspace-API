import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { AuthRunner } from "../../src/auth/auth-runner.js";
import { toPublicError } from "../../src/errors.js";

/**
 * Issue #27 (ported from brightspace-mcp-server#212): a caller running
 * several Brightspace calls in parallel against an expired session got the
 * same Entra number and the same long instructions back from every call in
 * the batch. The sign-in itself was already shared (AuthRunner's inFlight /
 * childDone joining); only the *report* was repeated. Intended behavior
 * (single-flight report): the first call to report a challenge carries it in
 * full; the rest get a short "sign-in already in progress" answer without the
 * digits. The digits must still reach someone if the first answer is lost
 * (brightspace-mcp-server#201).
 */

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));

const children: EventEmitter[] = [];
const NUMBER = "47";
const BATCH = 5;
/** Wording only the full notice carries. */
const LONG_NOTICE = /Open Microsoft Authenticator/;

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
  });
  children.push(child);
  return child;
}

/** What a caller sees for one run() call that ended in `error`. */
function answerText(error: unknown): string {
  return toPublicError(error).message;
}

/** Run one call to completion and capture the answer text it would produce. */
function answer(call: Promise<boolean>): Promise<string> {
  return call.then(
    () => "SIGNED_IN",
    (error: unknown) => answerText(error),
  );
}

const withDigits = (answers: string[]) => answers.filter((text) => text.includes(NUMBER));
const withLongNotice = (answers: string[]) => answers.filter((text) => LONG_NOTICE.test(text));

describe("a parallel batch of calls against an expired session", () => {
  let child: ReturnType<typeof mockChild>;

  beforeEach(() => {
    vi.useFakeTimers();
    child = mockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(execFileSync).mockReturnValue("12345 100\n" as never);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    for (const leftover of children.splice(0)) leftover.emit("close", 0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function batchAnswers(runner: AuthRunner): Promise<string>[] {
    return Array.from({ length: BATCH }, () => answer(runner.run()));
  }

  it("puts the number-match digits in exactly one response, not one per call", async () => {
    const runner = new AuthRunner();
    const answers = batchAnswers(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);

    const texts = await Promise.all(answers);

    expect(withDigits(texts)).toHaveLength(1);
  });

  it("puts the full sign-in instructions in exactly one response, not one per call", async () => {
    const runner = new AuthRunner();
    const answers = batchAnswers(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);

    const texts = await Promise.all(answers);

    expect(withLongNotice(texts)).toHaveLength(1);
  });

  it("gives the owner the digits and full notice, and every other call a short retry answer", async () => {
    const runner = new AuthRunner();
    const answers = batchAnswers(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);

    const [owner, ...contenders] = await Promise.all(answers);

    expect(owner).toContain(NUMBER);
    expect(owner).toMatch(LONG_NOTICE);
    for (const text of contenders) {
      expect(text).toMatch(/sign-in is already in progress/i);
      expect(text).not.toContain(NUMBER);
      expect(text.length).toBeLessThan(owner.length / 2);
    }
  });

  it("starts one sign-in for the whole batch", async () => {
    const runner = new AuthRunner();
    batchAnswers(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("still delivers the digits to the next caller when the first report was lost", async () => {
    const runner = new AuthRunner();
    // The first report is produced but never relayed to the user.
    const lost = answer(runner.run());
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);
    await lost;

    // A later call (another batch, or a retry) must carry the digits again.
    const later = answer(runner.run());
    await vi.advanceTimersByTimeAsync(46_000);
    const text = await later;

    expect(text).toContain(NUMBER);
    expect(text).toMatch(LONG_NOTICE);
  });
});
