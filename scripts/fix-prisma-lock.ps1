# PowerShell helper to fix EPERM on Prisma native engine file
# Run this script from the project root AS ADMINISTRATOR.
# It will try to stop common processes that may lock the file, remove the offending file and node_modules,
# and then run a clean `npm ci`.

param(
    [switch]$RemoveNodeModules # pass -RemoveNodeModules to delete entire node_modules (default: yes)
)

Write-Host "Running Prisma lock fixer..." -ForegroundColor Cyan

# 1) Stop Node processes and (optionally) common editor processes
$procsToStop = @('node', 'node.exe', 'Code', 'Code.exe', 'vscode', 'vscode.exe')
foreach ($p in $procsToStop) {
    try {
        $found = Get-Process -Name $p -ErrorAction SilentlyContinue
        if ($found) {
            Write-Host "Stopping process: $p" -ForegroundColor Yellow
            $found | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # ignore
    }
}

Start-Sleep -Milliseconds 500

# 2) Path to problematic file
$projRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$target = Join-Path $projRoot "node_modules\.prisma\client\query_engine-windows.dll.node"

if (Test-Path $target) {
    Write-Host "Found Prisma engine file: $target" -ForegroundColor Green
    try {
        Remove-Item -Path $target -Force -ErrorAction Stop
        Write-Host "Removed $target" -ForegroundColor Green
    } catch {
        Write-Host "Failed to remove Prisma engine file: $_" -ForegroundColor Red
        Write-Host "You may need to close apps that use the file, disable antivirus, or reboot and run this script as Administrator." -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host "Prisma engine file not present at expected path; continuing." -ForegroundColor Yellow
}

# 3) Optionally remove node_modules
if ($RemoveNodeModules -or -not (Test-Path (Join-Path $projRoot 'package-lock.json'))) {
    try {
        $nm = Join-Path $projRoot 'node_modules'
        if (Test-Path $nm) {
            Write-Host "Removing node_modules..." -ForegroundColor Yellow
            Remove-Item -Recurse -Force $nm -ErrorAction Stop
            Write-Host "node_modules removed." -ForegroundColor Green
        } else {
            Write-Host "node_modules not found, skipping." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Failed to remove node_modules: $_" -ForegroundColor Red
        Write-Host "Try running PowerShell as Administrator or rebooting and retrying." -ForegroundColor Yellow
        exit 1
    }
}

# 4) Re-run npm ci to install dependencies cleanly
Write-Host "Running npm ci..." -ForegroundColor Cyan
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "npm not found in PATH. Install Node.js and npm first." -ForegroundColor Red
    exit 1
}

$ci = Start-Process -FilePath npm -ArgumentList 'ci' -NoNewWindow -Wait -PassThru
if ($ci.ExitCode -ne 0) {
    Write-Host "npm ci failed with exit code $($ci.ExitCode)." -ForegroundColor Red
    Write-Host "If the error mentions a locked file, try rebooting or disabling antivirus and retry." -ForegroundColor Yellow
    exit $ci.ExitCode
}

Write-Host "npm ci completed successfully." -ForegroundColor Green
Write-Host "Run `npx prisma generate` then `npm run lint` and `npm test` as needed." -ForegroundColor Cyan

exit 0
