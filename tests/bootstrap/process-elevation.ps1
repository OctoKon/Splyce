param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$CreationTimeMs,
    [switch]$Details
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeProcessElevation {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
    [DllImport("advapi32.dll", EntryPoint="GetTokenInformation")] static extern bool GetLinkedToken(IntPtr token, int kind, out IntPtr value, int length, out int returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static int[] Read(int id, long expectedCreationMs, bool details) {
        IntPtr process = OpenProcess(0x1000, false, id), token = IntPtr.Zero, linked = IntPtr.Zero;
        try {
            long creation, exit, kernel, user;
            if (process == IntPtr.Zero || !GetProcessTimes(process, out creation, out exit, out kernel, out user)) return null;
            // CIM/JSON creation timestamps have millisecond precision; use the same handle for identity and token.
            if (creation / 10000 - 11644473600000L != expectedCreationMs) return null;
            if (!OpenProcessToken(process, 0x0008, out token)) return null;
            int elevated, returned;
            if (!GetTokenInformation(token, 20, out elevated, 4, out returned) || returned != 4) return null;
            int elevationType = 0, linkedAvailable = -1;
            if (details && GetTokenInformation(token, 18, out elevationType, 4, out returned) && returned == 4) {
                if (elevationType == 1) linkedAvailable = 0;
                else if (GetLinkedToken(token, 19, out linked, IntPtr.Size, out returned) && returned == IntPtr.Size)
                    linkedAvailable = linked == IntPtr.Zero ? 0 : 1;
            }
            return new int[] { elevated, elevationType, linkedAvailable };
        } finally {
            if (linked != IntPtr.Zero) CloseHandle(linked);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (process != IntPtr.Zero) CloseHandle(process);
        }
    }
}
'@
    $observed = [SmokeProcessElevation]::Read($ProcessId, $CreationTimeMs, $Details.IsPresent)
    if ($null -eq $observed) { throw 'Unavailable' }
    $result = @{ status = 'observed'; elevated = [bool]$observed[0] }
    if ($Details) {
        $result.elevationType = if ($observed[1] -in 1, 2, 3) { $observed[1] } else { $null }
        $result.linkedTokenAvailable = if ($observed[2] -ge 0) { [bool]$observed[2] } else { $null }
    }
    $result | ConvertTo-Json -Compress
} catch {
    @{ status = 'unknown'; elevated = $null } | ConvertTo-Json -Compress
}
