$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pathStore = Join-Path $root ".omx\cloudflared-path.txt"
$downloadTarget = Join-Path $root ".omx\cloudflared.exe"
$downloadsPage = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"

function Clean-PathValue([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $null
    }
    return [Environment]::ExpandEnvironmentVariables($value.Trim().Trim('"'))
}

function Save-CloudflaredPath([string]$path) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pathStore) | Out-Null
    Set-Content -LiteralPath $pathStore -Value $path
}

function Find-Cloudflared {
    $storedPath = $null
    if (Test-Path -LiteralPath $pathStore) {
        $storedPath = Get-Content -LiteralPath $pathStore -Raw
    }

    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    $candidates = @(
        $env:MULTIPLAY_CLOUDFLARED_PATH,
        $env:CLOUDFLARED_PATH,
        $storedPath,
        (Join-Path $root "tools\cloudflared.exe"),
        $downloadTarget,
        $(if ($command) { $command.Source } else { $null })
    )

    foreach ($candidate in $candidates) {
        $path = Clean-PathValue $candidate
        if ($path -and (Test-Path -LiteralPath $path)) {
            return $path
        }
    }

    return $null
}

$cloudflared = Find-Cloudflared
if (-not $cloudflared) {
    Write-Host ""
    Write-Host "cloudflared를 찾지 못했습니다."
    Write-Host "외부 친구와 접속하려면 Cloudflare Tunnel 프로그램이 필요합니다."
    Write-Host "1. 자동 다운로드해서 .omx\\cloudflared.exe에 저장"
    Write-Host "2. cloudflared.exe 경로 직접 입력"
    Write-Host "Enter. 취소"
    Write-Host "수동 설치 안내: $downloadsPage"
    $choice = Read-Host "선택"

    if ($choice -eq "1" -or $choice -ieq "download") {
        & (Join-Path $PSScriptRoot "install-cloudflared.ps1") -OutputPath $downloadTarget
        $cloudflared = $downloadTarget
    } elseif ($choice -eq "2" -or $choice -ieq "path") {
        $manualPath = Clean-PathValue (Read-Host "cloudflared.exe 전체 경로")
        if ($manualPath -and (Test-Path -LiteralPath $manualPath)) {
            Save-CloudflaredPath $manualPath
            $cloudflared = $manualPath
        }
    } else {
        $manualPath = Clean-PathValue $choice
        if ($manualPath -and (Test-Path -LiteralPath $manualPath)) {
            Save-CloudflaredPath $manualPath
            $cloudflared = $manualPath
        }
    }
}

if (-not $cloudflared) {
    throw "cloudflared가 없어 터널을 시작하지 않았습니다."
}

Write-Host "Using cloudflared:"
Write-Host $cloudflared
& $cloudflared tunnel --url http://localhost:3000
