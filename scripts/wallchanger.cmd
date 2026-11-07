@echo off
REM wallchanger.cmd - build + launch the vendored Windows wallpaper rotator
REM (the toxicwind/wallchanger fork, coat's persistent Windows rotation lane).
REM
REM   wallchanger.cmd build   -> dotnet publish WallpaperSlideshow.exe (win-x64, self-contained)
REM   wallchanger.cmd run     -> build (if exe missing) then launch it in the tray
REM
REM coat (src/index.ts) keeps %LocalAppData%\WallpaperSlideshow\config.json pointed
REM at %USERPROFILE%\Wallpapers, the folder coat fills each rotate. This tray app
REM then cycles that folder on the configured interval.
setlocal

cd /d "%~dp0\..\wallchanger"

set OUT=%~dp0..\dist\WallpaperSlideshow.exe
if not exist "%~dp0..\dist" mkdir "%~dp0..\dist"

if /i "%~1"=="build" goto build
if /i "%~1"=="run" goto run
echo usage: wallchanger.cmd [build^|run]
exit /b 1

:build
echo Publishing WallpaperSlideshow (self-contained win-x64)...
dotnet publish -c Release -r win-x64 ^
    -p:PublishSingleFile=true ^
    -p:SelfContained=true ^
    -o "%~dp0..\dist"
if errorlevel 1 ( echo build failed & exit /b 1 )
echo Built: %OUT%
exit /b 0

:run
if not exist "%OUT%" call :build
start "" "%OUT%"
echo Launching WallpaperSlideshow tray rotator.
exit /b 0