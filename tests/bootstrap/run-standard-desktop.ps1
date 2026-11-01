param(
  [ValidateSet('Smoke', 'Gate')][string]$Mode = 'Smoke',
  [switch]$SelfCheck
)

$ErrorActionPreference = 'Stop'

function Quote-TaskPath([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.Contains('"')) { throw 'Task paths must be absolute Windows paths.' }
  '"' + $Path + '"'
}

function Assert-RunResult($Completion, $Attestation, $Expected, $TaskInfo, [datetime]$StartedAfter) {
  if ($null -eq $Completion -or $null -eq $Attestation -or
      $Completion.nonce -ne $Expected.nonce -or $Attestation.nonce -ne $Expected.nonce -or
      $Attestation.sid -ne $Expected.sid -or $Attestation.session -ne $Expected.session -or
      $Attestation.userProfile -ne $Expected.userProfile -or $Attestation.profileWritable -ne $true -or
      $Attestation.integrity -ne 'Medium' -or $Attestation.elevated -ne $false -or
      $Attestation.elevationType -notin @(1, 3) -or
      ($Expected.controllerElevationType -eq 2 -and $Attestation.elevationType -ne 3) -or
      $Completion.status -ne 'completed' -or
      ($Completion.exitCode -isnot [int] -and $Completion.exitCode -isnot [long]) -or
      $Completion.exitCode -lt 0 -or $Completion.exitCode -gt 255) {
    throw 'Worker attestation, nonce, or completion failed.'
  }
  if ($null -ne $TaskInfo -and ($TaskInfo.LastRunTime.ToUniversalTime() -lt $StartedAfter.AddSeconds(-1) -or
      $TaskInfo.LastTaskResult -ne $Completion.exitCode)) {
    throw 'Scheduled task freshness or exact exit result failed.'
  }
  [int]$Completion.exitCode
}

function Get-FinalExitCode([int]$ChildExitCode, $LauncherFailure, $CleanupFailure) {
  if ($LauncherFailure -or $CleanupFailure) { return 1 }
  return $ChildExitCode
}

if ($SelfCheck) {
  $quoted = Quote-TaskPath 'C:\Program Files\Splyce & CI\worker.ps1'
  if ($quoted -cne '"C:\Program Files\Splyce & CI\worker.ps1"') { throw 'Task argument quoting failed.' }
  $expected = [pscustomobject]@{ nonce = 'abc'; sid = 'same'; session = 1; userProfile = 'C:\Users\test'; controllerElevationType = 2 }
  $attestation = [pscustomobject]@{ nonce = 'abc'; sid = 'same'; session = 1; userProfile = 'C:\Users\test'; profileWritable = $true; integrity = 'Medium'; elevated = $false; elevationType = 3 }
  $completion = [pscustomobject]@{ nonce = 'abc'; status = 'completed'; exitCode = 7 }
  $fresh = [pscustomobject]@{ LastRunTime = [datetime]::UtcNow; LastTaskResult = 7 }
  $started = [datetime]::UtcNow.AddSeconds(-2)
  if ((Assert-RunResult $completion $attestation $expected $fresh $started) -ne 7 -or (Get-FinalExitCode 7 $null $null) -ne 7 -or
      (Get-FinalExitCode 7 $null 'cleanup failed') -ne 1) { throw 'Exit or cleanup decision failed.' }
  foreach ($bad in @(
    @{ completion = [pscustomobject]@{ nonce = 'wrong'; status = 'completed'; exitCode = 7 }; taskInfo = $fresh },
    @{ completion = $completion; taskInfo = [pscustomobject]@{ LastRunTime = $started.AddMinutes(-1); LastTaskResult = 7 } },
    @{ completion = [pscustomobject]@{ nonce = 'abc'; status = 'failed'; exitCode = 7 }; taskInfo = $fresh }
  )) {
    $rejected = $false
    try { Assert-RunResult $bad.completion $attestation $expected $bad.taskInfo $started | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid nonce, stale run, or incomplete worker was accepted.' }
  }
  & (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'standard-desktop-worker.ps1') -SelfCheck
  if ($LASTEXITCODE -ne 0) { throw 'Profile probe collision selfcheck failed.' }
  Write-Output 'Standard desktop validation selfcheck passed.'
  return
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$node = Join-Path $root 'apps/desktop/src-tauri/resources/engine/node.exe'
$npm = Join-Path $root 'apps/desktop/src-tauri/target/build-tools/node_modules/npm/bin/npm-cli.js'
$worker = Join-Path $PSScriptRoot 'standard-desktop-worker.ps1'
$nonce = [guid]::NewGuid().ToString('N')
$taskName = "Splyce-Standard-CI-$nonce"
$runDirectory = Join-Path $root "apps/desktop/src-tauri/target/bootstrap-standard-ci/$nonce"
$registrationAttempted = $false
$launcherFailure = $null
$cleanupFailure = $null
$childExitCode = 1
$workerExit = $null

try {
  if (-not [OperatingSystem]::IsWindows()) { throw 'Windows is required.' }
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Pinned Node is missing.' }
  if ($Mode -eq 'Gate' -and -not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'Pinned npm is missing.' }
  if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'Fixed worker is missing.' }
  $shell = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $process = [Diagnostics.Process]::GetCurrentProcess()
  $session = $process.SessionId
  if (-not $identity.User -or $session -le 0) { throw 'An interactive current-user session is required.' }
  $creationMs = [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  $controllerElevation = & (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'process-elevation.ps1') -ProcessId $PID -CreationTimeMs $creationMs -Details | ConvertFrom-Json
  if ($controllerElevation.status -ne 'observed' -or $controllerElevation.elevationType -notin @(1, 2, 3)) { throw 'Controller token could not be attested.' }
  if ($env:SPLYCE_SMOKE_APP -and (-not [IO.Path]::IsPathFullyQualified($env:SPLYCE_SMOKE_APP) -or
      [IO.Path]::GetExtension($env:SPLYCE_SMOKE_APP) -ne '.exe' -or -not (Test-Path -LiteralPath $env:SPLYCE_SMOKE_APP -PathType Leaf))) {
    throw 'SPLYCE_SMOKE_APP must name an existing absolute release executable.'
  }
  New-Item -ItemType Directory -Path $runDirectory -ErrorAction Stop | Out-Null
  $runConfig = @{
    nonce = $nonce
    mode = $Mode
    sid = $identity.User.Value
    session = $session
    userProfile = $env:USERPROFILE
    path = $env:PATH
    ci = if ($env:CI -in @('true', 'false')) { $env:CI } else { $null }
    smokeApp = if ($Mode -eq 'Smoke') { $env:SPLYCE_SMOKE_APP } else { $null }
  }
  [IO.File]::WriteAllText((Join-Path $runDirectory 'input.json'), ($runConfig | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $expected = [pscustomobject]@{
    nonce = $nonce; sid = $identity.User.Value; session = $session
    userProfile = $env:USERPROFILE; controllerElevationType = $controllerElevation.elevationType
  }
  $startedAfter = [datetime]::UtcNow
  $taskInfo = $null
  $arguments = '-NoProfile -NonInteractive -File {0} -RunDirectory {1} -Nonce {2} -Mode {3}' -f (Quote-TaskPath $worker), (Quote-TaskPath $runDirectory), $nonce, $Mode
  if ($controllerElevation.elevated -eq $false) {
    $workerProcess = Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru
    $workerExit = $workerProcess.ExitCode
  } else {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task nonce collision.' }
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $(if ($Mode -eq 'Gate') { 100 } else { 15 }))
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
    $registrationAttempted = $true
    Register-ScheduledTask -TaskName $taskName -InputObject $task -ErrorAction Stop | Out-Null
    $registeredTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($registeredTask.Principal.LogonType -ne 'Interactive' -or $registeredTask.Principal.RunLevel -ne 'Limited' -or @($registeredTask.Triggers).Count -ne 0) {
      throw 'Registered task principal or triggers differ from the requested configuration.'
    }
    $startedAfter = [datetime]::UtcNow
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $deadline = [datetime]::UtcNow.AddMinutes($(if ($Mode -eq 'Gate') { 95 } else { 12 }))
    do {
      Start-Sleep -Seconds 2
      $state = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
      if ($state.State -ne 'Running' -and (Test-Path -LiteralPath (Join-Path $runDirectory 'completion.json') -PathType Leaf)) { break }
    } while ([datetime]::UtcNow -lt $deadline)
    if ($state.State -eq 'Running') { throw 'Scheduled worker timed out.' }
  }
  $completion = Get-Content -LiteralPath (Join-Path $runDirectory 'completion.json') -Raw | ConvertFrom-Json
  $attestation = Get-Content -LiteralPath (Join-Path $runDirectory 'attestation.json') -Raw | ConvertFrom-Json
  $childExitCode = Assert-RunResult $completion $attestation $expected $taskInfo $startedAfter
  if ($null -ne $workerExit -and $workerExit -ne $childExitCode) { throw 'Direct worker exit differed from completion.' }
} catch {
  $launcherFailure = $_
} finally {
  if ($registrationAttempted) {
    try {
      $ownedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if ($ownedTask) {
        if ($ownedTask.Principal.UserId -ne $identity.Name -or
            $ownedTask.Principal.LogonType -ne 'Interactive' -or $ownedTask.Principal.RunLevel -ne 'Limited' -or
            @($ownedTask.Actions).Count -ne 1 -or $ownedTask.Actions[0].Execute -ne $shell -or
            $ownedTask.Actions[0].Arguments -ne $arguments -or $ownedTask.Actions[0].WorkingDirectory -ne $root -or
            @($ownedTask.Triggers).Count -ne 0) { throw 'Ambiguous task registration; refusing to remove another task.' }
        if ($ownedTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
      }
      if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task remains registered.' }
    } catch { $cleanupFailure = $_ }
  }
}

foreach ($name in @('stdout.log', 'stderr.log', 'worker-error.txt')) {
  $path = Join-Path $runDirectory $name
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    Write-Output "--- $name ---"
    Get-Content -LiteralPath $path
  }
}
if ($launcherFailure) { Write-Output "Launcher failed: $launcherFailure" }
if ($cleanupFailure) { Write-Output "Task cleanup failed: $cleanupFailure" }
$finalExitCode = Get-FinalExitCode $childExitCode $launcherFailure $cleanupFailure
if ($finalExitCode -eq 0) { Write-Output "Standard desktop $Mode passed; nonce=$nonce" }
exit $finalExitCode
