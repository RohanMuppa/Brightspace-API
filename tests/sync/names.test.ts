import { describe, it, expect } from "vitest";
import { NameSet, fileNameFromTopic, foldKey, sanitizeComponent, splitExtension } from "../../src/sync/names.js";

/**
 * Module titles and file names in a sync come straight from the course, so
 * every one has to collapse to a single safe path component: no separators,
 * no leading dot (a course must never create a dotfile in the destination),
 * no Windows-reserved name, and no case-fold collision with a name already
 * taken in the same folder.
 */

describe("sanitizeComponent", () => {
  it("replaces characters invalid on Windows", () => {
    expect(sanitizeComponent('a<b>c:d"e/f\\g|h?i*j', "fallback")).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("prefixes a leading dot so a course cannot create a dotfile", () => {
    expect(sanitizeComponent(".ssh", "fallback")).toBe("_.ssh");
    expect(sanitizeComponent(".zshrc", "fallback")).toBe("_.zshrc");
  });

  it("falls back on an empty or all-dot name", () => {
    expect(sanitizeComponent("", "fallback")).toBe("fallback");
    expect(sanitizeComponent(".", "fallback")).toBe("fallback");
    expect(sanitizeComponent("..", "fallback")).toBe("fallback");
  });

  it("prefixes a Windows-reserved device name", () => {
    expect(sanitizeComponent("NUL", "fallback")).toBe("_NUL");
    expect(sanitizeComponent("con.txt", "fallback")).toBe("_con.txt");
  });

  it("trims trailing dots and spaces", () => {
    expect(sanitizeComponent("notes. ", "fallback")).toBe("notes");
  });

  it("caps the length, keeping the extension when it fits", () => {
    const long = "x".repeat(300) + ".pdf";
    const result = sanitizeComponent(long, "fallback", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("never returns something containing a path separator", () => {
    expect(sanitizeComponent("a/b\\c", "fallback")).not.toMatch(/[/\\]/);
  });
});

describe("foldKey", () => {
  it("treats case differences as the same name", () => {
    expect(foldKey("Notes.pdf")).toBe(foldKey("notes.PDF"));
  });

  it("folds German sharp s against ss", () => {
    expect(foldKey("straße")).toBe(foldKey("strasse"));
  });
});

describe("splitExtension", () => {
  it("splits stem and extension at the last dot", () => {
    expect(splitExtension("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: ".gz" });
  });

  it("treats a leading dot as not an extension", () => {
    expect(splitExtension(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });

  it("has no extension when there is no dot", () => {
    expect(splitExtension("README")).toEqual({ stem: "README", ext: "" });
  });
});

describe("fileNameFromTopic", () => {
  it("uses the upload's own name from the Url", () => {
    expect(fileNameFromTopic("/content/enforced/123-x/Lecture%201.pdf", "Lecture notes", "fallback")).toBe("Lecture 1.pdf");
  });

  it("falls back to the topic title when the Url has no usable basename", () => {
    expect(fileNameFromTopic("/content/enforced/123-x/", "Week 1 Slides", "fallback")).toBe("Week 1 Slides");
    expect(fileNameFromTopic("/content/enforced/123-x/....", "Week 1 Slides", "fallback")).toBe("Week 1 Slides");
  });

  it("neutralises a once-decoded percent escape so it cannot be decoded a second time downstream", () => {
    // "100%2525.pdf" decodes once to "100%25.pdf", which still looks like a valid escape.
    const name = fileNameFromTopic("/content/enforced/123-x/100%2525.pdf", "x", "fallback");
    expect(name).not.toMatch(/%[0-9a-fA-F]{2}/);
  });
});

describe("NameSet", () => {
  it("returns the name unchanged the first time", () => {
    const set = new NameSet();
    expect(set.add("notes.pdf")).toBe("notes.pdf");
  });

  it("numbers a repeat, compared case-insensitively", () => {
    const set = new NameSet();
    set.add("Notes.pdf");
    expect(set.add("notes.pdf")).toBe("notes (2).pdf");
    expect(set.add("notes.pdf")).toBe("notes (3).pdf");
  });

  it("numbers folders without an extension", () => {
    const set = new NameSet();
    set.add("Week 1", true);
    expect(set.add("Week 1", true)).toBe("Week 1 (2)");
  });

  it("resumes numbering where it left off rather than rescanning from 2", () => {
    const set = new NameSet();
    set.add("a.pdf");
    set.add("a.pdf"); // -> a (2).pdf
    set.add("a.pdf"); // -> a (3).pdf
    expect(set.add("a.pdf")).toBe("a (4).pdf");
  });
});
