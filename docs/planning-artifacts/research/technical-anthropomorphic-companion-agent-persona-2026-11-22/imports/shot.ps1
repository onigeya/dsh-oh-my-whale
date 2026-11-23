param([string]$Run, [string]$Anchor = "", [string]$Name = "shot.png", [string]$Page = "research-briefing.html")
$cands = @(
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe")
)
$exe = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { Write-Output "no-browser"; exit 0 }
$shot = Join-Path $Run ("imports\" + $Name)
if (Test-Path $shot) { Remove-Item $shot }
$tmp = Join-Path $env:TEMP ("edge-" + [guid]::NewGuid().ToString("N"))
$url = "file:///" + $Run.Replace([char]92, "/") + "/" + $Page
& $exe --headless=new --disable-gpu --hide-scrollbars --window-size=1280,2000 --user-data-dir=$tmp --no-first-run --screenshot=$shot $url 2>$null | Out-Null
Start-Sleep -Seconds 3
if (Test-Path $shot) { (Get-Item $shot).Length } else { "failed" }