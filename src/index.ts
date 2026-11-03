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
import { join } from "node:path";

const PORT = Number(process.env.COAT_PORT ?? 25240);
const HOME = process.env.HOME ?? "";
const WW = join(HOME, "pens/kelpie/products/ww");
const E621_SCRIPT = join(WW, "dots/.config/quickshell/ww/scripts/colors/random/random_e621_wall.sh");
const ARCHIVE = join(HOME, "pens/kelpie/docs/wallpaper-archive");
const STATE = join(HOME, ".local/state/coat");
const ROTATE_CRON = process.env.COAT_ROTATE_CRON ?? "0 21 * * *";

mkdirSync(ARCHIVE, { recursive: true });
mkdirSync(STATE, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[coat]", ...a);

interface CoatState { lastRotate: string | null; lastWall: string | null; rotates: number; lastError: string | null }
const statePath = join(STATE, "state.json");
const state: CoatState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { lastRotate: null, lastWall: null, rotates: 0, lastError: null };
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

async function rotateWall() {
  try {
    const wallsDir = join(HOME, "Wallpapers");
    const before = new Set(existsSync(wallsDir) ? readdirSync(wallsDir) : []);
    const proc = Bun.spawn(["bash", E621_SCRIPT], { stdout: "pipe", stderr: "pipe", env: { ...process.env, QUICKSHELL_CONFIG_NAME: "ww" } });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) { state.lastError = err.slice(0, 300); persist(); return { ok: false, error: state.lastError }; }
    const after = readdirSync(wallsDir).filter((f) => !before.has(f));
    const newest = after.sort().pop();
    if (newest) {
      const src = join(wallsDir, newest);
      if (existsSync(src)) copyFileSync(src, join(ARCHIVE, `${new Date().toISOString().slice(0, 10)}-${newest}`));
      state.lastWall = src;
    }
    state.lastRotate = new Date().toISOString();
    state.rotates += 1;
    state.lastError = null;
    persist();
    log("rotated", { wall: state.lastWall, rotates: state.rotates });
    return { ok: true, wall: state.lastWall };
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
