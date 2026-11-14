# メンテナンス用の PowerShell。エラーの確認・手動での作り直しなどに使う
. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'character_viewer メンテナンス'

function Show-Version([string]$label, [scriptblock]$cmd) {
    try { $v = (& $cmd 2>$null | Select-Object -First 1) } catch { $v = $null }
    if ($v) { Write-Host ('  {0,-10} {1}' -f $label, $v) } else { Write-Host ('  {0,-10} 見つかりません' -f $label) -ForegroundColor Yellow }
}

Write-Host '== character_viewer メンテナンス用 PowerShell ==' -ForegroundColor Cyan
Write-Host "プロジェクト: $Root"
Write-Host ''
Write-Host '部品のバージョン'
Show-Version 'アプリ' { & (Join-Path $Bin 'cv-engine.exe') --version }
Show-Version 'git' { git log -1 --format='%h %cd (%s)' --date=short }
Show-Version 'rustc' { rustc -V }
Show-Version 'cargo' { cargo -V }
Show-Version 'node' { node -v }
Show-Version 'npm' { npm -v }
Show-Version 'ffmpeg' { ffmpeg -version }
if (Test-Path (Join-Path $Root 'rust-toolchain.toml')) { Write-Host '  ※ Rust の版を rust-toolchain.toml で固定しています' -ForegroundColor Yellow }

Write-Host ''
$running = Get-Process cv-app -ErrorAction SilentlyContinue
if ($running) { Write-Host 'アプリ: 起動中' } else { Write-Host 'アプリ: 停止中' }

$log = Join-Path $LogDir ('cv-' + (Get-Date -Format 'yyyyMMdd') + '.log')
if (Test-Path $log) {
    $problems = Select-String -Path $log -Pattern '\[(error|warn) *\]' -Encoding UTF8 | Select-Object -Last 15
    Write-Host ''
    if ($problems) {
        Write-Host '今日のエラー・注意（新しい 15 件）' -ForegroundColor Yellow
        $problems | ForEach-Object { Write-Host ('  ' + $_.Line) }
    } else {
        Write-Host '今日のログにエラーはありません' -ForegroundColor Green
    }
}

Write-Host ''
Write-Host 'よく使うコマンド（コピーして貼り付け）' -ForegroundColor Cyan
Write-Host '  .\tools\update.ps1                     作り直す（更新しない）'
Write-Host '  .\tools\update.ps1 -Git -Rust -Deps    すべて更新して作り直す'
Write-Host '  .\tools\rollback.ps1                   前の版に戻す'
Write-Host '  .\bin\cv-engine.exe --list             マイクの一覧'
Write-Host '  .\bin\cv-engine.exe                    エンジンをこの画面で動かす（アプリを終了してから。ログがここに出る）'
Write-Host "  Get-Content `"$log`" -Encoding UTF8 -Wait -Tail 30    ログを見続ける（Ctrl+C で止める）"
Write-Host '  cargo build --release -p cv-app        アプリのビルドだけ試す（エラーの詳細を見る）'
Write-Host ''
