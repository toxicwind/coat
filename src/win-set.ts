/**
 * win-set.ts — coat's native Windows wallpaper setter.
 *
 * Mirrors the Win32 contract used by the vendored `wallchanger` fork
 * (SystemParametersInfo SPI_SETDESKWALLPAPER + Control Panel\Desktop
 * style/tile registry), but as a zero-compile call so the daemon can set a
 * freshly-fetched wall immediately on POST /rotate without building the C#.
 *
 * Style values match Windows:
 *   "Fill"  -> 10, "Fit" -> 6, "Stretch" -> 2, "Tile" -> 1, "Center" -> 0, "Span" -> 22
 *
 * Backgrounds set via SPI with an absolute .jpg/.png/.bmp path stick for the
 * current session/user. We write the PS to a .ps1 file and run `-File` because
 * `powershell -Command` strips $variables on this host.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STYLES: Record<string, string> = {
  Fill: "10",
  Fit: "6",
  Stretch: "2",
  Tile: "1",
  Center: "0",
  Span: "22",
};

export type WallStyle = keyof typeof STYLES;

interface WinSetOpts {
  /** WallpaperStyle registry value name ("Fill", "Fit", "Stretch", "Tile", "Center", "Span"). */
  style?: WallStyle;
  /** If true, wallpaper may exceed monitor bounds (Span) when style is Fit/Fill. */
  span?: boolean;
  /** Timeout for the child powershell, ms. */
  timeoutMs?: number;
}

const SCRIPT = (path: string, style: string) => `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CW {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
$path = [System.IO.Path]::GetFullPath($env:COAT_WALL)
try {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Control Panel\\Desktop', $true)
  if ($key) {
    $real = if ($env:COAT_STYLE) { $env:COAT_STYLE } else { '10' }
    $key.SetValue('WallpaperStyle', $real, [Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('TileWallpaper', '0', [Microsoft.Win32.RegistryValueKind]::String)
    $key.Close()
  }
} catch { }
$r = [CW]::SystemParametersInfo(0x0014, 0, $path, 0x01 -bor 0x02)
if ($r -eq 0) { throw "SystemParametersInfo failed (SetLastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
Write-Output "OK:$path"
`;

/**
 * Set the Windows desktop wallpaper to an absolute image path.
 * Resolves on Windows only; throws on other platforms.
 *
 * @returns the resolved set path
 */
export function setWallWindows(wallPath: string, opts?: WinSetOpts): Promise<string> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error(`setWallWindows is Windows-only (platform=${process.platform})`));
  }
  const full = wallPath; // caller passes absolute
  if (!existsSync(full)) return Promise.reject(new Error(`wall not found: ${full}`));
  const style = STYLES[opts?.style ?? "Fill"] ?? "10";
  const timeoutMs = opts?.timeoutMs ?? 20_000;

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const dir = mkdtempSync(join(tmpdir(), "coat-win-"));
  const ps = join(dir, "set.ps1");
  writeFileSync(ps, SCRIPT(full, style), "utf8");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps],
    { env: { ...process.env, COAT_WALL: full, COAT_STYLE: style }, windowsHide: true },
  );

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));

  const timer = setTimeout(() => child.kill(), timeoutMs);

  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  child.on("error", (e) => {
    clearTimeout(timer);
    cleanup();
    reject(e);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    cleanup();
    if (code === 0 && /^OK:/m.test(out)) return resolve(out.trim());
    reject(new Error(`setWallWindows failed (rc=${code}): ${err.trim() || out.trim()}`));
  });

  return promise;
}