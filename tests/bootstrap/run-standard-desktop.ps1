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

function Get-RootTask([string]$Name, [scriptblock]$Enumerate = { Get-ScheduledTask -TaskPath '\' -ErrorAction Stop }) {
  $matches = @(& $Enumerate | Where-Object { $_.TaskName -eq $Name -and $_.TaskPath -eq '\' })
  if ($matches.Count -gt 1) { throw 'Duplicate root task identity.' }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Assert-OwnedTask($Task, $Expected) {
  if ($null -eq $Task -or $Task.TaskName -ne $Expected.name -or $Task.TaskPath -ne '\' -or
      $Task.Principal.UserId -ne $Expected.user -or $Task.Principal.LogonType -ne 'Interactive' -or
      $Task.Principal.RunLevel -ne 'Limited' -or @($Task.Actions | Where-Object { $null -ne $_ }).Count -ne 1 -or
      $Task.Actions[0].Execute -ne $Expected.shell -or $Task.Actions[0].Arguments -ne $Expected.arguments -or
      $Task.Actions[0].WorkingDirectory -ne $Expected.root -or
      @($Task.Triggers | Where-Object { $null -ne $_ }).Count -ne 0) {
    throw 'Task ownership, action, principal, or triggers differ.'
  }
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
  foreach ($change in @(
    @{ key = 'sid'; value = 'wrong' }, @{ key = 'session'; value = 2 },
    @{ key = 'userProfile'; value = 'C:\Users\wrong' }, @{ key = 'profileWritable'; value = $false },
    @{ key = 'elevated'; value = $true }, @{ key = 'integrity'; value = 'High' },
    @{ key = 'elevationType'; value = 1 }
  )) {
    $badToken = $attestation | ConvertTo-Json | ConvertFrom-Json
    $badToken.($change.key) = $change.value
    $rejected = $false
    try { Assert-RunResult $completion $badToken $expected $fresh $started | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid token field $($change.key) was accepted." }
  }
  $lookupFailed = $false
  try { Get-RootTask 'selfcheck' { throw 'lookup unavailable' } | Out-Null } catch { $lookupFailed = $true }
  if (-not $lookupFailed -or (Get-FinalExitCode 0 $null $(if ($lookupFailed) { 'lookup failed' })) -ne 1) {
    throw 'Task lookup errors must block success.'
  }
  $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $taskAction = New-ScheduledTaskAction -Execute 'C:\Program Files\Splyce & CI\pwsh.exe' -Argument $quoted -WorkingDirectory 'C:\repo'
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskIdentity.User.Value -LogonType Interactive -RunLevel Limited
  $taskDefinition = New-ScheduledTask -Action $taskAction -Principal $taskPrincipal
  $taskExpected = [pscustomobject]@{ name = 'selfcheck'; user = $taskIdentity.Name; sid = $taskIdentity.User.Value; shell = $taskAction.Execute; arguments = $taskAction.Arguments; root = $taskAction.WorkingDirectory }
  $taskObserved = [pscustomobject]@{ TaskName = 'selfcheck'; TaskPath = '\'; Principal = $taskDefinition.Principal; Actions = $taskDefinition.Actions; Triggers = $taskDefinition.Triggers }
  $materializedPrincipalSid = if ($taskObserved.Principal.UserId -match '^S-\d+(?:-\d+)+$') {
    [Security.Principal.SecurityIdentifier]::new($taskObserved.Principal.UserId).Value
  } else {
    ([Security.Principal.NTAccount]::new($taskObserved.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  if ($materializedPrincipalSid -ne $taskExpected.sid) { throw 'Principal representation regression setup failed.' }
  $nativeLiteralExpected = [pscustomobject]@{ name = $taskExpected.name; user = $taskObserved.Principal.UserId; sid = $taskExpected.sid; shell = $taskExpected.shell; arguments = $taskExpected.arguments; root = $taskExpected.root }
  try { Assert-OwnedTask $taskObserved $nativeLiteralExpected } catch { throw 'Native principal fixture failed its literal-positive control.' }
  try { Assert-OwnedTask $taskObserved $taskExpected } catch { throw 'Equivalent current-account native principal representation was rejected.' }
  $sidTaskObserved = [pscustomobject]@{ TaskName = $taskObserved.TaskName; TaskPath = $taskObserved.TaskPath; Principal = [pscustomobject]@{ UserId = $taskExpected.sid; LogonType = $taskDefinition.Principal.LogonType; RunLevel = $taskDefinition.Principal.RunLevel }; Actions = $taskObserved.Actions; Triggers = $taskObserved.Triggers }
  if ($sidTaskObserved.Principal.UserId -eq $taskExpected.user) { throw 'SID representation regression setup failed.' }
  $sidLiteralExpected = [pscustomobject]@{ name = $taskExpected.name; user = $taskExpected.sid; sid = $taskExpected.sid; shell = $taskExpected.shell; arguments = $taskExpected.arguments; root = $taskExpected.root }
  try { Assert-OwnedTask $sidTaskObserved $sidLiteralExpected } catch { throw 'SID fixture failed its literal-positive control.' }
  try { Assert-OwnedTask $sidTaskObserved $taskExpected } catch { throw 'Equivalent current-account SID representation was rejected.' }
  $sidTaskObserved.Principal.UserId = $taskIdentity.Name
  Assert-OwnedTask $sidTaskObserved $taskExpected
  $wrongSid = if ($taskExpected.sid -ne 'S-1-0-0') { 'S-1-0-0' } else { 'S-1-5-18' }
  $unknownPrincipal = $env:COMPUTERNAME + '\splyce-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
  foreach ($change in @(
    @{ key = 'UserId'; value = $wrongSid; label = 'wrong SID' },
    @{ key = 'UserId'; value = $unknownPrincipal; label = 'unresolved principal' },
    @{ key = 'Execute'; value = 'C:\other.exe'; label = 'executable' },
    @{ key = 'Trigger'; value = [pscustomobject]@{ enabled = $true }; label = 'trigger' }
  )) {
    $badTask = [pscustomobject]@{ TaskName = 'selfcheck'; TaskPath = '\'; Principal = [pscustomobject]@{ UserId = $taskExpected.user; LogonType = 'Interactive'; RunLevel = 'Limited' }; Actions = @([pscustomobject]@{ Execute = $taskExpected.shell; Arguments = $taskExpected.arguments; WorkingDirectory = $taskExpected.root }); Triggers = $null }
    if ($change.key -eq 'UserId') { $badTask.Principal.UserId = $change.value }
    elseif ($change.key -eq 'Execute') { $badTask.Actions[0].Execute = $change.value }
    else { $badTask.Triggers = @($change.value) }
    $rejected = $false
    try { Assert-OwnedTask $badTask $taskExpected } catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid task $($change.label) was accepted." }
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
$completion = $null
$attestation = $null
$attestationValidated = $false
$receiptStream = $null
$receiptFailure = $null
$finalExitCode = 1

try {
  if (-not [OperatingSystem]::IsWindows()) { throw 'Windows is required.' }
  New-Item -ItemType Directory -Path $runDirectory -ErrorAction Stop | Out-Null
  $diagnostics = Join-Path $runDirectory 'diagnostics'
  New-Item -ItemType Directory -Path $diagnostics -ErrorAction Stop | Out-Null
  $receiptStream = [IO.FileStream]::new((Join-Path $diagnostics 'result.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
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
  $taskExpected = [pscustomobject]@{ name = $taskName; user = $identity.Name; shell = $shell; arguments = $arguments; root = $root }
  if ($controllerElevation.elevated -eq $false) {
    $workerProcess = Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru
    $workerExit = $workerProcess.ExitCode
  } else {
    if (Get-RootTask $taskName) { throw 'Task nonce collision.' }
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $(if ($Mode -eq 'Gate') { 100 } else { 15 }))
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
    $registrationAttempted = $true
    Register-ScheduledTask -TaskName $taskName -InputObject $task -ErrorAction Stop | Out-Null
    $registeredTask = Get-RootTask $taskName
    Assert-OwnedTask $registeredTask $taskExpected
    $startedAfter = [datetime]::UtcNow
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $deadline = [datetime]::UtcNow.AddMinutes($(if ($Mode -eq 'Gate') { 95 } else { 12 }))
    do {
      Start-Sleep -Seconds 2
      $state = Get-RootTask $taskName
      Assert-OwnedTask $state $taskExpected
      $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
      if ($state.State -ne 'Running' -and (Test-Path -LiteralPath (Join-Path $runDirectory 'completion.json') -PathType Leaf)) { break }
    } while ([datetime]::UtcNow -lt $deadline)
    if ($state.State -eq 'Running') { throw 'Scheduled worker timed out.' }
  }
  $completion = Get-Content -LiteralPath (Join-Path $runDirectory 'completion.json') -Raw | ConvertFrom-Json
  $attestation = Get-Content -LiteralPath (Join-Path $runDirectory 'attestation.json') -Raw | ConvertFrom-Json
  $childExitCode = Assert-RunResult $completion $attestation $expected $taskInfo $startedAfter
  if ($null -ne $workerExit -and $workerExit -ne $childExitCode) { throw 'Direct worker exit differed from completion.' }
  $attestationValidated = $true
} catch {
  $launcherFailure = $_
} finally {
  if ($registrationAttempted) {
    try {
      $ownedTask = Get-RootTask $taskName
      if ($ownedTask) {
        Assert-OwnedTask $ownedTask $taskExpected
        if ($ownedTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
      }
      if (Get-RootTask $taskName) { throw 'Task remains registered.' }
    } catch { $cleanupFailure = $_ }
  }
  $finalExitCode = Get-FinalExitCode $childExitCode $launcherFailure $cleanupFailure
  try {
    if ($null -eq $receiptStream) { throw 'Diagnostic receipt handle was not opened.' }
    $receipt = @{
      schemaVersion = 1
      mode = $Mode
      finalExitCode = $finalExitCode
      attestationValidated = $attestationValidated
      token = @{
        integrity = if ($attestation.integrity -in @('Medium', 'OtherOrUnknown')) { $attestation.integrity } else { $null }
        elevated = if ($attestation.elevated -is [bool]) { $attestation.elevated } else { $null }
        elevationType = if ($attestation.elevationType -in @(1, 2, 3)) { [int]$attestation.elevationType } else { $null }
        profileWritable = if ($attestation.profileWritable -is [bool]) { $attestation.profileWritable } else { $null }
      }
      taskCleanupSucceeded = $null -eq $cleanupFailure
      completion = @{
        status = if ($completion.status -in @('completed', 'failed')) { $completion.status } else { $null }
        exitCode = if (($completion.exitCode -is [int] -or $completion.exitCode -is [long]) -and
            $completion.exitCode -ge 0 -and $completion.exitCode -le 255) { [int]$completion.exitCode } else { $null }
      }
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 4 -Compress))
    $receiptStream.Write($bytes, 0, $bytes.Length)
    $receiptStream.Flush($true)
  } catch {
    $receiptFailure = $_
    $finalExitCode = 1
  } finally {
    if ($null -ne $receiptStream) { $receiptStream.Dispose() }
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
if ($receiptFailure) { Write-Output "Diagnostic receipt failed: $receiptFailure" }
if ($finalExitCode -eq 0) { Write-Output "Standard desktop $Mode passed; nonce=$nonce" }
exit $finalExitCode
