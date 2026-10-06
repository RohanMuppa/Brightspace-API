/**
 * Brightspace API
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { ZodError } from "zod";
import { ApiError, RateLimitError, NetworkError, TokenRefreshError } from "./api/errors.js";
import { AuthProcessError, type AuthFailureKind } from "./auth/auth-runner.js";
import { NativeCredentialStoreError } from "./auth/credential-store.js";
import { DownloadError, isSafeDetail, type DownloadFailureKind } from "./utils/download-errors.js";
import { NoTranscriptError, TranscriptFetchError } from "./utils/transcript/errors.js";
import { AUTH_COMMAND } from "./utils/commands.js";

/**
 * The public error contract. Every error that leaves the client facade or the
 * CLI is one of these, carries a stable `code`, and never contains a token,
 * a cookie, a stack from a child process, or raw Brightspace response text.
 * Scripts branch on `code`; people read `message`.
 */
export type BrightspaceErrorCode =
  | "BRIGHTSPACE_AUTH_EXPIRED"
  | "BRIGHTSPACE_MFA_PENDING"
  | "BRIGHTSPACE_AUTH_FAILED"
  | "BRIGHTSPACE_NOT_FOUND"
  | "BRIGHTSPACE_FORBIDDEN"
  | "BRIGHTSPACE_RATE_LIMITED"
  | "BRIGHTSPACE_NETWORK"
  | "BRIGHTSPACE_INVALID_ARGUMENT"
  | "BRIGHTSPACE_DOWNLOAD_FAILED"
  | "BRIGHTSPACE_API_ERROR"
  | "BRIGHTSPACE_UNEXPECTED";

export class BrightspaceError extends Error {
  readonly code: BrightspaceErrorCode;
  constructor(code: BrightspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrightspaceError";
    this.code = code;
  }
}

/** The saved session is gone and this call was not allowed to open a browser sign-in. */
export class BrightspaceAuthExpiredError extends BrightspaceError {
  constructor(message = `Brightspace session expired. Run \`${AUTH_COMMAND}\` in a terminal (from your home folder), then retry.`) {
    super("BRIGHTSPACE_AUTH_EXPIRED", message);
    this.name = "BrightspaceAuthExpiredError";
  }
}

/**
 * A browser sign-in was started and is waiting on the phone. `numberMatch`
 * is the Entra number to enter, when the tenant shows one. The sign-in keeps
 * running in the background; retry the call after approving.
 */
/**
 * A retry joins the background sign-in and waits for the approval itself, so
 * the caller should retry at once rather than sleep or wait for the user to
 * confirm they approved.
 */
const MFA_RETRY_GUIDANCE =
  "Retry right away without waiting: the sign-in is finishing in the background, and each retry waits up to " +
  "45 seconds for the approval and returns the result as soon as the sign-in completes. Keep retrying until it " +
  "succeeds or fails with a different error.";

export class BrightspaceMfaPendingError extends BrightspaceError {
  readonly numberMatch?: string;
  constructor(numberMatch?: string) {
    super(
      "BRIGHTSPACE_MFA_PENDING",
      numberMatch
        ? `Open Microsoft Authenticator and enter ${numberMatch} within 5 minutes. ${MFA_RETRY_GUIDANCE}`
        : `Approve the sign-in request on your phone (Microsoft Authenticator or Duo). ${MFA_RETRY_GUIDANCE}`,
    );
    this.name = "BrightspaceMfaPendingError";
    this.numberMatch = numberMatch;
  }
}

/** A browser sign-in was attempted and did not produce a session. `kind` says why. */
export class BrightspaceAuthFailedError extends BrightspaceError {
  readonly kind: AuthFailureKind;
  constructor(kind: AuthFailureKind, message: string) {
    super("BRIGHTSPACE_AUTH_FAILED", message);
    this.name = "BrightspaceAuthFailedError";
    this.kind = kind;
  }
}

export class BrightspaceNotFoundError extends BrightspaceError {
  constructor(message = "Resource not found. The course or item may not exist, or you may not have access.") {
    super("BRIGHTSPACE_NOT_FOUND", message);
    this.name = "BrightspaceNotFoundError";
  }
}

export class BrightspaceForbiddenError extends BrightspaceError {
  constructor(message = "Access denied. You may not have permission to access this resource.") {
    super("BRIGHTSPACE_FORBIDDEN", message);
    this.name = "BrightspaceForbiddenError";
  }
}

export class BrightspaceRateLimitedError extends BrightspaceError {
  constructor(message = "Rate limited by Brightspace. Wait a moment and retry.") {
    super("BRIGHTSPACE_RATE_LIMITED", message);
    this.name = "BrightspaceRateLimitedError";
  }
}

export class BrightspaceNetworkError extends BrightspaceError {
  constructor(message = "Could not connect to Brightspace. Check the network connection.", options?: ErrorOptions) {
    super("BRIGHTSPACE_NETWORK", message, options);
    this.name = "BrightspaceNetworkError";
  }
}

/** Arguments failed validation. `issues` are "path: message" strings. */
export class BrightspaceInvalidArgumentError extends BrightspaceError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[], message = `Invalid arguments: ${issues.join(", ")}`) {
    super("BRIGHTSPACE_INVALID_ARGUMENT", message);
    this.name = "BrightspaceInvalidArgumentError";
    this.issues = issues;
  }
}

export class BrightspaceDownloadError extends BrightspaceError {
  readonly kind: DownloadFailureKind;
  constructor(kind: DownloadFailureKind, message: string) {
    super("BRIGHTSPACE_DOWNLOAD_FAILED", message);
    this.name = "BrightspaceDownloadError";
    this.kind = kind;
  }
}

export class BrightspaceApiError extends BrightspaceError {
  readonly status: number;
  constructor(status: number, message = `Brightspace returned HTTP ${status}.`) {
    super("BRIGHTSPACE_API_ERROR", message);
    this.name = "BrightspaceApiError";
    this.status = status;
  }
}

const AUTH_FAILURE_GUIDANCE: Record<AuthFailureKind, string> = {
  busy: "A sign-in is already running in another process. Let it finish, then retry.",
  cooldown:
    "Automatic sign-in is paused because an MFA prompt went unanswered. " +
    `Run \`${AUTH_COMMAND}\` in a terminal (from your home folder) to retry now and see the number to enter.`,
  unsupported:
    "This login needs something a script cannot supply, usually a code from an authenticator app. " +
    `Run \`${AUTH_COMMAND}\` in a terminal (from your home folder) and sign in there.`,
  secureStorage:
    "The operating system credential store is locked or unavailable, so the saved password could not be read. " +
    "Unlock the keychain or keyring, then retry.",
  transport:
    "Brightspace could not be reached to sign in. The saved session was kept. Check the connection and retry in a few minutes.",
  timeout:
    "The sign-in did not finish in time, usually a missed MFA prompt. " +
    `Run \`${AUTH_COMMAND}\` in a terminal (from your home folder) to complete it with the number visible.`,
  failed:
    `The sign-in did not complete. Run \`${AUTH_COMMAND}\` in a terminal (from your home folder) to see why, ` +
    "or `brightspace-setup` if the saved school or username is wrong.",
  inProgress:
    "Brightspace sign-in is still starting in the background (opening the browser and the school's login pages). " +
    "Retry now: the next call joins the same sign-in, so no second MFA prompt is sent, and it reports the number " +
    "to approve as soon as one appears.",
  mfaPending:
    `Approve the sign-in request on your phone (Microsoft Authenticator or Duo). ${MFA_RETRY_GUIDANCE}`,
};

const DOWNLOAD_FAILURE_GUIDANCE: Record<DownloadFailureKind, string> = {
  unsupportedType: "The file's format is not on the allowed download list. Open it from Brightspace in a browser instead.",
  undetectableType:
    "The file's format could not be identified, so it was not saved. This usually means Brightspace returned an error page instead of the file.",
  badFilename: "The name Brightspace gave this file cannot be used on disk. Pass customFilename to choose one yourself.",
  pathTraversal:
    "The name Brightspace gave this file pointed outside the download directory and was refused. Pass customFilename to choose one yourself.",
  tooLarge: "The file exceeds the download size limit and was not saved.",
};

/**
 * The one place internal failures become public ones. The facade and the CLI
 * both route every thrown error through here, so a script sees the same
 * `code` for the same situation no matter which entry point it used.
 *
 * Only text this module writes, or text derived from a closed set this
 * package assigns itself (`kind`, HTTP status, a validated MIME token), ever
 * reaches `message` — never the caught error's own text.
 */
export function toPublicError(error: unknown): BrightspaceError {
  if (error instanceof BrightspaceError) return error;

  if (error instanceof AuthProcessError) {
    if (error.kind === "mfaPending") return new BrightspaceMfaPendingError(error.numberMatch);
    return new BrightspaceAuthFailedError(error.kind, AUTH_FAILURE_GUIDANCE[error.kind]);
  }

  if (error instanceof NativeCredentialStoreError) {
    return new BrightspaceAuthFailedError("secureStorage", AUTH_FAILURE_GUIDANCE.secureStorage);
  }

  // Checked before NetworkError, which it extends: a token service that is
  // briefly down is not a dead connection, and the saved session survives it.
  if (error instanceof TokenRefreshError) {
    return new BrightspaceNetworkError(
      "Brightspace could not renew the session right now. The saved login was kept. Retry in a few minutes.",
    );
  }

  if (error instanceof DownloadError) {
    const detail = error.detail && isSafeDetail(error.detail) ? ` (detected type: ${error.detail})` : "";
    return new BrightspaceDownloadError(error.kind, `Could not save the file.${detail} ${DOWNLOAD_FAILURE_GUIDANCE[error.kind]}`);
  }

  // RateLimitError extends ApiError, so it must be checked first.
  // A Retry-After too long for the client to wait out is surfaced at once,
  // so say how long Brightspace asked for rather than "a moment".
  if (error instanceof RateLimitError) {
    return new BrightspaceRateLimitedError(
      error.retryAfter
        ? `Rate limited by Brightspace. Retry after ${error.retryAfter}s.`
        : undefined,
    );
  }

  if (error instanceof ApiError) {
    if (error.status === 401) return new BrightspaceAuthExpiredError();
    if (error.status === 403) return new BrightspaceForbiddenError();
    if (error.status === 404) return new BrightspaceNotFoundError();
    return new BrightspaceApiError(error.status);
  }

  if (error instanceof NetworkError) return new BrightspaceNetworkError(undefined, { cause: error });

  if (error instanceof ZodError) {
    return new BrightspaceInvalidArgumentError(error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }

  if (error instanceof NoTranscriptError) return new BrightspaceNotFoundError("No transcript is available for this video.");
  if (error instanceof TranscriptFetchError) return new BrightspaceNetworkError("The transcript could not be fetched from the video platform.", { cause: error });

  return new BrightspaceError("BRIGHTSPACE_UNEXPECTED", "An unexpected error occurred.", { cause: error });
}
