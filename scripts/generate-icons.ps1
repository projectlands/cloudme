Add-Type -AssemblyName System.Drawing

$sourcePath = "C:\Users\U S E R\.gemini\antigravity-ide\brain\2100e0bf-781e-4efc-87bb-34adea769231\cloudme_logo_1788161514657.jpg"
$srcImg = [System.Drawing.Image]::FromFile($sourcePath)

function Resize-And-Save($targetPath, $width, $height, $format) {
    $parent = [System.IO.Path]::GetDirectoryName($targetPath)
    if (-not (Test-Path $parent)) { 
        New-Item -ItemType Directory -Path $parent -Force | Out-Null 
    }
    $bmp = New-Object System.Drawing.Bitmap($width, $height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($srcImg, 0, 0, $width, $height)
    $g.Dispose()
    $bmp.Save($targetPath, $format)
    $bmp.Dispose()
    Write-Host "Created: $targetPath"
}

Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\assets\logo.png" 1024 1024 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\assets\icon-512.png" 512 512 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\assets\icon-192.png" 192 192 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\assets\apple-touch-icon.png" 180 180 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\favicon.png" 64 64 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\favicon.ico" 32 32 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\icons\icon-512x512.png" 512 512 ([System.Drawing.Imaging.ImageFormat]::Png)
Resize-And-Save "c:\Users\U S E R\Downloads\Cloudme\public\icons\icon-192x192.png" 192 192 ([System.Drawing.Imaging.ImageFormat]::Png)

$srcImg.Dispose()
Write-Host "All icons generated successfully!"
