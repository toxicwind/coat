// dev.mjs — live hot-reload dev runner: starts the bun daemon and the Electron
// GUI together. COAT_DEV=1 makes main.js watch gui/* (reload window) and src/*
// (restart daemon) on edit. No cross-env/concurrently needed.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = join(fileURLToPath(import.meta.url), "..");
process.env.COAT_DEV = "1";
process.env.COAT_PORT = process.env.COAT_PORT || "25240";

const daemon = spawn(process.env.BUN_PATH || "bun", ["run", "src/index.ts"], {
  cwd: join(__dirname, ".."),
  stdio: "inherit",
});
daemon.on("exit", (c) => console.log("[coat-dev] daemon exited", c));

const electronBin = process.env.ELECTRON_PATH || require("electron");
const gui = spawn(electronBin, ["."], { cwd: __dirname, stdio: "inherit", env: process.env });
gui.on("exit", (c) => { console.log("[coat-dev] gui exited", c); process.exit(0); });

function shutdown() { try { daemon.kill(); } catch {} try { gui.kill(); } catch {} process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);