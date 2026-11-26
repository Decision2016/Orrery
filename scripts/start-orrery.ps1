[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$Windowed,
    [switch]$Kiosk,
    [ValidateRange(1, 65535)][int]$Port = 4318
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$serverEntry = Join-Path $repoRoot 'packages\server\dist\index.js'
$webEntry = Join-Path $repoRoot 'packages\web\dist\index.html'
$url = "http://127.0.0.1:$Port"

function Test-OrreryHealth {
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2 -ErrorAction Stop
        return $health.ok -eq $true -and $null -ne $health.collectors
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf) -or -not (Test-Path -LiteralPath $webEntry -PathType Leaf)) {
    Push-Location -LiteralPath $repoRoot
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Orrery build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

if (-not (Test-OrreryHealth)) {
    $previousPort = $env:ORRERY_PORT
    $previousHost = $env:ORRERY_HOST
    try {
        $env:ORRERY_PORT = [string]$Port
        $env:ORRERY_HOST = '127.0.0.1'
        $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
        $service = Start-Process -FilePath $node -ArgumentList ('"{0}"' -f $serverEntry) -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    } finally {
        $env:ORRERY_PORT = $previousPort
        $env:ORRERY_HOST = $previousHost
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not (Test-OrreryHealth)) {
        if ($service.HasExited) { throw "Orrery exited with code $($service.ExitCode) before its health endpoint was ready." }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for $url/api/health (PID $($service.Id))." }
        Start-Sleep -Milliseconds 250
    }
}

Write-Host "Orrery Observatory is ready at $url"
if (-not $NoBrowser) {
    & (Join-Path $PSScriptRoot 'launch-kiosk.ps1') -Url $url -Windowed:$Windowed -Kiosk:$Kiosk
}
