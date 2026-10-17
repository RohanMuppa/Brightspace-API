import { describe, it, expect } from "vitest";
import { parseCoursePath, extractCourseFilePaths, QUICKLINK_PATH } from "../../src/utils/course-files.js";

const COURSE = 101;

describe("parseCoursePath", () => {
  it("accepts a plain relative course file path", () => {
    expect(parseCoursePath("Notes/Lecture 1.pdf", COURSE)).toBe("Notes/Lecture 1.pdf");
  });

  it("resolves a quickLink URL for this course to its fileId", () => {
    const link = `${QUICKLINK_PATH}?ou=101&type=coursefile&fileId=Notes%2FLecture01.pdf`;
    expect(parseCoursePath(link, COURSE)).toBe("Notes/Lecture01.pdf");
  });

  it("refuses a quickLink that is not type=coursefile", () => {
    const link = `${QUICKLINK_PATH}?ou=101&type=lti&rcode=X`;
    const result = parseCoursePath(link, COURSE);
    expect(result).toHaveProperty("error");
  });

  it("refuses a quickLink for a different course", () => {
    const link = `${QUICKLINK_PATH}?ou=999&type=coursefile&fileId=Notes%2Fa.pdf`;
    const result = parseCoursePath(link, COURSE) as { error: string };
    expect(result.error).toContain("999");
  });

  it.each([
    "../secret.pdf",
    "Notes/../../secret.pdf",
    "/etc/passwd",
    "https://evil.example/a.pdf",
    "Notes\\..\\a.pdf",
    "",
    "Notes//a.pdf",
  ])("refuses the path %s", input => {
    const result = parseCoursePath(input, COURSE);
    expect(result).toHaveProperty("error");
  });
});

describe("extractCourseFilePaths", () => {
  const link = (file: string, ou = 101, extra = "") =>
    `<a href="${QUICKLINK_PATH}?ou=${ou}&amp;type=coursefile&amp;fileId=${file}${extra}">x</a>`;

  it("lists the course file paths linked in a module description, once each", () => {
    // The same file is usually linked twice: the visible link and the embedded viewer.
    const html = `<p>${link("Notes%2fLecture01.pdf")}</p><p>${link("Notes%2fLecture01.pdf")}</p><p>${link("Tutorials%2fT01.pdf")}</p>`;

    expect(extractCourseFilePaths(html, COURSE)).toEqual(["Notes/Lecture01.pdf", "Tutorials/T01.pdf"]);
  });

  it("keeps parentheses and spaces in the file name", () => {
    expect(extractCourseFilePaths(link("Notes%2fsyntax%28new-proof%29.pdf"), COURSE)).toEqual([
      "Notes/syntax(new-proof).pdf",
    ]);
    expect(extractCourseFilePaths(link("Notes%2fSlide+61+and+63.pdf"), COURSE)).toEqual([
      "Notes/Slide 61 and 63.pdf",
    ]);
  });

  it("ignores LTI links and links to other courses", () => {
    const lti = `<a href="${QUICKLINK_PATH}?ou=101&amp;type=lti&amp;rCode=A">tool</a>`;
    const other = `<a href="${QUICKLINK_PATH}?ou=999&amp;type=coursefile&amp;fileId=Notes%2fa.pdf">x</a>`;

    expect(extractCourseFilePaths(lti + other, COURSE)).toEqual([]);
  });

  it("drops paths that parseCoursePath would refuse", () => {
    expect(extractCourseFilePaths(link("..%2fsecret.pdf") + link("Notes%2fok.pdf"), COURSE)).toEqual([
      "Notes/ok.pdf",
    ]);
  });
});
