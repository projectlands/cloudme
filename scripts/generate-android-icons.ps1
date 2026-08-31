Add-Type -AssemblyName System.Drawing

$sourcePath = "c:\Users\U S E R\Downloads\Cloudme\logocdm.jpg"
$srcImg = [System.Drawing.Image]::FromFile($sourcePath)
$androidRes = "c:\Users\U S E R\Downloads\Cloudme\android\app\src\main\res"

function Save-Image($bmp, $targetPath) {
    $parent = [System.IO.Path]::GetDirectoryName($targetPath)
    if (-not (Test-Path $parent)) { 
        New-Item -ItemType Directory -Path $parent -Force | Out-Null 
    }
    $bmp.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Generated: $targetPath"
}

# 1. Standard Square Launcher Icon
function Create-Square-Icon($size, $targetPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($srcImg, 0, 0, $size, $size)
    $g.Dispose()
    Save-Image $bmp $targetPath
    $bmp.Dispose()
}

# 2. Round Launcher Icon (Clipped to circle)
function Create-Round-Icon($size, $targetPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $size, $size)
    $g.SetClip($path)
    $g.DrawImage($srcImg, 0, 0, $size, $size)
    $path.Dispose()
    $g.Dispose()
    Save-Image $bmp $targetPath
    $bmp.Dispose()
}

# 3. Adaptive Foreground Icon (Layered with safe margin)
function Create-Foreground-Icon($canvasSize, $targetPath) {
    $bmp = New-Object System.Drawing.Bitmap($canvasSize, $canvasSize)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $innerSize = [int]($canvasSize * 0.72)
    $offset = [int](($canvasSize - $innerSize) / 2)
    $g.DrawImage($srcImg, $offset, $offset, $innerSize, $innerSize)
    $g.Dispose()
    Save-Image $bmp $targetPath
    $bmp.Dispose()
}

# 4. Splash Screen (Centered Logo on dark background)
function Create-Splash-Screen($width, $height, $targetPath) {
    $bmp = New-Object System.Drawing.Bitmap($width, $height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    
    $darkBg = [System.Drawing.Color]::FromArgb(255, 30, 37, 45) # #1e252d
    $g.Clear($darkBg)

    $logoSize = [Math]::Min([int]($width * 0.45), [int]($height * 0.45))
    if ($logoSize -lt 120) { $logoSize = [Math]::Min($width, $height) }
    $x = [int](($width - $logoSize) / 2)
    $y = [int](($height - $logoSize) / 2)
    $g.DrawImage($srcImg, $x, $y, $logoSize, $logoSize)
    $g.Dispose()
    Save-Image $bmp $targetPath
    $bmp.Dispose()
}

$densities = @(
    @{ Name = "mipmap-mdpi"; Size = 48; ForeSize = 108 },
    @{ Name = "mipmap-hdpi"; Size = 72; ForeSize = 162 },
    @{ Name = "mipmap-xhdpi"; Size = 96; ForeSize = 216 },
    @{ Name = "mipmap-xxhdpi"; Size = 144; ForeSize = 324 },
    @{ Name = "mipmap-xxxhdpi"; Size = 192; ForeSize = 432 }
)

foreach ($d in $densities) {
    $folder = Join-Path $androidRes $d.Name
    Create-Square-Icon $d.Size (Join-Path $folder "ic_launcher.png")
    Create-Round-Icon $d.Size (Join-Path $folder "ic_launcher_round.png")
    Create-Foreground-Icon $d.ForeSize (Join-Path $folder "ic_launcher_foreground.png")
}

# Update Splash screens
$splashes = @(
    @{ Path = "drawable/splash.png"; W = 480; H = 800 },
    @{ Path = "drawable-port-mdpi/splash.png"; W = 320; H = 480 },
    @{ Path = "drawable-port-hdpi/splash.png"; W = 480; H = 800 },
    @{ Path = "drawable-port-xhdpi/splash.png"; W = 720; H = 1280 },
    @{ Path = "drawable-port-xxhdpi/splash.png"; W = 960; H = 1600 },
    @{ Path = "drawable-port-xxxhdpi/splash.png"; W = 1280; H = 1920 },
    @{ Path = "drawable-land-mdpi/splash.png"; W = 480; H = 320 },
    @{ Path = "drawable-land-hdpi/splash.png"; W = 800; H = 480 },
    @{ Path = "drawable-land-xhdpi/splash.png"; W = 1280; H = 720 },
    @{ Path = "drawable-land-xxhdpi/splash.png"; W = 1600; H = 960 },
    @{ Path = "drawable-land-xxxhdpi/splash.png"; W = 1920; H = 1280 }
)

foreach ($s in $splashes) {
    Create-Splash-Screen $s.W $s.H (Join-Path $androidRes $s.Path)
}

$srcImg.Dispose()
Write-Host "All Android App & APK icons and splash screens successfully updated!"
