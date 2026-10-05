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

describe("getVideoTranscript — Brightspace LTI quickLinks", () => {
  const BASE_URL = "https://purdue.brightspace.com";
  const QUICKLINK = "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=PU-123&srcou=6606";

  function launchPage(body: string) {
    return `<html><body>${body}<script>document.forms[0].submit();</script></body></html>`;
  }

  type Page = { html: string } | { redirect: string } | null;

  function setupLti(pages: Record<string, string | Page>, topicUrl: string = QUICKLINK) {
    const { ctx } = setup(kalturaFetch(), topicUrl);
    const getPage = vi.fn(async (path: string): Promise<Page> => {
      if (!(path in pages)) throw new Error(`Unexpected getPage: ${path}`);
      const page = pages[path];
      return typeof page === "string" ? { html: page } : page;
    });
    Object.assign(ctx.api, { getPage });
    Object.assign(ctx, { config: { baseUrl: BASE_URL } });
    return { ctx, getPage };
  }

  it("follows the LTI launch form to the Kaltura video and returns its transcript", async () => {
    const { ctx } = setupLti({
      [QUICKLINK]: launchPage(
        `<form id="LtiRequestForm" method="post" action="https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&amp;entry_id=1_abcdefg">` +
          `<input type="hidden" name="lti_version" value="LTI-1p0" /></form>`,
      ),
    });
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(true);
    if (!result.hasTranscript) throw new Error("expected hasTranscript");
    expect(result.platform).toBe("kaltura");
    expect(result.transcript).toBe(
      "[0:00:01] Welcome back to lecture seven.\n[0:00:04] Today: pinch-off in a MOSFET.",
    );
  });

  it("takes the Kaltura partner ID from the LTI consumer key when a school's KAF launch URL omits it", async () => {
    const { ctx } = setupLti({
      [QUICKLINK]: launchPage(
        `<form method="post" action="https://kaf.example.edu/browseandembed/index/media/entry_id/1_abcdefg">` +
          `<input type="hidden" name="oauth_consumer_key" value="123456" /></form>`,
      ),
    });
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(true);
    expect(result.platform).toBe("kaltura");
  });

  it("follows a quickLink page that frames the Brightspace tool launch", async () => {
    const { ctx } = setupLti({
      [QUICKLINK]: `<html><body><iframe src="/d2l/le/lti/101/toolLaunch/77?topicId=55&amp;x=1"></iframe></body></html>`,
      "/d2l/le/lti/101/toolLaunch/77?topicId=55&x=1": launchPage(
        `<form method="post" action="https://kaf.kaltura.com/browseandembed/index/media/entry_id/1_abcdefg/wid/_123456"></form>`,
      ),
    });
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(true);
  });

  it("reads a redirect off the Brightspace origin as the video, without requesting it", async () => {
    const { ctx, getPage } = setupLti({ [QUICKLINK]: { redirect: KALTURA_URL } });
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(true);
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it("says the LTI link could not be resolved when the page can't be read with the session cookie", async () => {
    const { ctx } = setupLti({ [QUICKLINK]: null });
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(false);
    if (result.hasTranscript) throw new Error("expected no transcript");
    expect(result.message).toMatch(/LTI link/);
  });

  it("says the LTI link could not be resolved, rather than calling it an unsupported platform", async () => {
    const { ctx } = setupLti({
      [QUICKLINK]: launchPage(
        `<form method="post" action="https://tool.example.com/lti/login">` +
          `<input type="hidden" name="login_hint" value="abc" /></form>`,
      ),
    });
    const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

    expect(result.hasTranscript).toBe(false);
    if (result.hasTranscript) throw new Error("expected no transcript");
    expect(result.message).toMatch(/LTI link/);
    expect(result.message).not.toMatch(/supported video platform/);
  });

  describe("session query parameters", () => {
    const WITH_SESSION =
      "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&d2lSessionVal=SECRET1&type=lti&D2LSECURESESSIONVAL=SECRET2&rcode=PU-123";

    it("never returns d2lSessionVal or d2lSecureSessionVal, but keeps ou/type/rcode", async () => {
      const { ctx, getPage } = setupLti({ [WITH_SESSION]: null }, WITH_SESSION);
      const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

      expect(getPage).toHaveBeenCalledWith(WITH_SESSION);
      const output = JSON.stringify(result);
      expect(output).not.toMatch(/SECRET|sessionval/i);
      expect(result.videoUrl).toBe("/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=PU-123");
      if (result.hasTranscript) throw new Error("expected no transcript");
      expect(result.message).toContain("ou=101&type=lti&rcode=PU-123");
    });

    it("strips them from a resolved video URL as well", async () => {
      const { ctx } = setupLti({
        [QUICKLINK]: launchPage(
          `<form action="https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&amp;entry_id=1_abcdefg&amp;d2lSessionVal=SECRET1"></form>`,
        ),
      });
      const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

      expect(result.hasTranscript).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/SECRET|sessionval/i);
      expect(result.videoUrl).toBe(KALTURA_URL);
    });

    it("strips them from an unsupported-platform message", async () => {
      const { ctx } = setup(kalturaFetch());
      const result = await getVideoTranscript(ctx, {
        videoUrl: "https://media.example.com/watch?v=1&d2lsessionval=SECRET1",
      });

      expect(JSON.stringify(result)).not.toMatch(/SECRET|sessionval/i);
    });
  });

  describe("absolute URLs", () => {
    it("treats an absolute /d2l/ URL on the configured origin like a relative one", async () => {
      const { ctx, getPage } = setupLti({
        [QUICKLINK]: launchPage(`<form action="${KALTURA_URL.replace(/&/g, "&amp;")}"></form>`),
      });
      const result = await getVideoTranscript(ctx, { videoUrl: `${BASE_URL}${QUICKLINK}#frag` });

      expect(getPage).toHaveBeenCalledWith(QUICKLINK);
      expect(result.hasTranscript).toBe(true);
    });

    it("follows an absolute same-origin tool launch framed by the quickLink as a path", async () => {
      const { ctx, getPage } = setupLti({
        [QUICKLINK]: `<iframe src="${BASE_URL}/d2l/le/lti/101/toolLaunch/77"></iframe>`,
        "/d2l/le/lti/101/toolLaunch/77": launchPage(`<form action="${KALTURA_URL.replace(/&/g, "&amp;")}"></form>`),
      });
      const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

      expect(getPage).toHaveBeenLastCalledWith("/d2l/le/lti/101/toolLaunch/77");
      expect(result.hasTranscript).toBe(true);
    });

    it("never sends the session to a /d2l/ URL on another origin", async () => {
      for (const videoUrl of [
        `https://evil.example.com${QUICKLINK}`,
        `https://purdue.brightspace.com.evil.example.com${QUICKLINK}`,
        `//evil.example.com${QUICKLINK}`,
      ]) {
        // Through the topic route, which (unlike videoUrl) also accepts a protocol-relative link.
        const { ctx, getPage } = setupLti({}, videoUrl);
        const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

        expect(getPage).not.toHaveBeenCalled();
        expect(result.hasTranscript).toBe(false);
      }
    });

    it("does not follow a framed /d2l/ page on another origin", async () => {
      const { ctx, getPage } = setupLti({
        [QUICKLINK]: `<iframe src="https://evil.example.com/d2l/le/lti/101/toolLaunch/77"></iframe>`,
      });
      const result = await getVideoTranscript(ctx, { courseId: COURSE_ID, topicId: 55 });

      expect(getPage).toHaveBeenCalledTimes(1);
      expect(result.hasTranscript).toBe(false);
    });
  });
});
