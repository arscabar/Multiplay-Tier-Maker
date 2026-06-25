$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "launcher\MultiplayTierMaker.Launcher.csproj"
$output = Join-Path $root "dist"
$publishOutput = Join-Path $output "launcher-win-x64"
$packageJson = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$portableName = "MultiplayTierMaker-v$version-win-x64"
$portableRoot = Join-Path $output $portableName
$zipPath = Join-Path $output "$portableName.zip"

New-Item -ItemType Directory -Force -Path $output | Out-Null

dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $publishOutput
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

if (Test-Path $portableRoot) {
    Remove-Item -LiteralPath $portableRoot -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $publishOutput "MultiplayTierMaker.exe") -Destination (Join-Path $portableRoot "MultiplayTierMaker.exe") -Force

foreach ($file in @("server.js", "package.json", "package-lock.json", "README.md")) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $portableRoot $file) -Force
}

foreach ($directory in @("public", "node_modules")) {
    Copy-Item -LiteralPath (Join-Path $root $directory) -Destination (Join-Path $portableRoot $directory) -Recurse -Force
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "node.exe was not found. Install Node.js before building the portable package."
}
$nodeTarget = Join-Path $portableRoot "tools\node"
New-Item -ItemType Directory -Force -Path $nodeTarget | Out-Null
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $nodeTarget "node.exe") -Force

$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflaredCommand) {
    $cloudflaredTarget = Join-Path $portableRoot "tools"
    New-Item -ItemType Directory -Force -Path $cloudflaredTarget | Out-Null
    Copy-Item -LiteralPath $cloudflaredCommand.Source -Destination (Join-Path $cloudflaredTarget "cloudflared.exe") -Force
} else {
    Write-Host "cloudflared.exe was not found. The launcher can still download it on first run."
}

Copy-Item -LiteralPath (Join-Path $portableRoot "MultiplayTierMaker.exe") -Destination (Join-Path $output "MultiplayTierMaker.exe") -Force
Compress-Archive -Path (Join-Path $portableRoot "*") -DestinationPath $zipPath -Force

Write-Host "Built launcher:"
Write-Host (Join-Path $output "MultiplayTierMaker.exe")
Write-Host "Built portable package:"
Write-Host $zipPath
