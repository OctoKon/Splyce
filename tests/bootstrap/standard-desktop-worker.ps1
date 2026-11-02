param(
  [string]$RunDirectory,
  [ValidatePattern('^[0-9a-f]{32}$')][string]$Nonce,
  [ValidateSet('Token', 'Smoke', 'Gate')][string]$Mode,
  [switch]$SelfCheck
)

$ErrorActionPreference = 'Stop'

function Get-IntegrityLabel([int]$Rid) {
  if ($Rid -eq 0x2000) { return 'Medium' }
  return 'OtherOrUnknown'
}

function Test-ProfileWritable([string]$Profile, [string]$RunNonce) {
  if (-not (Test-Path -LiteralPath $Profile -PathType Container)) { throw 'User profile is unavailable.' }
  $probe = Join-Path $Profile ".splyce-standard-ci-$RunNonce.tmp"
  $handle = $null
  try {
    $handle = [IO.FileStream]::new($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
    return $true
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
  }
}

function Invoke-OwnedChild([string]$FilePath, [string[]]$ArgumentVector, [string]$WorkingDirectory,
    [string]$StandardOutputPath, [string]$StandardErrorPath) {
  $child = [Diagnostics.Process]::new()
  $cancellation = [Threading.CancellationTokenSource]::new()
  $standardOutput = $null
  $standardError = $null
  $started = $false
  try {
    # Open both owned files before launch; a collision must have no child effect.
    $standardOutput = [IO.FileStream]::new($StandardOutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 65536, $true)
    $standardError = [IO.FileStream]::new($StandardErrorPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 65536, $true)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $ArgumentVector) { $startInfo.ArgumentList.Add($argument) }
    $child.StartInfo = $startInfo
    # Start retains the creation handle; do not replace this object with a PID lookup.
    if (-not $child.Start()) { throw 'Owned child did not start.' }
    $started = $true
    $pending = [Collections.Generic.List[Threading.Tasks.Task]]::new()
    $pending.Add($child.StandardOutput.BaseStream.CopyToAsync($standardOutput, 65536, $cancellation.Token))
    $pending.Add($child.StandardError.BaseStream.CopyToAsync($standardError, 65536, $cancellation.Token))
    $pending.Add($child.WaitForExitAsync($cancellation.Token))
    while ($pending.Count -gt 0) {
      $finished = [Threading.Tasks.Task]::WhenAny($pending.ToArray()).GetAwaiter().GetResult()
      [void]$pending.Remove($finished)
      # Observe each pump immediately: WhenAll could wait forever after one pump fails.
      [void]$finished.GetAwaiter().GetResult()
    }
    $observedExitCode = $child.get_ExitCode()
    if ($null -eq $observedExitCode) { throw 'Owned child exit code is null.' }
    if ($observedExitCode -isnot [int]) { throw 'Owned child exit code is not Int32.' }
    if ($observedExitCode -lt 0 -or $observedExitCode -gt 255) {
      $nativeExit = [uint32]([long]$observedExitCode -band 4294967295L)
      throw ('Owned child exit is outside completion range: 0x' + $nativeExit.ToString('X8', [Globalization.CultureInfo]::InvariantCulture) + '.')
    }
    # This waits for the root and both streams; the controller owns descendant settlement and timeout.
    return $observedExitCode
  } catch {
    $cancellation.Cancel()
    if ($started) {
      try { if (-not $child.HasExited) { $child.Kill() } } catch { } # The controller also settles its owned job.
    }
    throw
  } finally {
    $cancellation.Cancel()
    try {
      if ($started) {
        try { $child.StandardOutput.Dispose() } finally { $child.StandardError.Dispose() }
      }
    } finally {
      try { if ($null -ne $standardOutput) { $standardOutput.Dispose() } } finally {
        try { if ($null -ne $standardError) { $standardError.Dispose() } } finally {
          $child.Dispose()
          $cancellation.Dispose()
        }
      }
    }
  }
}

if ($SelfCheck) {
  if ((Get-IntegrityLabel 0x2000) -ne 'Medium') { throw 'Exact medium integrity was rejected.' }
  foreach ($rid in @(0x2100, 0x2001, 0x1000, 0x3000, -1)) {
    if ((Get-IntegrityLabel $rid) -ne 'OtherOrUnknown') { throw 'Non-medium integrity RID was accepted.' }
  }
  $testDirectory = Join-Path ([IO.Path]::GetTempPath()) ("splyce-profile-probe-" + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($testDirectory) | Out-Null
  $testNonce = [guid]::NewGuid().ToString('N')
  $sentinel = Join-Path $testDirectory ".splyce-standard-ci-$testNonce.tmp"
  $bytes = [byte[]](17, 0, 255, 42)
  try {
    [IO.File]::WriteAllBytes($sentinel, $bytes)
    $refused = $false
    try { Test-ProfileWritable $testDirectory $testNonce | Out-Null } catch [IO.IOException] { $refused = $true }
    if (-not $refused -or -not [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($sentinel), $bytes)) {
      throw 'Profile probe altered a preexisting sentinel.'
    }
    [IO.File]::Delete($sentinel)
    if (-not (Test-ProfileWritable $testDirectory $testNonce) -or (Test-Path -LiteralPath $sentinel)) {
      throw 'Profile probe did not remove its owned file.'
    }
  } finally {
    if (Test-Path -LiteralPath $sentinel -PathType Leaf) { [IO.File]::Delete($sentinel) }
    [IO.Directory]::Delete($testDirectory, $false)
  }
  Write-Output 'Profile probe collision selfcheck passed.'
  $root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
  $node = Join-Path $root 'apps/desktop/src-tauri/resources/engine/node.exe'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Pinned Node is required for the owned child selfcheck.' }
  $nodeVersion = (Get-Content -LiteralPath (Join-Path $root '.node-version') -Raw).Trim()
  $pins = Get-Content -LiteralPath (Join-Path $root 'runtime-pins.json') -Raw | ConvertFrom-Json
  if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$' -or $pins.node.version -ne $nodeVersion -or $pins.node.target -ne 'win-x64') {
    throw 'Node selfcheck version does not match the repository pin.'
  }
  $childDirectory = Join-Path ([IO.Path]::GetTempPath()) ('splyce-process-probe-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($childDirectory) | Out-Null
  try {
    $stdout = Join-Path $childDirectory 'stdout with spaces.log'
    $stderr = Join-Path $childDirectory 'stderr with spaces.log'
    $script = 'if (process.argv[1] !== "argument with spaces") throw new Error("argument boundary"); process.stdout.write("out".repeat(32768)); process.stderr.write("err".repeat(32768)); process.exitCode = 7;'
    $actualExit = Invoke-OwnedChild $node @('-e', $script, 'argument with spaces') $root $stdout $stderr
    if ($actualExit -isnot [int] -or $actualExit -ne 7 -or [IO.File]::ReadAllText($stdout) -cne ('out' * 32768) -or
        [IO.File]::ReadAllText($stderr) -cne ('err' * 32768)) {
      throw 'Owned child did not preserve both streams, argument boundaries, and nonzero exit.'
    }
    foreach ($collision in @('stdout', 'stderr')) {
      $collisionOut = Join-Path $childDirectory "$collision-out.log"
      $collisionErr = Join-Path $childDirectory "$collision-err.log"
      $marker = Join-Path $childDirectory "$collision-launched.txt"
      $collisionPath = if ($collision -eq 'stdout') { $collisionOut } else { $collisionErr }
      [IO.File]::WriteAllBytes($collisionPath, $bytes)
      $refused = $false
      try {
        Invoke-OwnedChild $node @('-e', 'require("node:fs").writeFileSync(process.argv[1], "launched");', $marker) $root $collisionOut $collisionErr | Out-Null
      } catch [IO.IOException] { $refused = $true }
      if (-not $refused -or -not [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($collisionPath), $bytes) -or
          (Test-Path -LiteralPath $marker)) {
        throw 'Owned child output collision did not refuse launch and preserve its sentinel.'
      }
    }
    $versionOut = Join-Path $childDirectory 'version-out.log'
    $versionErr = Join-Path $childDirectory 'version-err.log'
    $versionExit = Invoke-OwnedChild $node @('--version') $root $versionOut $versionErr
    if ($versionExit -ne 0 -or [IO.File]::ReadAllText($versionOut).Trim() -cne "v$nodeVersion" -or [IO.File]::ReadAllBytes($versionErr).Length -ne 0) {
      throw 'Owned child did not report the pinned Node version.'
    }
  } finally {
    foreach ($name in @('stdout with spaces.log', 'stderr with spaces.log', 'stdout-out.log', 'stdout-err.log', 'stdout-launched.txt',
        'stderr-out.log', 'stderr-err.log', 'stderr-launched.txt', 'version-out.log', 'version-err.log')) {
      $ownedPath = Join-Path $childDirectory $name
      if (Test-Path -LiteralPath $ownedPath -PathType Leaf) { [IO.File]::Delete($ownedPath) }
    }
    [IO.Directory]::Delete($childDirectory, $false)
  }
  Write-Output 'Owned child streams, collision refusal, exit, and pinned version selfcheck passed.'
  return
}

if (-not $RunDirectory -or -not $Nonce -or -not $Mode) { throw 'RunDirectory, Nonce, and Mode are required.' }
$exitCode = 1
$status = 'failed'
$validRunDirectory = $false
try {
  $root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
  $expectedDirectory = Join-Path $root "apps/desktop/src-tauri/target/bootstrap-standard-ci/$Nonce"
  if ([IO.Path]::GetFullPath($RunDirectory) -ne [IO.Path]::GetFullPath($expectedDirectory)) { throw 'Unexpected run directory.' }
  $validRunDirectory = $true
  $runConfig = Get-Content -LiteralPath (Join-Path $RunDirectory 'input.json') -Raw | ConvertFrom-Json
  if ($runConfig.nonce -ne $Nonce -or $runConfig.mode -ne $Mode) { throw 'Input nonce or mode mismatch.' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $process = [Diagnostics.Process]::GetCurrentProcess()
  $creationMs = [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  $elevation = & (Join-Path $PSScriptRoot 'process-elevation.ps1') -ProcessId $PID -CreationTimeMs $creationMs -Details | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StandardDesktopIntegrity {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public sealed class AccessResult { public bool Success { get; set; } public int Win32Error { get; set; } }
  static AccessResult ProbeProcess(uint access) {
    IntPtr handle = OpenProcess(access, false, GetCurrentProcessId());
    int error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    try { return new AccessResult { Success = handle != IntPtr.Zero, Win32Error = error }; }
    finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
  }
  static AccessResult ProbeToken(int access) {
    IntPtr handle = IntPtr.Zero;
    bool opened = OpenProcessToken(GetCurrentProcess(), access, out handle);
    int error = opened ? 0 : Marshal.GetLastWin32Error();
    try { return new AccessResult { Success = opened, Win32Error = error }; }
    finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
  }
  public static System.Collections.Generic.Dictionary<string, AccessResult> ReadSelfAccess() {
    return new System.Collections.Generic.Dictionary<string, AccessResult> {
      { "processLimitedQuery", ProbeProcess(0x1000) }, { "processAllAccess", ProbeProcess(0x1FFFFF) },
      { "tokenQuery", ProbeToken(8) }, { "tokenDuplicate", ProbeToken(2) }
    };
  }
  public static int ReadRid() {
    IntPtr token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) return -1;
      int length;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
      if (length <= 0) return -1;
      buffer = Marshal.AllocHGlobal(length);
      if (!GetTokenInformation(token, 25, buffer, length, out length)) return -1;
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      byte count = Marshal.ReadByte(sid, 1);
      if (count == 0) return -1;
      return Marshal.ReadInt32(sid, 8 + 4 * (count - 1));
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }
}
'@
  $rid = [StandardDesktopIntegrity]::ReadRid()
  $selfAccess = @{}
  foreach ($entry in [StandardDesktopIntegrity]::ReadSelfAccess().GetEnumerator()) { $selfAccess[$entry.Key] = $entry.Value }
  $selfAccess.powerShellVersion = $PSVersionTable.PSVersion.ToString()
  $selfAccess.managementModuleVersion = (Get-Command Start-Process -CommandType Cmdlet).Module.Version.ToString()
  $selfAccess.dotNetVersion = [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
  [IO.File]::WriteAllText((Join-Path $RunDirectory 'diagnostics/self-access.json'), ($selfAccess | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $profileSame = [IO.Path]::GetFullPath($env:USERPROFILE) -eq [IO.Path]::GetFullPath([string]$runConfig.userProfile)
  $profileWritable = Test-ProfileWritable $env:USERPROFILE $Nonce
  $attestation = @{
    nonce = $Nonce
    sid = $identity.User.Value
    session = $process.SessionId
    userProfile = $env:USERPROFILE
    profileWritable = $profileWritable
    elevated = $elevation.elevated
    elevationType = $elevation.elevationType
    integrity = Get-IntegrityLabel $rid
  }
  [IO.File]::WriteAllText((Join-Path $RunDirectory 'attestation.json'), ($attestation | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  if ($runConfig.sid -ne $attestation.sid -or $runConfig.session -ne $attestation.session -or -not $profileSame -or -not $profileWritable -or
      $elevation.status -ne 'observed' -or $attestation.elevated -ne $false -or
      $attestation.elevationType -notin @(1, 3) -or $attestation.integrity -ne 'Medium') {
    throw 'Worker token did not attest to the current medium-integrity session.'
  }
  $env:PATH = [string]$runConfig.path
  if ($runConfig.ci -in @('true', 'false')) { $env:CI = $runConfig.ci }
  else { Remove-Item Env:CI -ErrorAction SilentlyContinue }
  if ($Mode -eq 'Gate') {
    $env:RUSTUP_TOOLCHAIN = '1.99.1'
    $env:CARGO_BUILD_JOBS = '1'
    Remove-Item Env:SPLYCE_SMOKE_APP -ErrorAction SilentlyContinue
  } elseif ($runConfig.smokeApp) {
    if (-not [IO.Path]::IsPathFullyQualified($runConfig.smokeApp) -or [IO.Path]::GetExtension($runConfig.smokeApp) -ne '.exe' -or
        -not (Test-Path -LiteralPath $runConfig.smokeApp -PathType Leaf)) { throw 'SPLYCE_SMOKE_APP is invalid.' }
    $env:SPLYCE_SMOKE_APP = $runConfig.smokeApp
  } else { Remove-Item Env:SPLYCE_SMOKE_APP -ErrorAction SilentlyContinue }
  $node = Join-Path $root 'apps/desktop/src-tauri/resources/engine/node.exe'
  $command = if ($Mode -eq 'Token') { $node } elseif ($Mode -eq 'Smoke') { Join-Path $root 'tests/bootstrap/release-smoke.mjs' } else { Join-Path $root 'apps/desktop/src-tauri/target/build-tools/node_modules/npm/bin/npm-cli.js' }
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $command -PathType Leaf)) { throw 'Pinned command is missing.' }
  $arguments = if ($Mode -eq 'Token') { @('--version') } elseif ($Mode -eq 'Smoke') { @($command) } else { @($command, 'run', 'test:release-gate') }
  $exitCode = Invoke-OwnedChild $node $arguments $root (Join-Path $RunDirectory 'stdout.log') (Join-Path $RunDirectory 'stderr.log')
  $status = 'completed'
} catch {
  if ($validRunDirectory) { [IO.File]::WriteAllText((Join-Path $RunDirectory 'worker-error.txt'), $_.ToString(), [Text.UTF8Encoding]::new($false)) }
} finally {
  if ($validRunDirectory) {
    $completion = @{ nonce = $Nonce; status = $status; exitCode = $exitCode }
    [IO.File]::WriteAllText((Join-Path $RunDirectory 'completion.json'), ($completion | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  }
}
exit $exitCode
