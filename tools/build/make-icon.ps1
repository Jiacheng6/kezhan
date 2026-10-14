Add-Type -AssemblyName System.Drawing
$assetDirectory = Join-Path $PSScriptRoot '..\..\desktop\assets'
[System.IO.Directory]::CreateDirectory($assetDirectory) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::FromArgb(47, 111, 214))
$font = New-Object System.Drawing.Font 'Microsoft YaHei', 145, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString([string][char]0x5B66, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 256, 250), $format)
$memory = New-Object System.IO.MemoryStream
$bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $memory.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $assetDirectory 'icon.png'), $pngBytes)
$icoStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $icoStream
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$pngBytes.Length)
$writer.Write([uint32]22)
$writer.Write($pngBytes)
[System.IO.File]::WriteAllBytes((Join-Path $assetDirectory 'icon.ico'), $icoStream.ToArray())
$writer.Dispose()
$icoStream.Dispose()
$memory.Dispose()
$font.Dispose()
$format.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
