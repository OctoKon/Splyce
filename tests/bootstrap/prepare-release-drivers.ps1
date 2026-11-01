param([switch]$TestOnly)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$target = Join-Path $root "apps/desktop/src-tauri/target"
$tools = Join-Path $target "smoke-tools"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot "webview2-runtime.ps1")

function Write-JsonUtf8NoBom {
  param([string]$Path, [object]$Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 5
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8NoBom)
}

function Assert-SafeArchiveEntries {
  param([string]$Destination, [object[]]$Entries)
  $rootPath = [System.IO.Path]::GetFullPath($Destination).TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  foreach ($entry in $Entries) {
    $entryPath = ([string]$entry.FullName).Replace([char]92, [char]47)
    $segments = $entryPath.Split('/')
    if ($entryPath.StartsWith('/') -or $segments -contains '..' -or @($segments | Where-Object { $_.Contains(':') }).Count -gt 0) {
      throw "The Microsoft WebDriver archive contains an unsafe path."
    }
    $resolvedPath = [System.IO.Path]::GetFullPath((Join-Path $Destination $entryPath))
    if (-not $resolvedPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The Microsoft WebDriver archive contains an unsafe path."
    }
  }
}

function Assert-PinnedCrateArchive {
  param([string]$Path, [string]$ExpectedHash)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "The pinned tauri-driver source archive is missing." }
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $ExpectedHash) { throw "The tauri-driver source archive does not match its pinned checksum." }
  $hash
}

$pageUrl = "https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver"

function Get-EdgeDriverLatestReleaseUrl {
  param([string]$RuntimeBuild)
  "https://msedgedriver.microsoft.com/LATEST_RELEASE_$($RuntimeBuild.Split('.')[0])_WINDOWS"
}

function ConvertFrom-DriverVersionResponse {
  param([byte[]]$Bytes)
  if (-not $Bytes -or $Bytes.Length -eq 0) { return $null }
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) { $text = [System.Text.Encoding]::Unicode.GetString($Bytes, 2, $Bytes.Length - 2) }
  elseif ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) { $text = [System.Text.Encoding]::BigEndianUnicode.GetString($Bytes, 2, $Bytes.Length - 2) }
  else { $text = [System.Text.Encoding]::UTF8.GetString($Bytes) }
  $text.Trim([char[]]@([char]0xFEFF, [char]0, ' ', "`r", "`n", "`t"))
}

# Only a four-part version on the runtime's exact major.minor.build qualifies,
# whichever Microsoft record names it; no other build is ever substituted.
function Select-EdgeDriverVersion {
  param([string]$RuntimeBuild, [string]$CatalogPage, [string]$LatestRelease, [string]$LatestReleaseUrl)
  $candidates = @()
  foreach ($match in [regex]::Matches([string]$CatalogPage, 'href="https://msedgedriver\.microsoft\.com/(\d+\.\d+\.\d+\.\d+)/edgedriver_win64\.zip"')) {
    $candidates += [pscustomobject]@{ Version = $match.Groups[1].Value; Source = $pageUrl }
  }
  if ($LatestRelease -match '^\d+\.\d+\.\d+\.\d+$') {
    $candidates += [pscustomobject]@{ Version = $LatestRelease; Source = $LatestReleaseUrl }
  }
  $candidates |
    Where-Object { ($_.Version.Split('.')[0..2] -join '.') -eq $RuntimeBuild } |
    Sort-Object { [version]$_.Version } -Descending |
    Select-Object -First 1
}

function Test-EdgeDriverVersionSelection {
  $build = "155.0.4283"
  $latestUrl = Get-EdgeDriverLatestReleaseUrl $build
  if ($latestUrl -ne "https://msedgedriver.microsoft.com/LATEST_RELEASE_155_WINDOWS") { throw "The WebDriver release record URL is wrong." }
  $currentOnly = '<a href="https://msedgedriver.microsoft.com/156.0.4314.58/edgedriver_win64.zip">'
  $listed = $currentOnly + '<a href="https://msedgedriver.microsoft.com/155.0.4283.40/edgedriver_win64.zip">'

  $selected = Select-EdgeDriverVersion $build $currentOnly "155.0.4283.62" $latestUrl
  if (-not $selected -or $selected.Version -ne "155.0.4283.62" -or $selected.Source -ne $latestUrl) {
    throw "A runtime build that left the catalog page was not resolved from its release record."
  }
  $selected = Select-EdgeDriverVersion $build $listed $null $latestUrl
  if (-not $selected -or $selected.Version -ne "155.0.4283.40" -or $selected.Source -ne $pageUrl) {
    throw "A catalog-listed build was not selected without a release record."
  }
  $selected = Select-EdgeDriverVersion $build $listed "155.0.4283.62" $latestUrl
  if (-not $selected -or $selected.Version -ne "155.0.4283.62") { throw "The newest exact-build WebDriver was not selected." }
  foreach ($other in @("155.0.4284.1", "156.0.4314.58", "155.0.4283", "not-a-version", "")) {
    if (Select-EdgeDriverVersion $build $currentOnly $other $latestUrl) { throw "A WebDriver outside build $build was accepted from '$other'." }
  }

  $utf16 = [byte[]](@(0xFF, 0xFE) + [System.Text.Encoding]::Unicode.GetBytes("155.0.4283.62`r`n"))
  if ((ConvertFrom-DriverVersionResponse $utf16) -ne "155.0.4283.62") { throw "A UTF-16 release record was misread." }
  if ((ConvertFrom-DriverVersionResponse ([System.Text.Encoding]::UTF8.GetBytes("155.0.4283.62"))) -ne "155.0.4283.62") { throw "A UTF-8 release record was misread." }
  if ($null -ne (ConvertFrom-DriverVersionResponse ([byte[]]@()))) { throw "An empty release record was not rejected." }
}

function Test-DriverPreparationGuards {
  $rootPath = Join-Path $env:TEMP "release-driver-guard-test-$([guid]::NewGuid().ToString('N'))"
  Assert-SafeArchiveEntries $rootPath @(
    [pscustomobject]@{ FullName = "msedgedriver.exe" },
    [pscustomobject]@{ FullName = "Driver_Notes/EULA" },
    [pscustomobject]@{ FullName = "Driver_Notes\credits.html" }
  )
  foreach ($unsafe in @("../escape", "..\escape", "nested/../../escape", "/absolute", "C:\absolute")) {
    $rejected = $false
    try { Assert-SafeArchiveEntries $rootPath @([pscustomobject]@{ FullName = $unsafe }) }
    catch { $rejected = $true }
    if (-not $rejected) { throw "The archive guard accepted unsafe path '$unsafe'." }
  }

  Test-WebView2RuntimeSelection
  Test-EdgeDriverVersionSelection

  $cratePath = Join-Path $env:TEMP "tauri-driver-hash-test-$([guid]::NewGuid().ToString('N')).crate"
  try {
    [System.IO.File]::WriteAllBytes($cratePath, [byte[]]@(1, 2, 3))
    $crateHash = (Get-FileHash -LiteralPath $cratePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Assert-PinnedCrateArchive $cratePath $crateHash) -ne $crateHash) { throw "The pinned crate hash check returned the wrong digest." }
    $rejected = $false
    try { Assert-PinnedCrateArchive $cratePath ('0' * 64) }
    catch { $rejected = $true }
    if (-not $rejected) { throw "The crate hash check accepted tampered bytes." }
  }
  finally {
    if (Test-Path -LiteralPath $cratePath) { Remove-Item -LiteralPath $cratePath -Force }
  }

  $manifestPath = Join-Path $env:TEMP "release-driver-manifest-test-$([guid]::NewGuid().ToString('N')).json"
  try {
    Write-JsonUtf8NoBom $manifestPath ([ordered]@{ schemaVersion = 1 })
    $bytes = [System.IO.File]::ReadAllBytes($manifestPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      throw "The driver manifest must be UTF-8 without a BOM."
    }
    $null = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -ErrorAction Stop
  }
  finally {
    if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
  }
}

Test-DriverPreparationGuards
if ($TestOnly) { Write-Output "Driver preparation guard tests passed."; exit 0 }

$inventory = Get-Content (Join-Path $PSScriptRoot "tauri-driver-inventory.json") -Raw | ConvertFrom-Json
$tauriPin = $inventory | Where-Object { $_.name -eq "tauri-driver" }
if (-not $tauriPin -or $tauriPin.version -notmatch '^\d+\.\d+\.\d+$' -or $tauriPin.crateSha256 -notmatch '^[0-9a-f]{64}$') {
  throw "The tauri-driver inventory pin is incomplete."
}

$build = Join-Path $target "smoke-driver-build"
$sourceId = [guid]::NewGuid().ToString('N')
$crateArchive = Join-Path $target "tauri-driver-$($tauriPin.version)-$sourceId.crate"
$sourcePath = Join-Path $target "tauri-driver-$($tauriPin.version)-$sourceId"
$crateUrl = "https://crates.io/api/v1/crates/tauri-driver/$($tauriPin.version)/download"
New-Item -ItemType Directory -Path $target -Force | Out-Null
Invoke-WebRequest -Uri $crateUrl -OutFile $crateArchive -TimeoutSec 120
$crateHash = Assert-PinnedCrateArchive $crateArchive $tauriPin.crateSha256
$archiveEntries = @(& tar.exe -tzf $crateArchive)
if ($LASTEXITCODE -ne 0) { throw "Could not inspect the pinned tauri-driver source archive." }
Assert-SafeArchiveEntries $sourcePath @($archiveEntries | ForEach-Object { [pscustomobject]@{ FullName = $_ } })
New-Item -ItemType Directory -Path $sourcePath -Force | Out-Null
& tar.exe -xzf $crateArchive -C $sourcePath --strip-components=1
if ($LASTEXITCODE -ne 0) { throw "Could not extract the verified tauri-driver source archive." }
$cargoToml = Join-Path $sourcePath 'Cargo.toml'
if (-not (Test-Path -LiteralPath $cargoToml -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $sourcePath 'Cargo.lock') -PathType Leaf)) {
  throw "The verified tauri-driver archive lacks its manifest or locked dependency file."
}
$packageBlock = [regex]::Match((Get-Content -LiteralPath $cargoToml -Raw), '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)').Groups[1].Value
if ($packageBlock -notmatch '(?m)^name\s*=\s*"tauri-driver"\s*$' -or $packageBlock -notmatch ('(?m)^version\s*=\s*"' + [regex]::Escape($tauriPin.version) + '"\s*$')) {
  throw "The verified tauri-driver source manifest does not match the pinned package version."
}
$cargoHome = Join-Path $target "smoke-cargo-home-$([guid]::NewGuid().ToString('N'))"
$previousCargoHome = $env:CARGO_HOME
$env:CARGO_HOME = $cargoHome
try {
  & cargo install --path $sourcePath --locked --force --root $tools --target-dir $build
  $cargoExitCode = $LASTEXITCODE
}
finally {
  if ($null -eq $previousCargoHome) { Remove-Item Env:CARGO_HOME -ErrorAction SilentlyContinue }
  else { $env:CARGO_HOME = $previousCargoHome }
}
if ($cargoExitCode -ne 0) { throw "cargo install from the verified tauri-driver source failed with exit code $cargoExitCode." }

$runtimeRegistration = Get-InstalledWebView2Runtime
if (-not $runtimeRegistration) { throw "The Evergreen WebView2 Runtime is not registered." }
$runtimeVersion = $runtimeRegistration.Version

$runtimeBuild = ($runtimeVersion.Split('.')[0..2] -join '.')
$page = (Invoke-WebRequest -Uri $pageUrl -UseBasicParsing -TimeoutSec 30).Content
# The catalog page only links current channel builds; an older Evergreen runtime
# still has its driver, which Microsoft's per-major release record names.
$latestReleaseUrl = Get-EdgeDriverLatestReleaseUrl $runtimeBuild
$latestRelease = $null
try {
  $response = Invoke-WebRequest -Uri $latestReleaseUrl -UseBasicParsing -TimeoutSec 30
  $latestRelease = ConvertFrom-DriverVersionResponse $response.RawContentStream.ToArray()
}
catch { $latestRelease = $null }
$selection = Select-EdgeDriverVersion $runtimeBuild $page $latestRelease $latestReleaseUrl
if (-not $selection) { throw "Microsoft's driver catalog has no x64 WebDriver matching WebView2 $runtimeBuild." }
$edgeVersion = $selection.Version

$edgeUrl = "https://msedgedriver.microsoft.com/$edgeVersion/edgedriver_win64.zip"
$edgeDirectory = Join-Path $tools "edge-$edgeVersion"
New-Item -ItemType Directory -Path $edgeDirectory -Force | Out-Null
$edgeArchive = Join-Path $edgeDirectory "edgedriver_win64.zip"
Invoke-WebRequest -Uri $edgeUrl -OutFile $edgeArchive -TimeoutSec 120
$archiveHash = (Get-FileHash -LiteralPath $edgeArchive -Algorithm SHA256).Hash.ToLowerInvariant()

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($edgeArchive)
try {
  foreach ($entry in $zip.Entries) {
    Assert-SafeArchiveEntries $edgeDirectory @($entry)
  }
  if (-not ($zip.Entries | Where-Object { $_.FullName -eq "msedgedriver.exe" })) {
    throw "The Microsoft WebDriver archive is missing msedgedriver.exe."
  }
}
finally { $zip.Dispose() }
Expand-Archive -LiteralPath $edgeArchive -DestinationPath $edgeDirectory -Force
$edgeExecutable = Join-Path $edgeDirectory "msedgedriver.exe"
$edgeFileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($edgeExecutable).ProductVersion
if ($edgeFileVersion -ne $edgeVersion) { throw "The downloaded WebDriver bytes have an unexpected file version." }
$edgeHash = (Get-FileHash -LiteralPath $edgeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$tauriExecutable = Join-Path $tools "bin/tauri-driver.exe"
if (-not (Test-Path -LiteralPath $tauriExecutable -PathType Leaf)) { throw "The pinned tauri-driver executable is missing." }
$tauriHash = (Get-FileHash -LiteralPath $tauriExecutable -Algorithm SHA256).Hash.ToLowerInvariant()

$manifest = [ordered]@{
  schemaVersion = 1
  preparedAtUtc = [DateTime]::UtcNow.ToString("o")
  tauriDriver = [ordered]@{
    version = $tauriPin.version
    crateUrl = $crateUrl
    crateSha256 = $crateHash
    binarySha256 = $tauriHash
  }
  webview2 = [ordered]@{
    distribution = "Evergreen"
    runtimeVersion = $runtimeVersion
    registryScope = $runtimeRegistration.Scope
  }
  edgeDriver = [ordered]@{
    version = $edgeVersion
    sourcePage = $pageUrl
    versionSource = $selection.Source
    downloadUrl = $edgeUrl
    archiveSha256 = $archiveHash
    binarySha256 = $edgeHash
  }
}
$manifestPath = Join-Path $tools "driver-manifest.json"
Write-JsonUtf8NoBom $manifestPath $manifest
Write-Output "Qualified tauri-driver $($tauriPin.version) and WebDriver $edgeVersion for Evergreen WebView2 $runtimeVersion."
