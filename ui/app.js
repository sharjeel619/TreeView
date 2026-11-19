const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (s) => document.querySelector(s);

const ROW_H = 30;
const COLS = [
  { k: "name", t: "Name", w: 360 },
  { k: "size", t: "Size", w: 110, num: true },
  { k: "alloc", t: "Allocated", w: 110, num: true },
  { k: "files", t: "Files", w: 100, num: true },
  { k: "dirs", t: "Folders", w: 90, num: true },
  { k: "pct", t: "% of Parent", w: 140 },
  { k: "mtime", t: "Last Modified", w: 130 },
];
const S = { mode: "size", unit: "auto", sort: { k: "size", d: -1 }, root: null, rows: [], sel: null, info: null, tok: 0, path: null, locs: null };

// ---------- formatting ----------
const nf = new Intl.NumberFormat();
const nf1 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
function fmtSize(b, unit = S.unit) {
  if (unit !== "auto") return nf1.format(b / UNITS[unit]) + " " + unit;
  if (b < 1024) return nf.format(b) + " Bytes";
  const u = ["KB", "MB", "GB", "TB", "PB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return nf1.format(v) + " " + u[i];
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : "");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const metric = (d) => (S.mode === "alloc" ? d.alloc : S.mode === "files" ? d.files : d.size);
function frac(n) {
  if (!n.parent) return 1;
  const p = metric(n.parent.d);
  return p ? metric(n.d) / p : 0;
}
function prefix(n) {
  const d = n.d;
  if (S.mode === "size") return fmtSize(d.size);
  if (S.mode === "alloc") return fmtSize(d.alloc);
  if (S.mode === "files") return nf.format(d.files) + " Files";
  return nf1.format(frac(n) * 100) + " %";
}

// ---------- icons ----------
const ICON = {
  dir: `<svg class="ico" viewBox="0 0 20 20"><path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h4.1l1.8 1.8h7.1A1.5 1.5 0 0 1 18 6.8V15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15z" fill="#e5a031"/><path d="M2 8.2a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 18 8.2V15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15z" fill="#fcc650"/></svg>`,
  file: `<svg class="ico" viewBox="0 0 20 20"><path d="M5 2.5h6.5l4 4V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" fill="var(--file)" stroke="var(--muted)" stroke-width="1.1"/><path d="M11.5 2.5v4h4" fill="none" stroke="var(--muted)" stroke-width="1.1"/></svg>`,
  files: `<svg class="ico" viewBox="0 0 20 20"><path d="M7.5 1.8h5.5l3.5 3.5v9.2a.5.5 0 0 1-.5.5H7.5a.5.5 0 0 1-.5-.5V2.3a.5.5 0 0 1 .5-.5z" fill="var(--file)" stroke="var(--muted)"/><path d="M4 5h5.5L13 8.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12A.5.5 0 0 1 4 5z" fill="var(--file)" stroke="var(--muted)"/></svg>`,
  drive: `<svg class="ico" viewBox="0 0 20 20"><rect x="2" y="5.5" width="16" height="9" rx="2.2" fill="#64748b"/><rect x="2" y="5.5" width="16" height="4" rx="2" fill="#94a3b8"/><circle cx="14.6" cy="12" r="1.1" fill="#34d399"/></svg>`,
  home: `<svg class="ico" viewBox="0 0 20 20"><path d="M3 9.2 10 3.5l7 5.7V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z" fill="#818cf8"/></svg>`,
  browse: `<svg class="ico" viewBox="0 0 20 20"><path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h4.1l1.8 1.8h7.1A1.5 1.5 0 0 1 18 6.8V15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15z" fill="#a78bfa"/><path d="M10 8.5v5M7.5 11h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};
const isVolRoot = () => S.info && S.info.volume && S.info.volume.root.toLowerCase() === S.info.path.toLowerCase();
const iconFor = (n) => (n.kind === "root" ? (isVolRoot() ? ICON.drive : ICON.dir) : ICON[n.kind]);

// ---------- tree model ----------
const mk = (d, kind, path, parent) => ({ d, kind, path, parent, depth: parent ? parent.depth + 1 : 0, open: false, kids: null });

function cmp(a, b) {
  const { k, d } = S.sort;
  if (k === "name") return coll.compare(a.d.name, b.d.name) * d;
  const x = k === "pct" ? metric(a.d) : a.d[k], y = k === "pct" ? metric(b.d) : b.d[k];
  return (x - y) * d || coll.compare(a.d.name, b.d.name);
}
function sortTree(n) {
  if (!n.kids) return;
  n.kids.sort(cmp);
  n.kids.forEach(sortTree);
}

async function load(n) {
  if (n.kids) return;
  if (n.kind === "files") {
    n.kids = (await invoke("files", { path: n.path })).map((r) => mk(r, "file", n.path, n));
  } else {
    const c = await invoke("children", { path: n.path });
    n.kids = c.dirs.map((r) => mk(r, "dir", [...n.path, r.idx], n));
    if (c.files) n.kids.push(mk(c.files, "files", n.path, n));
  }
  n.kids.sort(cmp);
}

async function setOpen(n, open) {
  if (!n.d.kids || n.open === open) return;
  if (open) await load(n);
  n.open = open;
  flatten();
}

function flatten() {
  const out = [];
  (function walk(n) {
    out.push(n);
    if (n.open && n.kids) for (const k of n.kids) walk(k);
  })(S.root);
  S.rows = out;
  $("#canvas").style.height = out.length * ROW_H + "px";
  render();
}

function fullPath(n) {
  const names = [];
  for (let x = n; x.parent; x = x.parent) if (x.kind !== "files") names.unshift(x.d.name);
  return names.reduce((p, nm) => (p.endsWith("\\") ? p : p + "\\") + nm, S.info.path);
}

// ---------- rendering ----------
const body = $("#tbody"), rowsEl = $("#rows");

function rowHtml(n, i) {
  const d = n.d, f = frac(n);
  const cls = ["row"];
  if (n === S.sel) cls.push("sel");
  if (!n.parent) cls.push("root");
  else if (f >= 0.1) cls.push("big");
  const chev = d.kids ? `<span class="chev${n.open ? " open" : ""}" data-act="toggle"></span>` : `<span class="chev none"></span>`;
  let label = esc(d.name);
  if (!n.parent && isVolRoot()) label += ` <span class="vol">on [${esc(S.info.volume.label || "Local Disk")}]</span>`;
  const w = (Math.min(1, Math.max(0, f)) * 100).toFixed(2);
  return `<div class="${cls.join(" ")}" style="top:${i * ROW_H}px" data-i="${i}">
<div class="c name" style="padding-left:${6 + n.depth * 20}px">${chev}${iconFor(n)}<div class="nb"><div class="bar" style="width:${w}%"></div><span class="pre">${prefix(n)}</span><span class="nm" title="${esc(d.name)}">${label}</span>${d.denied ? '<span class="warn" title="Access denied — contents not counted">⚠</span>' : ""}</div></div>
<div class="c num k-size">${fmtSize(d.size)}</div>
<div class="c num k-alloc">${fmtSize(d.alloc)}</div>
<div class="c num k-files">${nf.format(d.files)}</div>
<div class="c num k-dirs">${n.kind === "file" ? "" : nf.format(d.dirs)}</div>
<div class="c k-pct"><div class="pbar"><i style="width:${w}%"></i><span>${nf1.format(f * 100)} %</span></div></div>
<div class="c date k-mtime">${fmtDate(d.mtime)}</div></div>`;
}

let raf = 0;
function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const top = body.scrollTop, h = body.clientHeight;
    const a = Math.max(0, Math.floor(top / ROW_H) - 6);
    const b = Math.min(S.rows.length, Math.ceil((top + h) / ROW_H) + 6);
    let html = "";
    for (let i = a; i < b; i++) html += rowHtml(S.rows[i], i);
    rowsEl.innerHTML = html;
  });
}
body.addEventListener("scroll", render, { passive: true });
new ResizeObserver(render).observe(body);

function renderHead() {
  const cols = COLS.map((c, i) => (i === 0 ? `minmax(${c.w}px, 1fr)` : c.w + "px")).join(" ");
  body.style.setProperty("--cols", cols);
  body.style.setProperty("--minw", COLS.reduce((s, c) => s + c.w, 0) + "px");
  body.dataset.sort = S.sort.k;
  const arr = (d) => `<svg class="arr" viewBox="0 0 12 12"><path d="${d < 0 ? "M3 4.5l3 3 3-3" : "M3 7.5l3-3 3 3"}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  $("#thead").innerHTML = COLS.map((c, i) =>
    `<div class="th${c.num ? " num" : ""}${S.sort.k === c.k ? " sorted" : ""}" data-k="${c.k}" role="columnheader">${c.t}${S.sort.k === c.k ? arr(S.sort.d) : ""}<span class="rz" data-rz="${i}"></span></div>`
  ).join("");
}

// ---------- header: sort + resize ----------
$("#thead").addEventListener("click", (e) => {
  const th = e.target.closest(".th");
  if (!th || e.target.classList.contains("rz")) return;
  const k = th.dataset.k;
  S.sort = { k, d: S.sort.k === k ? -S.sort.d : k === "name" ? 1 : -1 };
  resort();
});
$("#thead").addEventListener("pointerdown", (e) => {
  const i = e.target.dataset?.rz;
  if (i === undefined) return;
  e.preventDefault();
  const col = COLS[+i], x0 = e.clientX, w0 = col.w;
  const move = (ev) => { col.w = Math.max(i == 0 ? 200 : 60, w0 + ev.clientX - x0); renderHead(); };
  const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
});
function resort() {
  renderHead();
  if (S.root) { sortTree(S.root); flatten(); }
}

// ---------- row interaction ----------
const nodeAt = (el) => { const r = el.closest(".row"); return r ? S.rows[+r.dataset.i] : null; };
function select(n, scroll) {
  S.sel = n;
  if (scroll) {
    const i = S.rows.indexOf(n), y = i * ROW_H, head = 36;
    if (y < body.scrollTop) body.scrollTop = y;
    else if (y + ROW_H > body.scrollTop + body.clientHeight - head) body.scrollTop = y + ROW_H - body.clientHeight + head;
  }
  render();
}
rowsEl.addEventListener("click", (e) => {
  const n = nodeAt(e.target);
  if (!n) return;
  if (e.target.dataset.act === "toggle") setOpen(n, !n.open);
  select(n);
  body.focus();
});
rowsEl.addEventListener("dblclick", (e) => {
  const n = nodeAt(e.target);
  if (!n || e.target.dataset.act) return;
  if (n.kind === "file") invoke("open_path", { path: fullPath(n) }).catch(toast);
  else setOpen(n, !n.open);
});
rowsEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const n = nodeAt(e.target);
  if (!n) return;
  select(n);
  showCtx(n, e.clientX, e.clientY);
});

body.addEventListener("keydown", async (e) => {
  if (!S.rows.length) return;
  let i = Math.max(0, S.rows.indexOf(S.sel));
  const n = S.rows[i], page = Math.floor(body.clientHeight / ROW_H) - 2;
  const go = (j) => select(S.rows[Math.max(0, Math.min(S.rows.length - 1, j))], true);
  switch (e.key) {
    case "ArrowDown": go(i + 1); break;
    case "ArrowUp": go(i - 1); break;
    case "PageDown": go(i + page); break;
    case "PageUp": go(i - page); break;
    case "Home": go(0); break;
    case "End": go(S.rows.length - 1); break;
    case "ArrowRight":
      if (n.d.kids && !n.open) await setOpen(n, true); else if (n.open) go(i + 1);
      break;
    case "ArrowLeft":
      if (n.open) await setOpen(n, false); else if (n.parent) select(n.parent, true);
      break;
    case "Delete": askRecycle(n).catch(toast); break;
    case "c": case "C":
      if (!e.ctrlKey || n.kind === "files") return;
      copy(fullPath(n));
      break;
    case "F10": {
      if (!e.shiftKey) return;
      const r = rowsEl.querySelector(".row.sel")?.getBoundingClientRect();
      if (r) showCtx(n, r.left + 60, r.bottom);
      break;
    }
    case "Enter":
      if (e.altKey) { if (n.kind !== "files") openProps(n).catch(toast); }
      else if (n.kind === "file") invoke("open_path", { path: fullPath(n) }).catch(toast); else await setOpen(n, !n.open);
      break;
    case "ContextMenu": {
      const r = rowsEl.querySelector(".row.sel")?.getBoundingClientRect();
      if (r) showCtx(n, r.left + 60, r.bottom);
      break;
    }
    default: return;
  }
  e.preventDefault();
});

// ---------- context menu ----------
const ctx = $("#ctx");
const MI = {
  open: '<path d="M11 4h5v5M16 4l-7 7M14 11.5V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5"/>',
  openWith: '<rect x="3.5" y="3.5" width="5" height="5" rx="1"/><rect x="11.5" y="3.5" width="5" height="5" rx="1"/><rect x="3.5" y="11.5" width="5" height="5" rx="1"/><rect x="11.5" y="11.5" width="5" height="5" rx="1"/>',
  term: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/>',
  explorer: '<path d="M2.5 6A1.5 1.5 0 0 1 4 4.5h3.6l1.6 1.6H16A1.5 1.5 0 0 1 17.5 7.6V15A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15z"/>',
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="1.5"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6.5A1.5 1.5 0 0 0 5.5 13H7"/>',
  tag: '<path d="M3.5 10.6V4.5a1 1 0 0 1 1-1h6.1l6 6-7.1 7.1z"/><circle cx="7.3" cy="7.3" r="1.2"/>',
  details: '<path d="M5 5.5h10M5 10h10M5 14.5h6"/>',
  expand: '<path d="M6 8l4 4 4-4"/>',
  collapse: '<path d="M6 12l4-4 4 4"/>',
  tree: '<path d="M4 4.5h5M7 8.5h5M10 12.5h6M4 4.5v12h3M7 8.5v4"/>',
  scan: '<path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2"/>',
  trash: '<path d="M4 5.5h12M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.7 10a1.5 1.5 0 0 0 1.5 1.4h4.6a1.5 1.5 0 0 0 1.5-1.4l.7-10M8.5 9v5M11.5 9v5"/>',
  props: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5M10 6.4v.1"/>',
};
const mi = (k) => `<svg class="mi" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${MI[k]}</svg>`;

const details = (n) => {
  const d = n.d;
  return `${n.parent ? d.name : fullPath(n)} — ${fmtSize(d.size, "auto")} (${fmtSize(d.alloc, "auto")} allocated)` +
    (n.kind === "file" ? "" : `, ${nf.format(d.files)} files, ${nf.format(d.dirs)} folders`) +
    `, modified ${fmtDate(d.mtime)} — ${fullPath(n)}`;
};
const openProps = (n) => invoke("properties", { path: fullPath(n) });

function showCtx(n, x, y) {
  const p = fullPath(n);
  const real = n.kind !== "files", isFile = n.kind === "file", isDir = !isFile && real;
  // [icon, label, action, shortcut, danger]; "-" = separator; falsy entries are skipped.
  const raw = [
    real && ["open", "Open", () => invoke("open_path", { path: p }), "Enter"],
    isFile && ["openWith", "Open with…", () => invoke("open_with", { path: p })],
    real && ["term", "Open in Terminal", () => invoke("open_terminal", { path: p })],
    ["explorer", "Show in Explorer", () => invoke("reveal_path", { path: p })],
    "-",
    real && ["copy", "Copy path", () => copy(p), "Ctrl+C"],
    real && ["tag", "Copy name", () => copy(n.d.name)],
    ["details", "Copy details", () => copy(details(n))],
    "-",
    n.d.kids && [n.open ? "collapse" : "expand", n.open ? "Collapse" : "Expand", () => setOpen(n, !n.open), n.open ? "←" : "→"],
    isDir && n.d.kids && ["tree", "Expand 3 levels", () => expandLevel(n, 3).then(flatten)],
    isDir && (n.parent ? ["scan", "Scan this folder", () => scan(p)] : ["scan", "Rescan", () => scan(S.path), "F5"]),
    "-",
    real && ["props", "Properties", () => openProps(n), "Alt+Enter"],
    real && n.parent && ["trash", "Move to Recycle Bin", () => askRecycle(n), "Del", true],
  ];
  const items = []; // drop skipped entries and leading/double/trailing separators (null = <hr>)
  for (const it of raw) {
    if (Array.isArray(it)) items.push(it);
    else if (it === "-" && items.length && items.at(-1) !== null) items.push(null);
  }
  if (items.at(-1) === null) items.pop();
  ctx.innerHTML = items.map((it, i) => it
    ? `<button data-i="${i}" role="menuitem"${it[4] ? ' class="danger"' : ""}>${mi(it[0])}<span>${it[1]}</span>${it[3] ? `<kbd>${it[3]}</kbd>` : ""}</button>`
    : "<hr>").join("");
  ctx.onclick = (e) => {
    const it = items[e.target.closest("button")?.dataset.i];
    if (it) { hideMenus(); body.focus(); Promise.resolve(it[2]()).catch(toast); }
  };
  ctx.onkeydown = (e) => {
    const bs = [...ctx.querySelectorAll("button")], j = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      bs[(j + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus();
    } else if (e.key === "Escape") { hideMenus(); body.focus(); }
  };
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  ctx.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  ctx.querySelector("button")?.focus();
}
// ---------- recycle ----------
function confirmDlg(title, text, okLabel) {
  const d = $("#confirm");
  $("#cfTitle").textContent = title;
  $("#cfBody").textContent = text;
  $("#cfOk").textContent = okLabel;
  d.returnValue = "";
  d.showModal();
  return new Promise((r) => d.addEventListener("close", () => r(d.returnValue === "yes"), { once: true }));
}

async function askRecycle(n) {
  if (!n.parent || n.kind === "files") return;
  const p = fullPath(n), d = n.d;
  const what = n.kind === "file" ? "File" : `Folder · ${nf.format(d.files)} files, ${nf.format(d.dirs)} folders`;
  const ok = await confirmDlg(`Move “${d.name}” to the Recycle Bin?`, `${p}\n${what} · ${fmtSize(d.size, "auto")}`, "Move to Recycle Bin");
  body.focus();
  if (!ok) return;
  if (await invoke("recycle", { path: p })) {
    removeNode(n);
    toast(`Moved to Recycle Bin: ${d.name}`);
  } else toast("Cancelled — nothing was deleted");
}

/** Drops a deleted node from the model and subtracts its totals from every ancestor. */
function removeNode(n) {
  const i = S.rows.indexOf(n);
  const delta = { size: n.d.size, alloc: n.d.alloc, files: n.d.files, dirs: n.kind === "file" ? 0 : n.d.dirs + 1 };
  let p = n.parent;
  p.kids.splice(p.kids.indexOf(n), 1);
  for (let a = p; a; a = a.parent) for (const k in delta) a.d[k] -= delta[k];
  if (p.kind === "files") {
    p.d.name = `[${p.d.files} Files]`;
    if (!p.kids.length) { const g = p.parent; g.kids.splice(g.kids.indexOf(p), 1); p = g; }
  }
  if (!p.kids.length) { p.d.kids = false; p.open = false; }
  flatten();
  select(S.rows[Math.min(i, S.rows.length - 1)], true);
  status();
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast("Copied: " + text);
}
function hideMenus() { ctx.hidden = true; $("#menuSelect").hidden = true; $("#menuExpand").hidden = true; }
addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu, .ctx, .dd > .btn")) hideMenus(); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideMenus(); if (!$("#progress").hidden) invoke("cancel_scan"); }
  if (e.key === "F5" && S.path) { e.preventDefault(); scan(S.path); }
});
addEventListener("blur", hideMenus);

// ---------- expand ----------
async function expandLevel(n, lvl) {
  if (!n.d.kids || n.kind === "files") return;
  if (lvl <= 0) { n.open = false; return; }
  await load(n);
  n.open = true;
  await Promise.all(n.kids.map((k) => expandLevel(k, lvl - 1)));
}
$("#btnExpand").onclick = () => { $("#menuExpand").hidden = !$("#menuExpand").hidden; $("#menuSelect").hidden = true; };
$("#menuExpand").onclick = async (e) => {
  const lvl = e.target.dataset.lvl;
  if (lvl === undefined || !S.root) return;
  hideMenus();
  await expandLevel(S.root, +lvl || 1);
  if (+lvl === 0) S.sel = S.root;
  flatten();
};

// ---------- toolbar ----------
function seg(id, key) {
  $(id).onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    S[key] = v;
    $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target));
    if (key === "mode" && S.sort.k === "pct") resort(); else render();
    status();
  };
}
seg("#segMode", "mode");
seg("#segUnit", "unit");

$("#btnSelect").onclick = async () => {
  const m = $("#menuSelect");
  $("#menuExpand").hidden = true;
  if (!m.hidden) return (m.hidden = true);
  await refreshLocations();
  const L = S.locs;
  m.innerHTML =
    `<div class="mh">Drives</div>` +
    L.drives.map((d, i) => `<button data-drive="${i}">${ICON.drive}${esc(d.root)} ${esc(d.label || "Local Disk")}<span class="sub">${fmtSize(d.free, "auto")} free</span></button>`).join("") +
    `<hr><button data-home>${ICON.home}Home folder</button><button data-browse>${ICON.browse}Browse…</button>`;
  m.hidden = false;
};
$("#menuSelect").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  hideMenus();
  pickTarget(b.dataset);
};
async function pickTarget(ds) {
  if (ds.drive !== undefined) return scan(S.locs.drives[+ds.drive].root);
  if (ds.home !== undefined) return scan(S.locs.home);
  const p = await invoke("pick_folder");
  if (p) scan(p);
}
$("#btnStop").onclick = $("#pStop").onclick = () => invoke("cancel_scan");
$("#btnRefresh").onclick = () => S.path && scan(S.path);

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch {}
}
$("#btnTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
{
  let t = null;
  try { t = localStorage.getItem("theme"); } catch {}
  applyTheme(t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
}

// ---------- scanning ----------
let lastProg = null;
listen("scan-progress", ({ payload: p }) => {
  if ($("#progress").hidden) return;
  $("#pFiles").textContent = nf.format(p.files);
  $("#pDirs").textContent = nf.format(p.dirs);
  $("#pBytes").textContent = fmtSize(p.bytes, "auto");
  $("#pRate").textContent = nf.format(Math.round(p.files / Math.max(0.001, p.elapsedMs / 1000)));
  if (p.current) $("#pCur").textContent = "‎" + p.current;
  lastProg = p;
});

async function scan(path) {
  const tok = ++S.tok;
  S.path = path;
  hideMenus();
  $("#pPath").textContent = path;
  ["#pFiles", "#pDirs", "#pRate"].forEach((s) => ($(s).textContent = "0"));
  $("#pBytes").textContent = "0 Bytes";
  $("#pCur").innerHTML = "&nbsp;";
  $("#progress").hidden = false;
  $("#btnStop").disabled = false;
  $("#btnRefresh").disabled = true;
  try {
    const r = await invoke("start_scan", { path });
    if (tok !== S.tok) return;
    S.info = r;
    S.root = mk(r.root, "root", [], null);
    S.sel = S.root;
    $("#welcome").hidden = true;
    $("#tree").hidden = false;
    $("#btnExpand").disabled = false;
    body.scrollTop = 0;
    await setOpen(S.root, true);
    flatten();
    status();
    body.focus();
    if (r.cancelled) toast("Scan stopped — showing partial results");
  } catch (e) {
    if (tok === S.tok) toast(e);
  } finally {
    if (tok === S.tok) {
      $("#progress").hidden = true;
      $("#btnStop").disabled = true;
      $("#btnRefresh").disabled = !S.path;
    }
  }
}

function status() {
  const r = S.info;
  if (!r) return;
  const v = r.volume, d = r.root;
  const parts = [];
  if (v) parts.push(`Free Space: <b>${fmtSize(v.free)}</b> (of ${fmtSize(v.total)})`);
  parts.push(`<b>${nf.format(d.files)}</b> Files`, `<b>${nf.format(d.dirs)}</b> Folders`);
  parts.push(`${nf.format(r.errors)} Inaccessible`);
  if (v) parts.push(`${nf.format(v.cluster)} Bytes per Cluster (${esc(v.fs)})`);
  const t = r.elapsedMs < 1000 ? r.elapsedMs + " ms" : nf1.format(r.elapsedMs / 1000) + " s";
  parts.push(`${r.cancelled ? "Stopped after" : "Scanned in"} ${t} ·${nf.format(Math.round(d.files / Math.max(0.001, r.elapsedMs / 1000)))} files/s`);
  $("#status").innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
}

let toastT = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = String(msg);
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- welcome ----------
async function refreshLocations() { S.locs = await invoke("locations"); }
async function welcome() {
  await refreshLocations();
  const L = S.locs;
  const kinds = { 2: "Removable", 3: "Local Disk", 4: "Network", 5: "Optical", 6: "RAM Disk" };
  const cards = L.drives.map((d, i) => {
    const used = d.total ? (d.total - d.free) / d.total : 0;
    return `<button class="card" data-drive="${i}"><div class="top">${ICON.drive.replace('class="ico"', 'class="ci"')}<div><div class="t">${esc(d.label || kinds[d.kind] || "Drive")} (${esc(d.root.replace(/\\$/, ""))})</div><div class="s">${esc(d.fs)} · ${kinds[d.kind] || ""}</div></div></div>
      <div class="usage"><i class="${used > 0.9 ? "hot" : ""}" style="width:${(used * 100).toFixed(1)}%"></i></div>
      <div class="s">${fmtSize(d.free, "auto")} free of ${fmtSize(d.total, "auto")}</div></button>`;
  });
  cards.push(`<button class="card" data-home><div class="top">${ICON.home.replace('class="ico"', 'class="ci"')}<div><div class="t">Home folder</div><div class="s">${esc(L.home)}</div></div></div></button>`);
  cards.push(`<button class="card" data-browse><div class="top">${ICON.browse.replace('class="ico"', 'class="ci"')}<div><div class="t">Browse…</div><div class="s">Pick any folder or network share</div></div></div></button>`);
  $("#cards").innerHTML = cards.join("");
}
$("#cards").onclick = (e) => { const c = e.target.closest(".card"); if (c) pickTarget(c.dataset); };

// ---------- about ----------
// Empty fields are hidden; avatar may be a URL or file in ui/ (else initials).
const AUTHOR = {
  name: "Sharjeel Imtiaz",
  role: "Developer",
  bio: "",
  avatar: "",
  links: [
    ["GitHub", "https://github.com/sharjeel619"],
    ["Portfolio", "https://sharjeel.netlify.app"],
    ["Email", "mailto:imtiazsharjeel@gmail.com"],
  ],
};
$("#btnAbout").onclick = async () => {
  const A = AUTHOR, av = $("#abAvatar");
  $("#aboutName").textContent = A.name;
  $("#abRole").textContent = A.role;
  $("#abBio").textContent = A.bio;
  av.textContent = A.avatar ? "" : A.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  av.style.backgroundImage = A.avatar ? `url("${A.avatar}")` : "";
  $("#abLinks").innerHTML = A.links.map(([t], i) => `<button class="btn" data-i="${i}">${esc(t)}</button>`).join("");
  $("#abVer").textContent = "v" + (await window.__TAURI__.app.getVersion().catch(() => "0.1.0"));
  $("#about").showModal();
};
// URLs open in the default browser via the shell (explorer hands http/mailto to the registered app).
$("#abLinks").onclick = (e) => { const l = AUTHOR.links[e.target.dataset.i]; if (l) invoke("open_path", { path: l[1] }).catch(toast); };
$("#about").onclick = (e) => { // click on backdrop closes
  const r = e.currentTarget.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close();
};

renderHead();
welcome().catch(toast);
