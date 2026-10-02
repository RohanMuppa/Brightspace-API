import { describe, expect, it } from "vitest";
import {
  applyPasswordInput,
  INITIAL_PASSWORD_INPUT,
  type PasswordInputState,
} from "../../src/utils/password-input.js";

/** Feed chunks in order, as stdin would deliver them. */
function feed(...chunks: string[]) {
  let state: PasswordInputState = INITIAL_PASSWORD_INPUT;
  let echo = "";
  for (const chunk of chunks) {
    const step = applyPasswordInput(state, chunk);
    state = step.state;
    echo += step.echo;
    if (step.done || step.cancelled) return { ...step, echo };
  }
  return { state, echo, done: false, cancelled: false };
}

describe("hidden password input", () => {
  it("takes typed keys one chunk at a time", () => {
    const result = feed("p", "w", "\r");
    expect(result).toMatchObject({ done: true, cancelled: false, echo: "**" });
    expect(result.state.password).toBe("pw");
  });

  it("takes a pasted password and its trailing Enter from one chunk", () => {
    const result = feed("secret\r");
    expect(result.done).toBe(true);
    expect(result.state.password).toBe("secret");
    expect(result.echo).toBe("******");
  });

  it("finishes at the first Enter and drops the rest of the chunk", () => {
    expect(feed("abc\ndef\n").state.password).toBe("abc");
    expect(feed("abc\r\n").state.password).toBe("abc");
  });

  it("waits for Enter across chunks", () => {
    const step = applyPasswordInput(INITIAL_PASSWORD_INPUT, "part");
    expect(step.done).toBe(false);
    expect(step.state.password).toBe("part");
  });

  it("applies backspace per character, including inside a paste", () => {
    const result = feed("abx\x7fc\bd\r");
    expect(result.state.password).toBe("abd");
    expect(result.echo).toBe("***\b \b*\b \b*");
  });

  it("ignores backspace on an empty password", () => {
    const result = feed("\x7f\x7fa\r");
    expect(result.state.password).toBe("a");
    expect(result.echo).toBe("*");
  });

  it("erases a whole astral character", () => {
    expect(feed("a😀\x7f\r").state.password).toBe("a");
  });

  it("strips bracketed-paste markers", () => {
    const result = feed("\x1b[200~hunter2\x1b[201~", "\r");
    expect(result.state.password).toBe("hunter2");
    expect(result.echo).toBe("*******");
  });

  it("strips arrow keys and other escape sequences", () => {
    expect(feed("a\x1b[Db\x1bOAc\x1b[1;5Cd\x1b[3~e\r").state.password).toBe("abcde");
  });

  it("strips an escape sequence split across chunks", () => {
    expect(feed("a\x1b", "[", "20", "0~b\r").state.password).toBe("ab");
  });

  it("still sees Enter after a lone Escape", () => {
    const result = feed("ab\x1b\r");
    expect(result.done).toBe(true);
    expect(result.state.password).toBe("ab");
  });

  it("ignores other control characters", () => {
    expect(feed("a\tb\x00c\x15d\x85\r").state.password).toBe("abcd");
  });

  it("cancels on Ctrl-C, even mid-paste", () => {
    const result = feed("abc\x03def\r");
    expect(result.cancelled).toBe(true);
    expect(result.done).toBe(false);
  });

  it("keeps non-ASCII characters", () => {
    expect(feed("pässwörd\n").state.password).toBe("pässwörd");
  });
});
