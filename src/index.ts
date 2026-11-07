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
import { setWallWindows } from "./win-set";

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
/** Windows: e621 tags fed to the JSON API for the fetch lane. */
const E621_TAGS = process.env.COAT_E621_TAGS ?? "male score:>80 -sexual -gore -comic";
const E621_SCORE = Number(process.env.COAT_E621_MIN_SCORE ?? 80);

mkdirSync(ARCHIVE, { recursive: true });
mkdirSync(STATE, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[coat]", ...a);

interface CoatState { lastRotate: string | null; lastWall: string | null; rotates: number; lastError: string | null }
const statePath = join(STATE, "state.json");
const state: CoatState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { lastRotate: null, lastWall: null, rotates: 0, lastError: null };
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

/** Windows: fetch a fresh e621 post via the JSON API and write it to WALLS_DIR. */
async function fetchE621Wall(): Promise<string> {
  const url = `https://e621.net/posts.json?limit=1&tags=${encodeURIComponent(E621_TAGS)}&score=${E621_SCORE}`;
  const res = await fetch(url, { headers: { "User-Agent": `coat/${process.env.npm_package_version ?? "0.1.0"} (kelpie)` } });
  if (!res.ok) throw new Error(`e621 ${res.status}`);
  const body = (await res.json()) as { posts?: Array<{ file?: { url?: string; ext?: string }; score?: { total?: number } }> };
  const post = body.posts?.find((p) => p.file?.url && p.file.ext !== "webm");
  if (!post?.file?.url) throw new Error("no usable e621 post (bad tags/rating?)");
  const ext = extname(new URL(post.file.url).pathname) || `.${post.file.ext ?? "jpg"}`;
  const safe = new URL(post.file.url).pathname.split("/").pop()?.replace(/[^\w.\-]+/g, "_") || `wall-${Date.now()}`;
  const name = `${new Date().toISOString().slice(0, 10)}-${safe}`;
  const out = join(WALLS_DIR, name);
  const img = await fetch(post.file.url, { headers: { "User-Agent": `coat/${process.env.npm_package_version ?? "0.1.0"} (kelpie)` } });
  if (!img.ok) throw new Error(`e621 asset ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  writeFileSync(out, buf);
  log("fetched", { score: post.score?.total, file: name, bytes: buf.length });
  return out;
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

async function rotateWall() {
  try {
    mkdirSync(WALLS_DIR, { recursive: true });
    let setWall: (p: string) => Promise<unknown> = async () => {};
    const before = new Set(existsSync(WALLS_DIR) ? readdirSync(WALLS_DIR) : []);
    let fetched: string | null = null;

    if (IS_WIN) {
      // Native lane: no bash/ww dependency. Fetch + set via Win32 SPI.
      fetched = await fetchE621Wall();
      setWall = (p: string) => setWallWindows(p, { style: "Fill" });
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
    if (p === "/status") return Response.json({ ...state, port: PORT, cron: ROTATE_CRON, archive: ARCHIVE });
    if (p === "/rotate" && req.method === "POST") return rotateWall().then((r) => Response.json(r, { status: r.ok ? 200 : 500 }));
    return new Response("coat — the kelpie's fur. try /status, POST /rotate", { status: 404 });
  },
});

if (!process.env.COAT_NO_CRON) {
  new Cron(ROTATE_CRON, { name: "e621-rotate" }, () => void rotateWall());
  log("cron scheduled", ROTATE_CRON);
}
log(`coat up: http://127.0.0.1:${PORT} (the wallpaper lane)`);
