# install-plugin.ps1 - install the dsh-browser-bridge plugin into the local DSH web profile.
# Idempotent: safe to re-run. No dependencies beyond PowerShell 5.1+.
#
# Usage:  powershell -ExecutionPolicy Bypass -File install-plugin.ps1
#         (run from the folder that contains lib/ and package.json, or pass -PackageRoot)
param(
  [string]$PackageRoot = $PSScriptRoot,
  [string]$ProfileName = "web"
)
$ErrorActionPreference = "Stop"

# Write text as UTF-8 WITHOUT a BOM. PowerShell 5.1's Set-Content -Encoding UTF8
# writes a byte-order mark, and dsh's readProfileManifest JSON.parse rejects it
# ("SyntaxError: Unexpected token '\uFEFF'"). Every profile file we touch must
# be BOM-free.
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

# Strip a UTF-8 BOM from an existing file (fixes files written by older
# versions of this script or by Set-Content). Safe to call on any file.
function Remove-Bom([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $rest = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    Write-Utf8NoBom $Path $rest
    Write-Host "  stripped UTF-8 BOM from $Path"
  }
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profilesDir = Join-Path $dshHome "profiles"
if (-not (Test-Path $profilesDir)) {
  throw "DSH profiles directory not found: $profilesDir. Run 'dsh web' once so the profile is initialized, then retry."
}

$lib = Join-Path $PackageRoot "lib"
$pkgJson = Join-Path $PackageRoot "package.json"
if (-not (Test-Path $lib) -or -not (Test-Path $pkgJson)) {
  throw "Plugin package not found under $PackageRoot (expected a lib/ folder and package.json)."
}

# Locate the node_modules that already hosts the @deepseek-ai packages
# (pnpm hoists them to ~/.dsh/profiles/node_modules; some installs put them
# under the profile folder itself).
$candidates = @(
  (Join-Path $profilesDir "node_modules"),
  (Join-Path (Join-Path $profilesDir $ProfileName) "node_modules")
)
$nm = $candidates | Where-Object { Test-Path (Join-Path $_ "@deepseek-ai\dsh-tools") } | Select-Object -First 1
if (-not $nm) { $nm = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1 }
if (-not $nm) {
  throw "Cannot locate the profile node_modules (looked in: $($candidates -join ', '))."
}

$dest = Join-Path $nm "dsh-browser-bridge"
Write-Host "Installing plugin into: $dest"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item $lib $dest -Recurse -Force
Copy-Item $pkgJson $dest -Force
Write-Host "  copied lib/ and package.json"

# --- register the loader row in cordis.patch.yml --------------------------------
$profileDir = Join-Path $profilesDir $ProfileName
$patchFile = Join-Path $profileDir "cordis.patch.yml"
if (-not (Test-Path $patchFile)) {
  Write-Warning "No $patchFile found; the plugin files are in place but NOT registered. Initialize the profile (run 'dsh web' once) and re-run this script."
} else {
  $patch = Get-Content $patchFile -Raw -Encoding UTF8
  if ($patch -match "browser-bridge") {
    Write-Host "cordis.patch.yml already registers browser-bridge - skipped."
  } else {
    $block = @'

# DSH Browser Bridge: browser_* agent tools + a WebSocket endpoint for the
# companion browser extension (ws://127.0.0.1:<port>/bridge).
- insert:
    - id: browser-bridge
      name: 'dsh-browser-bridge'
      config:
        path: /bridge
        commandTimeoutMs: 60000
'@
    # If the file is still the default empty list '[]', replace it with the block
    # instead of appending (appending would create two YAML documents).
    $trimmed = $patch.TrimEnd()
    if ($trimmed -eq "[]" -or $trimmed.EndsWith("[]")) {
      $trimmed = $trimmed.Substring(0, $trimmed.Length - 2).TrimEnd()
    }
    $new = $trimmed + "`r`n" + $block.TrimStart("`r", "`n") + "`r`n"
    Write-Utf8NoBom $patchFile $new
    Write-Host "Registered browser-bridge in $patchFile"
  }
}

# --- optional bookkeeping in the profile package.json -----------------------------
$profilePkg = Join-Path $profileDir "package.json"
if (Test-Path $profilePkg) {
  try {
    $json = Get-Content $profilePkg -Raw | ConvertFrom-Json
    $has = $json.dependencies -and $json.dependencies.'dsh-browser-bridge'
    if (-not $has) {
      if (-not $json.dependencies) {
        $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([ordered]@{}) -Force
      }
      $json.dependencies | Add-Member -NotePropertyName 'dsh-browser-bridge' -NotePropertyValue '0.1.0' -Force
      Write-Utf8NoBom $profilePkg ($json | ConvertTo-Json -Depth 10)
      Write-Host "Recorded dsh-browser-bridge in $profilePkg"
    } else {
      Write-Host "dsh-browser-bridge already listed in $profilePkg dependencies."
    }
  } catch {
    Write-Warning "Could not update $profilePkg (not critical): $($_.Exception.Message)"
  }
} else {
  Write-Warning "No $profilePkg found (not critical: the plugin loads via cordis.patch.yml alone)."
}

# --- normalize: strip any UTF-8 BOM left by earlier runs / Set-Content ------------
Remove-Bom $patchFile
Remove-Bom $profilePkg

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. Restart the harness: stop the running 'dsh web' process, then start it again (dsh web)."
Write-Host "  2. Verify the plugin is active:"
Write-Host "       Invoke-WebRequest http://127.0.0.1:3080/bridge/info -UseBasicParsing"
Write-Host "     (expect JSON: name=dsh-browser-bridge, ws=ws://127.0.0.1:3080/bridge)"
Write-Host "  3. Load the browser extension from the 'extension' folder:"
Write-Host "     chrome://extensions (Edge: edge://extensions, Yandex: browser://extensions)"
Write-Host "     -> Developer mode -> Load unpacked -> select the extension folder."
Write-Host "  4. In any chat, the agent can now use browser_* tools (start with browser_status)."
