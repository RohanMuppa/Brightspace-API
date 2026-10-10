import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";
import {
  BrightspaceAuthExpiredError,
  BrightspaceMfaPendingError,
  BrightspaceInvalidArgumentError,
} from "../../src/errors.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * The facade never touches the network: D2LApiClient and AuthRunner are
 * replaced with fakes so a test exercises only the wiring in
 * src/client/index.ts — which onAuthExpired callback gets built, and how the
 * facade maps whatever a feature throws to the public error contract.
 */
const authRunnerRun = vi.fn();
vi.mock("../../src/auth/auth-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/auth-runner.js")>();
  return {
    ...actual,
    AuthRunner: vi.fn().mockImplementation(function AuthRunner() { return { run: authRunnerRun }; }),
  };
});

interface FakeApi {
  lp: (p: string) => string;
  get: ReturnType<typeof vi.fn>;
  onAuthExpired?: () => Promise<boolean>;
}
const fakeApis: FakeApi[] = [];
vi.mock("../../src/api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/index.js")>();
  return {
    ...actual,
    D2LApiClient: vi.fn().mockImplementation(function D2LApiClient(options: { onAuthExpired?: () => Promise<boolean> }) {
      const api: FakeApi = {
        lp: (p: string) => `/d2l/api/lp/1.0${p}`,
        get: vi.fn(async () => ({ Items: [] })),
        onAuthExpired: options.onAuthExpired,
      };
      fakeApis.push(api);
      return api;
    }),
  };
});

const { createBrightspaceClient } = await import("../../src/client/index.js");

function makeConfig(): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly: true },
  } as AppConfig;
}

beforeEach(() => {
  authRunnerRun.mockReset();
  fakeApis.length = 0;
});

describe("BrightspaceClient facade", () => {
  it("getMyCourses returns plain objects from the injected config", async () => {
    const client = await createBrightspaceClient({ config: makeConfig() });
    fakeApis[0].get.mockResolvedValueOnce({
      Items: [{
        OrgUnit: { Id: 1, Name: "Course", Code: "c1" },
        Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
      }],
    });

    const result = await client.getMyCourses();

    expect(result).toEqual([
      { id: 1, name: "Course", code: "c1", role: "Student", isActive: true, canAccess: undefined, lastAccessed: null },
    ]);
  });

  it("maps a 401 ApiError to BrightspaceAuthExpiredError under the default 'fail' policy", async () => {
    const client = await createBrightspaceClient({ config: makeConfig() });
    fakeApis[0].get.mockRejectedValueOnce(new ApiError(401, "/d2l/api/lp/1.0/enrollments", "unauthorized"));

    const error = await client.getMyCourses().catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceAuthExpiredError);
    expect(error.code).toBe("BRIGHTSPACE_AUTH_EXPIRED");
  });

  it("under 'login', maps an mfaPending AuthProcessError to BrightspaceMfaPendingError and calls onMfaChallenge", async () => {
    authRunnerRun.mockRejectedValueOnce(new AuthProcessError("mfaPending", "Approve on your phone", "47"));
    const onMfaChallenge = vi.fn();
    const client = await createBrightspaceClient({ config: makeConfig(), onAuthExpired: "login", onMfaChallenge });
    // Simulate the real D2LApiClient's 401 recovery path calling the
    // onAuthExpired callback the facade built for this client.
    fakeApis[0].get.mockImplementationOnce(async () => {
      await fakeApis[0].onAuthExpired!();
      throw new Error("unreachable — onAuthExpired above always throws or resolves");
    });

    const error = await client.getMyCourses().catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceMfaPendingError);
    expect(error.code).toBe("BRIGHTSPACE_MFA_PENDING");
    expect(error.numberMatch).toBe("47");
    expect(onMfaChallenge).toHaveBeenCalledWith("47");
  });

  it("under 'login', maps an automaticPending AuthProcessError to BrightspaceAutomaticPendingError and calls onAutomaticPending", async () => {
    authRunnerRun.mockRejectedValueOnce(new AuthProcessError("automaticPending", "Answering its own code"));
    const onAutomaticPending = vi.fn();
    const client = await createBrightspaceClient({ config: makeConfig(), onAuthExpired: "login", onAutomaticPending });
    fakeApis[0].get.mockImplementationOnce(async () => {
      await fakeApis[0].onAuthExpired!();
      throw new Error("unreachable — onAuthExpired above always throws or resolves");
    });

    const error = await client.getMyCourses().catch((e) => e);

    expect(error.code).toBe("BRIGHTSPACE_AUTOMATIC_PENDING");
    expect(onAutomaticPending).toHaveBeenCalledOnce();
  });

  it("maps a ZodError to BrightspaceInvalidArgumentError", async () => {
    const client = await createBrightspaceClient({ config: makeConfig() });

    const error = await client.getMyCourses({ activeOnly: "yes" as unknown as boolean }).catch((e) => e);

    expect(error).toBeInstanceOf(BrightspaceInvalidArgumentError);
    expect(error.code).toBe("BRIGHTSPACE_INVALID_ARGUMENT");
    expect(fakeApis[0].get).not.toHaveBeenCalled();
  });
});
