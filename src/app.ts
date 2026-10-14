import * as echarts from "echarts";
import type { Data } from "./git";

type Metric = "commits" | "tickets" | "churn" | "added" | "deleted" | "net";
type Bucket = "day" | "week" | "month";
type View = Partial<{
  metric: string; bucket: string; cumulative: boolean; layout: string; mode: string; trend: boolean; skipFirst: boolean;
  zoom: [number, number] | null; hidden: string[]; excludedExts: string[];
}>;

const [data, saved] = (await Promise.all(
  ["/api/data", "/api/state"].map((u) => fetch(u).then((r) => r.json())),
)) as [Data & { repo: string }, { merges: Record<string, string>; view: View }];
// ponytail: NX is this team's Jira key; widen to [A-Z]+-\d+ if other projects show up (beware UTF-8, SHA-256)
const TICKET = /\bNX-\d+\b/g;
const raw = data.commits
  .map(([t, a, ...files], i) => {
    const info = data.info[i] ?? ["", ""];
    return { t: t! * 1000, a: a!, files, info, tix: [...new Set(info[1].toUpperCase().match(TICKET))] };
  })
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
$("repo").textContent = data.repo;
$("repoCount").textContent = `${raw.length.toLocaleString()} commits`;

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

const icon = (name: string, cls = "i") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
// <select class="seg"> renders as a segmented control; the hidden select stays the source of truth
const segs = [...document.querySelectorAll<HTMLSelectElement>("select.seg")].map((sel) => {
  const bar = Object.assign(document.createElement("div"), { className: "segbar", role: "group" });
  bar.setAttribute("aria-label", sel.getAttribute("aria-label") ?? "");
  const btns = [...sel.options].map((o) => {
    const b = Object.assign(document.createElement("button"), { type: "button", title: o.text });
    b.innerHTML = `${o.dataset.icon ? icon(o.dataset.icon) : ""}<span></span>`;
    b.querySelector("span")!.textContent = o.text;
    b.onclick = () => { if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event("change")); } };
    return b;
  });
  bar.append(...btns);
  sel.hidden = true;
  sel.after(bar);
  return () => btns.forEach((b, i) => b.setAttribute("aria-pressed", String(sel.selectedIndex === i)));
});

// theme: system → light → dark; per-browser convenience, so localStorage is fine
const THEMES = ["system", "light", "dark"] as const;
const themeBtn = $<HTMLButtonElement>("theme");
let theme: string = "system";
try { theme = localStorage.getItem("ggrph-theme") ?? "system"; } catch {}
function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeBtn.innerHTML = icon(theme === "light" ? "sun" : theme === "dark" ? "moon" : "monitor");
  themeBtn.title = `Theme: ${theme}`;
}
applyTheme();
themeBtn.onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme as any) + 1) % 3]!;
  try { localStorage.setItem("ggrph-theme", theme); } catch {}
  applyTheme();
  render();
};

const toastEl = $("toast");
let toastTimer: ReturnType<typeof setTimeout>;
function toast(html: string) {
  toastEl.innerHTML = html;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// drag the bar between chart and board to resize the chart
const splitter = $("splitter");
splitter.onpointerdown = (e) => {
  const wrap = chartEl.parentElement!, y0 = e.clientY, h0 = wrap.offsetHeight;
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("drag");
  splitter.onpointermove = (ev) => (wrap.style.height = `${Math.max(160, h0 + ev.clientY - y0)}px`);
  splitter.onpointerup = () => { splitter.onpointermove = null; splitter.classList.remove("drag"); };
};

const initials = (name: string) =>
  name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase() || "?";
function avatar(el: HTMLElement, r: number, color?: string) {
  el.textContent = initials(authors[r]!.name);
  el.style.background = color || getComputedStyle(document.documentElement).getPropertyValue("--other");
}

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
  extsEl.querySelector("summary .v")!.textContent =
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
  const search = extsEl.querySelector("input[type=search]") as HTMLInputElement;
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const b of boxes) b.parentElement!.hidden = !data.exts[+b.value]!.toLowerCase().includes(q);
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

const tix = (c: readonly number[]) => raw[c[4]!]!.tix;
// tickets aren't additive (same ticket across commits counts once), so they're counted via sets, not value()
const value = (c: readonly number[], m: Metric) =>
  m === "tickets" ? 0 : m === "commits" ? 1 : m === "added" ? c[2]! : m === "deleted" ? c[3]! : m === "net" ? c[2]! - c[3]! : c[2]! + c[3]!;

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
const METRIC_KEY: Record<Metric, string> = { commits: "commits", tickets: "tickets", added: "add", deleted: "del", net: "net", churn: "churn" };
const boardSort: Sort = { k: "", asc: false };
const sideSort: Sort = { k: "", asc: false };
const boardKey = () => boardSort.k || METRIC_KEY[metricEl.value as Metric];
const sideKey = () => sideSort.k || (["commits", "tickets"].includes(metricEl.value) ? "churn" : METRIC_KEY[metricEl.value as Metric]);
type Row = { add: number; del: number } & Record<string, number>;
const col = (x: Row, k: string) => (k === "net" ? x.add - x.del : k === "churn" ? x.add + x.del : x[k]!);
function sortRows<T extends Row>(items: T[], s: Sort, k: string, thead: HTMLElement) {
  for (const th of thead.querySelectorAll<HTMLElement>("th[data-k]")) {
    th.classList.toggle("on", th.dataset.k === k);
    th.classList.toggle("asc", th.dataset.k === k && s.asc);
  }
  const cmp = (a: T, b: T) => (k === "name" ? authors[a.r!]!.name.localeCompare(authors[b.r!]!.name) : col(a, k) - col(b, k));
  return items.sort((a, b) => (s.asc ? 1 : -1) * cmp(a, b));
}
function bindSort(thead: HTMLElement, s: Sort, current: () => string, rerender: () => void) {
  thead.onclick = (e) => {
    const k = (e.target as HTMLElement).closest("th")?.dataset.k;
    if (!k) return;
    s.asc = current() === k ? !s.asc : k === "name"; // names start a→z, numbers start high→low
    s.k = k;
    rerender();
  };
}

// all-time rank by |metric|, ignoring zoom and hidden rows, so hiding/zooming never repaints anyone
function rank(m: Metric) {
  const tot = new Map<number, number>();
  const seen = new Map<number, Set<string>>();
  for (const c of commits) {
    const r = parent[c[1]]!;
    tot.set(r, (tot.get(r) ?? 0) + value(c, m));
    if (m === "tickets") for (const k of tix(c)) (seen.get(r) ?? seen.set(r, new Set()).get(r)!).add(k);
  }
  for (const [r, s] of seen) tot.set(r, s.size);
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
  // tickets: a unique set per bucket per author; key -1 is everyone shown, so a shared ticket counts once in the total
  const sets = new Map<number, Set<string>[]>();
  const addTix = (r: number, i: number, keys: string[]) => {
    let s = sets.get(r);
    if (!s) sets.set(r, (s = buckets.map(() => new Set())));
    for (const k of keys) s[i]!.add(k);
  };
  for (const c of commits) {
    const r = parent[c[1]]!;
    if (hidden.has(r)) continue;
    let arr = per.get(r);
    if (!arr) per.set(r, (arr = new Array(buckets.length).fill(0)));
    const i = idx.get(floorTo(c[0], b))!;
    if (m === "tickets") { addTix(r, i, tix(c)); addTix(-1, i, tix(c)); }
    else arr[i] += value(c, m);
  }
  let total = new Array(buckets.length).fill(0);
  if (m === "tickets") {
    // cumulative = distinct tickets touched so far, not a running sum
    const count = (s: Set<string>[]) => {
      const all = new Set<string>();
      return s.map((x) => (cumulative ? (x.forEach((k) => all.add(k)), all.size) : x.size));
    };
    for (const [r, s] of sets) r === -1 ? (total = count(s)) : per.set(r, count(s));
  } else {
    if (cumulative) for (const arr of per.values()) for (let i = 1; i < arr.length; i++) arr[i] += arr[i - 1]!;
    for (const arr of per.values()) arr.forEach((v, i) => (total[i] += v));
  }
  return { buckets, per, total };
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
  const { buckets, per, total } = series(m, b, cumulativeEl.checked);
  const order = rank(m);
  const colors = colorOf(order);
  const ranked = order.filter((r) => per.has(r));
  const top = new Set(order.slice(0, 8));
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--text-secondary").trim();
  const muted = css.getPropertyValue("--text-muted").trim();
  const grid = css.getPropertyValue("--border").trim();
  const other = css.getPropertyValue("--other").trim();
  const v = (k: string) => css.getPropertyValue(k).trim();
  const accent = v("--accent"), soft = v("--accent-soft");
  const mode = modeEl.value;
  // vertical fade under a line, from the series colour to transparent
  const fade = (hex: string, a = 0.28) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: `rgba(${r},${g},${bl},${a})` }, { offset: 1, color: `rgba(${r},${g},${bl},0)` },
    ]);
  };
  const pts = (arr: number[]) => arr.map((v, i) => [buckets[i]!, v]);
  const line = (name: string, arr: number[], color: string, extra: object = {}) => ({
    name, type: mode === "bar" ? "bar" : "line", data: pts(arr), color, emphasis: { focus: "series" },
    ...(mode === "bar"
      ? { barMaxWidth: 24, itemStyle: { borderRadius: layout === "stacked" ? 0 : [3, 3, 0, 0] } }
      : { showSymbol: false, symbolSize: 7, smooth: mode === "smooth", lineStyle: { width: 2 } }),
    ...extra,
  });
  // dashed fit sharing its series' name, so the legend toggles both; kept out of the tooltip
  trends = [];
  const trend = (name: string, arr: number[], color: string, axis = 0) => {
    const id = `trend${trends.length}`;
    trends.push({ id, pts: pts(arr) });
    return {
      id, name, type: "line", data: fit(pts(arr)), color, xAxisIndex: axis, yAxisIndex: axis, symbol: "none", silent: true,
      z: 5, lineStyle: { type: [6, 4], width: 1.5, opacity: 0.9 }, tooltip: { show: false }, emphasis: { disabled: true },
    };
  };
  const withTrend = trendEl.checked;
  const axisCommon = {
    axisLine: { lineStyle: { color: grid } }, axisTick: { show: false }, axisLabel: { color: muted, hideOverlap: true, fontSize: 11 },
    splitLine: { lineStyle: { color: grid, type: [4, 4] } },
  };
  const yCommon = { ...axisCommon, axisLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: compact } };
  const slider = {
    type: "slider", height: 26, borderColor: "transparent", backgroundColor: v("--surface-2"),
    fillerColor: soft, borderRadius: 8, showDetail: false,
    dataBackground: { lineStyle: { color: muted, opacity: 0.5 }, areaStyle: { color: muted, opacity: 0.15 } },
    selectedDataBackground: { lineStyle: { color: accent, opacity: 0.8 }, areaStyle: { color: accent, opacity: 0.2 } },
    handleIcon: "path://M-3,-11 h6 a3,3 0 0 1 3,3 v16 a3,3 0 0 1 -3,3 h-6 a3,3 0 0 1 -3,-3 v-16 a3,3 0 0 1 3,-3 z",
    handleSize: "90%", handleStyle: { color: v("--surface-1"), borderColor: accent, borderWidth: 1.5 },
    moveHandleSize: 4, moveHandleStyle: { color: accent, opacity: 0.35 }, emphasis: { moveHandleStyle: { opacity: 0.8 } },
  };
  const zoomRange = zoom ? { startValue: zoom[0], endValue: zoom[1] } : {};
  const tooltip = {
    trigger: "axis", order: "valueDesc", confine: true,
    valueFormatter: (x: number) => x?.toLocaleString(),
    backgroundColor: v("--surface-1"), borderColor: grid, borderWidth: 1, padding: [8, 12],
    textStyle: { color: v("--text-primary"), fontSize: 12 },
    extraCssText: "border-radius:10px;box-shadow:" + v("--shadow-pop"),
    axisPointer: mode === "bar"
      ? { type: "shadow", shadowStyle: { color: soft } }
      : { type: "line", lineStyle: { color: muted, type: [4, 4] } },
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
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      tooltip,
      title: shown.map((r, i) => ({
        text: authors[r]!.name, top: TOP + i * ROW - 4, left: 12,
        textStyle: { fontSize: 12, fontWeight: 600, color: ink },
      })),
      grid: shown.map((_, i) => ({ top: TOP + i * ROW + 24, height: ROW - 52, left: 56, right: 24 })),
      // bars sit centred on the bucket start; let echarts pad the axis so the edge ones aren't cut in half
      xAxis: shown.map((_, i) => ({
        type: "time", gridIndex: i, ...(mode === "bar" ? {} : { min: buckets[0], max: buckets.at(-1) }),
        ...axisCommon, splitLine: { show: false },
      })),
      yAxis: shown.map((_, i) => ({ type: "value", gridIndex: i, min: lo, max: hi, splitNumber: 2, ...yCommon })),
      dataZoom: [
        { ...slider, xAxisIndex: all, top: 10, ...zoomRange },
        { type: "inside", xAxisIndex: all, zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, ...zoomRange },
      ],
      series: [
        ...shown.map((r, i) => line(authors[r]!.name, per.get(r)!, colors.get(r)!, {
          xAxisIndex: i, yAxisIndex: i, areaStyle: { color: fade(colors.get(r)!) },
        })),
        ...(withTrend ? shown.map((r, i) => trend(authors[r]!.name, per.get(r)!, colors.get(r)!, i)) : []),
      ],
    };
  } else {
    chartEl.style.height = "100%";
    let list: any[];
    if (layout === "total") {
      list = [line("total", total, accent, { areaStyle: { color: fade(accent, 0.35) } })];
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
      // a stack's (or the total's) trend is the trend of its top edge; for tickets, of the distinct union
      if (layout === "overlaid") list.push(...list.map((s) => trend(s.name, s.data.map((p: number[]) => p[1]), s.color)));
      else list.push(trend(layout === "total" ? "total" : "trend", total, ink));
    }
    opt = {
      animation: false,
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      tooltip,
      legend: {
        show: legend, top: 12, type: "scroll", icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 18,
        textStyle: { color: ink, fontSize: 12 }, inactiveColor: grid,
        pageIconColor: accent, pageIconInactiveColor: grid, pageTextStyle: { color: muted },
      },
      grid: { top: legend ? 52 : 24, left: 56, right: 24, bottom: 64 },
      xAxis: { type: "time", ...axisCommon, splitLine: { show: false } },
      yAxis: { type: "value", ...yCommon },
      dataZoom: [
        { ...slider, bottom: 14, ...zoomRange },
        { type: "inside", ...zoomRange },
      ],
      series: list,
    };
  }
  chart.setOption(opt, { notMerge: true });
  chart.resize();
}

const compact = (n: number) => Intl.NumberFormat("en", { notation: "compact" }).format(n);
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");

function renderBoard() {
  const m = metricEl.value as Metric;
  const [z0, z1] = zoom ?? [-Infinity, Infinity];
  type S = { r: number; commits: number; tickets: number; add: number; del: number; first: number; last: number };
  const stats = new Map<number, S>(roots().map((r) => [r, { r, commits: 0, tickets: 0, add: 0, del: 0, first: 0, last: 0 }]));
  const seen = new Map<number, Set<string>>();
  for (const c of commits) {
    if (c[0] < z0 || c[0] > z1) continue;
    const r = parent[c[1]]!;
    const s = stats.get(r)!;
    s.commits++; s.add += c[2]; s.del += c[3];
    s.first ||= c[0]; s.last = c[0];
    for (const k of tix(c)) (seen.get(r) ?? seen.set(r, new Set()).get(r)!).add(k);
  }
  for (const [r, set] of seen) stats.get(r)!.tickets = set.size;
  renderKpis([...stats.values()].filter((s) => !hidden.has(s.r)), seen);
  const colors = colorOf(rank(m));
  const key = boardKey();
  const order = sortRows([...stats.values()], boardSort, key, boardEl.tHead!);
  const dated = key === "first" || key === "last" || key === "name"; // no share bar for non-metric sorts
  const max = Math.max(1, ...order.map((s) => Math.abs(col(s, key))));
  rowsEl.replaceChildren();
  order.forEach((s, i) => {
    const r = s.r;
    const off = hidden.has(r);
    const tr = document.createElement("tr");
    tr.className = "root" + (off ? " off" : "");
    tr.draggable = true;
    tr.title = `${authors[r]!.email} — click to hide/show, drag onto another row to merge`;
    const al = aliases(r);
    const net = s.add - s.del;
    tr.innerHTML = `<td class="rk">${icon("grip", "i grip")}${i + 1}</td>
      <td><div class="who"><span class="av"></span><div class="who-t"><div class="who-n"><span class="nm"></span></div>
        ${dated ? "" : `<i class="share"><b></b></i>`}</div>
        <button class="eye" tabindex="-1" title="${off ? "Show" : "Hide"}">${icon(off ? "eye-off" : "eye")}</button></div></td>
      <td>${s.commits.toLocaleString()}</td><td>${s.tickets.toLocaleString()}</td>
      <td class="pos">+${s.add.toLocaleString()}</td><td class="neg">−${s.del.toLocaleString()}</td>
      <td class="${net < 0 ? "neg" : ""}">${net.toLocaleString()}</td><td>${(s.add + s.del).toLocaleString()}</td>
      <td class="dim">${s.first ? fmtDate(s.first) : "–"}</td><td class="dim">${s.last ? fmtDate(s.last) : "–"}</td>`;
    avatar(tr.querySelector(".av")!, r, colors.get(r));
    tr.querySelector(".nm")!.textContent = authors[r]!.name;
    const bar = tr.querySelector<HTMLElement>(".share b");
    if (bar) Object.assign(bar.style, { width: `${(Math.abs(col(s, key)) / max) * 100}%`, background: colors.get(r) ?? "var(--other)" });
    if (al.length) {
      const btn = document.createElement("button");
      btn.className = "badge";
      btn.title = "Show merged identities";
      btn.setAttribute("aria-expanded", String(expanded.has(r)));
      btn.innerHTML = `${icon("merge", "i sm")}<span></span>`;
      btn.lastElementChild!.textContent = `+${al.length}`;
      btn.onclick = (e) => { e.stopPropagation(); expanded.has(r) ? expanded.delete(r) : expanded.add(r); renderBoard(); };
      tr.querySelector(".who-n")!.append(btn);
    }
    tr.onclick = () => { hidden.has(r) ? hidden.delete(r) : hidden.add(r); render(); };
    tr.ondragstart = (e) => { e.dataTransfer!.setData("text/plain", String(r)); tr.classList.add("dragging"); };
    tr.ondragend = () => tr.classList.remove("dragging");
    tr.ondragover = (e) => { e.preventDefault(); tr.classList.add("drop"); };
    tr.ondragleave = (e) => { if (!tr.contains(e.relatedTarget as Node)) tr.classList.remove("drop"); };
    tr.ondrop = (e) => {
      e.preventDefault();
      const src = Number(e.dataTransfer!.getData("text/plain"));
      if (Number.isInteger(src) && src !== r) {
        const name = authors[src]!.name;
        merge(src, r);
        toast(`${icon("merge")}<span></span>`);
        toastEl.lastElementChild!.textContent = `Merged ${name} into ${authors[r]!.name}`;
      } else tr.classList.remove("drop");
    };
    rowsEl.append(tr);

    if (expanded.has(r)) for (const a of [r, ...al]) {
      const sub = document.createElement("tr");
      sub.className = "alias";
      sub.innerHTML = `<td></td><td colspan="9">${icon(a === r ? "users" : "merge", "i sm")}<span></span><em></em></td>`;
      sub.querySelector("span")!.textContent = authors[a]!.name;
      sub.querySelector("em")!.textContent = `<${authors[a]!.email}>`;
      if (a !== r) {
        const x = document.createElement("button");
        x.className = "x";
        x.innerHTML = icon("x", "i sm");
        x.title = "Unmerge";
        x.onclick = () => { parent[a] = a; if (aliases(r).length === 0) expanded.delete(r); render(); };
        sub.children[1]!.append(x);
      }
      rowsEl.append(sub);
    }
  });
}

// headline numbers for everyone shown, over the zoomed range
const kpisEl = $("kpis");
function renderKpis(shown: { r: number; commits: number; add: number; del: number; first: number; last: number }[], seen: Map<number, Set<string>>) {
  const sum = (k: "commits" | "add" | "del") => shown.reduce((n, s) => n + s[k], 0);
  const tickets = new Set(shown.flatMap((s) => [...(seen.get(s.r) ?? [])])).size;
  const active = shown.filter((s) => s.commits);
  const first = Math.min(...active.map((s) => s.first)), last = Math.max(...active.map((s) => s.last));
  const add = sum("add"), del = sum("del");
  const items: [string, string, string, string?][] = [
    ["commit", "Commits", sum("commits").toLocaleString()],
    ["users", "Contributors", active.length.toLocaleString()],
    ["ticket", "Tickets", tickets.toLocaleString()],
    ["plus", "Added", `+${compact(add)}`, "pos"],
    ["minus", "Deleted", `−${compact(del)}`, "neg"],
    ["activity", "Churn", compact(add + del)],
    ["calendar", "Range", active.length ? `${Math.max(1, Math.round((last - first) / DAY)).toLocaleString()}d` : "–"],
  ];
  kpisEl.innerHTML = items.map(([ic, label, val, cls]) =>
    `<div class="kpi ${cls ?? ""}"><span class="ic">${icon(ic)}</span><div><span>${label}</span><b>${val}</b></div></div>`).join("");
  if (active.length) (kpisEl.lastElementChild as HTMLElement).title = `${fmtDate(first)} → ${fmtDate(last)}`;
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
  const colors = colorOf(rank(metricEl.value as Metric));
  const head = sideEl.querySelector<HTMLElement>(".side-h .av")!;
  if (root === null) { head.innerHTML = icon("users", "i sm"); head.style.background = "var(--accent)"; }
  else avatar(head, root, colors.get(root));
  sideEl.querySelector("h2")!.textContent = root === null ? "Everyone shown" : authors[root]!.name;
  const add = rows.reduce((n, c) => n + c.add, 0), del = rows.reduce((n, c) => n + c.del, 0);
  sideEl.querySelector(".meta")!.innerHTML =
    `<span>${icon("calendar", "i sm")} ${span}</span><span>${icon("commit", "i sm")} ${rows.length.toLocaleString()} commits</span>` +
    `<span class="pos">+${add.toLocaleString()}</span><span class="neg">−${del.toLocaleString()}</span>`;
  // ponytail: render cap keeps huge cumulative ranges snappy; paginate if anyone needs row 501
  sideTable.tBodies[0]!.replaceChildren(...rows.slice(0, 500).map((c) => {
    const tr = document.createElement("tr");
    const [hash, subject] = raw[c.ri]!.info;
    const net = c.add - c.del;
    tr.innerHTML = `<td class="dim">${fmtDate(c.t)}</td><td><div class="who"><span class="av sm"></span><span class="nm"></span></div></td>
      <td><button class="hash" title="Copy hash"></button><span class="subj"></span></td>
      <td class="pos">+${c.add.toLocaleString()}</td><td class="neg">−${c.del.toLocaleString()}</td>
      <td class="${net < 0 ? "neg" : ""}">${net.toLocaleString()}</td><td>${(c.add + c.del).toLocaleString()}</td>`;
    const r = parent[c.a]!;
    avatar(tr.querySelector(".av")!, r, colors.get(r));
    tr.querySelector(".nm")!.textContent = authors[r]!.name;
    const h = tr.querySelector<HTMLButtonElement>(".hash")!;
    h.textContent = hash;
    h.onclick = () => navigator.clipboard.writeText(hash).then(() => toast(`${icon("check")} Copied ${hash}`));
    // ticket keys become chips; odd split parts are the captured keys
    tr.querySelector(".subj")!.append(...subject.split(/(\bNX-\d+\b)/i).map((part, i) =>
      i % 2 ? Object.assign(document.createElement("span"), { className: "tk", textContent: part }) : part));
    return tr;
  }));
}
$("sideClose").onclick = () => { side = null; renderSide(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && side) { side = null; renderSide(); } });

function render() {
  for (const sync of segs) sync();
  renderChart();
  renderBoard();
  renderSide();
  save();
}

const boardEl = rowsEl.closest("table")!;
bindSort(boardEl.tHead!, boardSort, boardKey, renderBoard);
bindSort(sideTable.tHead!, sideSort, sideKey, renderSide);
const syncHint = () => ($("ticketHint").hidden = metricEl.value !== "tickets");
syncHint();
metricEl.onchange = () => { syncHint(); boardSort.k = sideSort.k = ""; boardSort.asc = sideSort.asc = false; render(); };
for (const el of [bucketEl, cumulativeEl, layoutEl, modeEl, trendEl]) el.onchange = render;
skipFirstEl.onchange = () => { applyFilter(); render(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
buildExtFilter();
applyFilter();
render();
