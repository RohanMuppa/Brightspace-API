import { describe, it, expect, vi } from "vitest";
import { getClasslistEmails } from "../../src/features/classlist-emails.js";
import type { FeatureContext } from "../../src/features/context.js";

/**
 * The paged classlist points at its next page with Next. Reading only the
 * first page used to hide everyone after it behind a warning.
 */

const COURSE_ID = 101;

const user = (name: string) => ({
  Identifier: name.length,
  DisplayName: name,
  Email: `${name}@example.edu`,
  ClasslistRoleDisplayName: "Student",
});

function setup(respond: (path: string) => unknown) {
  const requested: string[] = [];
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };
  const ctx = { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx, requested };
}

describe("getClasslistEmails pagination", () => {
  it("returns everyone across both pages", async () => {
    const { ctx, requested } = setup((path) =>
      path.includes("bookmark=b1") ? { Objects: [user("grace")], Next: null } : { Objects: [user("ada")], Next: "b1" },
    );

    const emails = await getClasslistEmails(ctx, { courseId: COURSE_ID });

    expect(emails.map((e) => e.name)).toEqual(["ada", "grace"]);
    expect(requested).toHaveLength(2);
  });

  it("filters out users with no email", async () => {
    const { ctx } = setup(() => ({
      Objects: [user("ada"), { ...user("grace"), Email: null }],
      Next: null,
    }));

    const emails = await getClasslistEmails(ctx, { courseId: COURSE_ID });

    expect(emails).toEqual([{ name: "ada", email: "ada@example.edu", role: "Student" }]);
  });
});
