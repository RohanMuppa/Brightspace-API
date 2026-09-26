import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toPublicError, BrightspaceError } from "../../src/errors.js";
import { ApiError, RateLimitError, NetworkError, TokenRefreshError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";
import { DownloadError } from "../../src/utils/download-errors.js";
import { NoTranscriptError, TranscriptFetchError } from "../../src/utils/transcript/errors.js";

/**
 * One case per branch of toPublicError. Each internal error below carries a
 * sensitive marker in its own message; every assertion checks both the
 * mapped code and that the marker never reaches the public message, since
 * that is the one property every branch shares.
 */
const SECRET = "cookie=d2lSessionVal=super-secret-token";

describe("toPublicError", () => {
  it("passes a BrightspaceError through unchanged", () => {
    const original = new BrightspaceError("BRIGHTSPACE_UNEXPECTED", "already public");
    expect(toPublicError(original)).toBe(original);
  });

  it("maps an mfaPending AuthProcessError to BrightspaceMfaPendingError", () => {
    const error = toPublicError(new AuthProcessError("mfaPending", SECRET, "47"));
    expect(error.code).toBe("BRIGHTSPACE_MFA_PENDING");
    expect(error.name).toBe("BrightspaceMfaPendingError");
    expect((error as { numberMatch?: string }).numberMatch).toBe("47");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps a non-mfaPending AuthProcessError to BrightspaceAuthFailedError", () => {
    const error = toPublicError(new AuthProcessError("busy", SECRET));
    expect(error.code).toBe("BRIGHTSPACE_AUTH_FAILED");
    expect(error.name).toBe("BrightspaceAuthFailedError");
    expect((error as { kind?: string }).kind).toBe("busy");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps TokenRefreshError to BrightspaceNetworkError before the ApiError/NetworkError branches see it", () => {
    const error = toPublicError(new TokenRefreshError(SECRET));
    expect(error.code).toBe("BRIGHTSPACE_NETWORK");
    expect(error.name).toBe("BrightspaceNetworkError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps DownloadError to BrightspaceDownloadError", () => {
    const error = toPublicError(new DownloadError("unsupportedType", SECRET));
    expect(error.code).toBe("BRIGHTSPACE_DOWNLOAD_FAILED");
    expect(error.name).toBe("BrightspaceDownloadError");
    expect((error as { kind?: string }).kind).toBe("unsupportedType");
    expect(error.message).not.toContain(SECRET);
  });

  it("includes a detected MIME type detail when it is a safe token", () => {
    const error = toPublicError(new DownloadError("undetectableType", SECRET, "application/pdf"));
    expect(error.message).toContain("application/pdf");
    expect(error.message).not.toContain(SECRET);
  });

  it("drops an unsafe download detail rather than surfacing it", () => {
    const error = toPublicError(new DownloadError("undetectableType", SECRET, SECRET));
    expect(error.message).not.toContain(SECRET);
  });

  it("maps RateLimitError to BrightspaceRateLimitedError, checked before plain ApiError", () => {
    const error = toPublicError(new RateLimitError("/some/path", 30));
    expect(error.code).toBe("BRIGHTSPACE_RATE_LIMITED");
    expect(error.name).toBe("BrightspaceRateLimitedError");
  });

  it("maps a 401 ApiError to BrightspaceAuthExpiredError", () => {
    const error = toPublicError(new ApiError(401, "/some/path", SECRET));
    expect(error.code).toBe("BRIGHTSPACE_AUTH_EXPIRED");
    expect(error.name).toBe("BrightspaceAuthExpiredError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps a 403 ApiError to BrightspaceForbiddenError", () => {
    const error = toPublicError(new ApiError(403, "/some/path", SECRET));
    expect(error.code).toBe("BRIGHTSPACE_FORBIDDEN");
    expect(error.name).toBe("BrightspaceForbiddenError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps a 404 ApiError to BrightspaceNotFoundError", () => {
    const error = toPublicError(new ApiError(404, "/some/path", SECRET));
    expect(error.code).toBe("BRIGHTSPACE_NOT_FOUND");
    expect(error.name).toBe("BrightspaceNotFoundError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps any other ApiError status to BrightspaceApiError, carrying only the status", () => {
    const error = toPublicError(new ApiError(500, "/some/path", SECRET, SECRET));
    expect(error.code).toBe("BRIGHTSPACE_API_ERROR");
    expect(error.name).toBe("BrightspaceApiError");
    expect((error as { status?: number }).status).toBe(500);
    expect(error.message).not.toContain(SECRET);
  });

  it("maps NetworkError to BrightspaceNetworkError", () => {
    const error = toPublicError(new NetworkError(SECRET));
    expect(error.code).toBe("BRIGHTSPACE_NETWORK");
    expect(error.name).toBe("BrightspaceNetworkError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps a ZodError to BrightspaceInvalidArgumentError with path:message issues", () => {
    const schema = z.object({ activeOnly: z.boolean() });
    const zodError = schema.safeParse({ activeOnly: "not-a-boolean" }).error!;
    const error = toPublicError(zodError);
    expect(error.code).toBe("BRIGHTSPACE_INVALID_ARGUMENT");
    expect(error.name).toBe("BrightspaceInvalidArgumentError");
    expect((error as { issues?: readonly string[] }).issues?.[0]).toContain("activeOnly");
  });

  it("maps NoTranscriptError to BrightspaceNotFoundError", () => {
    const error = toPublicError(new NoTranscriptError(SECRET));
    expect(error.code).toBe("BRIGHTSPACE_NOT_FOUND");
    expect(error.name).toBe("BrightspaceNotFoundError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps TranscriptFetchError to BrightspaceNetworkError", () => {
    const error = toPublicError(new TranscriptFetchError(SECRET));
    expect(error.code).toBe("BRIGHTSPACE_NETWORK");
    expect(error.name).toBe("BrightspaceNetworkError");
    expect(error.message).not.toContain(SECRET);
  });

  it("maps anything unrecognized to BrightspaceError BRIGHTSPACE_UNEXPECTED", () => {
    const error = toPublicError(new Error(SECRET));
    expect(error.code).toBe("BRIGHTSPACE_UNEXPECTED");
    expect(error.name).toBe("BrightspaceError");
    expect(error.message).not.toContain(SECRET);
  });
});
