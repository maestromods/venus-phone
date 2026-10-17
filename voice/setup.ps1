$ErrorActionPreference = 'Stop'
$voiceRoot = $PSScriptRoot
$voiceApp = Split-Path $voiceRoot -Parent
$env:UV_CACHE_DIR = Join-Path $voiceRoot '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $voiceRoot '.runtime\python'
$env:UV_PYTHON_BIN_DIR = Join-Path $voiceRoot '.runtime\bin'
$voiceUv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $voiceUv) {
    throw 'Install uv from https://docs.astral.sh/uv/getting-started/installation/ and run setup-voice.cmd again.'
}
Write-Host 'Installing local voice in an isolated environment. First setup downloads several GB.'
& $voiceUv.Source python install 3.11
if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
& $voiceUv.Source venv --python 3.11 (Join-Path $voiceRoot '.venv') --allow-existing
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the voice environment.' }
& $voiceUv.Source pip install --python (Join-Path $voiceRoot '.venv\Scripts\python.exe') -r (Join-Path $voiceRoot 'requirements-lock.txt') --override (Join-Path $voiceRoot 'overrides.txt') --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
if ($LASTEXITCODE -ne 0) { throw 'Voice dependency installation failed.' }
Write-Host 'Ready. Start start-voice.cmd, open a chat, click the phone, then Load voice models.'
