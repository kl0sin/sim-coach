# Builds the tests, the tools and the SimHub plugin with the C# compiler that ships with Windows.
# Output: plugin\build\User.SimCoach.dll
param(
    [string]$SimHubDir = 'C:\Program Files (x86)\SimHub',
    [string]$TestDir = (Join-Path $env:TEMP 'simcoach_test')
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $root
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
$dataDir = Join-Path $project 'data'
# sources are UTF-8 without a signature: tell the compiler, or Polish text depends on its guess
$common = '/nologo', '/codepage:65001'
$wpf = "/lib:$fw\WPF", '/r:PresentationCore.dll', '/r:PresentationFramework.dll', '/r:WindowsBase.dll', '/r:System.Xaml.dll'
$coach = "$root\src\Guide.cs", "$root\src\CoachEngine.cs"
$overlay = "$root\src\OverlayPainter.cs", "$root\src\Overlay.cs", "$root\src\Sounds.cs"

New-Item -ItemType Directory -Force (Join-Path $root 'build'), (Join-Path $root 'obj') | Out-Null

# Recorded laps go to <project>\data; the path is baked in at build time.
$config = 'namespace SimCoach { internal static class BuildConfig { public const string DataDir = @"' + $dataDir + '"; } }'
Set-Content -Path (Join-Path $root 'obj\BuildConfig.cs') -Value $config -Encoding UTF8

function Compile([string]$what, [string[]]$arguments) {
    & $csc @common @arguments
    if ($LASTEXITCODE -ne 0) { throw "$what failed to build" }
}

Write-Host '== recorder test =='
Compile 'recorder test' @('/target:exe', "/out:$root\build\RecorderTest.exe", "$root\src\LapRecorder.cs", "$root\test\RecorderTest.cs")
& "$root\build\RecorderTest.exe" $TestDir
if ($LASTEXITCODE -ne 0) { throw 'recorder test failed' }

Write-Host '== tools =='
Compile 'replay tool' @('/target:exe', "/out:$root\build\Replay.exe", "$root\src\LapRecorder.cs", "$root\test\Replay.cs")
Compile 'coach test' (@('/target:exe', "/out:$root\build\CoachTest.exe") + $coach + "$root\test\CoachTest.cs")
Compile 'overlay preview' (@('/target:exe', "/out:$root\build\OverlayPreview.exe") + $wpf + $coach + "$root\src\OverlayPainter.cs" + "$root\test\OverlayPreview.cs")
# (run by hand: it starts Node.js against the real data folder and takes 40 seconds)
Compile 'refresh test' @('/target:exe', "/out:$root\build\RefreshTest.exe", "$root\src\LapRecorder.cs", "$root\src\PlanRefresh.cs", "$root\test\RefreshTest.cs")
Compile 'overlay demo' (@('/target:exe', "/out:$root\build\OverlayDemo.exe") + $wpf + $coach + $overlay + "$root\src\LapRecorder.cs" + "$root\test\OverlayDemo.cs")

Compile 'sound check' (@('/target:exe', "/out:$root\build\SoundCheck.exe") + $wpf + $coach + $overlay + "$root\src\LapRecorder.cs" + "$root\test\SoundCheck.cs")
& "$root\build\SoundCheck.exe"
if ($LASTEXITCODE -ne 0) { throw 'sound check failed' }

Write-Host '== plugin =='
Compile 'plugin' (@('/target:library', '/optimize+', "/out:$root\build\User.SimCoach.dll", "/lib:$SimHubDir",
    '/r:SimHub.Plugins.dll', '/r:GameReaderCommon.dll', '/r:ACSharedMemory.dll') + $wpf + $coach + $overlay +
    "$root\src\LapRecorder.cs" + "$root\src\EvoRaw.cs" + "$root\src\PlanRefresh.cs" + "$root\src\SimCoachPlugin.cs" + "$root\obj\BuildConfig.cs")
Write-Host "built $root\build\User.SimCoach.dll"
