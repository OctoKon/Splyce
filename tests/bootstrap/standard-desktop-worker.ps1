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
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int ReadRid(IntPtr process) {
    IntPtr token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      if (!OpenProcessToken(process, 8, out token)) return -1;
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
  $rid = [StandardDesktopIntegrity]::ReadRid($process.Handle)
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
  $arguments = if ($Mode -eq 'Token') { @('--version') } elseif ($Mode -eq 'Smoke') { @('"' + $command + '"') } else { @('"' + $command + '"', 'run', 'test:release-gate') }
  $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -RedirectStandardOutput (Join-Path $RunDirectory 'stdout.log') -RedirectStandardError (Join-Path $RunDirectory 'stderr.log') -Wait -PassThru -WindowStyle Hidden
  $exitCode = $child.ExitCode
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
