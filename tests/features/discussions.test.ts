import { describe, it, expect, vi } from "vitest";
import { getDiscussions } from "../../src/features/discussions.js";
import { BrightspaceInvalidArgumentError } from "../../src/errors.js";
import type { FeatureContext } from "../../src/features/context.js";

const COURSE_ID = 101;

const forum = (id: number, overrides: Partial<Record<string, unknown>> = {}) => ({
  ForumId: id,
  Name: `Forum ${id}`,
  Description: { Text: `Forum ${id} description`, Html: `<p>Forum ${id} description</p>` },
  StartDate: null,
  EndDate: null,
  IsLocked: false,
  IsHidden: false,
  AllowAnonymous: false,
  RequiresApproval: false,
  ...overrides,
});

const topic = (forumId: number, id: number, overrides: Partial<Record<string, unknown>> = {}) => ({
  ForumId: forumId,
  TopicId: id,
  Name: `Topic ${id}`,
  Description: { Text: `Topic ${id} description`, Html: `<p>Topic ${id} description</p>` },
  StartDate: null,
  EndDate: null,
  DueDate: null,
  IsLocked: false,
  IsHidden: false,
  AllowAnonymousPosts: false,
  MustPostToParticipate: false,
  RequiresApproval: false,
  ScoreOutOf: null,
  ...overrides,
});

const post = (id: number, overrides: Partial<Record<string, unknown>> = {}) => ({
  ForumId: 1,
  TopicId: 1,
  PostId: id,
  ThreadId: id,
  ParentPostId: null,
  Subject: `Post ${id}`,
  Message: { Text: `Post ${id} body`, Html: `<p>Post ${id} body</p>` },
  PostingUserId: 1,
  PostingUserDisplayName: "Ada Lovelace",
  DatePosted: `2026-01-0${id}T00:00:00Z`,
  IsAnonymous: false,
  IsDeleted: false,
  LastEditedDate: null,
  ReplyPostIds: [],
  WordCount: 2,
  AttachmentCount: 0,
  IsRead: true,
  ...overrides,
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

describe("getDiscussions forums overview", () => {
  it("lists every forum with its topics when only courseId is given", async () => {
    const { ctx } = setup((path) => {
      if (path.endsWith("/discussions/forums/")) return [forum(1), forum(2)];
      if (path.includes("/forums/1/topics/")) return [topic(1, 10)];
      if (path.includes("/forums/2/topics/")) return [topic(2, 20)];
      throw new Error(`unexpected path ${path}`);
    });

    const result = await getDiscussions(ctx, { courseId: COURSE_ID });

    expect(result).toEqual({
      courseId: COURSE_ID,
      forumCount: 2,
      forums: [
        {
          forumId: 1,
          name: "Forum 1",
          description: "Forum 1 description",
          isLocked: false,
          isHidden: false,
          topics: [
            {
              topicId: 10,
              forumId: 1,
              name: "Topic 10",
              description: "Topic 10 description",
              dueDate: null,
              isLocked: false,
              isHidden: false,
              mustPostToParticipate: false,
              scoreOutOf: null,
            },
          ],
        },
        {
          forumId: 2,
          name: "Forum 2",
          description: "Forum 2 description",
          isLocked: false,
          isHidden: false,
          topics: [
            {
              topicId: 20,
              forumId: 2,
              name: "Topic 20",
              description: "Topic 20 description",
              dueDate: null,
              isLocked: false,
              isHidden: false,
              mustPostToParticipate: false,
              scoreOutOf: null,
            },
          ],
        },
      ],
    });
  });

  it("skips topics for a hidden forum it cannot access rather than throwing", async () => {
    const { ctx } = setup((path) => {
      if (path.endsWith("/discussions/forums/")) return [forum(1, { IsHidden: true })];
      const error: any = new Error("forbidden");
      error.status = 403;
      throw error;
    });

    const result = await getDiscussions(ctx, { courseId: COURSE_ID });

    expect(result).toEqual({
      courseId: COURSE_ID,
      forumCount: 1,
      forums: [
        { forumId: 1, name: "Forum 1", description: "Forum 1 description", isLocked: false, isHidden: true, topics: [] },
      ],
    });
  });
});

describe("getDiscussions forum detail", () => {
  it("returns the forum's topics with their posts, as markdown, sorted by date", async () => {
    const { ctx } = setup((path) => {
      if (path === "/d2l/api/le/1.0/101/discussions/forums/1") return forum(1);
      if (path.includes("/forums/1/topics/") && path.endsWith("/topics/")) return [topic(1, 10)];
      if (path.includes("/topics/10/posts/")) {
        return [
          post(2, { DatePosted: "2026-01-02T00:00:00Z", Message: { Text: "second", Html: "<p>second</p>" } }),
          post(1, { DatePosted: "2026-01-01T00:00:00Z", Message: { Text: "first", Html: "<p>first</p>" } }),
          post(3, { IsDeleted: true }),
        ];
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await getDiscussions(ctx, { courseId: COURSE_ID, forumId: 1 });

    expect(result).toEqual({
      courseId: COURSE_ID,
      forum: { forumId: 1, name: "Forum 1", description: "Forum 1 description", isLocked: false, isHidden: false },
      topicCount: 1,
      topics: [
        {
          topicId: 10,
          name: "Topic 10",
          description: "Topic 10 description",
          dueDate: null,
          isLocked: false,
          mustPostToParticipate: false,
          scoreOutOf: null,
          postCount: 3,
          posts: [
            {
              postId: 1,
              threadId: 1,
              parentPostId: null,
              subject: "Post 1",
              message: "first",
              author: "Ada Lovelace",
              datePosted: "2026-01-01T00:00:00Z",
              lastEditedDate: null,
              replyCount: 0,
              wordCount: 2,
              attachmentCount: 0,
              isRead: true,
            },
            {
              postId: 2,
              threadId: 2,
              parentPostId: null,
              subject: "Post 2",
              message: "second",
              author: "Ada Lovelace",
              datePosted: "2026-01-02T00:00:00Z",
              lastEditedDate: null,
              replyCount: 0,
              wordCount: 2,
              attachmentCount: 0,
              isRead: true,
            },
          ],
        },
      ],
    });
  });
});

describe("getDiscussions topic posts", () => {
  it("returns anonymous posts with the author masked", async () => {
    const { ctx } = setup((path) => {
      if (path === "/d2l/api/le/1.0/101/discussions/forums/1/topics/10") return topic(1, 10);
      if (path.includes("/topics/10/posts/")) return [post(1, { IsAnonymous: true })];
      throw new Error(`unexpected path ${path}`);
    });

    const result = await getDiscussions(ctx, { courseId: COURSE_ID, forumId: 1, topicId: 10 });

    expect(result).toEqual({
      courseId: COURSE_ID,
      forumId: 1,
      topic: {
        topicId: 10,
        name: "Topic 10",
        description: "Topic 10 description",
        dueDate: null,
        isLocked: false,
        mustPostToParticipate: false,
        scoreOutOf: null,
      },
      postCount: 1,
      posts: [
        {
          postId: 1,
          threadId: 1,
          parentPostId: null,
          subject: "Post 1",
          message: "Post 1 body",
          author: "Anonymous",
          datePosted: "2026-01-01T00:00:00Z",
          lastEditedDate: null,
          replyCount: 0,
          wordCount: 2,
          attachmentCount: 0,
          isRead: true,
        },
      ],
    });
  });
});

describe("getDiscussions argument validation", () => {
  it("throws BrightspaceInvalidArgumentError when topicId is given without forumId", async () => {
    const { ctx } = setup(() => {
      throw new Error("should not fetch");
    });

    await expect(getDiscussions(ctx, { courseId: COURSE_ID, topicId: 10 })).rejects.toBeInstanceOf(
      BrightspaceInvalidArgumentError,
    );
  });
});
