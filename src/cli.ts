#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve, basename, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_EXCLUDES, readRepo, repoRoot } from "./git";
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

// author merges ({aliasEmail: rootEmail}) persist per repo root, outside the repo
const root = await repoRoot(dir);
const store = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ggrph",
  `${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16)}.json`,
);
const isMerges = (m: unknown): m is Record<string, string> =>
  typeof m === "object" && m !== null && !Array.isArray(m) && Object.values(m).every((v) => typeof v === "string");

// Bun resolves bundled asset URLs against cwd
process.chdir(import.meta.dir);
const payload = JSON.stringify({ repo: basename(root), ...data });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
  routes: {
    "/": index,
    "/api/data": () => new Response(payload, { headers: { "content-type": "application/json" } }),
    "/api/merges": {
      GET: async () => {
        const f = Bun.file(store);
        return Response.json((await f.exists()) ? ((await f.json()).merges ?? {}) : {});
      },
      // JSON content-type forces a CORS preflight, so other sites can't write here
      PUT: async (req) => {
        if (req.headers.get("content-type") !== "application/json") return new Response(null, { status: 415 });
        const merges = await req.json().catch(() => null);
        if (!isMerges(merges)) return new Response(null, { status: 400 });
        await Bun.write(store, JSON.stringify({ repo: root, merges }, null, 2));
        return Response.json(merges);
      },
    },
  },
});

console.log(`ggrph: ${data.commits.length} commits, ${data.authors.length} authors → ${server.url}`);
console.log(`ggrph: merges saved in ${store}`);
Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", server.url.href], { stdout: "ignore", stderr: "ignore" });
