# Draws the SimCoach mark into app\public\favicon.ico: the icon of the app's window, of
# SimCoach.exe and of its shortcuts. Run it after changing the mark, then build again.
#
# The mark is the letter S as two bends of a track, leaning forward and cut in two like
# sectors on a timing screen. The same drawing is in app\public\index.html (the top bar)
# and in SettingsPanel.Mark (the page in SimHub); keep the three alike.
param(
    [string]$Out,
    [string]$PreviewDir   # optional: also save every size as a PNG here
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase

if (-not $Out) { $Out = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'app\public\favicon.ico' }

function Brush([string]$hex) {
    $b = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
    $b.Freeze(); return $b
}
$tileBrush = Brush '#121215'; $borderBrush = Brush '#3d3d43'; $yellow = Brush '#ffd60a'; $ink = Brush '#edebe6'

# Both drawings live in a 64-unit box. Up to 24 px the strokes are heavier and the letter
# fills the tile, or the cut between the halves closes up.
$large = @{ Width = 11.0; Top = 'M49 14.5H29.5a8.75 8.75 0 0 0 0 17.5H30'; Bottom = 'M34 32H34.5a8.75 8.75 0 0 1 0 17.5H15' }
$small = @{ Width = 13.0; Top = 'M52 12.5H29a9.75 9.75 0 0 0 0 19.5H29.5'; Bottom = 'M34.5 32H35a9.75 9.75 0 0 1 0 19.5H12' }

function Draw([int]$size) {
    $isSmall = $size -le 24
    $shape = if ($isSmall) { $small } else { $large }
    $visual = New-Object System.Windows.Media.DrawingVisual
    $dc = $visual.RenderOpen()

    # the tile, with a hairline once there is room for one
    $radius = [Math]::Max(2.0, $size * 0.19)
    $dc.DrawRoundedRectangle($tileBrush, $null, (New-Object System.Windows.Rect 0, 0, $size, $size), $radius, $radius)
    if ($size -ge 32) {
        $pen = New-Object System.Windows.Media.Pen $borderBrush, ([Math]::Max(1.0, $size / 64.0))
        $half = $pen.Thickness / 2
        $dc.DrawRoundedRectangle($null, $pen, (New-Object System.Windows.Rect $half, $half, ($size - 2 * $half), ($size - 2 * $half)), ($radius - $half), ($radius - $half))
    }

    $pad = if ($isSmall) { 0.0 } else { [Math]::Round($size * 0.10) }
    $k = ($size - 2 * $pad) / 64.0
    $dc.PushTransform((New-Object System.Windows.Media.TranslateTransform $pad, $pad))
    $dc.PushTransform((New-Object System.Windows.Media.ScaleTransform $k, $k))
    # leaning 12 degrees forward around the middle of the box
    $dc.PushTransform((New-Object System.Windows.Media.MatrixTransform 1, 0, -0.212557, 1, 6.8018, 0))
    $dc.DrawGeometry($null, (New-Object System.Windows.Media.Pen $yellow, $shape.Width), [System.Windows.Media.Geometry]::Parse($shape.Top))
    $dc.DrawGeometry($null, (New-Object System.Windows.Media.Pen $ink, $shape.Width), [System.Windows.Media.Geometry]::Parse($shape.Bottom))
    $dc.Pop(); $dc.Pop(); $dc.Pop()
    $dc.Close()

    $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $size, $size, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    return $bitmap
}

function PngBytes($bitmap) {
    $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = New-Object System.IO.MemoryStream
    $encoder.Save($stream)
    return ,$stream.ToArray()
}

# A classic icon image: BITMAPINFOHEADER (height doubled), 32-bit pixels bottom-up, then the AND mask.
function DibBytes($bitmap) {
    $n = $bitmap.PixelWidth
    $straight = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap $bitmap, ([System.Windows.Media.PixelFormats]::Bgra32), $null, 0
    $pixels = New-Object byte[] ($n * $n * 4)
    $straight.CopyPixels($pixels, $n * 4, 0)
    $stream = New-Object System.IO.MemoryStream; $writer = New-Object System.IO.BinaryWriter $stream
    $writer.Write([int]40); $writer.Write([int]$n); $writer.Write([int]($n * 2)); $writer.Write([int16]1); $writer.Write([int16]32)
    for ($i = 0; $i -lt 6; $i++) { $writer.Write([int]0) }
    for ($y = $n - 1; $y -ge 0; $y--) { $writer.Write($pixels, $y * $n * 4, $n * 4) }
    $maskRow = [int]([Math]::Ceiling($n / 32.0) * 4)
    $writer.Write((New-Object byte[] ($maskRow * $n)))
    $writer.Flush()
    return ,$stream.ToArray()
}

$images = @()
foreach ($size in 16, 20, 24, 32, 40, 48, 64, 256) {
    $bitmap = Draw $size
    $png = PngBytes $bitmap
    if ($PreviewDir) { [System.IO.File]::WriteAllBytes((Join-Path $PreviewDir "icon_$size.png"), $png) }
    # 256 px is stored as a PNG, the rest as plain bitmaps, which every reader of .ico understands
    $images += ,@($size, $(if ($size -eq 256) { $png } else { DibBytes $bitmap }))
}

$file = [System.IO.File]::Create($Out); $writer = New-Object System.IO.BinaryWriter $file
$writer.Write([int16]0); $writer.Write([int16]1); $writer.Write([int16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($image in $images) {
    $size = $image[0]; $bytes = $image[1]
    $side = [byte]$(if ($size -eq 256) { 0 } else { $size })
    $writer.Write($side); $writer.Write($side); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([int16]1); $writer.Write([int16]32); $writer.Write([int]$bytes.Length); $writer.Write([int]$offset)
    $offset += $bytes.Length
}
foreach ($image in $images) { $writer.Write([byte[]]$image[1]) }
$writer.Flush(); $file.Close()
Write-Host "written $Out ($((Get-Item $Out).Length) bytes)"
