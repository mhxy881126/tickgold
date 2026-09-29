Add-Type -AssemblyName System.Drawing
$dir = $PSScriptRoot
$src = [System.Drawing.Image]::FromFile((Join-Path $dir 'card-concepts.png'))
Write-Host $src.Width $src.Height
for ($i = 0; $i -lt 3; $i++) {
  $y = [int]($src.Height * $i / 3)
  $h = [int]($src.Height / 3)
  $nw = 1200
  $nh = [int]($h * $nw / $src.Width)
  $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $nw, $nh)), (New-Object System.Drawing.Rectangle(0, $y, $src.Width, $h)), [System.Drawing.GraphicsUnit]::Pixel)
  $bmp.Save((Join-Path $dir ("part$($i+1).png")))
  $g.Dispose(); $bmp.Dispose()
}
$src.Dispose()
