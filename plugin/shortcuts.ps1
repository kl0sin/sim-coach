# Puts a SimCoach shortcut on the desktop and in the Start menu. Both start plugin\build\SimCoach.exe,
# which opens the app in a window of its own.
#   shortcuts.ps1            create or refresh the shortcuts
#   shortcuts.ps1 -Remove    take them away
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'build\SimCoach.exe'
$places = [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')

if ($Remove) {
    foreach ($place in $places) {
        $link = Join-Path $place 'SimCoach.lnk'
        if (Test-Path $link) { Remove-Item $link; Write-Host "Removed $link" }
    }
    exit 0
}

if (-not (Test-Path $exe)) { throw 'The launcher has not been built yet: run plugin\build.ps1 first.' }
$shell = New-Object -ComObject WScript.Shell
foreach ($place in $places) {
    $link = $shell.CreateShortcut((Join-Path $place 'SimCoach.lnk'))
    $link.TargetPath = $exe
    $link.WorkingDirectory = Split-Path -Parent $root
    $link.IconLocation = "$exe,0"
    $link.Description = 'SimCoach: lap analysis and coaching plan'
    $link.Save()
}
Write-Host 'SimCoach shortcuts are on the desktop and in the Start menu.'
