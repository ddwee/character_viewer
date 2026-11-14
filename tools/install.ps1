# 初回セットアップ（setup.cmd から実行される）。ビルドしてショートカットを作り、アプリを起動する
. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'character_viewer のセットアップ'
Write-Host '== character_viewer のセットアップ ==' -ForegroundColor Cyan
$ok = $false
try {
    Write-Step '必要なもの（すべて無料）を確認しています'
    $missing = @()
    if (-not (Test-Tool cargo)) { $missing += 'Rust: https://rustup.rs （または winget install -e --id Rustlang.Rustup）' }
    if (-not (Test-Tool npm)) { $missing += 'Node.js: https://nodejs.org （または winget install -e --id OpenJS.NodeJS.LTS）' }
    if (-not (Test-Tool git)) { $missing += 'Git: https://git-scm.com （または winget install -e --id Git.Git）' }
    if ($missing.Count -gt 0) {
        $missing | ForEach-Object { Write-Fail $_ }
        throw '足りないものをインストールしてから、もう一度 setup.cmd を実行してください'
    }
    Write-Ok 'Rust・Node.js・Git'
    if (-not (Test-Tool ffmpeg)) { Write-Note 'ffmpeg がありません（録画の解析だけに使います。あとから設定画面でインストールできます）' }

    Build-All
    Install-Build -NoStart

    Write-Step 'ショートカットを作っています'
    $shell = New-Object -ComObject WScript.Shell
    $exe = Join-Path $Bin 'cv-app.exe'
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'character_viewer'
    New-Item -ItemType Directory -Force $menu | Out-Null
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), $menu)) {
        $lnk = $shell.CreateShortcut((Join-Path $dir 'character_viewer.lnk'))
        $lnk.TargetPath = $exe
        $lnk.WorkingDirectory = $Bin
        $lnk.IconLocation = "$exe,0"
        $lnk.Description = '音声に反応してイラストを切り替える（OBS 用）'
        $lnk.Save()
    }
    # アプリが起動できないときにも使えるよう、メンテナンス用の PowerShell も登録する
    $lnk = $shell.CreateShortcut((Join-Path $menu 'character_viewer メンテナンス.lnk'))
    $lnk.TargetPath = 'powershell.exe'
    $lnk.Arguments = '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'tools\terminal.ps1') + '"'
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'エラーの確認・作り直しなど'
    $lnk.Save()
    Write-Ok 'デスクトップとスタートメニューに「character_viewer」を作りました'
    Write-Ok 'スタートメニューに「character_viewer メンテナンス」を作りました（起動できないときに使います）'

    Start-App
    $ok = $true
} catch {
    Write-Fail $_.Exception.Message
}
Wait-Close $ok
