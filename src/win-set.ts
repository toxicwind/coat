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
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

/**
 * Read a PNG/JPEG/WebP/BMP if only its width/height by parsing the header —
 * zero dependencies, sub-millisecond. Returns {w,h} or null.
 */
export function imageDimensions(path: string): { w: number; h: number } | null {
  try {
    const buf = readFileSync(path);
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG (scan SOF0/SOF2 markers)
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      }
    }
    // BMP
    if (buf[0] === 0x42 && buf[1] === 0x4d) {
      return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
    }
    return null;
  } catch {
    return null;
  }
}

export interface WallFit {
  style: WallStyle;
  /** TileWallpaper registry value ('0' / '1'); tile only used for Center. */
  tile: "0" | "1";
}

/**
 * Pick the correct Windows scaling for a wall on the (single) monitor:
 *  - genuinely small art (<75% of monitor on both axes) -> CENTRE at native size
 *    (no ugly upscaling; the art sits pixel-for-pixel in the middle).
 *  - portrait / very tall post                         -> FIT (contain, whole art
 *    visible, centred with side bars — never cropped).
 *  - otherwise (landscape/square, big enough)          -> FILL (cover, fills the
 *    whole screen; only the small aspect difference is cropped).
 * Returns {style, tile}. Falls back to {Fill,'0'} when dimensions unknown.
 */
export function pickFitStyle(imgW: number, imgH: number, monW = 0, monH = 0): WallFit {
  if (!imgW || !imgH || !monW || !monH) return { style: "Fill", tile: "0" };
  // Genuinely small (<75% of monitor on both axes): native-size CENTRE, no upscale.
  if (imgW < monW * 0.75 && imgH < monH * 0.75) return { style: "Center", tile: "0" };
  // Portrait / very tall post that would crop heavily when filled -> FIT (contain):
  // whole art visible, centred with side bars.
  if (imgH > imgW && imgH >= monH) return { style: "Fit", tile: "0" };
  // Otherwise (landscape or square, big enough) -> FILL (cover): crop the small
  // aspect difference and fill the whole screen. Handles 1920x1080/2560x1600 etc.
  return { style: "Fill", tile: "0" };
}

export type PanAxis = "left" | "center" | "right" | "top" | "bottom";

interface WinSetOpts {
  /** WallpaperStyle registry value name ("Fill", "Fit", "Stretch", "Tile", "Center", "Span"). */
  style?: WallStyle;
  /** TileWallpaper registry value ('0' off, '1' on). Useful with Center. */
  tile?: boolean;
  /** If true, wallpaper may exceed monitor bounds (Span) when style is Fit/Fill. */
  span?: boolean;
  /** Target aspect ratio W/H to CROP the image to (server-side) before setting.
   *  When set, the image is cover-cropped to exactly this aspect using `pan`,
   *  so Windows "Fill" has nothing left to crop and the result is predictable. */
  cropToAspect?: number;
  /** Pan within the crop: x in left|center|right, y in top|center|bottom. */
  pan?: { x: PanAxis; y: PanAxis };
  /** Timeout for the child powershell, ms. */
  timeoutMs?: number;
}

const SCRIPT = () => `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CW {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
$path = [System.IO.Path]::GetFullPath($env:COAT_WALL)
$wallDir = [System.IO.Path]::GetDirectoryName($path)
$tmp = [System.IO.Path]::Combine($wallDir, "current-wall.bmp")
try {
  $img = [System.Drawing.Image]::FromFile($path)
  $tgtAspect = $null
  if ($env:COAT_ASPECT) { [double]$tgtAspect = [double]::Parse($env:COAT_ASPECT, [Globalization.CultureInfo]::InvariantCulture) }
  if ($tgtAspect -gt 0) {
    # Cover-crop the source to exactly the target aspect, honoring pan.
    $sw = $img.Width; $sh = $img.Height
    $srcAspect = [double]$sw / [double]$sh
    $cropW = 0; $cropH = 0
    if ([Math]::Abs($srcAspect - $tgtAspect) -lt 0.0001) { $cropW = $sw; $cropH = $sh }
    elseif ($srcAspect -gt $tgtAspect) { $cropH = $sh; $cropW = [int][Math]::Floor($sh * $tgtAspect) }
    else { $cropW = $sw; $cropH = [int][Math]::Floor($sw / $tgtAspect) }
    $px = if ($env:COAT_PAN_X -eq 'left') { 0 } elseif ($env:COAT_PAN_X -eq 'right') { $sw - $cropW } else { [int](($sw - $cropW) / 2) }
    $py = if ($env:COAT_PAN_Y -eq 'top') { 0 } elseif ($env:COAT_PAN_Y -eq 'bottom') { $sh - $cropH } else { [int](($sh - $cropH) / 2) }
    $px = [Math]::Max(0, [Math]::Min($px, $sw - $cropW))
    $py = [Math]::Max(0, [Math]::Min($py, $sh - $cropH))
    $cropRect = New-Object System.Drawing.Rectangle($px, $py, $cropW, $cropH)
    $bmp = New-Object System.Drawing.Bitmap($cropW, $cropH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0,0,$cropW,$cropH)), $cropRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $img.Dispose()
  } else {
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $img
    $img.Dispose()
  }
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
} catch { throw "convert/crop failed: $_" }
try {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Control Panel\\Desktop', $true)
  if ($key) {
    $real = if ($env:COAT_STYLE) { $env:COAT_STYLE } else { '10' }
    $tile = if ($env:COAT_TILE) { $env:COAT_TILE } else { '0' }
    $key.SetValue('WallpaperStyle', $real, [Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('TileWallpaper', $tile, [Microsoft.Win32.RegistryValueKind]::String)
    $key.Close()
  }
} catch { }
$r = [CW]::SystemParametersInfo(0x0014, 0, $tmp, 0x01 -bor 0x02)
if ($r -eq 0) { throw "SystemParametersInfo failed (SetLastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
Write-Output "OK:$path"
`;

/**
 * Read the current Windows desktop wallpaper path (the Wallpaper registry value
 * we set via SPI). Empty string when none or not Windows.
 */
export function getCurrentWallWindows(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = Bun.spawnSync(["reg", "query", `HKCU\\Control Panel\\Desktop`, "/v", "Wallpaper"], { stdout: "pipe" }).stdout.toString();
    const m = out.match(/Wallpaper\s+REG_SZ\s+(.+)\s*$/m);
    const wall = m?.[1]?.trim();
    return wall && existsSync(wall) ? wall : null;
  } catch {
    return null;
  }
}

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
  writeFileSync(ps, SCRIPT(), "utf8");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps],
    {
      env: {
        ...process.env,
        COAT_WALL: full,
        COAT_STYLE: style,
        COAT_TILE: opts?.tile ? "1" : "0",
        COAT_ASPECT: opts?.cropToAspect ? String(opts.cropToAspect) : "",
        COAT_PAN_X: opts?.pan?.x ?? "center",
        COAT_PAN_Y: opts?.pan?.y ?? "center",
      },
      windowsHide: true,
    },
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