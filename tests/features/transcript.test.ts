import { describe, it, expect, vi, afterEach } from "vitest";
import { getVideoTranscript } from "../../src/features/transcript.js";
import { BrightspaceInvalidArgumentError } from "../../src/errors.js";
import { NoTranscriptError } from "../../src/utils/transcript/errors.js";
import type { FeatureContext } from "../../src/features/context.js";
import type { FetchLike } from "../../src/utils/transcript/types.js";

const COURSE_ID = 101;
const KALTURA_URL =
  "https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&entry_id=1_abcdefg";

const KALTURA_WEBVTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome back to lecture seven.

00:00:04.000 --> 00:00:08.000
Today: pinch-off in a MOSFET.
`;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(body: string) {
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
}

/** A fetch stub that answers the Kaltura widget-session/caption-list/serve/media-get sequence. */
function kalturaFetch(overrides: Partial<{ captionAssets: unknown[]; captionText: string }> = {}): FetchLike {
  const captionAssets = overrides.captionAssets ?? [{ id: "cap1", languageCode: "en", isDefault: true }];
  const captionText = overrides.captionText ?? KALTURA_WEBVTT;

  return vi.fn(async (url: string) => {
    if (url.includes("session/action/startWidgetSession")) return jsonResponse({ ks: "widget-ks-token" });
    if (url.includes("caption_captionasset/action/list")) return jsonResponse({ objects: captionAssets });
    if (url.includes("caption_captionasset/action/serve")) return textResponse(captionText);
    if (url.includes("media/action/get")) return jsonResponse({ name: "Lecture 7", duration: 3000 });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as FetchLike;
}

function setup(fetchImpl: FetchLike, topicUrl: string | null = KALTURA_URL) {
  vi.stubGlobal("fetch", fetchImpl);
  const api = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async () => ({ Id: 55, Title: "Lecture 7 recording", Url: topicUrl })),
  };
  const ctx = { api, config: {}, version: "0.0.0-test" } as unknown as FeatureContext;
  return { ctx };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getVideoTranscript — Kaltura", () => {
  it("returns the transcript with timestamps, title, and duration for a Kaltura topic", async () => {
    const { ctx } = setup(kalturaFetch());
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(true);
    if (!result.hasTranscript) throw new Error("expected hasTranscript");
    expect(result.platform).toBe("kaltura");
    expect(result.title).toBe("Lecture 7");
    expect(result.durationSeconds).toBe(3000);
    expect(result.language).toBe("en");
    expect(result.transcript).toBe(
      "[0:00:01] Welcome back to lecture seven.\n[0:00:04] Today: pinch-off in a MOSFET.",
    );
    expect(result.truncated).toBe(false);
  });

  it("propagates NoTranscriptError untouched when the video has no captions", async () => {
    const { ctx } = setup(kalturaFetch({ captionAssets: [] }));

    await expect(getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 })).rejects.toBeInstanceOf(
      NoTranscriptError,
    );
  });

  it("pages a long transcript across multiple calls via offset/nextOffset", async () => {
    const { ctx } = setup(kalturaFetch());

    const first = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55, maxChars: 20 });
    if (!first.hasTranscript) throw new Error("expected hasTranscript");
    expect(first.truncated).toBe(true);
    expect(first.transcript).toHaveLength(20);
    expect(first.nextOffset).toBe(20);

    let assembled = first.transcript;
    let offset: number | null = first.nextOffset;
    while (offset !== null) {
      const page = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55, maxChars: 20, offset });
      if (!page.hasTranscript) throw new Error("expected hasTranscript");
      assembled += page.transcript;
      offset = page.nextOffset;
    }

    expect(assembled).toBe("[0:00:01] Welcome back to lecture seven.\n[0:00:04] Today: pinch-off in a MOSFET.");
  });
});

describe("getVideoTranscript — unsupported and unresolved cases", () => {
  it("names the platform when it isn't supported yet", async () => {
    const { ctx } = setup(kalturaFetch(), null);
    const result = await getVideoTranscript(ctx, {
      videoUrl: "https://purdue.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=1",
    });

    expect(result.hasTranscript).toBe(false);
    if (result.hasTranscript) throw new Error("expected not hasTranscript");
    expect(result.platform).toBe("panopto");
    expect(result.message).toMatch(/Panopto/);
  });

  it("gives a clear message when the content topic has no URL to resolve", async () => {
    const { ctx } = setup(kalturaFetch(), null);
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(false);
    if (result.hasTranscript) throw new Error("expected not hasTranscript");
    expect(result.message).toMatch(/no URL/i);
  });

  it("requires either videoUrl or courseId+topicId", async () => {
    const { ctx } = setup(kalturaFetch());

    await expect(getVideoTranscript(ctx, {})).rejects.toBeInstanceOf(BrightspaceInvalidArgumentError);
  });
});
