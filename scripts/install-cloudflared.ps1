param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $root "tools\cloudflared.exe"
}

$OutputPath = [Environment]::ExpandEnvironmentVariables($OutputPath.Trim('"'))
$outputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Write-Host "Downloading cloudflared..."
Write-Host $downloadUrl
Invoke-WebRequest -Uri $downloadUrl -OutFile $OutputPath -UseBasicParsing

Write-Host "Saved cloudflared:"
Write-Host $OutputPath
& $OutputPath --version
