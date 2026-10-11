#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve, basename } from "node:path";
import { DEFAULT_EXCLUDES, readRepo } from "./git";
import index from "./index.html";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { exclude: { type: "string", multiple: true, default: [] }, help: { type: "boolean", short: "h" } },
});

if (values.help) {
  console.log("usage: ggrph [path] [--exclude <glob>]...");
  process.exit(0);
}

const dir = resolve(positionals[0] ?? ".");
console.log(`ggrph: reading history of ${dir}…`);
let data;
try {
  data = await readRepo(dir, [...DEFAULT_EXCLUDES, ...values.exclude!]);
} catch (e) {
  console.error(`ggrph: ${dir}: ${(e as Error).message}`);
  process.exit(1);
}

// Bun resolves bundled asset URLs against cwd
process.chdir(import.meta.dir);
const payload = JSON.stringify({ repo: basename(dir), ...data });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
  routes: {
    "/": index,
    "/api/data": () => new Response(payload, { headers: { "content-type": "application/json" } }),
  },
});

console.log(`ggrph: ${data.commits.length} commits, ${data.authors.length} authors → ${server.url}`);
Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", server.url.href], { stdout: "ignore", stderr: "ignore" });
