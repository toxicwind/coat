# coat — the kelpie's fur

coat is the wallpaper lane of the estate. Every surface of the desktop is its fur:
**e621 wallpaper rotation**, **palette grooming**, and a **byte-perfect wall archive**.
One daemon, the look of the box.

HTTP daemon on `:25240`:

```
GET  /status            daemon + last-wall state
POST /rotate            rotate the wall now
```

## Rotation lanes

coat auto-detects the platform and picks a lane:

| Platform | Provice fetch | How it sets the wallpaper |
|----------|---------------|---------------------------|
| **Linux** | `pens/kelpie/products/ww` bash script (`random_e621_wall.sh`) | the ww pipeline sets via quickshell |
| **Windows** | native e621 JSON API (bun `fetch`, no bash) | Win32 `SystemParametersInfo` via `src/win-set.ts` |

On both lanes the freshly-downloaded wall lands in `~/Wallpapers`, is copied into
the `pens/kelpie/docs/wallpaper-archive` with a timestamped name, and the state is
persisted (`~/.local/state/coat/state.json`).

## Windows: persistent rotation with the vendored rotator

`coat/wallchanger` is the forked **Wallpaper Slideshow** C# / .NET 10 tray app
(`toxicwind/wallchanger`, upstream `osmanonurkoc/wallchanger`). It is the
**persistent** Windows lane: coat fills `~/Wallpapers` each rotate, and wallchanger
cycles that folder on an interval so the desktop keeps moving between coat runs.

Build / launch:

```bat
scripts\wallchanger.cmd build   :: dotnet publish WallpaperSlideshow.exe (self-contained win-x64)
scripts\wallchanger.cmd run     :: build if missing, then start the tray rotator
```

> Requires the **.NET 10 Desktop SDK** (`dotnet publish`). coat's *immediate* rotation
> (fetch + set via the native TS setter) has **no** dotnet dependency — only the
> optional persistent tray cycler needs it. Grab it from
> <https://dotnet.microsoft.com/download/dotnet/10.0>.

coat keeps `%LocalAppData%\WallpaperSlideshow\config.json` pointed at
`%USERPROFILE%\Wallpapers` (see `syncWallchangerConfig()` in `src/index.ts`).

### Why a fork

The upstream rotator has no e621 / custom-API source — it only cycles a folder.
coat is the source of walls; the fork is the (native, 15 MB) set-and-forget desktop
cycler. Keeping it as a Git submodule pins the build we tested against; diverge the
fork under `toxicwind/wallchanger` when you need the rotator itself to grow.

## Config (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `COAT_PORT` | `25240` | HTTP daemon port |
| `COAT_ROTATE_CRON` | `0 21 * * *` | cron schedule for auto-rotate |
| `COAT_E621_TAGS` | `male score:>80 -sexual -gore -comic` | e621 search (Windows lane) |
| `COAT_E621_MIN_SCORE` | `80` | minimum score filter (Windows lane) |
| `COAT_WALLCHANGER_MIN` | `30` | wallchanger rotation interval (minutes) |
| `COAT_NO_CRON` | — | set to skip scheduling the cron |

## Dev

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run rotate      # rotate once
bun run start       # daemon + cron
```

## License

MIT