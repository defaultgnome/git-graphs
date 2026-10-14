export const DEFAULT_EXCLUDES = [
  "*.lock", "package-lock.json", "pnpm-lock.yaml", "go.sum", "*.min.js",
  "dist/**", "vendor/**", "node_modules/**",
];

export type Author = { email: string; name: string };
// [unix seconds, author index, ...(ext index, lines added, lines deleted) per file type touched]
export type Commit = number[];
// info[i] = [short hash, subject] of commits[i]
export type Data = { authors: Author[]; exts: string[]; commits: Commit[]; info: [string, string][] };

export const LOG_FORMAT = "%x00%at%x09%aE%x09%aN%x09%h%x09%s";

// gitignore-ish: a pattern without "/" matches at any depth
const toGlob = (p: string) => new Bun.Glob(p.startsWith("/") ? p.slice(1) : `**/${p}`);

// numstat rename forms: "a => b" and "dir/{a => b}/f"
const newPath = (p: string) =>
  p.replace(/\{[^{}]* => ([^{}]*)\}/, "$1").replace(/\/\//g, "/").replace(/^.* => /, "");

// ".ts", ".json"; extensionless files (Makefile, Dockerfile) keep their name
export function extOf(path: string) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : base;
}

export function parseLog(text: string, excludes: string[]): Data {
  const globs = excludes.map(toGlob);
  const authors: Author[] = [];
  const byEmail = new Map<string, { i: number; names: Map<string, number> }>();
  const commits: Commit[] = [];
  const info: [string, string][] = [];
  const exts: string[] = [];
  const extIdx = new Map<string, number>();

  for (const block of text.split("\0")) {
    if (!block.trim()) continue;
    const [header, ...lines] = block.split("\n");
    const [t, rawEmail, name, hash = "", ...subject] = header!.split("\t");
    const email = rawEmail!.toLowerCase();
    let a = byEmail.get(email);
    if (!a) {
      a = { i: authors.length, names: new Map() };
      byEmail.set(email, a);
      authors.push({ email, name: name! });
    }
    a.names.set(name!, (a.names.get(name!) ?? 0) + 1);

    const perExt = new Map<number, [number, number]>();
    for (const line of lines) {
      const [ad, de, path] = line.split("\t");
      if (!path || ad === "-") continue; // blank line or binary file
      const p = newPath(path);
      if (globs.some((g) => g.match(p))) continue;
      const ext = extOf(p);
      let e = extIdx.get(ext);
      if (e === undefined) extIdx.set(ext, (e = exts.push(ext) - 1));
      const sum = perExt.get(e) ?? [0, 0];
      sum[0] += +ad!;
      sum[1] += +de!;
      perExt.set(e, sum);
    }
    info.push([hash, subject.join("\t")]);
    commits.push([+t!, a.i, ...[...perExt].flatMap(([e, [ad, de]]) => [e, ad, de])]);
  }

  for (const [, a] of byEmail)
    authors[a.i]!.name = [...a.names].sort((x, y) => y[1] - x[1])[0]![0];
  return { authors, exts, commits, info };
}

export async function readRepo(dir: string, excludes: string[]): Promise<Data> {
  const proc = Bun.spawn(
    ["git", "-C", dir, "-c", "core.quotePath=off", "log", "--no-merges", "--numstat", `--format=${LOG_FORMAT}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `git log exited ${code}`);
  return parseLog(out, excludes);
}

export async function repoRoot(dir: string) {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(proc.stdout).text()).trim() || dir;
}
