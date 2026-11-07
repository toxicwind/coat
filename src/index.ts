/**
 * coat — the kelpie's fur. The wallpaper lane.
 *
 * e621 rotation (SFW male furry, score>80), palette grooming, every wall
 * archived byte-perfect. Wraps the PROVEN ww pipeline script.
 *
 * Endpoints (:25240):
 *   POST /rotate  — rotate the wall now
 *   GET  /status  — daemon + last-wall state
 */
import { consola } from "consola";
import { Cron } from "croner";
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { buildTagCandidates, pickFirstUsable, postMeta, type E621Post, type WallMeta } from "./rotate-utils";
import { HistoryDB, type HistorySource } from "./db";
import { setWallWindows, getCurrentWallWindows, imageDimensions, pickFitStyle, type PanAxis } from "./win-set";

const PORT = Number(process.env.COAT_PORT ?? 25240);
const HOME = process.env.HOME ?? "";
const IS_WIN = process.platform === "win32";
const WW = join(HOME, "pens/kelpie/products/ww");
const E621_SCRIPT = join(WW, "dots/.config/quickshell/ww/scripts/colors/random/random_e621_wall.sh");
const ARCHIVE = join(HOME, "pens/kelpie/docs/wallpaper-archive");
const STATE = join(HOME, ".local/state/coat");
const ROTATE_CRON = process.env.COAT_ROTATE_CRON ?? "0 21 * * *";
/** Local wall landing dir (kept in sync with the wallchanger config when on Windows). */
const WALLS_DIR = join(HOME, "Wallpapers");
/** Windows: e621 search query (default male/male, NSFW allowed). Managed via GET/POST /tags. */
const DEFAULT_TAGS = process.env.COAT_E621_TAGS ?? "male/male score:>80 -gore -comic";

mkdirSync(ARCHIVE, { recursive: true });
mkdirSync(STATE, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[coat]", ...a);

interface CoatState { lastRotate: string | null; lastWall: string | null; lastWallMeta: WallMeta | null; rotates: number; lastError: string | null; tags: string; intervalHours: number; pan: { x: PanAxis; y: PanAxis } }
const statePath = join(STATE, "state.json");
const loaded = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<CoatState>) : {};
const state: CoatState = {
  lastRotate: loaded.lastRotate ?? null,
  lastWall: loaded.lastWall ?? null,
  lastWallMeta: loaded.lastWallMeta ?? null,
  rotates: loaded.rotates ?? 0,
  lastError: loaded.lastError ?? null,
  tags: loaded.tags ?? DEFAULT_TAGS,
  intervalHours: loaded.intervalHours ?? Number(process.env.COAT_ROTATE_HOURS ?? 24),
  pan: loaded.pan ?? { x: "center", y: "center" },
};
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

// ── Persistent history DB ────────────────────────────────────────────────
// SQLite at the coat state dir. On first open it ingests every prior archive/*
// file so previous sessions become queryable, restorable history.
const historyDb = new HistoryDB(join(STATE, "history.db"));
const ingested = historyDb.ingestArchive(ARCHIVE, "rotate");
if (ingested > 0) log("history DB seeded from previous archive", { rows: ingested, total: historyDb.count() });

/** Record a wall event (rotate/save/restore) with its metadata into the DB. */
function recordHistory(input: { path: string; source: HistorySource; meta?: WallMeta | null }) {
  try {
    const m = input.meta ?? null;
    historyDb.insert({
      path: input.path,
      source: input.source,
      artist: m?.artist ?? null,
      score: m?.score ?? null,
      rating: m?.rating ?? null,
      postId: m?.id ?? null,
      generalTags: m?.tags?.general,
      sampleUrl: m?.sampleUrl ?? null,
      fullUrl: m?.fullUrl ?? null,
    });
  } catch (e) {
    log("history record failed", String(e));
  }
}

/**
 * Rotation scheduler. Rebuilds the Cron to fire every `hours` hours on the hour
 * (e.g. 3/6/12), clearing the previous one, so the tray can change the interval
 * live without a daemon restart. Disabled when COAT_NO_CRON.
 */
let rotateCron: Cron | null = null;

function setIntervalHours(hours: number) {
  const h = Math.max(1, Math.round(hours));
  state.intervalHours = h;
  persist();
  rotateCron?.stop();
  rotateCron = null;
  if (process.env.COAT_NO_CRON) return;
  rotateCron = new Cron(`0 */${h} * * *`, { name: "e621-rotate" }, () => void rotateWall());
  log("interval updated", { hours: h, cron: `0 */${h} * * *` });
}

/** A single browseable search result for the GUI (thumbnail + full metadata). */
export interface SearchResult extends WallMeta {
  previewUrl: string | null;
  postUrl: string;
}

/**
 * /search — proxy a query to the e621 API and return a browseable result list
 * (thumbnails + metadata) for the GUI. Each result is a still image with a
 * sample URL; the caller uses `/preview` or the sample URL to render it.
 */
async function searchE621(req: Request): Promise<{ ok: boolean; query?: string; results?: SearchResult[]; error?: string }> {
  try {
    const body = (await req.json().catch(() => ({}))) as { q?: string; limit?: number };
    const q = (body.q ?? "").trim();
    if (!q) return { ok: false, error: "query required" };
    const limit = Math.min(Number(body.limit ?? 24) || 24, 60);
    const url = `https://e621.net/posts.json?limit=${limit}&tags=${encodeURIComponent(`${q} order:random`)}`;
    const res = await fetch(url, { headers: { "User-Agent": `coat/${process.env.npm_package_version ?? "0.1.0"} (kelpie)` } });
    if (!res.ok) return { ok: false, error: `e621 ${res.status}` };
    const data = (await res.json()) as { posts?: E621Post[] };
    const results = (data.posts ?? []).map((p) => {
      const post = pickFirstUsable([p]);
      if (!post) return null;
      const m = postMeta(post);
      const postUrl = post.id ? `https://e621.net/posts/${post.id}` : m.fullUrl;
      return { ...m, previewUrl: m.sampleUrl ?? m.fullUrl, postUrl };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
    return { ok: true, query: q, results: results.slice(0, limit) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/**
 * /wall/from-search — set a specific searched post as the wallpaper. Body carries
 * a SearchResult: it downloads the full-res file, saves it, sets it (Windows
 * SPI), records it in history, and updates current state/meta.
 */
async function setWallFromSearch(req: Request): Promise<{ ok: boolean; wall?: string; error?: string }> {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<SearchResult> & { url?: string };
    const url = body.fullUrl || body.url;
    if (!url) return { ok: false, error: "no image url" };
    const res = await fetch(url, { headers: { "User-Agent": `coat/${process.env.npm_package_version ?? "0.1.0"} (kelpie)` } });
    if (!res.ok) return { ok: false, error: `image ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extname(new URL(url).pathname) || ".jpg";
    const safe = new URL(url).pathname.split("/").pop()?.replace(/[^\w.\-]+/g, "_") || `wall-${Date.now()}`;
    const out = join(WALLS_DIR, `${new Date().toISOString().slice(0, 10)}-${safe}`);
    mkdirSync(WALLS_DIR, { recursive: true });
    writeFileSync(out, buf);
    const meta: WallMeta = {
      id: body.id,
      artist: body.artist ?? "(unknown)",
      score: body.score ?? 0,
      rating: body.rating ?? "",
      tags: { artist: body.tags?.artist ?? [], general: body.tags?.general ?? [], species: body.tags?.species ?? [], character: [], copyright: [], meta: [] },
      sampleUrl: body.sampleUrl ?? null,
      fullUrl: url,
      ext,
    };
    if (IS_WIN) {
      const { w: monW, h: monH } = getWindowsDesktopSize();
      await setWallWindows(out, { style: "Fill", cropToAspect: monW && monH ? monW / monH : undefined, pan: state.pan, tile: false });
    }
    state.lastWall = out;
    state.lastWallMeta = meta;
    persist();
    recordHistory({ path: out, source: "restore", meta });
    log("wall from search", { artist: meta.artist, file: out });
    return { ok: true, wall: out };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/**
 * Windows: fetch a fresh e621 post via the JSON API and write it to WALLS_DIR.
 * Uses the tested rotate-utils logic: only still images (jpg/png/bmp) are
 * picked, and if a strict tag query returns an empty page, it falls back to the
 * score-stripped candidate so the rotate button never comes back dead.
 */
async function fetchE621Wall(): Promise<{ path: string; meta: WallMeta }> {
  const candidates = buildTagCandidates(state.tags);
  let lastErr = "no usable e621 post (bad tags/rating?)";
  for (const tags of candidates) {
    try {
      const url = `https://e621.net/posts.json?limit=8&tags=${encodeURIComponent(`${tags} order:random`)}`;
      const res = await fetch(url, { headers: { "User-Agent": `coat/${process.env.npm_package_version ?? "0.1.0"} (kelpie)` } });
      if (!res.ok) { lastErr = `e621 ${res.status}`; continue; }
      const body = (await res.json()) as { posts?: E621Post[] };
      const post = pickFirstUsable(body.posts);
      if (!post) { lastErr = "no usable e621 post (bad tags/rating?)"; continue; }
      const ext = extname(new URL(post.file.url).pathname) || `.${post.file.ext ?? "jpg"}`;
      const safe = new URL(post.file.url).pathname.split("/").pop()?.replace(/[^\w.\-]+/g, "_") || `wall-${Date.now()}`;
      const name = `${new Date().toISOString().slice(0, 10)}-${safe}`;
      const out = join(WALLS_DIR, name);
      const img = await fetch(post.file.url, { headers: { "User-Agent": `coat/${process.env.npm_package_version ?? "0.1.0"} (kelpie)` } });
      if (!img.ok) { lastErr = `e621 asset ${img.status}`; continue; }
      const buf = Buffer.from(await img.arrayBuffer());
      writeFileSync(out, buf);
      const meta = postMeta(post);
      log("fetched", { id: post.id, artist: meta.artist, score: meta.score, file: name, bytes: buf.length, tags });
      return { path: out, meta };
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(lastErr);
}

/**
 * Windows: keep the vendored `wallchanger` tray rotator pointed at WALLS_DIR so
 * it cycles the same folder coat fills. Config lives at
 * %LocalAppData%\WallpaperSlideshow\config.json (the fork's read location).
 */
function syncWallchangerConfig() {
  try {
    const cfgDir = join(process.env.LOCALAPPDATA ?? join(HOME, "AppData/Local"), "WallpaperSlideshow");
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "config.json");
    const existing = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(cfgPath, JSON.stringify({ ...existing, WallpaperFolder: WALLS_DIR, IntervalMinutes: Number(process.env.COAT_WALLCHANGER_MIN ?? 30), Randomize: true }, null, 2));
  } catch (e) {
    log("wallchanger config sync failed", String(e));
  }
}

/**
 * Restore an archived wall as the desktop wallpaper. Copies the history file
 * into WALLS_DIR as a fresh wall (so the current path is always on disk), sets
 * it (Windows: via SPI; Linux: leaves to the ww lane) and records the restore.
 */
async function restoreWallFromHistory(id: number): Promise<{ ok: boolean; wall?: string; error?: string }> {
  try {
    const row = historyDb.get(id);
    if (!row || !existsSync(row.path)) return { ok: false, error: "history entry not found or file missing" };
    const ext = extname(row.path) || ".jpg";
    const dest = join(WALLS_DIR, `restored-${id}${ext}`);
    if (!existsSync(dest)) copyFileSync(row.path, dest);
    if (IS_WIN) {
      const { w: monW, h: monH } = getWindowsDesktopSize();
      await setWallWindows(dest, { style: "Fill", cropToAspect: monW && monH ? monW / monH : undefined, pan: state.pan, tile: false });
    }
    state.lastWall = dest;
    state.lastWallMeta = {
      id: row.post_id ?? undefined,
      artist: row.artist ?? "(unknown)",
      score: row.score ?? 0,
      rating: row.rating ?? "",
      tags: { artist: [], general: row.tags ? (JSON.parse(row.tags) as string[]) : [], species: [], character: [], copyright: [], meta: [] },
      sampleUrl: row.sample_url,
      fullUrl: row.full_url ?? "",
      ext,
    };
    persist();
    recordHistory({ path: dest, source: "restore", meta: state.lastWallMeta });
    log("restored wall", { id, wall: dest });
    return { ok: true, wall: dest };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/** Serve the current wallpaper image for the GUI preview. Read from a local file
 *  so the GUI never depends on an external CDN (CSP/CORS/hotlink-proof). */
function serveCurrentWall(): Response {
  try {
    // Prefer the Windows BMP that's actively displayed; else the last fetched wall.
    const candidates = IS_WIN ? [join(WALLS_DIR, "current-wall.bmp")] : [];
    if (state.lastWall) candidates.push(state.lastWall);
    for (const c of candidates) {
      if (c && existsSync(c)) {
        const buf = readFileSync(c);
        const ext = extname(c).toLowerCase();
        const type = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
        return new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
      }
    }
  } catch { /* fall through */ }
  return new Response("no wall yet", { status: 404 });
}

/**
 * Save the CURRENT desktop wallpaper (whatever is on screen right now, even if
 * it was set outside coat) into the archive as a history entry.
 */
function saveCurrentWall() {
  try {
    if (!IS_WIN) return { ok: false, error: "save-current is Windows-only" };
    const current = getCurrentWallWindows();
    if (!current) return { ok: false, error: "no current desktop wallpaper to save" };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(ARCHIVE, `${stamp}-saved${extname(current)}`);
    copyFileSync(current, dest);
    log("saved current to history", dest);
    recordHistory({ path: dest, source: "save", meta: state.lastWallMeta });
    return { ok: true, archived: dest, source: current };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/**
 * Get the Windows desktop virtual-screen size (pixels) — one horizontal monitor
 * here. Zero-dep: SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN via powershell Add-Type.
 */
function getWindowsDesktopSize(): { w: number; h: number } {
  try {
    // Inline `Add-Type -TypeDefinition` with a one-line C# string fails ("Identifier
    // expected") — write a proper .ps1 file (the same reason the setter does).
    const dir = mkdtempSync(join(tmpdir(), "coat-monsize-"));
    const ps = join(dir, "mon.ps1");
    writeFileSync(ps, [
      "Add-Type -TypeDefinition @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class VM {",
      "  [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int nIndex);",
      "}",
      "'@",
      "Write-Output (([VM]::GetSystemMetrics(78)).ToString() + ' ' + ([VM]::GetSystemMetrics(79)).ToString())",
    ].join("\n"), "utf8");
    try {
      const out = Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { stdout: "pipe", windowsHide: true }).stdout.toString();
      const [w, h] = out.trim().split(/\s+/).map(Number);
      if (w && h) return { w, h };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* fall through */ }
  return { w: 0, h: 0 };
}

async function rotateWall() {
  try {
    mkdirSync(WALLS_DIR, { recursive: true });
    let setWall: (p: string) => Promise<unknown> = async () => {};
    const before = new Set(existsSync(WALLS_DIR) ? readdirSync(WALLS_DIR) : []);
    let fetched: string | null = null;
    let meta: WallMeta | null = null;

    if (IS_WIN) {
      // Native lane: no bash/ww dependency. Fetch + set via Win32 SPI.
      const fetchedWall = await fetchE621Wall(); // { path, meta }
      fetched = fetchedWall.path;
      meta = fetchedWall.meta;
      // Correct scaling on the single (horizontal) monitor: smaller walls center
      // at native size, same-aspect walls fill/cover, mismatched contain/fit.
      const { w: monW, h: monH } = getWindowsDesktopSize();
      const dims = imageDimensions(fetched);
      const fit = dims ? pickFitStyle(dims.w, dims.h, monW, monH) : { style: "Fill" as const, tile: "0" as const };
      log("windows fit", { dims, monitor: `${monW}x${monH}`, style: fit.style, pan: state.pan });
      // Server-side crop to the exact monitor aspect (honoring user pan) so the
      // wallpaper is always framed correctly — Windows 'Fill' has nothing left to
      // mis-crop. Style Fill + cropToAspect == deterministic full-bleed result.
      const cropToAspect = monW && monH ? monW / monH : undefined;
      setWall = (p: string) => setWallWindows(p, { style: "Fill", cropToAspect, pan: state.pan, tile: false });
    } else {
      const proc = Bun.spawn(["bash", E621_SCRIPT], { stdout: "pipe", stderr: "pipe", env: { ...process.env, QUICKSHELL_CONFIG_NAME: "ww" } });
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      if (proc.exitCode !== 0) { state.lastError = err.slice(0, 300); persist(); return { ok: false, error: state.lastError }; }
      const after = readdirSync(WALLS_DIR).filter((f) => !before.has(f));
      const newest = after.sort().pop();
      fetched = newest ? join(WALLS_DIR, newest) : null;
    }

    const wall: string | null = fetched ?? (() => {
      const files = existsSync(WALLS_DIR) ? readdirSync(WALLS_DIR).sort() : [];
      return files.length ? join(WALLS_DIR, files[files.length - 1]!) : null;
    })();
    if (!wall) { state.lastError = "no wall produced"; persist(); return { ok: false, error: state.lastError }; }
    await setWall(wall);
    if (existsSync(wall)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(wall, join(ARCHIVE, `${stamp}-wall${extname(wall)}`));
      if (IS_WIN) syncWallchangerConfig();
      state.lastWall = wall;
      state.lastWallMeta = meta;
      state.lastError = null;
      persist();
      recordHistory({ path: wall, source: "rotate", meta });
      log("rotated", { wall: state.lastWall, artist: meta?.artist, score: meta?.score, rotates: state.rotates });
      return { ok: true, wall: state.lastWall, meta };
    }
    state.lastError = "wall missing after set";
    persist();
    return { ok: false, error: state.lastError };
  } catch (e) {
    state.lastError = String(e).slice(0, 300);
    persist();
    return { ok: false, error: state.lastError };
  }
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/status") return Response.json({ ...state, port: PORT, cron: rotateCron ? `0 */${state.intervalHours} * * *` : ROTATE_CRON, archive: ARCHIVE, historyCount: historyDb.count() });
    if (p === "/pan" && req.method === "POST") return req.json().then((raw) => {
      const b = (raw ?? {}) as { x?: string; y?: string };
      if (b.x) { if (!["left","center","right"].includes(b.x)) return Response.json({ ok: false, error: "x must be left|center|right" }, { status: 400 }); state.pan.x = b.x as PanAxis; }
      if (b.y) { if (!["top","center","bottom"].includes(b.y)) return Response.json({ ok: false, error: "y must be top|center|bottom" }, { status: 400 }); state.pan.y = b.y as PanAxis; }
      persist();
      return Response.json({ ok: true, pan: state.pan });
    });
    if (p === "/wall") return serveCurrentWall();
    if (p === "/history" && req.method === "GET") return Response.json({ ok: true, total: historyDb.count(), entries: historyDb.list(Number(new URL(req.url).searchParams.get("limit") ?? 50), Number(new URL(req.url).searchParams.get("offset") ?? 0)) });
    if (p === "/search" && req.method === "POST") return searchE621(req).then((r) => Response.json(r, { status: r.ok ? 200 : 400 }));
    if (p === "/wall/from-search" && req.method === "POST") return setWallFromSearch(req).then((r) => Response.json(r, { status: r.ok ? 200 : 400 }));
    const hl = p.match(/^\/history\/(\d+)$/);
    if (hl) { const row = historyDb.get(Number(hl[1])); return row ? Response.json({ ok: true, entry: row }) : Response.json({ ok: false, error: "not found" }, { status: 404 }); }
    const hr = p.match(/^\/history\/(\d+)\/restore$/);
    if (hr && req.method === "POST") return restoreWallFromHistory(Number(hr[1])).then((r) => Response.json(r, { status: r.ok ? 200 : 400 }));
    const hp = p.match(/^\/history\/(\d+)\/preview$/);
    if (hp) {
      const row = historyDb.get(Number(hp[1]));
      if (row && existsSync(row.path)) {
        const buf = readFileSync(row.path);
        const type = extname(row.path).toLowerCase() === ".png" ? "image/png" : extname(row.path).toLowerCase() === ".gif" ? "image/gif" : "image/jpeg";
        return new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
      }
      return new Response("not found", { status: 404 });
    }
    if (p === "/rotate" && req.method === "POST") return rotateWall().then((r) => Response.json(r, { status: r.ok ? 200 : 500 }));
    if (p === "/interval" && req.method === "POST") {
      return req.json().then((raw) => {
        const b = (raw ?? {}) as { hours?: number };
        const h = Number(b.hours);
        if (!h || !Number.isFinite(h)) return Response.json({ ok: false, error: "hours required (3 | 6 | 12 | …)" }, { status: 400 });
        setIntervalHours(h);
        return Response.json({ ok: true, intervalHours: state.intervalHours, cron: `0 */${state.intervalHours} * * *` });
      });
    }
    if (p === "/save" && req.method === "POST") { const r = saveCurrentWall(); return Response.json(r, { status: r.ok ? 200 : 400 }); }
    if (p === "/tags" && req.method === "GET") return Response.json({ tags: state.tags });
    if (p === "/tags" && req.method === "POST") {
      return req.json().then((raw) => {
        const b = (raw ?? {}) as { tags?: string; add?: string[]; remove?: string[]; search?: string };
        let next = state.tags;
        if (b.tags != null) next = b.tags;
        if (b.add) {
          const pool = next.split(/\s+/).filter(Boolean);
          for (const t of b.add) if (!pool.includes(t)) pool.push(t);
          next = pool.join(" ");
        }
        if (b.remove) {
          const drop = new Set(b.remove);
          next = next.split(/\s+/).filter((t) => !drop.has(t)).join(" ");
        }
        state.tags = next.trim() || DEFAULT_TAGS;
        persist();
        if (b.search) return Response.json({ tags: state.tags, matches: (b.search.trim() === "" ? [] : state.tags.split(/\s+/).filter((t) => !b.search || t.includes(b.search))) });
        return Response.json({ ok: true, tags: state.tags });
      });
    }
    return new Response("coat — the kelpie's fur. try /status, POST /rotate, POST /save, GET/POST /tags", { status: 404 });
  },
});

setIntervalHours(state.intervalHours); // schedules cron if not COAT_NO_CRON, else no-op
log(`coat up: http://127.0.0.1:${PORT} (the wallpaper lane) · rotate every ${state.intervalHours}h`);
