# 共通の設定と関数（ほかのスクリプトから読み込む）

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $Root 'bin'
$BinPrev = Join-Path $Root 'bin.prev'
$BinNew = Join-Path $Root 'bin.new'
$DataDir = Join-Path $env:APPDATA 'character_viewer'
$LogDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force $LogDir | Out-Null
$StepLog = Join-Path $LogDir ('maintenance-' + (Get-Date -Format 'yyyyMMdd') + '.log')

# インストール直後でも道具が見つかるように、よくある場所を PATH に足す
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd;$env:Path"
Set-Location $Root

function Write-Log([string]$text) {
    Add-Content -Path $StepLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $text) -Encoding UTF8
}
function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "▶ $text" -ForegroundColor Cyan
    Write-Log "▶ $text"
}
function Write-Ok([string]$text) {
    Write-Host "  ✓ $text" -ForegroundColor Green
    Write-Log "  ✓ $text"
}
function Write-Note([string]$text) {
    Write-Host "  ! $text" -ForegroundColor Yellow
    Write-Log "  ! $text"
}
function Write-Fail([string]$text) {
    Write-Host "  × $text" -ForegroundColor Red
    Write-Log "  × $text"
}

# 外部コマンドを実行し、失敗したら止める（エラーの内容はそのまま画面に出る）
function Invoke-Checked([string]$what, [scriptblock]$block) {
    & $block
    if ($LASTEXITCODE -ne 0) {
        throw "$what に失敗しました（終了コード $LASTEXITCODE）。上に表示されているエラーを確認してください"
    }
}

function Test-Tool([string]$name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# このプロジェクトのアプリだけを止める
function Stop-App {
    $procs = Get-Process cv-app -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) }
    if ($procs) {
        Write-Host '  アプリを終了しています…'
        $procs | Stop-Process -Force
        $procs | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
}

function Start-App {
    $exe = Join-Path $Bin 'cv-app.exe'
    if (Test-Path $exe) {
        Start-Process -FilePath $exe -WorkingDirectory $Bin
        Write-Ok 'アプリを起動しました'
    }
}

# node_modules が package-lock.json と合っていなければ入れ直す
function Sync-NodeModules {
    $lock = Join-Path $Root 'renderer\package-lock.json'
    $stamp = Join-Path $Root 'renderer\node_modules\.cv-lock-hash'
    $hash = (Get-FileHash $lock -Algorithm SHA256).Hash
    if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $hash)) {
        Write-Ok '描画ページの部品は揃っています'
        return
    }
    Invoke-Checked '描画ページの部品のインストール（npm ci）' { npm ci --no-audit --no-fund }
    Set-Content -Path $stamp -Value $hash -Encoding ASCII
}

# 描画ページ・設定画面・エンジン・アプリをビルドしてテストする（失敗したら止める）
function Build-All {
    Write-Step '描画ページと設定画面をビルドしています'
    Push-Location (Join-Path $Root 'renderer')
    try {
        Sync-NodeModules
        Invoke-Checked '描画ページのビルド' { npm run build }
        Invoke-Checked '描画ページのテスト' { npm test }
    } finally {
        Pop-Location
    }
    Write-Ok '描画ページと設定画面'

    Write-Step 'エンジンとアプリをビルドしています（初回や更新後は数分かかります）'
    Invoke-Checked 'エンジンとアプリのビルド' { cargo build --release -p cv-engine -p cv-app }
    Write-Step 'エンジンのテストをしています'
    Invoke-Checked 'エンジンのテスト' { cargo test --release -p cv-engine }
    Write-Ok 'エンジンとアプリ'
}

# ビルドしたものを bin に入れる。今の版は bin.prev に残す（「前の版に戻す」で使う）
function Install-Build([switch]$NoStart) {
    Write-Step '新しい版に入れ替えています'
    if (Test-Path $BinNew) { Remove-Item -Recurse -Force $BinNew }
    New-Item -ItemType Directory -Force $BinNew | Out-Null
    Copy-Item (Join-Path $Root 'target\release\cv-app.exe') $BinNew
    Copy-Item (Join-Path $Root 'target\release\cv-engine.exe') $BinNew
    Copy-Item -Recurse (Join-Path $Root 'renderer\dist') (Join-Path $BinNew 'renderer')

    Stop-App
    if (Test-Path $Bin) {
        if (Test-Path $BinPrev) { Remove-Item -Recurse -Force $BinPrev }
        Rename-Item $Bin 'bin.prev'
    }
    Rename-Item $BinNew 'bin'
    Write-Ok '入れ替えました（前の版は bin.prev に残しています）'
    if (-not $NoStart) { Start-App }
}

function Wait-Close([bool]$ok) {
    Write-Host ''
    if ($ok) {
        Write-Host '完了しました。このウィンドウは閉じて大丈夫です。' -ForegroundColor Green
    } else {
        Write-Host 'うまくいきませんでした。上のエラーを確認してください。' -ForegroundColor Red
        Write-Host "記録: $StepLog"
    }
    Read-Host 'Enter キーで閉じます' | Out-Null
}
