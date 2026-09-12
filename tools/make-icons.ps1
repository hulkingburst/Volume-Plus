# Generates the Volume+ icon set (16/32/48/128) as PNG files.
# Usage:  powershell -ExecutionPolicy Bypass -File make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundRectPath {
  param([System.Drawing.Rectangle]$r, [float]$radius)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $p.AddArc($r.Left, $r.Top, $d, $d, 180, 90)
  $p.AddArc($r.Right - $d, $r.Top, $d, $d, 270, 90)
  $p.AddArc($r.Right - $d, $r.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($r.Left, $r.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Icon {
  param([int]$size, [string]$out)

  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 42, 50, 88),
    [System.Drawing.Color]::FromArgb(255, 15, 18, 26),
    90,
    $null)
  $round = New-RoundRectPath $rect ([float]($size * 0.22))
  $g.FillPath($grad, $round)

  $s = $size / 128.0
  $fx = { param($v) [single]($v * $s) }

  $white  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 241, 250))
  $accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 108, 140, 255))

  # Speaker cone
  $pts = @(
    (New-Object System.Drawing.PointF ((& $fx 30), (& $fx 46))),
    (New-Object System.Drawing.PointF ((& $fx 58), (& $fx 46))),
    (New-Object System.Drawing.PointF ((& $fx 82), (& $fx 68))),
    (New-Object System.Drawing.PointF ((& $fx 58), (& $fx 90))),
    (New-Object System.Drawing.PointF ((& $fx 30), (& $fx 90)))
  )
  $g.FillPolygon($white, $pts)

  # Sound waves (upper right)
  $wavePen = New-Object System.Drawing.Pen($accent, [single](7 * $s))
  $wavePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $wavePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  $cx = 88.0 * $s
  $cy = 68.0 * $s
  foreach ($w in @(22.0, 40.0)) {
    $w2 = $w * $s
    $g.DrawArc($wavePen, [single]($cx - $w2 / 2), [single]($cy - $w2 / 2),
      [single]$w2, [single]$w2, [single]-62, [single]124)
  }

  # "+" mark (bottom right)
  $plus = New-Object System.Drawing.Pen($accent, [single](9 * $s))
  $plus.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $plus.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $px = 106.0 * $s
  $py = 92.0 * $s
  $half = 12.0 * $s
  $g.DrawLine($plus, [single]($px - $half), [single]$py, [single]($px + $half), [single]$py)
  $g.DrawLine($plus, [single]$px, [single]($py - $half), [single]$px, [single]($py + $half))

  $white.Dispose(); $accent.Dispose(); $wavePen.Dispose(); $plus.Dispose()
  $grad.Dispose(); $round.Dispose()
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "wrote $out"
}

foreach ($size in @(16, 32, 48, 128)) {
  New-Icon $size (Join-Path $outDir "icon$size.png")
}