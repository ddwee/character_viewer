# ffmpeg（録画の解析に使う。無料）をインストールする
. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'ffmpeg のインストール'
$ok = $false
try {
    if (-not (Test-Tool winget)) { throw 'winget が見つかりません。Microsoft Store の「アプリ インストーラー」を更新してください' }
    Write-Step 'ffmpeg をインストールしています'
    Invoke-Checked 'ffmpeg のインストール' { winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements }
    Write-Ok 'インストールしました。設定画面で「状態を更新」を押してください'
    $ok = $true
} catch {
    Write-Fail $_.Exception.Message
}
Wait-Close $ok
