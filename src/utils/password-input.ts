/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

/**
 * Where the reader is inside a terminal escape sequence. A sequence can be
 * split across stdin chunks, so this is carried from one chunk to the next.
 */
export type EscapeState = "none" | "esc" | "csi" | "ss3";

export interface PasswordInputState {
  password: string;
  escape: EscapeState;
}

export interface PasswordInputResult {
  state: PasswordInputState;
  /** What to write to the terminal: one `*` per accepted character, `\b \b` per erase. */
  echo: string;
  /** Enter was pressed; `state.password` is the answer. */
  done: boolean;
  /** Ctrl-C was pressed. */
  cancelled: boolean;
}

export const INITIAL_PASSWORD_INPUT: PasswordInputState = { password: "", escape: "none" };

/**
 * Apply one raw-mode stdin chunk to a hidden password prompt.
 *
 * A chunk is not one key: a paste arrives as a single chunk ("secret\r"),
 * and arrow keys or bracketed-paste markers (`ESC [200~` … `ESC [201~`)
 * arrive as multi-byte escape sequences. So the chunk is read character by
 * character: Enter (`\r` or `\n`) finishes the prompt and anything after it
 * in the same chunk is dropped, backspace erases one character, escape
 * sequences and other control characters are discarded, and every other
 * character is accepted.
 */
export function applyPasswordInput(
  state: PasswordInputState,
  chunk: string,
): PasswordInputResult {
  let { password, escape } = state;
  let echo = "";
  const result = (done: boolean, cancelled: boolean): PasswordInputResult => ({
    state: { password, escape },
    echo,
    done,
    cancelled,
  });

  for (const ch of chunk) {
    const code = ch.codePointAt(0)!;

    // A control character never belongs to an escape sequence: it ends a
    // malformed or lone one (Escape then Enter) and is handled below.
    if (escape !== "none" && code >= 0x20 && code !== 0x7f) {
      if (escape === "esc") {
        // ESC [ starts a CSI sequence, ESC O an SS3 one (F1-F4, some arrows);
        // anything else is a two-character Alt sequence and is dropped whole.
        escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none";
      } else if (escape === "csi") {
        // Parameter and intermediate bytes (0x20-0x3F) continue the sequence;
        // anything else ends it ("A" for an arrow, "~" for the paste markers).
        if (code > 0x3f) escape = "none";
      } else {
        escape = "none";
      }
      continue;
    }
    escape = "none";

    if (ch === "\x03") return result(false, true);
    if (ch === "\r" || ch === "\n") return result(true, false);
    if (ch === "\x7f" || ch === "\b") {
      if (password.length > 0) {
        password = Array.from(password).slice(0, -1).join("");
        echo += "\b \b";
      }
      continue;
    }
    if (ch === "\x1b") {
      escape = "esc";
      continue;
    }
    // Other C0 and C1 control characters are not typed text.
    if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) continue;

    password += ch;
    echo += "*";
  }

  return result(false, false);
}
