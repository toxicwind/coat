@echo off
REM coat-tray.cmd - launch the Windows tray tool for coat's wallpaper lane
REM   * Rotate now          -> fresh e621 wall (set + archive)
REM   * Save to history     -> snapshot the current desktop wallpaper
REM   * Open history folder -> explore the archived walls
REM   * Restart daemon      -> ensure :25240 daemon is up
REM No dotnet needed; runs the PowerShell NotifyIcon tray.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0coat-tray.ps1"