/**
 * coat Electron shell — the wallpaper lane as a hidden-console Windows app.
 *
 * The coat bun daemon (:25240) is spawned as a detached child with
 * `windowsHide` so NO console window ever appears. A hidden BrowserWindow gives
 * the app a tray + lifecycle, and a native Tray exposes the same actions the
 * PowerShell tray did (rotate, auto-rotate interval, tags, save-to-history,
 * open archive). Auto-launches at login.
 */
const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain } = require("electron");
const { spawn, execFile, execSync } = require("child_process");
const { join } = require("path");
const { existsSync } = require("fs");
const http = require("http");
const fs = require("fs");

const PORT = Number(process.env.COAT_PORT ?? 25240);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Locate the coat daemon source. In dev that's ../../ from electron/ (the coat
 * checkout). In a packaged build it's under process.resourcesPath/app.asar if we
 * bundle src/ via extraResources, else fall back to the dev checkout path.
 */
function resolveCoatDir() {
  if (process.env.COAT_DIR && existsSync(process.env.COAT_DIR)) return process.env.COAT_DIR;
  const dev = join(__dirname, ".."); // electron/ .. = the coat checkout root
  if (existsSync(join(dev, "src", "index.ts"))) return dev;
  const bundled = app.isPackaged ? join(process.resourcesPath, "daemon") : join(__dirname, "..", "daemon");
  if (existsSync(join(bundled, "src", "index.ts"))) return bundled;
  return dev; // best effort
}
const COAT_DIR = resolveCoatDir();

/**
 * Resolve the REAL bun.exe to an absolute path. Spawning the bare name "bun" is
 * a bug on Windows: it can hit a .cmd/.bat PATHEXT shim, which Electron then
 * spawns THROUGH cmd.exe — leaking a console/terminal window. Always return a
 * concrete absolute .exe so the daemon is spawned directly with a hidden console.
 */
function resolveBun() {
  const cands = [
    process.env.BUN_PATH,
    join(process.env.USERPROFILE || "", ".bun", "bin", "bun.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\bun.exe",
    "C:\\ProgramData\\chocolatey\\lib\\bun\\tools\\bun-windows-x64\\bun.exe",
    join(process.env.LOCALAPPDATA || "", "bun", "bun.exe"),
  ].filter(Boolean);
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  // Last resort: resolve on PATH but drop any non-.exe (cmd/bat shim) hit.
  const onPath = require("child_process").execFileSync("where", ["bun"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/);
  const exe = (onPath || []).find((p) => /\.exe$/i.test(p.trim()));
  if (exe) return exe.trim();
  throw new Error("bun executable not found — coat cannot start its daemon");
}

/** Simple JSON GET/POST to the coat daemon. */
function coat(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method, headers: data ? { "Content-Type": "application/json" } : {} },
      (res) => {
        let acc = "";
        res.on("data", (d) => (acc += d));
        res.on("end", () => {
          try { resolve({ ok: res.statusCode < 400, data: JSON.parse(acc) }); }
          catch { resolve({ ok: res.statusCode < 400, data: acc }); }
        });
      },
    );
    req.on("error", () => resolve({ ok: false, data: null }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, data: null }); });
    if (data) req.write(data);
    req.end();
  });
}

let daemon; // the hidden bun child

/**
 * Spawn the coat daemon directly, with NO visible console. Electron is a
 * GUI-subsystem process, so `windowsHide: true` (libuv -> CREATE_NO_WINDOW,
 * 0x08000000) is the whole story: the console-subsystem bun child owns a hidden
 * windowless console and never shows a window. No cmd.exe/PowerShell/.bat
 * indirection — Electron spawns bun itself.
 */
function ensureDaemon() {
  if (daemon && !daemon.killed) return;
  daemon = spawn(resolveBun(), ["run", "src/index.ts"], {
    cwd: resolveCoatDir(),
    windowsHide: true,          // libuv -> CREATE_NO_WINDOW: hidden windowless console
    detached: true,             // independent of Electron's lifecycle
    stdio: "ignore",
    env: { ...process.env, COAT_PORT: String(PORT) },
  });
  daemon.unref();
}

let tray = null;

function notify(title, text) {
  if (tray) tray.displayBalloon({ title, content: text });
}

async function doRotate() {
  const r = await coat("POST", "/rotate");
  notify("coat · rotated", r.ok && r.data?.wall ? `wall: ${r.data.wall.split(/[\\/]/).pop()}` : (r.data?.error || "rotate failed"));
}

async function setInterval(hours) {
  const r = await coat("POST", "/interval", { hours });
  if (r.ok) notify("coat · auto-rotate", `every ${r.data?.intervalHours} hour(s)`);
  else notify("coat · auto-rotate", "failed");
}

let guiWin = null; // the single control-panel window

function showGUI(focus = true) {
  if (guiWin && !guiWin.isDestroyed()) {
    if (focus) guiWin.focus();
    return;
  }
  guiWin = new BrowserWindow({
    width: 560, height: 560, show: false, resizable: true,
    icon: app.isPackaged ? join(process.resourcesPath, "icon.png") : join(__dirname, "..", "..", "electron", "icon.png"),
    backgroundColor: "#1a121c",
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, "preload.js") },
  });
  guiWin.loadFile(join(__dirname, "gui", "index.html"));
  guiWin.once("ready-to-show", () => guiWin.show());
  guiWin.on("closed", () => (guiWin = null));
}

// IPC: every action calls the daemon over HTTP (no shell, no console).
ipcMain.handle("coat:status", () => coat("GET", "/status"));
ipcMain.handle("coat:rotate", () => coat("POST", "/rotate").then(r => { broadcastChanged(); return r; }));
ipcMain.handle("coat:save", () => coat("POST", "/save").then(r => { broadcastChanged(); return r; }));
ipcMain.handle("coat:interval", (_e, hours) => coat("POST", "/interval", { hours }).then(r => { broadcastChanged(); return r; }));
ipcMain.handle("coat:tags", () => coat("GET", "/tags"));
ipcMain.handle("coat:tags:set", (_e, tags) => coat("POST", "/tags", { tags }).then(r => { broadcastChanged(); return r; }));
ipcMain.handle("coat:open", async () => { const s = await coat("GET", "/status"); if (s.ok && s.data?.archive) execFile("explorer.exe", [s.data.archive]); return { ok: true }; });
ipcMain.handle("coat:history", (_e, limit = 50) => coat("GET", `/history?limit=${limit}`));
ipcMain.handle("coat:restore", (_e, id) => coat("POST", `/history/${id}/restore`).then((r) => { broadcastChanged(); return r; }));
ipcMain.handle("coat:search", (_e, q, limit = 24) => coat("POST", "/search", { q, limit }));
ipcMain.handle("coat:wall-from-search", (_e, result) => coat("POST", "/wall/from-search", result).then((r) => { broadcastChanged(); return r; }));
ipcMain.handle("coat:pan", (_e, x, y) => coat("POST", "/pan", { x, y }).then((r) => { broadcastChanged(); return r; }));

function broadcastChanged() {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("coat:msg", { type: "changed" });
}

/** DEV hot-reload (COAT_DEV=1): reload the GUI + restart the daemon on file edits. */
async function enableHotReload() {
  if (process.env.COAT_DEV !== "1") return;
  const { default: chokidar } = await import("chokidar"); // v4+ is ESM-only
  const guiWatcher = chokidar.watch([join(__dirname, "gui"), join(__dirname, "preload.js")], { ignoreInitial: true });
  guiWatcher.on("change", () => {
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.reload(); }
    console.log("[coat-dev] gui reloaded");
  });
  const srcWatcher = chokidar.watch(join(resolveCoatDir(), "src"), { ignoreInitial: true });
  srcWatcher.on("change", () => {
    if (daemon && !daemon.killed) { try { daemon.kill(); } catch {} }
    daemon = null;
    setTimeout(ensureDaemon, 300);
    console.log("[coat-dev] daemon restarted");
  });
}

/**
 * Register coat to auto-launch at login, and make sure it actually loads the
 * app when it does.
 *
 * The plain `setLoginItemSettings({ openAtLogin: true })` registers ONLY the
 * executable on Windows — for a dev run that's the bare `node_modules\...\electron.exe`,
 * and at login Electron starts up with no app path and prints:
 *
 *   "coat: electron did not auto load apps on startup
 *    To run a local app, execute ... electron.exe path-to-app"
 *
 * It then exits, so coat never appears. The fix: always pass the app path as an
 * explicit arg (and in dev, point at the binary that owns this app). Two stale
 * Run keys also get cleaned up: a bare `electron.app.Electron` entry and a
 * `electron.app.coat` entry whose `coat.exe` no longer exists.
 */
function registerAutoLaunch() {
  const exe = process.execPath; // dev: node_modules\electron\dist\electron.exe; packaged: coat.exe
  const appDir = app.getAppPath(); // dev: the electron/ dir holding main.js; packaged: inside asar

  // In dev we MUST hand Electron the app path or it boots bare. In a packaged
  // build the exe already embeds the app, so no arg is needed (and an arg would
  // be treated as another app path — wrong).
  const isPackaged = app.isPackaged;
  const args = isPackaged ? [] : [appDir];

  app.setLoginItemSettings({ openAtLogin: true, path: exe, args });

  // Clean up stale/broken counterparts so login doesn't also fire a bare
  // Electron or a phantom coat.exe.
  const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const appId = app.isPackaged ? "coat" : "Electron"; // the registry value name Electron derives
  try {
    // If we're packaged, kill the stale dev Electron entry; if dev, the stale
    // old coat entry whose exe no longer exists.
    const staleName = isPackaged ? "electron.app.Electron" : "electron.app.coat";
    execSync(`reg delete "${runKey}" /v "${staleName}" /f`, { windowsHide: true, stdio: "ignore" });
    console.log(`[coat] removed stale auto-launch key ${staleName}`);
  } catch {
    // not present — fine
  }
  console.log(`[coat] auto-launch: ${exe}${args.length ? " " + JSON.stringify(args) : ""} (${appId})`);
}

function buildTray() {
  const i = new Tray(nativeImage.createEmpty());
  // Bundle icon.png as an extraResource so the tray uses the real generated mark.
  const iconPng = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(__dirname, "..", "..", "electron", "icon.png");
  const trayIcon = fs.existsSync(iconPng)
    ? nativeImage.createFromPath(iconPng).resize({ width: 16, height: 16 })
    : nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMAoGAAAFFwABWv8sXQAAAABJRU5ErkJggg==",
      );
  i.setImage(trayIcon);
  i.setToolTip("coat — the wallpaper lane");

  const intervalItems = [
    { label: "Off", hours: 0 }, { label: "1 hour", hours: 1 }, { label: "3 hours", hours: 3 },
    { label: "6 hours", hours: 6 }, { label: "12 hours", hours: 12 }, { label: "24 hours", hours: 24 },
  ];
  const intervalMenu = Menu.buildFromTemplate([
    { label: "Auto-rotate every", enabled: false },
    ...intervalItems.map((it) => ({
      label: it.label,
      type: "radio",
      click: () => setInterval(it.hours),
    })),
  ]);

  i.setContextMenu(Menu.buildFromTemplate([
    { label: "Open coat control panel", click: () => showGUI() },
    { type: "separator" },
    { label: "Rotate now", click: doRotate },
    { label: "Auto-rotate every…", submenu: intervalMenu },
    { type: "separator" },
    { label: "Save current to history", click: async () => (await coat("POST", "/save")).ok ? notify("coat · saved", "wall added to history") : notify("coat · save", "failed") },
    { label: "Open history folder", click: async () => { const s = await coat("GET", "/status"); if (s.ok && s.data?.archive) execFile("explorer.exe", [s.data.archive]); } },
    { type: "separator" },
    { label: "Restart daemon", click: () => { if (daemon) { try { daemon.kill(); } catch {} } daemon = null; ensureDaemon(); notify("coat · daemon", "restarted"); } },
    { label: "Exit", click: () => app.quit() },
  ]));
  i.on("double-click", () => showGUI());

  tray = i;
  return i;
}

// Single instance — only one tray/daemon.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerAutoLaunch();
    // Don't open a window at boot unless flagged — the tray is the home.
    buildTray();
    ensureDaemon();
    if (process.env.COAT_DEV === "1") { enableHotReload(); showGUI(); } // dev: hot-reload + open panel
    else if (process.env.COAT_OPEN_GUI === "1") showGUI();
  });
  app.on("window-all-closed", () => {
    // Windows: keep running in the tray — do not quit when windows close.
  });
}