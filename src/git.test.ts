import { expect, test } from "bun:test";
import { DEFAULT_EXCLUDES, extOf, parseLog } from "./git";

const log = [
  "\x001700000000\tAlice@X.com\tAlice",
  "",
  "10\t2\tsrc/a.ts",
  "500\t0\tpackage-lock.json",
  "-\t-\timg.png",
  "3\t1\tsrc/{old => new}/b.ts",
  "7\t0\tweb/dist/app.js",
  "",
  "\x001700000100\tbob@y.com\tBob",
  "",
  "1\t1\tREADME.md",
  "",
  "\x001700000200\talice@x.com\tAlice Smith",
  "\x001700000300\talice@x.com\tAlice",
  "",
  "4\t4\tgen/x.ts",
].join("\n");

test("parseLog", () => {
  const d = parseLog(log, [...DEFAULT_EXCLUDES, "gen/**"]);
  expect(d.authors).toEqual([
    { email: "alice@x.com", name: "Alice" },
    { email: "bob@y.com", name: "Bob" },
  ]);
  expect(d.exts).toEqual([".ts", ".md"]);
  expect(d.commits).toEqual([
    [1700000000, 0, 0, 13, 3],
    [1700000100, 1, 1, 1, 1],
    [1700000200, 0],
    [1700000300, 0],
  ]);
});

test("extOf", () => {
  expect(["a/b.TSX", "Makefile", "x/.gitignore", "a.min.js"].map(extOf)).toEqual([".tsx", "Makefile", ".gitignore", ".js"]);
});
