import { describe, expect, test } from "vitest";
import { fuzzyMatch, fuzzyPath } from "../fuzzy";
import { basename, dirname, disambiguate, isMarkdownPath, tildify } from "../paths";

describe("paths", () => {
  test("basename and dirname", () => {
    expect(basename("/a/b/README.md")).toBe("README.md");
    expect(basename("/a/b/")).toBe("b");
    expect(dirname("/a/b/README.md")).toBe("/a/b");
    expect(dirname("/README.md")).toBe("/");
  });

  test("tildify", () => {
    expect(tildify("/Users/ada/Projects/x.md")).toBe("~/Projects/x.md");
    expect(tildify("/Volumes/Data/x.md")).toBe("/Volumes/Data/x.md");
    expect(tildify("/Users/ada")).toBe("~");
  });

  test("markdown extensions", () => {
    for (const ext of ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext", "MD"]) {
      expect(isMarkdownPath(`/x/readme.${ext}`)).toBe(true);
    }
    expect(isMarkdownPath("/x/notes.txt")).toBe(false);
  });

  test("disambiguate uses the shortest distinguishing parent", () => {
    expect(disambiguate(["/p/web/README.md", "/p/api/README.md", "/p/guide.md", null])).toEqual(["web", "api", null, null]);
    expect(disambiguate(["/a/x/docs/README.md", "/b/y/docs/README.md"])).toEqual(["x/docs", "y/docs"]);
    // The same file twice isn't ambiguous.
    expect(disambiguate(["/p/README.md", "/p/README.md"])).toEqual([null, null]);
  });
});

describe("fuzzy", () => {
  test("in-order characters, contiguous and word starts rank higher", () => {
    expect(fuzzyMatch("gde", "guide.md")).not.toBeNull();
    expect(fuzzyMatch("xyz", "guide.md")).toBeNull();
    const contiguous = fuzzyMatch("read", "README.md")!;
    const scattered = fuzzyMatch("read", "rename-all-docs.md")!;
    expect(contiguous.score).toBeGreaterThan(scattered.score);
    expect(contiguous.indices).toEqual([0, 1, 2, 3]);
  });

  test("folders are searched only for queries with a slash", () => {
    expect(fuzzyPath("long", "README.md", "/tmp/claude/home-user-king/README.md")).toBeNull();
    expect(fuzzyPath("docs/gui", "guide.md", "/p/docs/guide.md")).not.toBeNull();
    const byName = fuzzyPath("guide", "guide.md", "/p/docs/guide.md")!;
    expect(byName.indices.length).toBe(5);
  });
});
