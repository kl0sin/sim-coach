# Puts the built plugin into SimHub: closes SimHub, copies the DLL, starts SimHub again.
# Refuses while the game is running, because closing SimHub then would cut the recording.
param([string]$SimHubDir = 'C:\Program Files (x86)\SimHub')
$ErrorActionPreference = 'Stop'
$dll = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'build\User.SimCoach.dll'
if (-not (Test-Path $dll)) { throw 'The plugin has not been built yet: run plugin\build.ps1 first.' }
if (Get-Process AssettoCorsaEVO, 'Le Mans Ultimate' -ErrorAction SilentlyContinue) { Write-Host 'The game is running. Close it and try again.'; exit 1 }

$running = Get-Process SimHubWPF -ErrorAction SilentlyContinue
if ($running) {
    $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    for ($i = 0; $i -lt 40 -and (Get-Process SimHubWPF -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    if (Get-Process SimHubWPF -ErrorAction SilentlyContinue) { Write-Host 'SimHub did not close. Close it by hand and try again.'; exit 1 }
}
Copy-Item $dll (Join-Path $SimHubDir 'User.SimCoach.dll') -Force
# through Explorer, so SimHub does not belong to the window this script was started from
Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $SimHubDir 'SimHubWPF.exe') + '"')
Write-Host 'Plugin installed, SimHub started again.'
