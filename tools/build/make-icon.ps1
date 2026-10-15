$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../desktop/assets'))
[xml]$source = Get-Content -LiteralPath (Join-Path $assetDirectory 'icon.svg') -Raw
Copy-Item -LiteralPath (Join-Path $assetDirectory 'icon.svg') -Destination (Join-Path $PSScriptRoot '../../src/ui/icon.svg') -Force

# The SVG master uses filled M/L/C/Z paths, so Windows icons and UI share one drawing.
function ConvertTo-DrawingPath([string]$data) {
  $tokens = [regex]::Matches($data, '[MLCZ]|-?\d+(?:\.\d+)?') | ForEach-Object { $_.Value }
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $x = 0.0; $y = 0.0; $i = 0
  while ($i -lt $tokens.Count) {
    $command = $tokens[$i]; $i++
    switch ($command) {
      'M' { $x = [single]$tokens[$i]; $y = [single]$tokens[$i + 1]; $i += 2; $shape.StartFigure() }
      'L' {
        $nextX = [single]$tokens[$i]; $nextY = [single]$tokens[$i + 1]; $i += 2
        $shape.AddLine([single]$x, [single]$y, $nextX, $nextY); $x = $nextX; $y = $nextY
      }
      'C' {
        $shape.AddBezier([single]$x, [single]$y, [single]$tokens[$i], [single]$tokens[$i + 1], [single]$tokens[$i + 2], [single]$tokens[$i + 3], [single]$tokens[$i + 4], [single]$tokens[$i + 5])
        $x = [single]$tokens[$i + 4]; $y = [single]$tokens[$i + 5]; $i += 6
      }
      'Z' { $shape.CloseFigure() }
      default { throw "Unsupported SVG command: $command" }
    }
  }
  return ,$shape
}

$images = @()
foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
  $scale = 4
  $canvas = New-Object System.Drawing.Bitmap ($size * $scale), ($size * $scale)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.ScaleTransform(($size * $scale / 256.0), ($size * $scale / 256.0))
  foreach ($element in $source.svg.path) {
    if ($size -le 32 -and $element.'data-detail' -eq 'true') { continue }
    $shape = ConvertTo-DrawingPath $element.d
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($element.fill))
    $graphics.FillPath($brush, $shape)
    $brush.Dispose(); $shape.Dispose()
  }
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $resample = [System.Drawing.Graphics]::FromImage($bitmap)
  $resample.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resample.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $resample.DrawImage($canvas, 0, 0, $size, $size)
  $memory = New-Object System.IO.MemoryStream
  $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $memory.ToArray()
  $images += @{ Size = $size; Bytes = $bytes }
  if ($size -eq 256) { [System.IO.File]::WriteAllBytes((Join-Path $assetDirectory 'icon.png'), $bytes) }
  $memory.Dispose(); $resample.Dispose(); $bitmap.Dispose(); $graphics.Dispose(); $canvas.Dispose()
}
$icoStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $icoStream
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($entry in $images) {
  $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
  $offset += $entry.Bytes.Length
}
foreach ($entry in $images) { $writer.Write([byte[]]$entry.Bytes) }
[System.IO.File]::WriteAllBytes((Join-Path $assetDirectory 'icon.ico'), $icoStream.ToArray())
$writer.Dispose(); $icoStream.Dispose()
Write-Output 'Course archive icon generated: 16/20/24/32/40/48/64/128/256 px'
