# coat-tray.ps1 — coat's Windows system-tray tool.
#
# A zero-compile NotifyIcon tray app for the wallpaper lane:
#   * Rotate now          -> POST /rotate   (fresh e621 wall, set + archive)
#   * Save to history     -> POST /save     (snapshot the CURRENT desktop wallpaper)
#   * Open history        -> opens the archive folder
#   * Restart daemon      -> ensures the coat daemon is up on :25240
#   * Exit                -> kill this tray (daemon keeps the cron running)
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/coat-tray.ps1
# (dotnet is NOT required — this is the native tray lane.)

param(
  [int]$Port = 25240,
  [string]$CoatDir = (Join-Path $PSScriptRoot "..")
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Base = "http://127.0.0.1:$Port"

function Invoke-Coat {
  param([string]$Method, [string]$Path)
  try {
    $r = Invoke-RestMethod -Uri "$Base$Path" -Method $Method -TimeoutSec 30
    return $r
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

function Ensure-Daemon {
  try {
    $null = Invoke-RestMethod -Uri "$Base/status" -Method GET -TimeoutSec 3
    return $true
  } catch {
    # daemon down -> start it detached
    $log = Join-Path $env:TEMP "coat-daemon.log"
    # cd into coat dir, run bun; keep it alive past this script's scope
    Start-Process -FilePath "bun" -ArgumentList "run", "src/index.ts" `
      -WorkingDirectory $CoatDir -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    Start-Sleep -Seconds 2
    try { $null = Invoke-RestMethod -Uri "$Base/status" -Method GET -TimeoutSec 3; return $true }
    catch { return $false }
  }
}

# Context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miRotate = New-Object System.Windows.Forms.ToolStripMenuItem("Rotate now")
$miInterval = New-Object System.Windows.Forms.ToolStripMenuItem("Auto-rotate every…")
$miTags   = New-Object System.Windows.Forms.ToolStripMenuItem("Search / set tags…")
$miSave   = New-Object System.Windows.Forms.ToolStripMenuItem("Save current to history")
$miOpen   = New-Object System.Windows.Forms.ToolStripMenuItem("Open history folder")
$miDash   = New-Object System.Windows.Forms.ToolStripMenuItem("Restart daemon")
$miExit   = New-Object System.Windows.Forms.ToolStripMenuItem("Exit")

# Interval submenu — radio-checked 3h/6h/12h (+ Off, 1h, 24h). Selecting posts
# POST /interval to rewire the daemon cron live.
$ivMenu = New-Object System.Windows.Forms.ToolStripMenuItem("Auto-rotate every…")
$ivOff  = New-Object System.Windows.Forms.ToolStripMenuItem("Off")
$iv1h   = New-Object System.Windows.Forms.ToolStripMenuItem("1 hour")
$iv3h   = New-Object System.Windows.Forms.ToolStripMenuItem("3 hours")
$iv6h   = New-Object System.Windows.Forms.ToolStripMenuItem("6 hours")
$iv12h  = New-Object System.Windows.Forms.ToolStripMenuItem("12 hours")
$iv24h  = New-Object System.Windows.Forms.ToolStripMenuItem("24 hours")
$ivMenu.DropDownItems.AddRange(@($ivOff, $iv1h, $iv3h, $iv6h, $iv12h, $iv24h))

$menu.Items.AddRange(@($miRotate, $ivMenu, $miTags, $miSave, $miOpen, $miDash, $miExit))

Add-Type -AssemblyName Microsoft.VisualBasic

function Show-Balloon($title, $text) {
  $n.ShowBalloonTip(2500, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info)
}

function Get-IntervalHours {
  try {
    $s = Invoke-RestMethod -Uri "$Base/status" -Method GET -TimeoutSec 5
    return [int]$s.intervalHours
  } catch { return -1 }
}

function Set-IntervalHours([int]$hours) {
  try {
    $body = @{ hours = $hours } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$Base/interval" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 5
    Show-Balloon "coat · auto-rotate" ("every {0} hour(s)" -f $r.intervalHours)
    return $true
  } catch {
    Show-Balloon "coat · auto-rotate" "failed: $_"
    return $false
  }
}

# Check the current interval so the right radio is selected on open
$curIv = Get-IntervalHours
$ivMap = @{ 0 = $ivOff; 1 = $iv1h; 3 = $iv3h; 6 = $iv6h; 12 = $iv12h; 24 = $iv24h }
if ($ivMap.ContainsKey($curIv)) { $ivMap[$curIv].Checked = $true }

$ivOff.Add_Click({ if (Set-IntervalHours 0) { $ivOff.Checked=$true } })
$iv1h.Add_Click({  if (Set-IntervalHours 1) { $iv1h.Checked=$true } })
$iv3h.Add_Click({  if (Set-IntervalHours 3) { $iv3h.Checked=$true } })
$iv6h.Add_Click({  if (Set-IntervalHours 6) { $iv6h.Checked=$true } })
$iv12h.Add_Click({ if (Set-IntervalHours 12) { $iv12h.Checked=$true } })
$iv24h.Add_Click({ if (Set-IntervalHours 24) { $iv24h.Checked=$true } })

function Get-CurrentTags {
  try {
    $s = Invoke-RestMethod -Uri "$Base/tags" -Method GET -TimeoutSec 5
    return $s.tags
  } catch { return $null }
}

$miRotate.Add_Click({
  $r = Invoke-Coat -Method "POST" -Path "/rotate"
  if ($r.ok) { Show-Balloon "coat · rotated" ("wall: {0}" -f [IO.Path]::GetFileName($r.wall)) }
  else       { Show-Balloon "coat · rotate failed" $r.error }
})

$miTags.Add_Click({
  $current = Get-CurrentTags
  if ($null -eq $current) { Show-Balloon "coat · tags" "daemon not reachable"; return }
  $answer = [Microsoft.VisualBasic.Interaction]::InputBox(
    "Enter tags to search (e621 syntax, e.g. male/male score:>80)." + [Environment]::NewLine + "Blank = just show current.",
    "coat · tags",
    $current)
  if ($null -eq $answer) { return }
  $answer = $answer.Trim()
  if ($answer -eq "") {
    Show-Balloon "coat · tags" "current: $current"
    return
  }
  $r = Invoke-RestMethod -Uri "$Base/tags" -Method POST -ContentType "application/json" -Body (@{ tags = $answer } | ConvertTo-Json) -TimeoutSec 5
  # offer to rotate with the new tags
  $go = [System.Windows.Forms.MessageBox]::Show(
    "Tags set to:`n$($r.tags)`n`nRotate now?", "coat · tags",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($go -eq [System.Windows.Forms.DialogResult]::Yes) {
    $rr = Invoke-Coat -Method "POST" -Path "/rotate"
    if ($rr.ok) { Show-Balloon "coat · rotated" ("wall: {0}" -f [IO.Path]::GetFileName($rr.wall)) }
    else        { Show-Balloon "coat · rotate failed" $rr.error }
  }
})

$miSave.Add_Click({
  $r = Invoke-Coat -Method "POST" -Path "/save"
  if ($r.ok) { Show-Balloon "coat · saved to history" ([IO.Path]::GetFileName($r.archived)) }
  else       { Show-Balloon "coat · save failed" $r.error }
})

$miOpen.Add_Click({
  try {
    $s = Invoke-RestMethod -Uri "$Base/status" -Method GET -TimeoutSec 5
    $arch = $s.archive
    if ($arch -and (Test-Path $arch)) { Start-Process explorer.exe $arch }
    else { Show-Balloon "coat · history" "archive not found: $arch" }
  } catch { Show-Balloon "coat · history" "daemon not reachable" }
})

$miDash.Add_Click({
  if (Ensure-Daemon) { Show-Balloon "coat · daemon" "daemon up on :$Port" }
  else               { Show-Balloon "coat · daemon" "could not start daemon" }
})

$miExit.Add_Click({ $n.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Application
$n.Text = "coat — the wallpaper lane"
$n.ContextMenuStrip = $menu
$n.Visible = $true

Ensure-Daemon | Out-Null

[System.Windows.Forms.Application]::Run()
$n.Dispose()