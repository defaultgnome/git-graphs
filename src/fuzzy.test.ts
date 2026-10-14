import { expect, test } from "bun:test";
import { fuzzy } from "./fuzzy";

test("fuzzy", () => {
  expect(fuzzy("zz", "John Doe")).toBeNull();
  expect(fuzzy("", "x")).not.toBeNull();
  expect(fuzzy("JD", "john doe")).not.toBeNull();
  expect(fuzzy("doe", "john doe")!).toBeGreaterThan(fuzzy("doe", "d-xo-xe")!);
  expect(fuzzy("jd", "john.doe@x.com")!).toBeGreaterThan(fuzzy("jd", "ajxdx")!);
  expect(fuzzy("john d", "john.doe")).not.toBeNull();
});
