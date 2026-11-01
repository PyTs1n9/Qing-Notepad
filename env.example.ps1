# Qing Notepad 开发环境配置模板
#
# 用法：
#   1. 复制为 env.ps1：  Copy-Item env.example.ps1 env.ps1
#   2. 按本机实际安装路径调整下面的版本号（脚本会在找不到时自动回退到最新版本）
#   3. 加载环境：        . .\env.ps1
#
# env.ps1 已被 .gitignore 忽略——它只对本机有效，不要提交。

# 1. Rust 工具链
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

# 2. MSVC Build Tools + Windows SDK
#    可用以下命令查询本机实际版本：
#      Get-ChildItem "$VsRoot\VC\Tools\MSVC" -Directory | Select-Object -ExpandProperty Name
#      Get-ChildItem "$SdkRoot\Lib" -Directory | Select-Object -ExpandProperty Name
$VsRoot = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
$SdkRoot = "C:\Program Files (x86)\Windows Kits\10"

$MsvcVersion = "14.44.35207"
$SdkVersion = "10.0.26100.0"

$MsvcRoot = Join-Path $VsRoot "VC\Tools\MSVC"
if (-not (Test-Path (Join-Path $MsvcRoot $MsvcVersion))) {
    $latest = Get-ChildItem $MsvcRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) { $MsvcVersion = $latest.Name }
}

if (-not (Test-Path (Join-Path $SdkRoot "Lib\$SdkVersion"))) {
    $latest = Get-ChildItem (Join-Path $SdkRoot "Lib") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.' } |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) { $SdkVersion = $latest.Name }
}

$MsvcDir = Join-Path $MsvcRoot $MsvcVersion

$env:Path = "$(Join-Path $MsvcDir 'bin\Hostx64\x64');$env:Path"
$env:LIB = "$(Join-Path $MsvcDir 'lib\x64');$(Join-Path $SdkRoot "Lib\$SdkVersion\um\x64");$(Join-Path $SdkRoot "Lib\$SdkVersion\ucrt\x64")"
$env:INCLUDE = "$(Join-Path $MsvcDir 'include');$(Join-Path $SdkRoot "Include\$SdkVersion\ucrt");$(Join-Path $SdkRoot "Include\$SdkVersion\um");$(Join-Path $SdkRoot "Include\$SdkVersion\shared");$(Join-Path $SdkRoot "Include\$SdkVersion\cppwinrt")"
$env:WindowsSdkDir = "$SdkRoot\"

# 3. Windows SDK Resource Compiler (rc.exe) —— Tauri build 需要
$env:Path = "$(Join-Path $SdkRoot "bin\$SdkVersion\x64");$env:Path"

# 4. Tauri 更新包签名
#    `bundle.createUpdaterArtifacts` 打开后，`tauri build` 必须能拿到私钥，否则构建失败。
#    密钥生成：npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\qing-notepad.key"
#    （密码跟着交互提示输入；本模板假定密码存在同目录的 .key.pass，私钥与密码都不进 git）
#    缺失私钥时的构建失败是刻意的：静默产出一个签不了名的包比构建报错更难查。
$SigningKey = "$env:USERPROFILE\.tauri\qing-notepad.key"
$SigningPass = "$env:USERPROFILE\.tauri\qing-notepad.key.pass"
if (Test-Path $SigningKey) {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $SigningKey -Raw).Trim()
    if (Test-Path $SigningPass) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $SigningPass -Raw).Trim()
    }
} else {
    Write-Host "未找到更新签名私钥，tauri build 会失败（见 docs/decisions-updater.md）" -ForegroundColor Yellow
}

Write-Host "Environment configured: Rust + MSVC $MsvcVersion + Windows SDK $SdkVersion (rc.exe)" -ForegroundColor Green
