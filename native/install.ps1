param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId = 'mifgnjonedpicacfieeabbfpffednjif',
    [string]$Python = 'py'
)
$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$venvPython = Join-Path $nativeRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $venvPython)) {
    & $Python -m venv (Join-Path $nativeRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать Python-окружение' }
}
& $venvPython -m pip install -r (Join-Path $nativeRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости' }
# Build a small launcher so Chromium never has to execute a .bat path with Cyrillic.
$launcher = Join-Path $nativeRoot 'launcher.exe'
$pythonLiteral = $venvPython.Replace('"', '""')
$hostLiteral = (Join-Path $nativeRoot 'host.py').Replace('"', '""')
if (Test-Path -LiteralPath $launcher) { Remove-Item -LiteralPath $launcher }
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
public class Launcher {
    public static int Main() {
        var p = new ProcessStartInfo(@"$pythonLiteral", "\"" + @"$hostLiteral" + "\"");
        p.UseShellExecute = false;
        var child = Process.Start(p);
        child.WaitForExit();
        return child.ExitCode;
    }
}
"@ -OutputAssembly $launcher -OutputType ConsoleApplication
$base = @{
    name = 'org.google_unlocked.captcha'; description = 'Local ONNX captcha recognizer'
    path = $launcher; type = 'stdio'
}
$chromeManifest = Join-Path $nativeRoot 'chrome-host.json'
$firefoxManifest = Join-Path $nativeRoot 'firefox-host.json'
$chromeData = $base.Clone()
$chromeData.allowed_origins = @("chrome-extension://$ExtensionId/")
$firefoxData = $base.Clone()
$firefoxData.allowed_extensions = @('google-unlocked@local')
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($chromeManifest, ($chromeData | ConvertTo-Json), $utf8)
[IO.File]::WriteAllText($firefoxManifest, ($firefoxData | ConvertTo-Json), $utf8)
foreach ($vendor in @('Google\Chrome', 'Microsoft\Edge', 'Mozilla')) {
    $key = "HKCU:\Software\$vendor\NativeMessagingHosts\org.google_unlocked.captcha"
    New-Item -Path $key -Force | Out-Null
    $manifest = if ($vendor -eq 'Mozilla') { $firefoxManifest } else { $chromeManifest }
    Set-Item -LiteralPath $key -Value $manifest
}
Write-Host 'Готово. В настройках расширения нажмите «Проверить модели».'
