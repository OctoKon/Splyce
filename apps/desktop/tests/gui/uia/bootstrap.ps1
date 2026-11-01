param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Import-Module CimCmdlets

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
$target = Join-Path $repo 'apps/desktop/src-tauri/target'
$executable = Join-Path $target 'release/splyce-desktop.exe'
$evidence = Join-Path $target ('bootstrap-smoke/uia-' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ'))
$null = New-Item -ItemType Directory -Path $evidence
$checks = [Collections.Generic.List[string]]::new()
$report = [ordered]@{
    case = 'bootstrap-native-uia'; passed = $false; checks = $checks
    appSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    harnessSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    os = [Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
    limits = @('No keyboard, IME, Narrator, contrast, DPI or manual M qualification.', 'Loaded release executable; no installed NSIS journey or full TD-34 qualification.')
}
$application = $null
$engine = $null
$engineProcess = $null

function Assert-Check([bool] $Condition, [string] $Description) {
    if (-not $Condition) { throw "Assertion failed: $Description" }
    $checks.Add($Description)
}

function Wait-For([scriptblock] $Check, [string] $Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $value = & $Check
        if ($value) { return $value }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $Description"
}

function Read-Tree {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
    if ($null -eq $window) { throw 'Owned native window is unavailable' }
    if ($window.Current.ProcessId -ne $application.Id) { throw 'Native window process identity changed' }
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
    @($elements | ForEach-Object {
        $current = $_.Current
        [pscustomobject]@{
            name = $current.Name; role = $current.ControlType.ProgrammaticName
            processId = $current.ProcessId; automationId = $current.AutomationId
            enabled = $current.IsEnabled; offscreen = $current.IsOffscreen
        }
    })
}

function Assert-NoReady($Tree) {
    Assert-Check (-not ($Tree | Where-Object { $_.name -match '^(ready|Ready for workspace execution\.)$' })) 'No accessible ready claim'
    $interactiveRoles = @('ControlType.Button', 'ControlType.Edit', 'ControlType.ComboBox', 'ControlType.CheckBox', 'ControlType.RadioButton', 'ControlType.Hyperlink', 'ControlType.MenuItem')
    Assert-Check (-not ($Tree | Where-Object { $_.role -in $interactiveRoles -and [string]::IsNullOrWhiteSpace($_.name) })) 'Zero unnamed interactive controls in owned window'
}

try {
    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'splyce-desktop.exe'" | Where-Object { $_.ExecutablePath -eq $executable })
    Assert-Check ($existing.Count -eq 0) 'No existing instance of this release executable'
    $application = Start-Process -FilePath $executable -WorkingDirectory (Split-Path $executable) -PassThru -RedirectStandardOutput (Join-Path $evidence 'app.stdout.log') -RedirectStandardError (Join-Path $evidence 'app.stderr.log')
    $null = Wait-For {
        $application.Refresh()
        if ($application.HasExited) { throw 'Application exited before native window appeared' }
        $application.MainWindowHandle -ne 0
    } 'owned native window'
    $report.applicationPid = $application.Id
    $report.windowHandle = $application.MainWindowHandle.ToInt64()
    $window = Wait-For {
        $application.Refresh()
        if ($application.HasExited) { throw 'Application exited before accessibility root appeared' }
        $candidate = [System.Windows.Automation.AutomationElement]::FromHandle($application.MainWindowHandle)
        $current = $candidate.Current
        $description = [ordered]@{ name = $current.Name; role = $current.ControlType.ProgrammaticName; processId = $current.ProcessId }
        if (-not $report.Contains('initialRoot')) { $report.initialRoot = $description }
        $report.lastStartupRoot = $description
        if ($current.ProcessId -eq $application.Id -and $current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and $current.Name -eq 'Splyce') { return $candidate }
    } 'owned accessible Splyce Window root'
    Assert-Check ($window.Current.ProcessId -eq $application.Id) 'UIA window belongs to launched application'
    Assert-Check ($window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) 'Owned native root has Window role'
    Assert-Check ($window.Current.Name -eq 'Splyce') 'Owned native window has accessible Splyce name'
    $engine = Wait-For {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($application.Id)" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith('\engine\node.exe', [StringComparison]::OrdinalIgnoreCase) })
        if ($children.Count -gt 1) { throw 'Expected exactly one owned packaged Node child' }
        if ($children.Count -eq 1) { $children[0] }
    } 'owned packaged Node engine child'
    $report.enginePid = $engine.ProcessId
    $report.engineSha256 = (Get-FileHash -LiteralPath $engine.ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.engineVersion = (& $engine.ExecutablePath --version).Trim()
    Assert-Check ($report.engineVersion -eq 'v24.22.1') 'Owned packaged engine uses Node 24.22.1'
    $initial = Wait-For {
        $tree = @(Read-Tree)
        if ($tree | Where-Object { $_.name -ceq 'Engine Unavailable' }) { ,$tree }
    } 'accessible Engine Unavailable text'
    $initial | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'initial-tree.json')
    Assert-Check ([bool]($initial | Where-Object { $_.name -ceq 'Engine Unavailable' -and $_.role -eq 'ControlType.Text' -and -not $_.offscreen })) 'Initial Engine Unavailable is accessible visible Text'
    Assert-Check ([bool]($initial | Where-Object { $_.name -like 'The native engine is unavailable*' })) 'Initial accessible explanation names the unavailable native engine'
    Assert-Check (-not ($initial | Where-Object { $_.name -ceq 'Engine stopped' })) 'Initial unavailable state does not claim engine stopped'
    Assert-NoReady $initial
    $engineProcess = [Diagnostics.Process]::GetProcessById($engine.ProcessId)
    $null = $engineProcess.Handle
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($engine.ProcessId)"
    Assert-Check ($null -ne $current -and $current.CreationDate -eq $engine.CreationDate -and $current.ParentProcessId -eq $application.Id -and $current.ExecutablePath -eq $engine.ExecutablePath) 'Engine identity and direct ownership revalidated before termination'
    $engineProcess.Kill()
    $stopped = Wait-For {
        $tree = @(Read-Tree)
        if ($tree | Where-Object { $_.name -ceq 'Engine stopped' }) { ,$tree }
    } 'accessible Engine stopped text after actual owned engine termination'
    $stopped | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'stopped-tree.json')
    Assert-Check ([bool]($stopped | Where-Object { $_.name -ceq 'Engine stopped' -and $_.role -eq 'ControlType.Text' -and -not $_.offscreen })) 'Actual engine loss exposes visible accessible Engine stopped Text'
    Assert-Check ([bool]($stopped | Where-Object { $_.name -like 'The native engine exited.*' })) 'Accessible engine loss explanation preserves incomplete transcript warning'
    Assert-Check (-not ($stopped | Where-Object { $_.name -ceq 'Engine Unavailable' })) 'Engine stopped replaces initial unavailable heading'
    Assert-NoReady $stopped
    $replacement = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($application.Id)" | Where-Object { $_.ExecutablePath -eq $engine.ExecutablePath })
    Assert-Check ($replacement.Count -eq 0) 'Engine loss does not automatically spawn a replacement child'
    Assert-Check ($application.CloseMainWindow()) 'Owned native application accepts window close'
    Assert-Check ($application.WaitForExit(10000)) 'Native close exits application'
    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($engine.ProcessId)"
    Assert-Check ($null -eq $remaining -or $remaining.CreationDate -ne $engine.CreationDate) 'Original owned Node child is gone after close'
    $remainingChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($application.Id)" | Where-Object { $_.ExecutablePath -eq $engine.ExecutablePath })
    Assert-Check ($remainingChildren.Count -eq 0) 'No owned packaged Node children remain after close'
    $report.initialElementCount = $initial.Count
    $report.stoppedElementCount = $stopped.Count
    $report.passed = $true
} catch {
    $report.error = $_.ToString()
    throw
} finally {
    if ($null -ne $engineProcess) { $engineProcess.Dispose() }
    if ($null -ne $application) {
        $application.Refresh()
        if (-not $application.HasExited) {
            $null = $application.CloseMainWindow()
            if (-not $application.WaitForExit(5000)) {
                $application.Kill()
                $application.WaitForExit()
                $report.forcedApplicationCleanup = $true
            }
        }
    }
    $report.checkCount = $checks.Count
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'report.json')
    Write-Output ("UIA passed={0}; checks={1}; evidence={2}" -f $report.passed, $checks.Count, $evidence)
}
