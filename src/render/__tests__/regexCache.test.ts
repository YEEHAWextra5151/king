import { describe, expect, test } from "vitest";
import { defaultJavaScriptRegexConstructor } from "shiki/engine/javascript";
import { constructRegex } from "../regexCache";

describe("regex translation cache", () => {
  const patterns = [
    "\\b(const|let|var)\\b",
    "(?i)select\\s+\\*",
    "\\G(?<=\\.)\\s*([A-Za-z_$][\\w$]*)",
    "a++b",
    "(?>foo|foobar)x",
    "\\h+:\\h+",
    "(?<!\\\\)\\$\\{",
  ];

  test("matches exactly what Shiki's own constructor would", () => {
    const samples = ["const x = 1", "SELECT * from t", "obj.prop", "aaab", "foobarx fooX", "a1:ff", "x ${y}"];
    for (const pattern of patterns) {
      const ours = constructRegex(pattern);
      const theirs = defaultJavaScriptRegexConstructor(pattern);
      expect(ours.flags).toBe(theirs.flags);
      for (const sample of samples) {
        ours.lastIndex = 0;
        theirs.lastIndex = 0;
        expect(ours.exec(sample)?.[0], `${pattern} on ${sample}`).toBe(theirs.exec(sample)?.[0]);
      }
    }
  });

  test("a second construction reuses the translation", () => {
    const a = constructRegex("\\b(if|else)\\b");
    const b = constructRegex("\\b(if|else)\\b");
    expect(a).not.toBe(b); // fresh RegExp objects (lastIndex is per scanner)
    expect(a.source).toBe(b.source);
  });

  test("patterns the engine can't express throw every time", () => {
    const bad = "(?<a>x)\\k<b>";
    expect(() => constructRegex(bad)).toThrow();
    expect(() => constructRegex(bad)).toThrow();
  });
});
