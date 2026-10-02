import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import ts from "typescript";
import { acquireProcessLock, AuthenticationInProgressError } from "../../src/auth/auth-lock.js";

let lockPath: string;
let moduleUrl: string;

beforeEach(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-lock-test-"));
  lockPath = path.join(directory, "auth.lock");
  const source = await fs.readFile(new URL("../../src/auth/auth-lock.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
});

/**
 * A real process that takes the lock and holds it until a line arrives on
 * its stdin, or prints the error code and exits if the lock is taken.
 */
function child(): ChildProcessWithoutNullStreams {
  const script = `
    const { acquireProcessLock } = await import(process.argv[1]);
    try {
      const release = await acquireProcessLock(process.argv[2]);
      process.stdout.write("locked\\n");
      process.stdin.once("data", async () => { await release(); process.exit(0); });
    } catch (error) { process.stdout.write(error.code + "\\n"); process.exitCode = 2; }
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, lockPath], { stdio: "pipe" });
}

async function firstLine(process: ChildProcessWithoutNullStreams): Promise<string> {
  const [data] = await once(process.stdout, "data");
  return String(data).trim();
}

/**
 * Race four real processes for the lock. The winner holds it until every
 * contender has reported, so no contender can start after the release and
 * take a lock that is free again; only then is the holder released.
 */
async function contend(): Promise<string[]> {
  const processes = Array.from({ length: 4 }, () => child());
  const exits = processes.map(process => once(process, "exit"));
  const lines = processes.map(firstLine);
  const messages = await Promise.all(lines);
  for (const [index, message] of messages.entries()) {
    if (message === "locked") processes[index].stdin.write("release\n");
  }
  await Promise.all(exits);
  return messages;
}

describe("process-shared authentication lock", () => {
  it("fails quickly for a live owner and can be acquired after release", async () => {
    const release = await acquireProcessLock(lockPath);
    await expect(acquireProcessLock(lockPath)).rejects.toBeInstanceOf(AuthenticationInProgressError);
    await release();
    await (await acquireProcessLock(lockPath))();
  });

  it("does not reclaim unknown ownership or a live PID after the hostname changes", async () => {
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), "{}");
    await expect(acquireProcessLock(lockPath)).rejects.toBeInstanceOf(AuthenticationInProgressError);
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, host: "previous-dhcp-hostname", nonce: "foreign" }));
    await expect(acquireProcessLock(lockPath)).rejects.toBeInstanceOf(AuthenticationInProgressError);
  });

  it("allows only one of four real processes to authenticate", async () => {
    const messages = await contend();
    expect(messages.filter(message => message === "locked")).toHaveLength(1);
    expect(messages.filter(message => message === "AUTH_IN_PROGRESS")).toHaveLength(3);
  });

  it("recovers a lock after its actual process dies", async () => {
    const owner = child();
    const exit = once(owner, "exit");
    expect(await firstLine(owner)).toBe("locked");
    owner.kill("SIGKILL");
    await exit;
    const ownerFile = path.join(lockPath, "owner.json");
    const metadata = JSON.parse(await fs.readFile(ownerFile, "utf8"));
    await fs.writeFile(ownerFile, JSON.stringify({ ...metadata, host: "previous-dhcp-hostname" }));
    await (await acquireProcessLock(lockPath))();
  });

  it("serializes competing processes recovering a dead owner", async () => {
    const owner = child();
    const exit = once(owner, "exit");
    expect(await firstLine(owner)).toBe("locked");
    owner.kill("SIGKILL");
    await exit;
    const messages = await contend();
    expect(messages.filter(message => message === "locked")).toHaveLength(1);
    expect(messages.filter(message => message === "AUTH_IN_PROGRESS")).toHaveLength(3);
  });

  it("recovers when a stale-recovery process also died", async () => {
    const owner = child();
    const exit = once(owner, "exit");
    expect(await firstLine(owner)).toBe("locked");
    owner.kill("SIGKILL");
    await exit;
    const metadata = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    const claimPath = path.join(lockPath, "reclaim.lock");
    await fs.mkdir(claimPath);
    await fs.writeFile(path.join(claimPath, "owner.json"), metadata);
    await (await acquireProcessLock(lockPath))();
  });
});
