import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SCHOOL_PRESETS, buildConfigToSave, presetForArgv } =
  await import("../../src/setup.js");
const { createSSOFlow } = await import("../../src/auth/sso-flow.js");
const { SunySSOFlow } = await import("../../src/auth/suny-sso.js");
const { WesternSSOFlow } = await import("../../src/auth/western-sso.js");
const { PurdueSSOFlow } = await import("../../src/auth/purdue-sso.js");
type AppConfig = import("../../src/types/index.js").AppConfig;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("school presets", () => {
  it("resolves every shipped preset from its flag", () => {
    for (const [flag, expected] of Object.entries(SCHOOL_PRESETS)) {
      expect(presetForArgv(["node", "setup.js", `--${flag}`])).toBe(expected);
    }
    expect(presetForArgv(["node", "setup.js", "--WESTERN"])).toBe(SCHOOL_PRESETS.western);
  });

  it("ignores flags that are not presets, including inherited object keys", () => {
    expect(presetForArgv(["node", "setup.js"])).toBeUndefined();
    expect(presetForArgv(["node", "setup.js", "--not-a-school"])).toBeUndefined();
    for (const inherited of ["constructor", "__proto__", "toString", "valueOf"]) {
      expect(presetForArgv(["node", "setup.js", `--${inherited}`])).toBeUndefined();
    }
  });

  it("gives every preset an https origin the auth layer can match", () => {
    for (const preset of Object.values(SCHOOL_PRESETS)) {
      const url = new URL(preset.baseUrl);
      expect(url.protocol).toBe("https:");
      expect(preset.baseUrl).toBe(url.origin);
    }
  });

  it("routes each preset's saved URL to the sign-in flow written for it", () => {
    const flowFor = (baseUrl: string) => createSSOFlow({ baseUrl } as AppConfig);

    expect(flowFor(SCHOOL_PRESETS.western.baseUrl)).toBeInstanceOf(WesternSSOFlow);
    expect(flowFor(SCHOOL_PRESETS.suny.baseUrl)).toBeInstanceOf(SunySSOFlow);
    expect(flowFor(SCHOOL_PRESETS.purdue.baseUrl)).toBeInstanceOf(PurdueSSOFlow);
  });

  it("asks for a campus only where several campuses share one site", () => {
    expect(SCHOOL_PRESETS.suny.campusPrompt).toBeTruthy();
    expect(SCHOOL_PRESETS.western.campusPrompt).toBeUndefined();
    expect(SCHOOL_PRESETS.purdue.campusPrompt).toBeUndefined();
  });
});

describe("saved settings on a repeat run", () => {
  const answers = {
    baseUrl: "https://mylearning.suny.edu",
    username: "abc123@sunypoly.edu",
    password: "new-password",
    headless: true,
  };

  it("keeps settings the wizard never asks about", () => {
    const existing = {
      baseUrl: "https://mylearning.suny.edu",
      username: "abc123@sunypoly.edu",
      campus: "SUNY Poly",
      excludeCourses: [1234],
      activeOnly: false,
      sessionDir: "~/custom-session",
      tokenTtl: 900,
      headless: false,
    };

    expect(buildConfigToSave(existing, answers)).toEqual({
      ...existing,
      password: "new-password",
      headless: true,
    });
  });

  it("takes a newly answered campus over the stored one", () => {
    const saved = buildConfigToSave(
      { baseUrl: answers.baseUrl, campus: "SUNY Poly" },
      { ...answers, campus: "SUNY Oswego" },
    );
    expect(saved.campus).toBe("SUNY Oswego");
  });

  it("never carries a v1 plaintext password over the one just typed", () => {
    const saved = buildConfigToSave(
      { baseUrl: answers.baseUrl, password: "old-v1-password" },
      answers,
    );
    expect(saved.password).toBe("new-password");
  });

  it("starts clean when the school changes", () => {
    const saved = buildConfigToSave(
      { baseUrl: "https://purdue.brightspace.com", campus: "Purdue West Lafayette", excludeCourses: [7] },
      answers,
    );
    expect(saved).toEqual({ ...answers, password: "new-password" });
    expect(saved.campus).toBeUndefined();
    expect(saved.excludeCourses).toBeUndefined();
  });

  it("keeps settings from a config that never recorded a school", () => {
    const saved = buildConfigToSave({ excludeCourses: [7], activeOnly: false }, answers);
    expect(saved.excludeCourses).toEqual([7]);
    expect(saved.activeOnly).toBe(false);
  });

  it("writes just the answers when there is nothing saved yet", () => {
    expect(buildConfigToSave(null, { ...answers, campus: "SUNY Poly" })).toEqual({
      ...answers,
      campus: "SUNY Poly",
    });
  });
});
