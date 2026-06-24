$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "launcher\MultiplayTierMaker.Launcher.csproj"
$output = Join-Path $root "dist"

dotnet publish $project -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o $output
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

Write-Host "Built launcher:"
Write-Host (Join-Path $output "MultiplayTierMaker.exe")
