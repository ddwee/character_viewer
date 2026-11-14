# 更新・作り直し（設定画面の「メンテナンス」から実行される）
#
#   .\tools\update.ps1                  作り直すだけ（更新しない）
#   .\tools\update.ps1 -Git -Rust -Deps  プロジェクト・Rust・部品を更新して作り直す
#
# 新しい版のビルドとテストが通ったときだけ入れ替える。失敗したら元に戻し、今の版のまま動き続ける。
param([switch]$Git, [switch]$Rust, [switch]$Deps)

. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'character_viewer の更新'
$what = @()
if ($Git) { $what += 'プロジェクト' }
if ($Rust) { $what += 'Rust' }
if ($Deps) { $what += '部品' }
Write-Host '== character_viewer ==' -ForegroundColor Cyan
if ($what.Count -gt 0) { Write-Host ('更新: ' + ($what -join '・')) } else { Write-Host '作り直し（更新はしません）' }
Write-Host 'アプリと OBS の表示は、最後の入れ替えまでそのまま動きます。このウィンドウは閉じないでください。'
if ($what.Count -gt 0) { Write-Log ('==== 開始: ' + ($what -join ',')) } else { Write-Log '==== 開始: 作り直し' }

$backup = Join-Path $env:TEMP ('cv-update-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item (Join-Path $Root 'Cargo.lock') $backup
Copy-Item (Join-Path $Root 'renderer\package-lock.json') $backup
$headBefore = (git rev-parse HEAD 2>$null)
$rustBefore = ''
if (Test-Tool rustc) { $rustBefore = ((rustc -V) -split ' ')[1] }
$pin = Join-Path $Root 'rust-toolchain.toml'
$pinBackup = Join-Path $backup 'rust-toolchain.toml'
$pulled = $false
$ok = $false

try {
    if (-not (Test-Tool cargo)) { throw 'Rust（cargo）が見つかりません。https://rustup.rs からインストールしてください' }
    if (-not (Test-Tool npm)) { throw 'Node.js（npm）が見つかりません。https://nodejs.org からインストールしてください' }

    if ($Git) {
        Write-Step 'プロジェクトを GitHub の最新版にしています'
        if (git status --porcelain --untracked-files=no) {
            Write-Note '手元で変更したファイルがあるため、プロジェクトの更新は飛ばします'
        } else {
            Invoke-Checked 'GitHub からの取得' { git pull --ff-only }
            $pulled = ((git rev-parse HEAD) -ne $headBefore)
            if ($pulled) { Write-Ok '最新版にしました' } else { Write-Ok 'すでに最新です' }
        }
    }

    if ($Rust) {
        Write-Step 'Rust を更新しています'
        # 固定していた版があれば外して、最新の安定版で試す（失敗したら元に戻す）
        if (Test-Path $pin) { Move-Item $pin $pinBackup -Force }
        Invoke-Checked 'Rust の更新' { rustup update stable --no-self-update }
        Write-Ok ('Rust ' + ((rustc -V) -split ' ')[1])
    }

    if ($Deps) {
        Write-Step '部品を更新しています（互換性を保つ範囲）'
        Invoke-Checked 'Rust の部品の更新' { cargo update }
        Push-Location (Join-Path $Root 'renderer')
        try { Invoke-Checked 'npm の部品の更新' { npm update --no-audit --no-fund } } finally { Pop-Location }
        Write-Ok '部品を更新しました'
    }

    Build-All
    Install-Build
    $ok = $true
    Write-Log '==== 成功'
} catch {
    Write-Host ''
    Write-Fail $_.Exception.Message
    Write-Log ('==== 失敗: ' + $_.Exception.Message)
    Write-Step '元の状態に戻しています（今動いている版はそのままです）'
    Copy-Item (Join-Path $backup 'Cargo.lock') (Join-Path $Root 'Cargo.lock') -Force
    Copy-Item (Join-Path $backup 'package-lock.json') (Join-Path $Root 'renderer\package-lock.json') -Force
    if ($pulled) {
        git reset --hard $headBefore | Out-Null
        Write-Ok 'プロジェクトを更新前に戻しました'
    }
    if ($Rust) {
        $rustAfter = ((rustc -V) -split ' ')[1]
        if (Test-Path $pinBackup) {
            Move-Item $pinBackup $pin -Force
            Write-Ok 'Rust の版の固定を元に戻しました'
        } elseif ($rustBefore -and $rustAfter -ne $rustBefore) {
            # 新しい Rust でビルドできなかった可能性があるので、動いていた版に固定する
            Write-Host "  Rust を動作確認済みの $rustBefore に固定します"
            rustup toolchain install $rustBefore --profile minimal --no-self-update
            $text = "# 新しい Rust でビルドできなかったため、動作確認済みの版に固定しています（tools\update.ps1 が作成）`r`n[toolchain]`r`nchannel = `"$rustBefore`"`r`nprofile = `"minimal`"`r`n"
            Set-Content -Path $pin -Encoding ASCII -Value $text
            Write-Ok "Rust を $rustBefore に固定しました（次に「Rust を更新」したとき、改めて新しい版を試します）"
        }
    }
    Write-Ok '元に戻しました'
}
Wait-Close $ok
