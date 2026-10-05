import { describe, it, expect } from "vitest";
import { stripSessionParams } from "../../src/utils/session-params.js";

describe("stripSessionParams", () => {
  it("drops d2lSessionVal and d2lSecureSessionVal in any case and keeps routing params in order", () => {
    expect(
      stripSessionParams(
        "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&d2lSessionVal=a&type=lti&D2LSECURESESSIONVAL=b&rcode=PU-1",
      ),
    ).toBe("/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=PU-1");
  });

  it("matches a percent-encoded parameter name", () => {
    expect(stripSessionParams("https://x.edu/d2l/a?%642lSessionVal=a&ou=1")).toBe("https://x.edu/d2l/a?ou=1");
  });

  it("removes the query entirely when only session parameters were in it, keeping the fragment", () => {
    expect(stripSessionParams("/d2l/a?d2lsessionval=a&d2lsecuresessionval=b#top")).toBe("/d2l/a#top");
  });

  it("leaves a URL without them untouched", () => {
    const url = "https://cdnapisec.kaltura.com/p/1/embed?wid=_1&entry_id=1_a";
    expect(stripSessionParams(url)).toBe(url);
    expect(stripSessionParams("/d2l/a")).toBe("/d2l/a");
  });
});
