export const DEFAULT_EXCLUDES = [
  "*.lock", "package-lock.json", "pnpm-lock.yaml", "go.sum", "*.min.js",
  "dist/**", "vendor/**", "node_modules/**",
];

export type Author = { email: string; name: string };
// [unix seconds, author index, lines added, lines deleted]
export type Commit = [number, number, number, number];
export type Data = { authors: Author[]; commits: Commit[] };

export const LOG_FORMAT = "%x00%at%x09%aE%x09%aN";

// gitignore-ish: a pattern without "/" matches at any depth
const toGlob = (p: string) => new Bun.Glob(p.startsWith("/") ? p.slice(1) : `**/${p}`);

// numstat rename forms: "a => b" and "dir/{a => b}/f"
const newPath = (p: string) =>
  p.replace(/\{[^{}]* => ([^{}]*)\}/, "$1").replace(/\/\//g, "/").replace(/^.* => /, "");

export function parseLog(text: string, excludes: string[]): Data {
  const globs = excludes.map(toGlob);
  const authors: Author[] = [];
  const byEmail = new Map<string, { i: number; names: Map<string, number> }>();
  const commits: Commit[] = [];

  for (const block of text.split("\0")) {
    if (!block.trim()) continue;
    const [header, ...lines] = block.split("\n");
    const [t, rawEmail, name] = header!.split("\t");
    const email = rawEmail!.toLowerCase();
    let a = byEmail.get(email);
    if (!a) {
      a = { i: authors.length, names: new Map() };
      byEmail.set(email, a);
      authors.push({ email, name: name! });
    }
    a.names.set(name!, (a.names.get(name!) ?? 0) + 1);

    let add = 0, del = 0;
    for (const line of lines) {
      const [ad, de, path] = line.split("\t");
      if (!path || ad === "-") continue; // blank line or binary file
      const p = newPath(path);
      if (globs.some((g) => g.match(p))) continue;
      add += +ad!;
      del += +de!;
    }
    commits.push([+t!, a.i, add, del]);
  }

  for (const [, a] of byEmail)
    authors[a.i]!.name = [...a.names].sort((x, y) => y[1] - x[1])[0]![0];
  return { authors, commits };
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
