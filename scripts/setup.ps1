#Requires -Version 5.1
<#
.SYNOPSIS
    Install everything needed to run the Farmhouse route-optimization project
    locally on Windows, then install the project's npm dependencies.

.DESCRIPTION
    Installs (only when missing) the required tooling using winget:
        - Node.js LTS   (OpenJS.NodeJS.LTS)   -- the app needs Node 18+
        - PostgreSQL     (PostgreSQL.PostgreSQL) -- unless -UseDocker or -SkipDb

    Then runs `npm install` in the project root.

    The script is idempotent: anything already installed is detected and left
    alone. It never uninstalls, downgrades, or deletes anything.

.PARAMETER UseDocker
    Instead of installing a local PostgreSQL server, start a disposable
    PostgreSQL container with Docker (matches the README setup) and print the
    DATABASE_URL to use. Requires Docker Desktop to be installed and running.

.PARAMETER SkipDb
    Do not install or start PostgreSQL. Use this if you already have a database
    and will supply DATABASE_URL / PG* yourself.

.PARAMETER SkipNpmInstall
    Do not run `npm install` (just install the system tooling).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -UseDocker

.NOTES
    Run this from the project root. Installing system software may prompt for
    elevation (winget/UAC). Review the script before running it.
#>

[CmdletBinding()]
param(
    [switch]$UseDocker,
    [switch]$SkipDb,
    [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"

# --- Configuration (matches the README Docker example) ---------------------
$PgContainerName = "farmhouse-pg"
$PgPassword      = "password"
$PgDatabase      = "route_optimization"
$PgPort          = 5432
$DatabaseUrl     = "postgres://postgres:$PgPassword@localhost:$PgPort/$PgDatabase"
$MinNodeMajor    = 18

# --- Output helpers ---------------------------------------------------------
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ok] $msg"   -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  $msg"        -ForegroundColor Gray }
function Write-Warn2($msg){ Write-Host "  [warn] $msg" -ForegroundColor Yellow }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Refresh the current session's PATH from the machine + user environment so a
# freshly installed tool becomes usable without reopening the shell.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = @($machine, $user | Where-Object { $_ }) -join ";"
}

# Resolve the project root as the parent of this script's folder.
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Write-Step "Farmhouse route-optimization — local setup"
Write-Info "Project root: $ProjectRoot"

# --- winget availability ----------------------------------------------------
$HasWinget = Test-Command "winget"
if (-not $HasWinget) {
    Write-Warn2 "winget (the Windows Package Manager) was not found."
    Write-Info  "Install 'App Installer' from the Microsoft Store, or install the"
    Write-Info  "tools manually:"
    Write-Info  "  - Node.js LTS: https://nodejs.org/en/download"
    Write-Info  "  - PostgreSQL:  https://www.postgresql.org/download/windows/"
    Write-Info  "Then re-run this script (it will skip anything already installed)."
}

function Install-WithWinget($id, $friendlyName) {
    if (-not $HasWinget) {
        Write-Warn2 "Cannot auto-install $friendlyName without winget. See the links above."
        return $false
    }
    Write-Info "Installing $friendlyName via winget ($id)..."
    # --silent keeps it non-interactive; the accept flags avoid agreement prompts.
    winget install --id $id --exact --silent `
        --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "winget exited with code $LASTEXITCODE for $friendlyName."
        return $false
    }
    Update-SessionPath
    return $true
}

# --- 1. Node.js -------------------------------------------------------------
Write-Step "Checking Node.js (need $MinNodeMajor or newer)"
$needNode = $true
if (Test-Command "node") {
    $nodeVer = (node --version).TrimStart("v")
    $major = [int]($nodeVer.Split(".")[0])
    if ($major -ge $MinNodeMajor) {
        Write-Ok "Node.js $nodeVer is installed."
        $needNode = $false
    } else {
        Write-Warn2 "Node.js $nodeVer is older than $MinNodeMajor. Installing the LTS."
    }
} else {
    Write-Info "Node.js not found."
}

if ($needNode) {
    if (Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS") {
        if (Test-Command "node") {
            Write-Ok "Node.js $((node --version)) is now available."
        } else {
            Write-Warn2 "Node.js was installed but is not on PATH in this session."
            Write-Info  "Close and reopen your terminal, then re-run this script."
        }
    }
}

# --- 2. PostgreSQL / Docker -------------------------------------------------
if ($SkipDb) {
    Write-Step "Skipping PostgreSQL setup (-SkipDb)"
    Write-Info "Provide your own DATABASE_URL or PG* variables before 'npm start'."
}
elseif ($UseDocker) {
    Write-Step "Setting up PostgreSQL via Docker"
    if (-not (Test-Command "docker")) {
        Write-Warn2 "Docker was not found. Install Docker Desktop:"
        Write-Info  "  https://www.docker.com/products/docker-desktop/"
        Write-Info  "Then re-run: scripts\setup.ps1 -UseDocker"
    } else {
        $existing = (docker ps -a --filter "name=^/$PgContainerName$" --format "{{.Names}}")
        if ($existing -eq $PgContainerName) {
            Write-Info "Container '$PgContainerName' already exists; starting it."
            docker start $PgContainerName | Out-Null
        } else {
            Write-Info "Starting a new PostgreSQL container '$PgContainerName'."
            docker run --name $PgContainerName `
                -e "POSTGRES_PASSWORD=$PgPassword" `
                -e "POSTGRES_DB=$PgDatabase" `
                -p "$PgPort`:5432" -d postgres:16 | Out-Null
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "PostgreSQL container is running on localhost:$PgPort."
        } else {
            Write-Warn2 "Docker could not start the container (is Docker Desktop running?)."
        }
    }
}
else {
    Write-Step "Checking PostgreSQL"
    if (Test-Command "psql") {
        Write-Ok "PostgreSQL client (psql) is installed."
        Write-Info "Make sure the server is running and create the database, e.g.:"
        Write-Info "  createdb $PgDatabase"
    } else {
        Write-Info "PostgreSQL not found."
        if (Install-WithWinget "PostgreSQL.PostgreSQL" "PostgreSQL") {
            Write-Ok "PostgreSQL installed. Note the superuser password you set during install."
            Write-Info "Create the app database (in a new terminal), e.g.:"
            Write-Info "  createdb -U postgres $PgDatabase"
        }
    }
    Write-Info "Tip: -UseDocker gives a zero-config disposable database instead."
}

# --- 3. npm dependencies ----------------------------------------------------
if ($SkipNpmInstall) {
    Write-Step "Skipping 'npm install' (-SkipNpmInstall)"
}
elseif (Test-Command "npm") {
    Write-Step "Installing project dependencies (npm install)"
    Push-Location $ProjectRoot
    try {
        npm install
        if ($LASTEXITCODE -eq 0) { Write-Ok "Dependencies installed." }
        else { Write-Warn2 "npm install exited with code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} else {
    Write-Warn2 "npm is not on PATH yet. Reopen your terminal and run 'npm install' manually."
}

# --- Next steps -------------------------------------------------------------
Write-Step "Next steps"
if ($UseDocker) {
    Write-Info "1. Point the app at the database (this terminal):"
    Write-Host  "     `$env:DATABASE_URL = `"$DatabaseUrl`"" -ForegroundColor White
} elseif (-not $SkipDb) {
    Write-Info "1. Set DATABASE_URL for your PostgreSQL, e.g.:"
    Write-Host  "     `$env:DATABASE_URL = `"$DatabaseUrl`"" -ForegroundColor White
} else {
    Write-Info "1. Set DATABASE_URL (or PG* vars) for your database."
}
Write-Info "2. (first run) seed a driver for the driver app:"
Write-Host  "     `$env:SEED_DRIVER_USERNAME = `"driver1`"" -ForegroundColor White
Write-Host  "     `$env:SEED_DRIVER_PASSWORD = `"choose-a-password`"" -ForegroundColor White
Write-Host  "     npm run db:seed" -ForegroundColor White
Write-Info "3. Start the server:"
Write-Host  "     npm start" -ForegroundColor White
Write-Info "   Dashboard        http://localhost:3000"
Write-Info "   Route planner    http://localhost:3000/plan.html"
Write-Info "   Driver app       http://localhost:3000/driver.html"
Write-Info "Run the tests (no database required):  npm test"
Write-Host ""
