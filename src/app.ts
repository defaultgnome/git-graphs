import * as echarts from "echarts";
import type { Data } from "./git";

type Metric = "commits" | "churn" | "added" | "deleted" | "net";
type Bucket = "day" | "week" | "month";

const [data, saved] = (await Promise.all(
  ["/api/data", "/api/merges"].map((u) => fetch(u).then((r) => r.json())),
)) as [Data & { repo: string }, Record<string, string>];
const raw = data.commits.map(([t, a, ...files]) => ({ t: t! * 1000, a: a!, files })).sort((x, y) => x.t - y.t);
const authors = data.authors;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const metricEl = $<HTMLSelectElement>("metric");
const bucketEl = $<HTMLSelectElement>("bucket");
const cumulativeEl = $<HTMLInputElement>("cumulative");
const layoutEl = $<HTMLSelectElement>("layout");
const extsEl = $("exts");
const rowsEl = $("rows");
const chartEl = $("chart");
$("repo").textContent = `${data.repo} · ${raw.length.toLocaleString()} commits`;

// --- state ---
const parent = authors.map((_, i) => i); // author index -> merged root
const byEmail = new Map(authors.map((a, i) => [a.email, i]));
for (const [alias, root] of Object.entries(saved)) {
  const i = byEmail.get(alias), r = byEmail.get(root);
  if (i !== undefined && r !== undefined) parent[i] = r;
}
// keeps entries for authors not in this history (e.g. other branches)
function saveMerges() {
  for (const [i, p] of parent.entries()) {
    delete saved[authors[i]!.email];
    if (p !== i) saved[authors[i]!.email] = authors[p]!.email;
  }
  fetch("/api/merges", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(saved) });
}
const hidden = new Set<number>(); // roots
const expanded = new Set<number>(); // roots showing their aliases
let zoom: [number, number] | null = null; // visible ms range

const tMin = raw[0]?.t ?? Date.now();
const tMax = raw.at(-1)?.t ?? Date.now();

// --- file-type filter: commits reduced to [ms, author, added, deleted] over the selected extensions ---
const allowed = new Set(data.exts.keys());
let commits: (readonly [number, number, number, number])[] = [];
function applyFilter() {
  const all = allowed.size === data.exts.length;
  commits = raw.flatMap(({ t, a, files }) => {
    let add = 0, del = 0, hit = false;
    for (let i = 0; i < files.length; i += 3) {
      if (!allowed.has(files[i]!)) continue;
      hit = true; add += files[i + 1]!; del += files[i + 2]!;
    }
    // with a filter on, a commit only counts if it touched a selected file type
    return all || hit ? [[t, a, add, del] as const] : [];
  });
  const n = allowed.size;
  extsEl.querySelector("summary")!.textContent =
    n === data.exts.length ? "Files: all" : n === 0 ? "Files: none" :
    `Files: ${[...allowed].slice(0, 4).map((e) => data.exts[e]).join(" ")}${n > 4 ? ` +${n - 4}` : ""}`;
}

const JS_TS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
function buildExtFilter() {
  const churn = data.exts.map(() => 0);
  for (const { files } of raw) for (let i = 0; i < files.length; i += 3) churn[files[i]!] += files[i + 1]! + files[i + 2]!;
  const list = extsEl.querySelector(".list")!;
  const boxes = [...data.exts.keys()].sort((x, y) => churn[y]! - churn[x]!).map((e) => {
    const label = document.createElement("label");
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: true, value: String(e) });
    box.onchange = () => { box.checked ? allowed.add(e) : allowed.delete(e); applyFilter(); render(); };
    const name = Object.assign(document.createElement("span"), { textContent: data.exts[e] });
    const n = Object.assign(document.createElement("span"), { className: "n", textContent: churn[e]!.toLocaleString() });
    label.append(box, name, n);
    list.append(label);
    return box;
  });
  const pick = (keep: (ext: string) => boolean) => {
    allowed.clear();
    for (const b of boxes) if ((b.checked = keep(data.exts[+b.value]!))) allowed.add(+b.value);
    applyFilter(); render();
  };
  extsEl.querySelector<HTMLButtonElement>(".all")!.onclick = () => pick(() => true);
  extsEl.querySelector<HTMLButtonElement>(".none")!.onclick = () => pick(() => false);
  extsEl.querySelector<HTMLButtonElement>(".jsts")!.onclick = () => pick((x) => JS_TS.includes(x));
  extsEl.querySelector<HTMLButtonElement>(".nojson")!.onclick = () => pick((x) => x !== ".json");
  document.addEventListener("click", (e) => { if (!extsEl.contains(e.target as Node)) extsEl.removeAttribute("open"); });
}
const DAY = 864e5;
bucketEl.value = tMax - tMin < 90 * DAY ? "day" : tMax - tMin < 730 * DAY ? "week" : "month";

const value = (c: readonly number[], m: Metric) =>
  m === "commits" ? 1 : m === "added" ? c[2]! : m === "deleted" ? c[3]! : m === "net" ? c[2]! - c[3]! : c[2]! + c[3]!;

function floorTo(ms: number, b: Bucket) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  if (b === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (b === "month") d.setDate(1);
  return d.getTime();
}
function nextBucket(ms: number, b: Bucket) {
  const d = new Date(ms);
  if (b === "day") d.setDate(d.getDate() + 1);
  else if (b === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

const roots = () => parent.filter((p, i) => p === i);
const aliases = (r: number) => parent.flatMap((p, i) => (p === r && i !== r ? [i] : []));

// all-time rank by |metric|, ignoring zoom and hidden rows, so hiding/zooming never repaints anyone
function rank(m: Metric) {
  const tot = new Map<number, number>();
  for (const c of commits) tot.set(parent[c[1]]!, (tot.get(parent[c[1]]!) ?? 0) + value(c, m));
  return [...tot].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([r]) => r);
}

// top 8 = categorical palette size; everyone else is "other" grey
function colorOf(order: number[]): Map<number, string> {
  const css = getComputedStyle(document.documentElement);
  return new Map(order.map((r, i) => [r, css.getPropertyValue(i < 8 ? `--s${i + 1}` : "--other").trim()]));
}

function series(m: Metric, b: Bucket, cumulative: boolean) {
  const buckets: number[] = [];
  for (let t = floorTo(tMin, b); t <= tMax; t = nextBucket(t, b)) buckets.push(t);
  const idx = new Map(buckets.map((t, i) => [t, i]));
  const per = new Map<number, number[]>();
  for (const c of commits) {
    const r = parent[c[1]]!;
    if (hidden.has(r)) continue;
    let arr = per.get(r);
    if (!arr) per.set(r, (arr = new Array(buckets.length).fill(0)));
    arr[idx.get(floorTo(c[0], b))!] += value(c, m);
  }
  if (cumulative) for (const arr of per.values()) for (let i = 1; i < arr.length; i++) arr[i] += arr[i - 1]!;
  return { buckets, per };
}

const chart = echarts.init(chartEl);
chart.on("datazoom", () => {
  const dz = (chart.getOption() as any).dataZoom[0];
  zoom = [dz.startValue, dz.endValue];
  renderBoard();
});
new ResizeObserver(() => chart.resize()).observe(chartEl.parentElement!);

function renderChart() {
  const m = metricEl.value as Metric, b = bucketEl.value as Bucket, layout = layoutEl.value;
  const { buckets, per } = series(m, b, cumulativeEl.checked);
  const order = rank(m);
  const colors = colorOf(order);
  const ranked = order.filter((r) => per.has(r));
  const top = new Set(order.slice(0, 8));
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--text-secondary").trim();
  const muted = css.getPropertyValue("--text-muted").trim();
  const grid = css.getPropertyValue("--border").trim();
  const other = css.getPropertyValue("--other").trim();
  const pts = (arr: number[]) => arr.map((v, i) => [buckets[i], v]);
  const line = (name: string, arr: number[], color: string, extra: object = {}) => ({
    name, type: "line", data: pts(arr), color, showSymbol: false, lineStyle: { width: 2 }, emphasis: { focus: "series" }, ...extra,
  });
  const axisCommon = {
    axisLine: { lineStyle: { color: grid } }, axisLabel: { color: muted, hideOverlap: true },
    splitLine: { lineStyle: { color: grid } },
  };
  const zoomRange = zoom ? { startValue: zoom[0], endValue: zoom[1] } : {};
  const tooltip = {
    trigger: "axis", order: "valueDesc",
    valueFormatter: (v: number) => v?.toLocaleString(),
  };

  let opt: any;
  if (layout === "split") {
    // ponytail: one canvas, 50-row cap keeps it under browser canvas height limits
    const shown = ranked.slice(0, 50);
    const ROW = 110, TOP = 56;
    chartEl.style.height = `${TOP + shown.length * ROW + 30}px`;
    let lo = 0, hi = 0;
    for (const r of shown) for (const v of per.get(r)!) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const all = shown.map((_, i) => i);
    opt = {
      animation: false,
      tooltip,
      title: shown.map((r, i) => ({
        text: authors[r]!.name, top: TOP + i * ROW - 4, left: 12,
        textStyle: { fontSize: 12, fontWeight: 500, color: ink },
      })),
      grid: shown.map((_, i) => ({ top: TOP + i * ROW + 18, height: ROW - 46, left: 56, right: 24 })),
      xAxis: shown.map((_, i) => ({ type: "time", gridIndex: i, min: buckets[0], max: buckets.at(-1), ...axisCommon, splitLine: { show: false } })),
      yAxis: shown.map((_, i) => ({ type: "value", gridIndex: i, min: lo, max: hi, splitNumber: 2, ...axisCommon })),
      dataZoom: [
        { type: "slider", xAxisIndex: all, top: 8, height: 24, ...zoomRange },
        { type: "inside", xAxisIndex: all, zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, ...zoomRange },
      ],
      series: shown.map((r, i) => line(authors[r]!.name, per.get(r)!, colors.get(r)!, {
        xAxisIndex: i, yAxisIndex: i, areaStyle: { opacity: 0.15 },
      })),
    };
  } else {
    chartEl.style.height = "100%";
    let list: any[];
    if (layout === "total") {
      const sum = new Array(buckets.length).fill(0);
      for (const arr of per.values()) arr.forEach((v, i) => (sum[i] += v));
      list = [line("total", sum, css.getPropertyValue("--s1").trim(), { areaStyle: { opacity: 0.15 } })];
    } else {
      // only the coloured (top 8) get their own series; the rest fold into "others"
      const stacked = layout === "stacked";
      const extra = stacked ? { stack: "all", areaStyle: { opacity: 0.85 }, lineStyle: { width: 1 } } : {};
      const rest = ranked.filter((r) => !top.has(r));
      list = ranked.filter((r) => top.has(r)).map((r) => line(authors[r]!.name, per.get(r)!, colors.get(r)!, extra));
      if (rest.length) {
        const sum = new Array(buckets.length).fill(0);
        for (const r of rest) per.get(r)!.forEach((v, i) => (sum[i] += v));
        list.push(line(`others (${rest.length})`, sum, other, extra));
      }
    }
    opt = {
      animation: false,
      tooltip,
      legend: { show: list.length > 1, top: 8, textStyle: { color: ink }, type: "scroll" },
      grid: { top: 48, left: 64, right: 24, bottom: 72 },
      xAxis: { type: "time", ...axisCommon, splitLine: { show: false } },
      yAxis: { type: "value", ...axisCommon },
      dataZoom: [
        { type: "slider", bottom: 16, height: 24, ...zoomRange },
        { type: "inside", ...zoomRange },
      ],
      series: list,
    };
  }
  chart.setOption(opt, { notMerge: true });
  chart.resize();
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");

function renderBoard() {
  const m = metricEl.value as Metric;
  const [z0, z1] = zoom ?? [-Infinity, Infinity];
  type S = { commits: number; add: number; del: number; v: number; first: number; last: number };
  const stats = new Map<number, S>(roots().map((r) => [r, { commits: 0, add: 0, del: 0, v: 0, first: 0, last: 0 }]));
  for (const c of commits) {
    if (c[0] < z0 || c[0] > z1) continue;
    const s = stats.get(parent[c[1]]!)!;
    s.commits++; s.add += c[2]; s.del += c[3]; s.v += value(c, m);
    s.first ||= c[0]; s.last = c[0];
  }
  const colors = colorOf(rank(m));
  const order = [...stats].sort((a, b) => b[1].v - a[1].v || b[1].commits - a[1].commits);
  rowsEl.replaceChildren();
  order.forEach(([r, s], i) => {
    const tr = document.createElement("tr");
    tr.className = "root" + (hidden.has(r) ? " off" : "");
    tr.draggable = true;
    tr.title = `${authors[r]!.email} — click to hide/show, drag onto another row to merge`;
    const al = aliases(r);
    tr.innerHTML = `<td>${i + 1}</td><td><span class="sw"></span><span class="nm"></span></td>
      <td>${s.commits.toLocaleString()}</td><td class="add">+${s.add.toLocaleString()}</td>
      <td class="add">−${s.del.toLocaleString()}</td>
      <td>${s.first ? fmtDate(s.first) : "–"}</td><td>${s.last ? fmtDate(s.last) : "–"}</td>`;
    (tr.querySelector(".sw") as HTMLElement).style.background = colors.get(r) ?? "transparent";
    tr.querySelector(".nm")!.textContent = authors[r]!.name;
    if (al.length) {
      const btn = document.createElement("button");
      btn.className = "badge";
      btn.textContent = `+${al.length} alias${al.length > 1 ? "es" : ""}`;
      btn.onclick = (e) => { e.stopPropagation(); expanded.has(r) ? expanded.delete(r) : expanded.add(r); renderBoard(); };
      tr.children[1]!.append(btn);
    }
    tr.onclick = () => { hidden.has(r) ? hidden.delete(r) : hidden.add(r); render(); };
    tr.ondragstart = (e) => e.dataTransfer!.setData("text/plain", String(r));
    tr.ondragover = (e) => { e.preventDefault(); tr.classList.add("drop"); };
    tr.ondragleave = () => tr.classList.remove("drop");
    tr.ondrop = (e) => {
      e.preventDefault();
      const src = Number(e.dataTransfer!.getData("text/plain"));
      if (Number.isInteger(src) && src !== r) merge(src, r);
      else tr.classList.remove("drop");
    };
    rowsEl.append(tr);

    if (expanded.has(r)) for (const a of [r, ...al]) {
      const sub = document.createElement("tr");
      sub.className = "alias";
      sub.innerHTML = `<td></td><td colspan="6"></td>`;
      sub.children[1]!.textContent = `${authors[a]!.name} <${authors[a]!.email}>`;
      if (a !== r) {
        const x = document.createElement("button");
        x.className = "x";
        x.textContent = "×";
        x.title = "Unmerge";
        x.onclick = () => { parent[a] = a; if (aliases(r).length === 0) expanded.delete(r); saveMerges(); render(); };
        sub.children[1]!.append(x);
      }
      rowsEl.append(sub);
    }
  });
}

function merge(src: number, dst: number) {
  parent.forEach((p, i) => { if (p === src) parent[i] = dst; });
  hidden.delete(src);
  saveMerges();
  render();
}

function render() {
  renderChart();
  renderBoard();
}

for (const el of [metricEl, bucketEl, cumulativeEl, layoutEl]) el.onchange = render;
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
buildExtFilter();
applyFilter();
render();
