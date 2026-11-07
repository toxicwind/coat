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
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { setWallWindows, getCurrentWallWindows, imageDimensions, pickFitStyle } from "./win-set";
import { buildTagCandidates, pickFirstUsable, type E621Post } from "./rotate-utils";

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

interface CoatState { lastRotate: string | null; lastWall: string | null; rotates: number; lastError: string | null; tags: string; intervalHours: number }
const statePath = join(STATE, "state.json");
const loaded = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<CoatState>) : {};
const state: CoatState = {
  lastRotate: loaded.lastRotate ?? null,
  lastWall: loaded.lastWall ?? null,
  rotates: loaded.rotates ?? 0,
  lastError: loaded.lastError ?? null,
  tags: loaded.tags ?? DEFAULT_TAGS,
  intervalHours: loaded.intervalHours ?? Number(process.env.COAT_ROTATE_HOURS ?? 24),
};
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

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

/**
 * Windows: fetch a fresh e621 post via the JSON API and write it to WALLS_DIR.
 * Uses the tested rotate-utils logic: only still images (jpg/png/bmp) are
 * picked, and if a strict tag query returns an empty page, it falls back to the
 * score-stripped candidate so the rotate button never comes back dead.
 */
async function fetchE621Wall(): Promise<string> {
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
      log("fetched", { id: post.id, score: post.score?.total, file: name, bytes: buf.length, tags });
      return out;
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
    const out = Bun.spawnSync(
      ["powershell", "-NoProfile", "-Command", "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class VM{[DllImport(\"user32.dll\")]public static extern int GetSystemMetrics(int);}' ; (New-Object VM).GetSystemMetrics(78).ToString()+' '+(New-Object VM).GetSystemMetrics(79)"],
      { stdout: "pipe" },
    ).stdout.toString();
    const [w, h] = out.trim().split(/\s+/).map(Number);
    if (w && h) return { w, h };
  } catch { /* fall through */ }
  return { w: 0, h: 0 };
}

async function rotateWall() {
  try {
    mkdirSync(WALLS_DIR, { recursive: true });
    let setWall: (p: string) => Promise<unknown> = async () => {};
    const before = new Set(existsSync(WALLS_DIR) ? readdirSync(WALLS_DIR) : []);
    let fetched: string | null = null;

    if (IS_WIN) {
      // Native lane: no bash/ww dependency. Fetch + set via Win32 SPI.
      fetched = await fetchE621Wall();
      // Correct scaling on the single (horizontal) monitor: smaller walls center
      // at native size, same-aspect walls fill/cover, mismatched contain/fit.
      const { w: monW, h: monH } = getWindowsDesktopSize();
      const dims = imageDimensions(fetched);
      const fit = dims ? pickFitStyle(dims.w, dims.h, monW, monH) : { style: "Fill" as const, tile: "0" as const };
      log("windows fit", { dims, monitor: `${monW}x${monH}`, style: fit.style, tile: fit.tile });
      setWall = (p: string) => setWallWindows(p, { style: fit.style, tile: fit.tile === "1" });
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
      state.lastError = null;
      persist();
      log("rotated", { wall: state.lastWall, rotates: state.rotates });
      return { ok: true, wall: state.lastWall };
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
    if (p === "/status") return Response.json({ ...state, port: PORT, cron: rotateCron ? `0 */${state.intervalHours} * * *` : ROTATE_CRON, archive: ARCHIVE });
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
