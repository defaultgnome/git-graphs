import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXCLUDES, LOG_FORMAT, extOf, parseLog, readRepo } from "./git";

const log = [
  "\x001700000000\tAlice@X.com\tAlice\tabc123\tfix: a\tb",
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
  expect(d.info[0]).toEqual(["abc123", "fix: a\tb"]);
  expect(d.info[1]).toEqual(["", ""]);
});

test("extOf", () => {
  expect(["a/b.TSX", "Makefile", "x/.gitignore", "a.min.js"].map(extOf)).toEqual([".tsx", "Makefile", ".gitignore", ".js"]);
});

test("readRepo matches serial git log, cold and cached", async () => {
  const dir = import.meta.dir;
  const out = await new Response(
    Bun.spawn(["git", "-C", dir, "-c", "core.quotePath=off", "log", "--no-merges", "--numstat", `--format=${LOG_FORMAT}`]).stdout,
  ).text();
  const ref = parseLog(out, DEFAULT_EXCLUDES);
  const cache = join(tmpdir(), `ggrph-test-${process.pid}.log`);
  expect(await readRepo(dir, DEFAULT_EXCLUDES, cache)).toEqual(ref);
  expect(await readRepo(dir, DEFAULT_EXCLUDES, cache)).toEqual(ref);
  await Bun.file(cache).delete();
});
