param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [ValidateRange(1024, 65535)][int]$Port = 8792,
    [switch]$Https
)

$ErrorActionPreference = 'Stop'
$buildRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $buildRoot 'dist\server.js'
$appUrl = "http://localhost:$Port"

try {
    if ($Action -eq 'Stop') {
        # Only this build, identified by its full entrypoint path. Never stop
        # an arbitrary process merely because it is listening on our port.
        $servers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if (!$servers.Count) {
            Write-Host 'No running voice build from this folder was found.'
            exit 0
        }
        foreach ($server in $servers) {
            & taskkill.exe /PID $server.ProcessId /T /F
            if ($LASTEXITCODE -ne 0) { throw 'Windows could not stop the voice app.' }
        }
        Write-Host 'The experimental voice app and its speech worker have stopped.'
        exit 0
    }

    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count) {
        $isVoiceApp = $false
        try {
            $status = Invoke-WebRequest -Uri "$appUrl/api/status" -UseBasicParsing -TimeoutSec 5
            $page = Invoke-WebRequest -Uri "$appUrl/" -UseBasicParsing -TimeoutSec 5
            $state = $status.Content | ConvertFrom-Json
            $isVoiceApp = $status.StatusCode -eq 200 -and $state.authed -is [bool] -and
                $page.Content.Contains('id="voice-panel"') -and $page.Content.Contains('Bunnyboard')
        } catch { $isVoiceApp = $false }
        if ($isVoiceApp) {
            if ($Https) {
                Write-Host 'For microphone access on a phone, stop this build with stop-voice.cmd first, then run start-voice-https.cmd.'
            }
            Write-Host "The experimental voice app is already running at $appUrl"
            Write-Host 'You can open that address now. No second copy was started.'
            Write-Host 'Use stop-voice.cmd to stop the app and its speech worker.'
            exit 0
        }
        Write-Host "Port $Port is being used by another app, or the voice app is still starting."
        Write-Host 'Wait a moment and try again. No existing process was stopped.'
        exit 1
    }

    Set-Location -LiteralPath $buildRoot
    if (!(Test-Path -LiteralPath (Join-Path $buildRoot 'node_modules\typescript'))) {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the app dependencies.' }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the app.' }
    $env:VENUS_PHONE_PORT = [string]$Port
    $env:VENUS_PHONE_DATA = Join-Path $buildRoot 'app-data'
    if ($Https) { $env:VENUS_PHONE_HTTPS = '1' }
    Write-Host "Experimental local voice build: $appUrl"
    Write-Host 'Keep this window open. Press Ctrl+C or use stop-voice.cmd to stop.'
    # An absolute entrypoint lets the stop shortcut identify this build safely.
    & node $serverPath
    exit $LASTEXITCODE
} catch {
    Write-Host "Could not $($Action.ToLower()) the experimental voice app: $($_.Exception.Message)"
    exit 1
}
