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

// UI state persists per repo root, outside the repo:
// { merges: {aliasEmail: rootEmail}, view: {...whatever the page saves}, layouts: {name: view} }
const root = await repoRoot(dir);
const store = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ggrph",
  `${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16)}.json`,
);
const isObj = (o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null && !Array.isArray(o);
type State = { merges: Record<string, string>; view: Record<string, unknown>; layouts: Record<string, Record<string, unknown>> };
const isState = (s: unknown): s is State =>
  isObj(s) && isObj(s.merges) && Object.values(s.merges).every((v) => typeof v === "string") && isObj(s.view) &&
  isObj(s.layouts) && Object.values(s.layouts).every(isObj);

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
    "/api/state": {
      GET: async () => {
        const f = Bun.file(store);
        const saved = (await f.exists()) ? await f.json().catch(() => ({})) : {};
        return Response.json({ merges: saved.merges ?? {}, view: saved.view ?? {}, layouts: saved.layouts ?? {} });
      },
      // JSON content-type forces a CORS preflight, so other sites can't write here
      PUT: async (req) => {
        if (req.headers.get("content-type") !== "application/json") return new Response(null, { status: 415 });
        const state = await req.json().catch(() => null);
        if (!isState(state)) return new Response(null, { status: 400 });
        await Bun.write(store, JSON.stringify({ repo: root, merges: state.merges, view: state.view, layouts: state.layouts }, null, 2));
        return new Response(null, { status: 204 });
      },
    },
  },
});

console.log(`ggrph: ${data.commits.length} commits, ${data.authors.length} authors → ${server.url}`);
console.log(`ggrph: state saved in ${store}`);
Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", server.url.href], { stdout: "ignore", stderr: "ignore" });
