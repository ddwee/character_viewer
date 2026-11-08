# 前の版に戻す（設定画面の「メンテナンス」から実行される）。もう一度実行すると元の版に戻る
. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'character_viewer を前の版に戻す'
$ok = $false
try {
    if (-not (Test-Path $BinPrev)) { throw '前の版が残っていません（更新したことがないか、すでに消えています）' }
    Write-Step '前の版に戻しています'
    Stop-App
    $tmp = Join-Path $Root 'bin.swap'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    if (Test-Path $Bin) { Rename-Item $Bin 'bin.swap' }
    Rename-Item $BinPrev 'bin'
    if (Test-Path $tmp) { Rename-Item $tmp 'bin.prev' }
    Write-Ok '前の版に戻しました（もう一度実行すると元に戻ります）'
    Start-App
    $ok = $true
} catch {
    Write-Fail $_.Exception.Message
}
Wait-Close $ok
