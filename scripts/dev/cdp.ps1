# Dev helper (Windows PowerShell): drive headless Edge over the DevTools protocol to screenshot/poke the UI.
# Usage: powershell -File cdp.ps1 -SpecPath C:\path\spec.json
param([Parameter(Mandatory)][string]$SpecPath)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw $SpecPath | ConvertFrom-Json
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$port = 9333
$prof = Join-Path $env:TEMP 'awsmon-edge-profile'
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$prof*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$proc = Start-Process $edge -PassThru -ArgumentList @('--headless=new', '--disable-gpu', "--remote-debugging-port=$port", "--user-data-dir=$prof", '--no-first-run', 'about:blank')
try {
  $tab = $null
  for ($i = 0; $i -lt 40 -and -not $tab; $i++) {
    try { $tab = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$port/json/new?about:blank" } catch { Start-Sleep -Milliseconds 250 }
  }
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.ConnectAsync([Uri]$tab.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  $script:id = 0
  function Send($method, $params = @{}) {
    $script:id++
    $json = @{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    while ($true) {
      $ms = New-Object IO.MemoryStream
      do {
        $buf = New-Object byte[] 65536
        $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        $ms.Write($buf, 0, $r.Count)
      } until ($r.EndOfMessage)
      $msg = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
      if ($msg.id -eq $script:id) { if ($msg.error) { throw "$method : $($msg.error.message)" }; return $msg.result }
    }
  }
  Send 'Page.enable' | Out-Null
  Send 'Runtime.enable' | Out-Null
  Send 'Performance.enable' | Out-Null
  $w = if ($spec.width) { $spec.width } else { 1920 }
  $h = if ($spec.height) { $spec.height } else { 1080 }
  Send 'Emulation.setDeviceMetricsOverride' @{ width = $w; height = $h; deviceScaleFactor = 1; mobile = $false } | Out-Null
  foreach ($step in $spec.steps) {
    if ($step.theme) { Send 'Emulation.setEmulatedMedia' @{ features = @(@{ name = 'prefers-color-scheme'; value = $step.theme }) } | Out-Null }
    if ($step.goto) { Send 'Page.navigate' @{ url = $step.goto } | Out-Null }
    if ($step.wait) { Start-Sleep -Milliseconds $step.wait }
    if ($step.eval) {
      $r = Send 'Runtime.evaluate' @{ expression = $step.eval; awaitPromise = $true; returnByValue = $true }
      Write-Output ("eval -> " + ($r.result.value | ConvertTo-Json -Compress -Depth 6))
    }
    if ($step.metrics) {
      $m = Send 'Performance.getMetrics'
      $pick = $m.metrics | Where-Object { $_.name -in @('TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'Timestamp') }
      Write-Output ("metrics " + $step.metrics + " -> " + (($pick | ForEach-Object { "$($_.name)=$([math]::Round($_.value, 3))" }) -join ' '))
    }
    if ($step.cdp) { Send $step.cdp.method $step.cdp.params | Out-Null }
    if ($step.shot) {
      $r = Send 'Page.captureScreenshot' @{ format = 'png' }
      [IO.File]::WriteAllBytes($step.shot, [Convert]::FromBase64String($r.data))
      Write-Output "saved $($step.shot)"
    }
  }
} finally {
  # Edge spawns child processes; end the whole tree, then sweep anything still using this profile.
  $ErrorActionPreference = 'Continue'
  if ($proc) { try { & taskkill.exe /T /F /PID $proc.Id *> $null } catch {} }
  Start-Sleep -Milliseconds 300
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$prof*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
