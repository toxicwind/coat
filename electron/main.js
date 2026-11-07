/**
 * coat Electron shell — the wallpaper lane as a hidden-console Windows app.
 *
 * The coat bun daemon (:25240) is spawned as a detached child with
 * `windowsHide` so NO console window ever appears. A hidden BrowserWindow gives
 * the app a tray + lifecycle, and a native Tray exposes the same actions the
 * PowerShell tray did (rotate, auto-rotate interval, tags, save-to-history,
 * open archive). Auto-launches at login.
 */
const { app, Tray, Menu, BrowserWindow, nativeImage, dialog } = require("electron");
const { spawn } = require("child_process");
const { join, dirname } = require("path");
const { existsSync } = require("fs");
const os = require("os");
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
  const dev = join(__dirname, "..", ".."); // electron/ ../ .. = coat checkout
  if (existsSync(join(dev, "src", "index.ts"))) return dev;
  const bundled = app.isPackaged ? join(process.resourcesPath, "daemon") : join(__dirname, "..", "daemon");
  if (existsSync(join(bundled, "src", "index.ts"))) return bundled;
  return dev; // best effort
}
const COAT_DIR = resolveCoatDir();

/** Resolve the bun executable (PATH first, then common installs). */
function resolveBun() {
  if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH;
  const cands = [
    "bun",
    join(process.env.USERPROFILE || "", ".bun", "bin", "bun.exe"),
    join(process.env.LOCALAPPDATA || "", "bun", "bun.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\bun.exe",
  ];
  return cands.find((c) => c === "bun" || existsSync(c)) || "bun";
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

function ensureDaemon() {
  if (daemon && !daemon.killed) return;
  const bunPath = resolveBun();
  daemon = spawn(bunPath, ["run", "src/index.ts"], {
    cwd: resolveCoatDir(),
    windowsHide: true,          // no console window for the daemon
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

async function openTags() {
  const cur = (await coat("GET", "/tags")).data?.tags ?? "";
  const win = new BrowserWindow({
    width: 480, height: 210, show: false, resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }, // trusted local prompt
  });
  win.loadURL("data:text/html," + encodeURIComponent(tagPromptHtml(cur)));
  win.once("ready-to-show", () => win.show());
  win.setMenuBarVisibility(false);
}

function tagPromptHtml(current) {
  return `<!doctype html><html><body style="font-family:Segoe UI;padding:16px">
    <h3 style="margin-top:0">e621 tags (search syntax)</h3>
    <input id="t" style="width:100%;padding:6px;font-size:14px" value="${escapeHtml(current)}"/>
    <div style="margin-top:12px"><button onclick="send()">Set & Rotate</button>
    <button onclick="sendCancel()">Cancel</button></div>
    <script>const {ipcRenderer}=require('electron');
      function send(){ipcRenderer.send('tags-ok',document.getElementById('t').value);window.close();}
      function sendCancel(){ipcRenderer.send('tags-cancel');window.close();}
    </script></body></html>`;
}
function escapeHtml(s){return (s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");}

function buildTray() {
  const i = new Tray(nativeImage.createEmpty());
  // Use the app icon if available, else a generated dot.
  const iconPath = join(__dirname, "..", "icon.ico");
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMAoGAAAFFwABWv8sXQAAAABJRU5ErkJggg==",
  );
  i.setImage(icon);
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
    { label: "Rotate now", click: doRotate },
    { label: "Auto-rotate every…", submenu: intervalMenu },
    { type: "separator" },
    { label: "Search / set tags…", click: openTags },
    { label: "Save current to history", click: async () => (await coat("POST", "/save")).ok ? notify("coat · saved", "wall added to history") : notify("coat · save", "failed") },
    { label: "Open history folder", click: async () => { const s = await coat("GET", "/status"); if (s.ok && s.data?.archive) require("child_process").exec(`explorer "${s.data.archive}"`); } },
    { type: "separator" },
    { label: "Restart daemon", click: () => { if (daemon) { try { daemon.kill(); } catch {} } daemon = null; ensureDaemon(); notify("coat · daemon", "restarted"); } },
    { label: "Exit", click: () => app.quit() },
  ]));

  tray = i;
  return i;
}

// IPC for the tags prompt
const { ipcMain } = require("electron");
ipcMain.on("tags-ok", async (_e, tags) => { if (tags) { await coat("POST", "/tags", { tags }); await doRotate(); } });
ipcMain.on("tags-cancel", () => {});

// Single instance — only one tray/daemon.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let hiddenWin = null; // held so the hidden window isn't GC'd
  app.whenReady().then(() => {
    // Auto-launch at login (replaces the old HKCU Run key).
    app.setLoginItemSettings({ openAtLogin: true });
    // A hidden window gives the app a real handle without showing a console/UI.
    hiddenWin = new BrowserWindow({ width: 1, height: 1, show: false });
    buildTray();
    ensureDaemon();
    // Keep the daemon alive if the tray is closed on shutdown.
    app.on("before-quit", () => { if (daemon && !daemon.killed) daemon.unref(); });
  });
  app.on("window-all-closed", () => {
    // Windows: keep running in the tray — do not quit when windows close.
  });
  app.on("activate", () => { /* macOS convention, not used on Windows */ });
}