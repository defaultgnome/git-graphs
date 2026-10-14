import * as echarts from "echarts";
import type { Data } from "./git";

type Metric = "commits" | "churn" | "added" | "deleted" | "net";
type Bucket = "day" | "week" | "month";
type View = Partial<{
  metric: string; bucket: string; cumulative: boolean; layout: string; mode: string; trend: boolean; skipFirst: boolean;
  zoom: [number, number] | null; hidden: string[]; excludedExts: string[];
}>;

const [data, saved] = (await Promise.all(
  ["/api/data", "/api/state"].map((u) => fetch(u).then((r) => r.json())),
)) as [Data & { repo: string }, { merges: Record<string, string>; view: View }];
const raw = data.commits
  .map(([t, a, ...files], i) => ({ t: t! * 1000, a: a!, files, info: data.info[i] ?? ["", ""] }))
  .sort((x, y) => x.t - y.t);
const authors = data.authors;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const metricEl = $<HTMLSelectElement>("metric");
const bucketEl = $<HTMLSelectElement>("bucket");
const cumulativeEl = $<HTMLInputElement>("cumulative");
const layoutEl = $<HTMLSelectElement>("layout");
const modeEl = $<HTMLSelectElement>("mode");
const trendEl = $<HTMLInputElement>("trend");
const skipFirstEl = $<HTMLInputElement>("skipFirst");
const sideEl = $("side");
const extsEl = $("exts");
const rowsEl = $("rows");
const chartEl = $("chart");
$("repo").textContent = `${data.repo} · ${raw.length.toLocaleString()} commits`;

// --- state, restored from the per-repo file ---
const view = saved.view;
const parent = authors.map((_, i) => i); // author index -> merged root
const byEmail = new Map(authors.map((a, i) => [a.email, i]));
for (const [alias, root] of Object.entries(saved.merges)) {
  const i = byEmail.get(alias), r = byEmail.get(root);
  if (i !== undefined && r !== undefined) parent[i] = r;
}
const hidden = new Set<number>( // roots
  (view.hidden ?? []).flatMap((e) => (byEmail.has(e) ? [parent[byEmail.get(e)!]!] : [])),
);
const expanded = new Set<number>(); // roots showing their aliases
let zoom: [number, number] | null = view.zoom ?? null; // visible ms range
const restore = (el: HTMLSelectElement, v?: string) => {
  if (v && [...el.options].some((o) => o.value === v)) el.value = v;
};
restore(metricEl, view.metric);
restore(layoutEl, view.layout);
restore(modeEl, view.mode);
cumulativeEl.checked = view.cumulative ?? false;
trendEl.checked = view.trend ?? true;
skipFirstEl.checked = view.skipFirst ?? false;

// entries for authors/extensions not in this history (e.g. other branches) are kept, not dropped
let saveTimer: ReturnType<typeof setTimeout>;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const [i, p] of parent.entries()) {
      delete saved.merges[authors[i]!.email];
      if (p !== i) saved.merges[authors[i]!.email] = authors[p]!.email;
    }
    const known = new Set(authors.map((a) => a.email));
    const knownExt = new Set(data.exts);
    saved.view = {
      metric: metricEl.value, bucket: bucketEl.value, cumulative: cumulativeEl.checked, layout: layoutEl.value,
      mode: modeEl.value, trend: trendEl.checked, skipFirst: skipFirstEl.checked, zoom,
      hidden: [...(view.hidden ?? []).filter((e) => !known.has(e)), ...[...hidden].map((r) => authors[r]!.email)],
      excludedExts: [
        ...(view.excludedExts ?? []).filter((x) => !knownExt.has(x)),
        ...data.exts.filter((_, e) => !allowed.has(e)),
      ],
    };
    fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(saved) });
  }, 300);
}

const tMin = raw[0]?.t ?? Date.now();
const tMax = raw.at(-1)?.t ?? Date.now();

// --- file-type filter: commits reduced to [ms, author, added, deleted, raw index] over the selected extensions ---
// stored as exclusions so extensions new to the history default to included
const excluded = new Set(view.excludedExts ?? []);
const allowed = new Set([...data.exts.keys()].filter((e) => !excluded.has(data.exts[e]!)));
let commits: (readonly [number, number, number, number, number])[] = [];
function applyFilter() {
  const all = allowed.size === data.exts.length;
  commits = raw.flatMap(({ t, a, files }, ri) => {
    if (ri === 0 && skipFirstEl.checked) return []; // raw is oldest-first
    let add = 0, del = 0, hit = false;
    for (let i = 0; i < files.length; i += 3) {
      if (!allowed.has(files[i]!)) continue;
      hit = true; add += files[i + 1]!; del += files[i + 2]!;
    }
    // with a filter on, a commit only counts if it touched a selected file type
    return all || hit ? [[t, a, add, del, ri] as const] : [];
  });
  const n = allowed.size;
  extsEl.querySelector("summary")!.textContent =
    n === data.exts.length ? "Files: all" : n === 0 ? "Files: none" :
    `Files: ${[...data.exts.keys()].filter((e) => allowed.has(e)).slice(0, 4).map((e) => data.exts[e]).join(" ")}${n > 4 ? ` +${n - 4}` : ""}`;
}

const JS_TS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
function buildExtFilter() {
  const churn = data.exts.map(() => 0);
  for (const { files } of raw) for (let i = 0; i < files.length; i += 3) churn[files[i]!] += files[i + 1]! + files[i + 2]!;
  const list = extsEl.querySelector(".list")!;
  const boxes = [...data.exts.keys()].sort((x, y) => churn[y]! - churn[x]!).map((e) => {
    const label = document.createElement("label");
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: allowed.has(e), value: String(e) });
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
restore(bucketEl, view.bucket);

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

// header-click sorting; an empty key follows the metric picked at the top
type Sort = { k: string; asc: boolean };
const METRIC_KEY: Record<Metric, string> = { commits: "commits", added: "add", deleted: "del", net: "net", churn: "churn" };
const boardSort: Sort = { k: "", asc: false };
const sideSort: Sort = { k: "", asc: false };
const boardKey = () => boardSort.k || METRIC_KEY[metricEl.value as Metric];
const sideKey = () => sideSort.k || (metricEl.value === "commits" ? "churn" : METRIC_KEY[metricEl.value as Metric]);
type Row = { add: number; del: number } & Record<string, number>;
const col = (x: Row, k: string) => (k === "net" ? x.add - x.del : k === "churn" ? x.add + x.del : x[k]!);
function sortRows<T extends Row>(items: T[], s: Sort, k: string, thead: HTMLElement) {
  for (const th of thead.querySelectorAll<HTMLElement>("th[data-k]")) {
    th.classList.toggle("on", th.dataset.k === k);
    th.classList.toggle("asc", th.dataset.k === k && s.asc);
  }
  return items.sort((a, b) => (s.asc ? 1 : -1) * (col(a, k) - col(b, k)));
}
function bindSort(thead: HTMLElement, s: Sort, current: () => string, rerender: () => void) {
  thead.onclick = (e) => {
    const k = (e.target as HTMLElement).closest("th")?.dataset.k;
    if (!k) return;
    s.asc = current() === k ? !s.asc : false;
    s.k = k;
    rerender();
  };
}

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

// least-squares line over the buckets inside the zoom window
function fit(pts: number[][]) {
  const [z0, z1] = zoom ?? [-Infinity, Infinity];
  const p = pts.filter(([t]) => t! >= z0 && t! <= z1);
  if (p.length < 2) return [];
  const mx = p.reduce((s, [t]) => s + t!, 0) / p.length;
  const my = p.reduce((s, [, v]) => s + v!, 0) / p.length;
  let sxy = 0, sxx = 0;
  for (const [t, v] of p) { sxy += (t! - mx) * (v! - my); sxx += (t! - mx) ** 2; }
  const k = sxx ? sxy / sxx : 0;
  return [p[0]!, p.at(-1)!].map(([t]) => [t!, my + k * (t! - mx)]);
}
let trends: { id: string; pts: number[][] }[] = [];
let splitRoots: number[] = []; // author root per grid in split layout

const chart = echarts.init(chartEl);
chart.on("datazoom", () => {
  const dz = (chart.getOption() as any).dataZoom[0];
  zoom = [dz.startValue, dz.endValue];
  if (trends.length) chart.setOption({ series: trends.map((t) => ({ id: t.id, data: fit(t.pts) })) });
  renderBoard();
  save();
});
// click anywhere in a plot: list the commits of the nearest bucket (of that row's author in split layout)
chart.getZr().on("click", (e) => {
  const pt = [e.offsetX, e.offsetY];
  const split = layoutEl.value === "split";
  for (let i = 0; i < (split ? splitRoots.length : 1); i++) {
    if (!chart.containPixel({ gridIndex: i }, pt)) continue;
    const t = (chart.convertFromPixel({ gridIndex: i }, pt) as number[])[0]!;
    const b = bucketEl.value as Bucket;
    const b0 = floorTo(t, b), b1 = nextBucket(b0, b);
    const from = t - b0 < b1 - t ? b0 : b1;
    // a cumulative point is the sum of everything up to it
    side = { from: cumulativeEl.checked ? -Infinity : from, to: nextBucket(from, b), root: split ? splitRoots[i]! : null };
    sideSort.k = "";
    renderSide();
    return;
  }
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
  const mode = modeEl.value;
  const pts = (arr: number[]) => arr.map((v, i) => [buckets[i]!, v]);
  const line = (name: string, arr: number[], color: string, extra: object = {}) => ({
    name, type: mode === "bar" ? "bar" : "line", data: pts(arr), color, emphasis: { focus: "series" },
    ...(mode === "bar" ? { barMaxWidth: 24 } : { showSymbol: false, smooth: mode === "smooth", lineStyle: { width: 2 } }),
    ...extra,
  });
  // dashed fit sharing its series' name, so the legend toggles both; kept out of the tooltip
  trends = [];
  const trend = (name: string, arr: number[], color: string, axis = 0) => {
    const id = `trend${trends.length}`;
    trends.push({ id, pts: pts(arr) });
    return {
      id, name, type: "line", data: fit(pts(arr)), color, xAxisIndex: axis, yAxisIndex: axis, symbol: "none", silent: true,
      z: 5, lineStyle: { type: "dashed", width: 1.5 }, tooltip: { show: false }, emphasis: { disabled: true },
    };
  };
  const withTrend = trendEl.checked;
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
    const shown = (splitRoots = ranked.slice(0, 50));
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
      // bars sit centred on the bucket start; let echarts pad the axis so the edge ones aren't cut in half
      xAxis: shown.map((_, i) => ({
        type: "time", gridIndex: i, ...(mode === "bar" ? {} : { min: buckets[0], max: buckets.at(-1) }),
        ...axisCommon, splitLine: { show: false },
      })),
      yAxis: shown.map((_, i) => ({ type: "value", gridIndex: i, min: lo, max: hi, splitNumber: 2, ...axisCommon })),
      dataZoom: [
        { type: "slider", xAxisIndex: all, top: 8, height: 24, ...zoomRange },
        { type: "inside", xAxisIndex: all, zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, ...zoomRange },
      ],
      series: [
        ...shown.map((r, i) => line(authors[r]!.name, per.get(r)!, colors.get(r)!, {
          xAxisIndex: i, yAxisIndex: i, areaStyle: { opacity: 0.15 },
        })),
        ...(withTrend ? shown.map((r, i) => trend(authors[r]!.name, per.get(r)!, colors.get(r)!, i)) : []),
      ],
    };
  } else {
    chartEl.style.height = "100%";
    let list: any[];
    const total = new Array(buckets.length).fill(0);
    for (const arr of per.values()) arr.forEach((v, i) => (total[i] += v));
    if (layout === "total") {
      list = [line("total", total, css.getPropertyValue("--s1").trim(), { areaStyle: { opacity: 0.15 } })];
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
    const legend = list.length > 1;
    if (withTrend) {
      // a stack's (or the total's) trend is the trend of its top edge
      if (layout === "overlaid") list.push(...list.map((s) => trend(s.name, s.data.map((p: number[]) => p[1]), s.color)));
      else list.push(trend(layout === "total" ? "total" : "trend", total, ink));
    }
    opt = {
      animation: false,
      tooltip,
      legend: { show: legend, top: 8, textStyle: { color: ink }, type: "scroll" },
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
  type S = { r: number; commits: number; add: number; del: number; first: number; last: number };
  const stats = new Map<number, S>(roots().map((r) => [r, { r, commits: 0, add: 0, del: 0, first: 0, last: 0 }]));
  for (const c of commits) {
    if (c[0] < z0 || c[0] > z1) continue;
    const s = stats.get(parent[c[1]]!)!;
    s.commits++; s.add += c[2]; s.del += c[3];
    s.first ||= c[0]; s.last = c[0];
  }
  const colors = colorOf(rank(m));
  const order = sortRows([...stats.values()], boardSort, boardKey(), boardEl.tHead!);
  rowsEl.replaceChildren();
  order.forEach((s, i) => {
    const r = s.r;
    const tr = document.createElement("tr");
    tr.className = "root" + (hidden.has(r) ? " off" : "");
    tr.draggable = true;
    tr.title = `${authors[r]!.email} — click to hide/show, drag onto another row to merge`;
    const al = aliases(r);
    tr.innerHTML = `<td>${i + 1}</td><td><span class="sw"></span><span class="nm"></span></td>
      <td>${s.commits.toLocaleString()}</td><td class="add">+${s.add.toLocaleString()}</td>
      <td class="add">−${s.del.toLocaleString()}</td>
      <td>${(s.add - s.del).toLocaleString()}</td><td>${(s.add + s.del).toLocaleString()}</td>
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
      sub.innerHTML = `<td></td><td colspan="8"></td>`;
      sub.children[1]!.textContent = `${authors[a]!.name} <${authors[a]!.email}>`;
      if (a !== r) {
        const x = document.createElement("button");
        x.className = "x";
        x.textContent = "×";
        x.title = "Unmerge";
        x.onclick = () => { parent[a] = a; if (aliases(r).length === 0) expanded.delete(r); render(); };
        sub.children[1]!.append(x);
      }
      rowsEl.append(sub);
    }
  });
}

function merge(src: number, dst: number) {
  parent.forEach((p, i) => { if (p === src) parent[i] = dst; });
  hidden.delete(src);
  render();
}

// --- commit explorer for a clicked bucket ---
let side: { from: number; to: number; root: number | null } | null = null;
const sideTable = sideEl.querySelector("table")!;
function renderSide() {
  sideEl.hidden = !side;
  if (!side) return;
  const { from, to, root } = side;
  const rows = commits
    .filter((c) => c[0] >= from && c[0] < to && (root === null ? !hidden.has(parent[c[1]]!) : parent[c[1]] === root))
    .map(([t, a, add, del, ri]) => ({ t, a, add, del, ri }));
  sortRows(rows, sideSort, sideKey(), sideTable.tHead!);
  const span = from === -Infinity ? `up to ${fmtDate(to - 1)}` :
    fmtDate(from) === fmtDate(to - 1) ? fmtDate(from) : `${fmtDate(from)} → ${fmtDate(to - 1)}`;
  sideEl.querySelector("h2")!.innerHTML = `<span></span> <small></small>`;
  sideEl.querySelector("h2 span")!.textContent = root === null ? "all shown" : authors[root]!.name;
  sideEl.querySelector("h2 small")!.textContent = `${span} · ${rows.length.toLocaleString()} commits`;
  const colors = colorOf(rank(metricEl.value as Metric));
  // ponytail: render cap keeps huge cumulative ranges snappy; paginate if anyone needs row 501
  sideTable.tBodies[0]!.replaceChildren(...rows.slice(0, 500).map((c) => {
    const tr = document.createElement("tr");
    const [hash, subject] = raw[c.ri]!.info;
    tr.innerHTML = `<td>${fmtDate(c.t)}</td><td><span class="sw"></span><span class="nm"></span></td><td><code></code><span></span></td>
      <td class="add">+${c.add.toLocaleString()}</td><td class="add">−${c.del.toLocaleString()}</td>
      <td>${(c.add - c.del).toLocaleString()}</td><td>${(c.add + c.del).toLocaleString()}</td>`;
    const r = parent[c.a]!;
    (tr.querySelector(".sw") as HTMLElement).style.background = colors.get(r) ?? "transparent";
    tr.querySelector(".nm")!.textContent = authors[r]!.name;
    tr.querySelector("code")!.textContent = hash;
    tr.querySelector("td:nth-child(3) span")!.textContent = subject;
    return tr;
  }));
}
$("sideClose").onclick = () => { side = null; renderSide(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && side) { side = null; renderSide(); } });

function render() {
  renderChart();
  renderBoard();
  renderSide();
  save();
}

const boardEl = rowsEl.closest("table")!;
bindSort(boardEl.tHead!, boardSort, boardKey, renderBoard);
bindSort(sideTable.tHead!, sideSort, sideKey, renderSide);
metricEl.onchange = () => { boardSort.k = sideSort.k = ""; boardSort.asc = sideSort.asc = false; render(); };
for (const el of [bucketEl, cumulativeEl, layoutEl, modeEl, trendEl]) el.onchange = render;
skipFirstEl.onchange = () => { applyFilter(); render(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
buildExtFilter();
applyFilter();
render();
