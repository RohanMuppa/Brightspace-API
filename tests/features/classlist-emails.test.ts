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

    expect([...emails]).toEqual([{ name: "ada", email: "ada@example.edu", role: "Student" }]);
    expect(emails.hiddenCount).toBe(1);
  });
});

/**
 * People whose email Brightspace hides were dropped without a word, so a
 * partial list read as the whole class and an all-hidden course as empty.
 */
describe("getClasslistEmails hidden emails", () => {
  const hiddenUser = (name: string) => ({ ...user(name), Email: null });

  it("lists visible emails and says how many people were left out", async () => {
    const { ctx } = setup(() => ({
      Objects: [user("ada"), hiddenUser("bob"), hiddenUser("cy")],
      Next: null,
    }));

    const emails = await getClasslistEmails(ctx, { courseId: COURSE_ID });

    expect(emails.map((e) => e.name)).toEqual(["ada"]);
    expect(emails.hiddenCount).toBe(2);
    expect(emails.notice).toBe(
      "2 of 3 people in this course have no email visible to you (Brightspace hides it), so they are not listed.",
    );
    // The properties ride on the array: the JSON is still just the entries.
    expect(JSON.parse(JSON.stringify(emails))).toEqual([{ name: "ada", email: "ada@example.edu", role: "Student" }]);
  });

  it("does not report an all-hidden course as empty", async () => {
    const { ctx } = setup(() => ({ Objects: [hiddenUser("bob")], Next: null }));

    const emails = await getClasslistEmails(ctx, { courseId: COURSE_ID });

    expect(emails).toHaveLength(0);
    expect(emails.hiddenCount).toBe(1);
    expect(emails.notice).toBe(
      "1 of 1 person in this course has no email visible to you (Brightspace hides it), so they are not listed.",
    );
  });

  it("adds no notice when every email is visible", async () => {
    const { ctx } = setup(() => ({ Objects: [user("ada")], Next: null }));

    const emails = await getClasslistEmails(ctx, { courseId: COURSE_ID });

    expect(emails.hiddenCount).toBeUndefined();
    expect(emails.notice).toBeUndefined();
    expect(Object.keys(emails)).toEqual(["0"]);
  });
});
