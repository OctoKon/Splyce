param([switch]$Probe)

function Resolve-WebView2Runtime {
  param(
    [object[]]$Registrations,
    [string]$LocalAppData = $env:LOCALAPPDATA,
    [string]$ProgramFilesX86 = ${env:ProgramFiles(x86)},
    [string]$ProgramFiles = $env:ProgramFiles,
    [scriptblock]$GetFileVersion = {
      param([string]$Path)
      [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion
    }
  )

  foreach ($registration in $Registrations) {
    $version = [string]$registration.Version
    if ($version -notmatch '^\d+(?:\.\d+){3}$' -or $version -eq '0.0.0.0') { continue }

    $paths = @()
    if ($registration.Location) {
      $paths += Join-Path (Join-Path $registration.Location $version) 'msedgewebview2.exe'
      $paths += Join-Path $registration.Location 'msedgewebview2.exe'
    }
    if ($registration.Scope -eq 'user') {
      if ($LocalAppData) {
        $paths += Join-Path $LocalAppData "Microsoft\EdgeWebView\Application\$version\msedgewebview2.exe"
      }
    }
    else {
      if ($ProgramFilesX86) {
        $paths += Join-Path $ProgramFilesX86 "Microsoft\EdgeWebView\Application\$version\msedgewebview2.exe"
      }
      if ($ProgramFiles) {
        $paths += Join-Path $ProgramFiles "Microsoft\EdgeWebView\Application\$version\msedgewebview2.exe"
      }
    }

    foreach ($path in $paths | Select-Object -Unique) {
      if ((Test-Path -LiteralPath $path -PathType Leaf) -and (& $GetFileVersion $path) -eq $version) {
        return [pscustomobject]@{
          Version = $version
          Scope = [string]$registration.Scope
          Location = [string]$registration.Location
          Executable = $path
        }
      }
    }
  }
  return $null
}

function Get-InstalledWebView2Runtime {
  $guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $keys = @(
    @{ Path = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid"; Scope = 'machine' },
    @{ Path = "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid"; Scope = 'machine' },
    @{ Path = "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid"; Scope = 'user' }
  )
  $registrations = foreach ($key in $keys) {
    if (Test-Path -LiteralPath $key.Path) {
      $registration = Get-ItemProperty -LiteralPath $key.Path -ErrorAction SilentlyContinue
      if ($registration) {
        [pscustomobject]@{
          Scope = $key.Scope
          Version = $registration.pv
          Location = $registration.location
        }
      }
    }
  }
  Resolve-WebView2Runtime -Registrations @($registrations)
}

function Test-WebView2RuntimeSelection {
  $fixtureRoot = Join-Path $env:TEMP "webview2-registration-test-$([guid]::NewGuid().ToString('N'))"
  $userVersion = '155.0.4283.62'
  $userLocation = Join-Path $fixtureRoot 'user-runtime'
  $userExecutable = Join-Path (Join-Path $userLocation $userVersion) 'msedgewebview2.exe'
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $userExecutable) -Force | Out-Null
    Set-Content -LiteralPath $userExecutable -Value 'fixture'
    $getVersion = {
      param([string]$Path)
      if ($Path -eq $userExecutable) { $userVersion } else { '0.0.0.0' }
    }.GetNewClosure()
    $selected = Resolve-WebView2Runtime -Registrations @(
      [pscustomobject]@{ Scope = 'machine'; Version = '154.0.1.0'; Location = (Join-Path $fixtureRoot 'stale-machine') },
      [pscustomobject]@{ Scope = 'user'; Version = $userVersion; Location = $userLocation }
    ) -LocalAppData '' -ProgramFilesX86 '' -ProgramFiles '' -GetFileVersion $getVersion
    if (-not $selected -or $selected.Scope -ne 'user' -or $selected.Executable -ne $userExecutable) {
      throw 'A stale machine registration masked the installed per-user WebView2 runtime.'
    }
  }
  finally {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
  }
}

if ($Probe) {
  $runtime = Get-InstalledWebView2Runtime
  if (-not $runtime) { throw 'The Evergreen WebView2 Runtime is not registered with a matching executable.' }
  [ordered]@{ version = $runtime.Version; scope = $runtime.Scope; executable = $runtime.Executable } | ConvertTo-Json -Compress
}
