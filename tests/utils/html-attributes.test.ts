import { describe, it, expect } from "vitest";
import { decodeEntities, tagAttributes } from "../../src/utils/html-attributes.js";

describe("html-attributes", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a&amp;b &quot;c&quot; &#39;d&#39; &#x1F600;")).toBe(
      "a&b \"c\" 'd' \u{1F600}"
    );
  });

  it("keeps a reference past U+10FFFF as written instead of throwing (issue #72)", () => {
    expect(decodeEntities("x&#x110000;y&#99999999;z")).toBe("x&#x110000;y&#99999999;z");
  });

  it("still decodes the rest of an element whose attribute holds an out-of-range reference", () => {
    const [attributes] = tagAttributes(
      '<a title="&#99999999;" href="/d2l/a?b=1&amp;c=2">x</a>',
      "a"
    );
    expect(attributes.get("href")).toBe("/d2l/a?b=1&c=2");
    expect(attributes.get("title")).toBe("&#99999999;");
  });

  it("decodes each reference once, so an encoded ampersand stays literal (issue #79)", () => {
    expect(decodeEntities("&#38;lt;b&#38;gt; &#x26;amp; &#38;quot; &amp;lt;")).toBe(
      "&lt;b&gt; &amp; &quot; &lt;"
    );
  });

  it("keeps an encoded ampersand literal inside an attribute value", () => {
    const [attributes] = tagAttributes('<a href="/d2l/a?q=&#38;quot;x&amp;y=1">x</a>', "a");
    expect(attributes.get("href")).toBe("/d2l/a?q=&quot;x&y=1");
  });
});
