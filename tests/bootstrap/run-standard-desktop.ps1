param(
  [ValidateSet('Token', 'Smoke', 'Gate')][string]$Mode = 'Smoke',
  [switch]$SelfCheck
)

$ErrorActionPreference = 'Stop'

function Assert-RunResult($Completion, $Attestation, $Expected, $WorkerExit) {
  if ($null -eq $Completion -or $null -eq $Attestation -or
      $Attestation.elevated -isnot [bool] -or $Attestation.profileWritable -isnot [bool] -or
      ($Attestation.elevationType -isnot [int] -and $Attestation.elevationType -isnot [long]) -or
      ($Attestation.session -isnot [int] -and $Attestation.session -isnot [long]) -or
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
  if ($null -eq $WorkerExit -or $WorkerExit -ne $Completion.exitCode) {
    throw 'Worker exit differed from completion.'
  }
  [int]$Completion.exitCode
}

function Get-FinalExitCode([int]$ChildExitCode, $LauncherFailure, $CleanupFailure) {
  if ($LauncherFailure -or $CleanupFailure) { return 1 }
  return $ChildExitCode
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
public static class StandardDesktopLauncher {
  const uint WorkerCreationFlags = 0x00000004; // Assign the suspended worker to its job before any worker code runs.
  [StructLayout(LayoutKind.Sequential)] struct Label { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  public sealed class Observation {
    public string Sid { get; internal set; } public int Session { get; internal set; }
    public int ElevationType { get; internal set; } public bool Elevated { get; internal set; }
    public string Integrity { get; internal set; }
  }
  public static Observation Controller { get; private set; }
  public static Observation Derived { get; private set; }
  public static Observation Child { get; private set; }
  public static uint? NativeExitCode { get; private set; }
  public static string NativeExitHex { get { return FormatExit(NativeExitCode); } }
  public static bool CleanupSucceeded { get; private set; } = true;
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int returned);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr primary);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabled, IntPtr sids, uint deleted, IntPtr privileges, uint restricted, IntPtr restricting, out IntPtr result);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSidW(string text, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr label, int size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
  static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static string FormatExit(uint? exit) { return exit.HasValue ? "0x" + exit.Value.ToString("X8", System.Globalization.CultureInfo.InvariantCulture) : null; }
  static IntPtr Info(IntPtr token, int kind, int expectedSize = 0) {
    int length;
    bool probe = GetTokenInformation(token, kind, IntPtr.Zero, 0, out length);
    int error = Marshal.GetLastWin32Error();
    if (probe || (error != 122 && error != 24) || length <= 0 || length > 65536 || (expectedSize != 0 && length != expectedSize)) throw new InvalidOperationException("Invalid token information length: kind=" + kind + "; bytes=" + length + "; error=" + error);
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try { int returned; Check(GetTokenInformation(token, kind, buffer, length, out returned), "Read token information");
      if (returned != length) throw new InvalidOperationException("Incomplete token information."); return buffer;
    } catch { Marshal.FreeHGlobal(buffer); throw; }
  }
  static int Scalar(IntPtr token, int kind) {
    IntPtr buffer = Info(token, kind, 4);
    try { return Marshal.ReadInt32(buffer); } finally { Marshal.FreeHGlobal(buffer); }
  }
  static string ClassifyIntegrity(int rid) { return rid == 0x2000 ? "Medium" : "OtherOrUnknown"; }
  static Observation Inspect(IntPtr token) {
    IntPtr user = Info(token, 1), label = IntPtr.Zero;
    try {
      IntPtr sid = Marshal.ReadIntPtr(user); if (!IsValidSid(sid)) throw new InvalidOperationException("Invalid user SID.");
      label = Info(token, 25); IntPtr integritySid = Marshal.ReadIntPtr(label);
      if (!IsValidSid(integritySid)) throw new InvalidOperationException("Invalid integrity SID.");
      byte count = Marshal.ReadByte(integritySid, 1);
      if (count == 0) throw new InvalidOperationException("Missing integrity RID.");
      int rid = Marshal.ReadInt32(integritySid, 8 + 4 * (count - 1));
      int elevated = Scalar(token, 20), type = Scalar(token, 18);
      if ((elevated != 0 && elevated != 1) || type < 1 || type > 3 || Scalar(token, 8) != 1) throw new InvalidOperationException("Malformed primary token.");
      return new Observation { Sid = new SecurityIdentifier(sid).Value, Session = Scalar(token, 12), Elevated = elevated == 1, ElevationType = type, Integrity = ClassifyIntegrity(rid) };
    } finally { Marshal.FreeHGlobal(user); if (label != IntPtr.Zero) Marshal.FreeHGlobal(label); }
  }
  static void RequireWorker(Observation candidate, Observation owner) {
    if (candidate.Sid != owner.Sid || candidate.Session != owner.Session || candidate.Session <= 0 || candidate.Elevated || candidate.Integrity != "Medium" ||
        (candidate.ElevationType != 1 && candidate.ElevationType != 3) || (owner.ElevationType == 2 && candidate.ElevationType != 3))
      throw new InvalidOperationException("Derived token failed current-user medium-session validation.");
  }
  static IntPtr Restrict(IntPtr source) {
    IntPtr restricted = IntPtr.Zero, mediumSid = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      // Only the new token is restricted; policy enforcement stays enabled.
      Check(CreateRestrictedToken(source, 0x5, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted), "Restrict current-user token");
      Check(ConvertStringSidToSidW("S-1-16-8192", out mediumSid), "Create medium integrity SID");
      int labelSize = Marshal.SizeOf<Label>(), sidSize = checked((int)GetLengthSid(mediumSid)), size = checked(labelSize + sidSize);
      buffer = Marshal.AllocHGlobal(size);
      var bytes = new byte[sidSize]; Marshal.Copy(mediumSid, bytes, 0, sidSize);
      IntPtr copiedSid = IntPtr.Add(buffer, labelSize); Marshal.Copy(bytes, 0, copiedSid, sidSize);
      Marshal.StructureToPtr(new Label { Sid = copiedSid, Attributes = 0x20 }, buffer, false);
      Check(SetTokenInformation(restricted, 25, buffer, size), "Set derived token integrity");
      return restricted;
    } catch { if (restricted != IntPtr.Zero) CloseHandle(restricted); throw; }
    finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); if (mediumSid != IntPtr.Zero) LocalFree(mediumSid); }
  }
  static string Quote(string path) {
    if (!Path.IsPathFullyQualified(path) || path.IndexOfAny(new char[] {'"', '\r', '\n', '\0'}) >= 0) throw new ArgumentException("Expected absolute path.");
    int trailing = path.Length - path.TrimEnd('\\').Length;
    return "\"" + path + new string('\\', trailing) + "\"";
  }
  static Startup HiddenStartup() { return new Startup { Size = Marshal.SizeOf<Startup>(), Desktop = "winsta0\\default", Flags = 1, Show = 0 }; }
  static int Launch(string shell, string root, string runDirectory, string nonce, string mode, bool failBeforeResume) {
    if (!Regex.IsMatch(nonce, "\\A[0-9a-f]{32}\\z") || (mode != "Token" && mode != "Smoke" && mode != "Gate")) throw new ArgumentException("Invalid fixed worker invocation.");
    string worker = Path.Combine(root, "tests", "bootstrap", "standard-desktop-worker.ps1");
    string expectedDirectory = Path.Combine(root, "apps", "desktop", "src-tauri", "target", "bootstrap-standard-ci", nonce);
    if (!String.Equals(Path.GetFullPath(runDirectory), Path.GetFullPath(expectedDirectory), StringComparison.OrdinalIgnoreCase) || !File.Exists(worker) || !File.Exists(shell) || !String.Equals(Path.GetFileName(shell), "pwsh.exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid fixed worker paths.");
    var command = new StringBuilder(Quote(shell) + " -NoProfile -NonInteractive -File " + Quote(worker) + " -RunDirectory " + Quote(runDirectory) + " -Nonce " + nonce + " -Mode " + mode);
    IntPtr current = IntPtr.Zero, linked = IntPtr.Zero, primary = IntPtr.Zero, restricted = IntPtr.Zero, job = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo(); bool assigned = false;
    CleanupSucceeded = true; Derived = null; Child = null; NativeExitCode = null;
    try {
      Check(OpenProcessToken(GetCurrentProcess(), 0x8B, out current), "Open current primary token");
      Controller = Inspect(current);
      if (Controller.Session <= 0) throw new InvalidOperationException("Interactive current-user session required.");
      if (Controller.Elevated) {
        IntPtr source = current;
        if (Controller.ElevationType == 2) {
          IntPtr buffer = Info(current, 19, IntPtr.Size);
          try { linked = Marshal.ReadIntPtr(buffer); } finally { Marshal.FreeHGlobal(buffer); }
          if (linked == IntPtr.Zero) throw new InvalidOperationException("Linked token unavailable.");
          Observation limited = Inspect(linked);
          if (limited.Sid != Controller.Sid || limited.Session != Controller.Session || limited.Elevated || limited.ElevationType != 3) throw new InvalidOperationException("Linked token is not the current limited token.");
          Check(DuplicateTokenEx(linked, 0x8B, IntPtr.Zero, 2, 1, out primary), "Duplicate linked primary token"); source = primary;
        } else if (Controller.ElevationType != 1) throw new InvalidOperationException("Unexpected elevated token type.");
        restricted = Restrict(source);
        Derived = Inspect(restricted); RequireWorker(Derived, Controller);
      } else { RequireWorker(Controller, Controller); Derived = Controller; }
      job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Create owned worker job");
      var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<ExtendedLimits>()), "Set kill-on-close job");
      var startup = HiddenStartup();
      if (Controller.Elevated) Check(CreateProcessAsUserW(restricted, shell, command, IntPtr.Zero, IntPtr.Zero, false, WorkerCreationFlags, IntPtr.Zero, root, ref startup, out child), "Create restricted worker");
      else Check(CreateProcessW(shell, command, IntPtr.Zero, IntPtr.Zero, false, WorkerCreationFlags, IntPtr.Zero, root, ref startup, out child), "Create standard worker");
      Check(AssignProcessToJobObject(job, child.Process), "Assign suspended worker job"); assigned = true;
      IntPtr childToken = IntPtr.Zero;
      try {
        Check(OpenProcessToken(child.Process, 8, out childToken), "Inspect suspended worker token");
        Child = Inspect(childToken); RequireWorker(Child, Controller);
      } finally { if (childToken != IntPtr.Zero) CloseHandle(childToken); }
      if (failBeforeResume) throw new InvalidOperationException("Selfcheck: before-resume failure.");
      Check(ResumeThread(child.Thread) != 0xFFFFFFFF, "Resume owned worker");
      uint waited = WaitForSingleObject(child.Process, mode == "Gate" ? 5700000u : mode == "Token" ? 120000u : 720000u);
      if (waited == 258) throw new TimeoutException("Owned worker timed out.");
      Check(waited == 0, "Wait for owned worker");
      uint exit; Check(GetExitCodeProcess(child.Process, out exit), "Read exact worker exit");
      NativeExitCode = exit;
      if (exit > 255) throw new InvalidOperationException("Worker exit is outside completion range: " + NativeExitHex + ".");
      return (int)exit;
    } finally {
      try {
        if (assigned) {
          Check(TerminateJobObject(job, 1), "Settle owned worker descendants");
          var timer = Stopwatch.StartNew(); Accounting accounting;
          do { Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf<Accounting>(), IntPtr.Zero), "Verify owned job cleanup");
            if (accounting.ActiveProcesses == 0) break; Thread.Sleep(20);
          } while (timer.ElapsedMilliseconds < 5000);
          if (accounting.ActiveProcesses != 0) throw new InvalidOperationException("Owned job still has active processes.");
        } else if (child.Process != IntPtr.Zero) {
          Check(TerminateProcess(child.Process, 1), "Terminate unstarted owned worker");
          Check(WaitForSingleObject(child.Process, 5000) == 0, "Verify unstarted worker cleanup");
        }
      } catch { CleanupSucceeded = false; throw; }
      finally {
        if (job != IntPtr.Zero) CloseHandle(job);
        if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
        if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
        if (restricted != IntPtr.Zero) CloseHandle(restricted);
        if (primary != IntPtr.Zero) CloseHandle(primary);
        if (linked != IntPtr.Zero) CloseHandle(linked);
        if (current != IntPtr.Zero) CloseHandle(current);
      }
    }
  }
  public static int RunWorker(string shell, string root, string directory, string nonce, string mode) { return Launch(shell, root, directory, nonce, mode, false); }
  public static bool SelfCheck(string shell, string root) {
    Startup startup = HiddenStartup();
    if (WorkerCreationFlags != 0x00000004 || startup.Flags != 1 || startup.Show != 0) throw new InvalidOperationException("Suspended hidden worker flags selfcheck failed.");
    if (FormatExit(null) != null || FormatExit(0) != "0x00000000" || FormatExit(255) != "0x000000FF" ||
        FormatExit(0xC0000142) != "0xC0000142" || FormatExit(uint.MaxValue) != "0xFFFFFFFF") throw new InvalidOperationException("Native exit formatting selfcheck failed.");
    if (ClassifyIntegrity(0x2000) != "Medium") throw new InvalidOperationException("Exact medium integrity was rejected.");
    foreach (int rid in new int[] { 0x2100, 0x2001, 0x1000, 0x3000, -1 })
      if (ClassifyIntegrity(rid) != "OtherOrUnknown") throw new InvalidOperationException("Non-medium integrity RID was accepted.");
    if (Quote(@"C:\Program Files\Splyce & CI\") != "\"C:\\Program Files\\Splyce & CI\\\\\"") throw new InvalidOperationException("Windows argument quoting failed.");
    var owner = new Observation { Sid = "same", Session = 1, Elevated = true, ElevationType = 2, Integrity = "OtherOrUnknown" };
    var valid = new Observation { Sid = "same", Session = 1, Elevated = false, ElevationType = 3, Integrity = "Medium" };
    RequireWorker(valid, owner);
    for (int change = 0; change < 7; change++) {
      var invalid = new Observation { Sid = "same", Session = 1, Elevated = false, ElevationType = 3, Integrity = "Medium" };
      if (change == 0) invalid.Sid = "other";
      if (change == 1) invalid.Session = 2;
      if (change == 2) invalid.Elevated = true;
      if (change == 3) invalid.Integrity = "High";
      if (change == 4) invalid.Integrity = "Low";
      if (change == 5) invalid.Integrity = "OtherOrUnknown";
      if (change == 6) invalid.ElevationType = 1;
      bool refused = false;
      try { RequireWorker(invalid, owner); } catch (InvalidOperationException) { refused = true; }
      if (!refused) throw new InvalidOperationException("Native token guard selfcheck failed: case=" + change);
    }
    IntPtr current, derived = IntPtr.Zero;
    Check(OpenProcessToken(GetCurrentProcess(), 0x8B, out current), "Inspect selfcheck current token");
    try {
      Observation observed = Inspect(current);
      if (observed.Elevated) return false;
      derived = Restrict(current); RequireWorker(Inspect(derived), observed);
    } finally { if (derived != IntPtr.Zero) CloseHandle(derived); CloseHandle(current); }
    string nonce = Guid.NewGuid().ToString("N"), directory = Path.Combine(root, "apps", "desktop", "src-tauri", "target", "bootstrap-standard-ci", nonce);
    bool rejected = false;
    try { Launch(shell, root, directory, nonce, "Token", true); }
    catch (InvalidOperationException error) { if (error.Message != "Selfcheck: before-resume failure.") throw; rejected = true; }
    if (!rejected || !CleanupSucceeded || Child == null || NativeExitCode.HasValue || NativeExitHex != null) throw new InvalidOperationException("Before-resume cleanup or missing-exit selfcheck failed.");
    RequireWorker(Child, Controller);
    return true;
  }
}
'@

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($SelfCheck) {
  $expected = [pscustomobject]@{ nonce = 'abc'; sid = 'same'; session = 1; userProfile = 'C:\Users\test'; controllerElevationType = 2 }
  $attestation = [pscustomobject]@{ nonce = 'abc'; sid = 'same'; session = 1; userProfile = 'C:\Users\test'; profileWritable = $true; integrity = 'Medium'; elevated = $false; elevationType = 3 }
  $completion = [pscustomobject]@{ nonce = 'abc'; status = 'completed'; exitCode = 7 }
  if ((Assert-RunResult $completion $attestation $expected 7) -ne 7 -or (Get-FinalExitCode 7 $null $null) -ne 7 -or
      (Get-FinalExitCode 7 $null 'cleanup failed') -ne 1 -or (Get-FinalExitCode 7 'launch failed' $null) -ne 1) { throw 'Exit or cleanup decision failed.' }
  $cases = 0
  foreach ($change in @(
    @{ key = 'nonce'; value = 'wrong' }, @{ key = 'sid'; value = 'wrong' }, @{ key = 'session'; value = 2 },
    @{ key = 'userProfile'; value = 'C:\Users\wrong' }, @{ key = 'profileWritable'; value = $false },
    @{ key = 'elevated'; value = $true }, @{ key = 'integrity'; value = 'High' },
    @{ key = 'integrity'; value = 'Low' }, @{ key = 'integrity'; value = 'OtherOrUnknown' },
    @{ key = 'elevationType'; value = 1 }, @{ key = 'elevationType'; value = 9 },
    @{ key = 'elevationType'; value = '3' }, @{ key = 'elevated'; value = 'false' },
    @{ key = 'session'; value = '1' }, @{ key = 'profileWritable'; value = 'true' }
  )) {
    $bad = $attestation | ConvertTo-Json | ConvertFrom-Json
    $bad.($change.key) = $change.value
    $rejected = $false
    try { Assert-RunResult $completion $bad $expected 7 | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid token field $($change.key) was accepted." }
    $cases++
  }
  foreach ($bad in @(
    $null, [pscustomobject]@{ nonce = 'wrong'; status = 'completed'; exitCode = 7 },
    [pscustomobject]@{ nonce = 'abc'; status = 'failed'; exitCode = 7 },
    [pscustomobject]@{ nonce = 'abc'; status = 'completed'; exitCode = '7' },
    [pscustomobject]@{ nonce = 'abc'; status = 'completed'; exitCode = -1 },
    [pscustomobject]@{ nonce = 'abc'; status = 'completed'; exitCode = 256 }
  )) {
    $rejected = $false
    try { Assert-RunResult $bad $attestation $expected 7 | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid or missing completion was accepted.' }
    $cases++
  }
  foreach ($workerExit in @($null, 0)) {
    $rejected = $false
    try { Assert-RunResult $completion $attestation $expected $workerExit | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Missing or mismatched native exit was accepted.' }
    $cases++
  }
  $expected.controllerElevationType = 1
  $attestation.elevationType = 1
  if ((Assert-RunResult $completion $attestation $expected 7) -ne 7) { throw 'Non-split standard token was rejected.' }
  $shell = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $cleanupTested = [StandardDesktopLauncher]::SelfCheck($shell, $root)
  if (-not $cleanupTested) { Write-Output 'Suspended-process cleanup fixture requires an already standard controller; early Token mode tests the elevated route.' }
  & $shell -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'standard-desktop-worker.ps1') -SelfCheck
  if ($LASTEXITCODE -ne 0) { throw 'Profile probe collision selfcheck failed.' }
  Write-Output "Standard desktop validation selfcheck passed; rejection cases=$cases; suspended cleanup tested=$cleanupTested."
  return
}
$node = Join-Path $root 'apps/desktop/src-tauri/resources/engine/node.exe'
$npm = Join-Path $root 'apps/desktop/src-tauri/target/build-tools/node_modules/npm/bin/npm-cli.js'
$worker = Join-Path $PSScriptRoot 'standard-desktop-worker.ps1'
$nonce = [guid]::NewGuid().ToString('N')
$runDirectory = Join-Path $root "apps/desktop/src-tauri/target/bootstrap-standard-ci/$nonce"
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
  $workerExit = [StandardDesktopLauncher]::RunWorker($shell, $root, $runDirectory, $nonce, $Mode)
  $completion = Get-Content -LiteralPath (Join-Path $runDirectory 'completion.json') -Raw | ConvertFrom-Json
  $attestation = Get-Content -LiteralPath (Join-Path $runDirectory 'attestation.json') -Raw | ConvertFrom-Json
  $childExitCode = Assert-RunResult $completion $attestation $expected $workerExit
  $attestationValidated = $true
} catch {
  $launcherFailure = $_
} finally {
  if (-not [StandardDesktopLauncher]::CleanupSucceeded) { $cleanupFailure = 'Owned worker cleanup failed.' }
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
      ownedProcessCleanupSucceeded = $null -eq $cleanupFailure
      controllerToken = @{
        integrity = if ([StandardDesktopLauncher]::Controller.Integrity -in @('Medium', 'OtherOrUnknown')) { [StandardDesktopLauncher]::Controller.Integrity } else { $null }
        elevated = if ($controllerElevation.elevated -is [bool]) { $controllerElevation.elevated } else { $null }
        elevationType = if ($controllerElevation.elevationType -in @(1, 2, 3)) { [int]$controllerElevation.elevationType } else { $null }
      }
      derivedToken = @{
        integrity = if ([StandardDesktopLauncher]::Derived.Integrity -in @('Medium', 'OtherOrUnknown')) { [StandardDesktopLauncher]::Derived.Integrity } else { $null }
        elevated = if ($null -ne [StandardDesktopLauncher]::Derived) { [StandardDesktopLauncher]::Derived.Elevated } else { $null }
        elevationType = if ([StandardDesktopLauncher]::Derived.ElevationType -in @(1, 2, 3)) { [StandardDesktopLauncher]::Derived.ElevationType } else { $null }
      }
      childToken = @{
        integrity = if ([StandardDesktopLauncher]::Child.Integrity -in @('Medium', 'OtherOrUnknown')) { [StandardDesktopLauncher]::Child.Integrity } else { $null }
        elevated = if ($null -ne [StandardDesktopLauncher]::Child) { [StandardDesktopLauncher]::Child.Elevated } else { $null }
        elevationType = if ([StandardDesktopLauncher]::Child.ElevationType -in @(1, 2, 3)) { [StandardDesktopLauncher]::Child.ElevationType } else { $null }
      }
      nativeExitCode = [StandardDesktopLauncher]::NativeExitCode
      nativeExitHex = [StandardDesktopLauncher]::NativeExitHex
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
if ($cleanupFailure) { Write-Output "Owned process cleanup failed: $cleanupFailure" }
if ($receiptFailure) { Write-Output "Diagnostic receipt failed: $receiptFailure" }
if ($finalExitCode -eq 0) { Write-Output "Standard desktop $Mode passed; nonce=$nonce" }
exit $finalExitCode
