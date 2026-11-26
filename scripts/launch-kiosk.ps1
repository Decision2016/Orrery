[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)][int]$MonitorIndex,
    [uri]$Url = 'http://127.0.0.1:4318',
    [switch]$Kiosk
)

$ErrorActionPreference = 'Stop'
if (-not $Url.IsAbsoluteUri -or $Url.Scheme -notin @('http', 'https')) {
    throw 'Supply an absolute HTTP or HTTPS URL.'
}

Add-Type -AssemblyName System.Windows.Forms
if (-not ('Orrery.MonitorDpi' -as [type])) {
    Add-Type -Namespace Orrery -Name MonitorDpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr context);
'@
}

# WinForms screen bounds must be physical pixels, including on mixed-DPI desktops.
$previousDpi = [Orrery.MonitorDpi]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    if (-not $screens.Count) { throw 'No attached monitor was detected.' }
    if ($PSBoundParameters.ContainsKey('MonitorIndex')) {
        if ($MonitorIndex -ge $screens.Count) {
            throw "Monitor index $MonitorIndex is outside the available range 0..$($screens.Count - 1)."
        }
        $screen = $screens[$MonitorIndex]
    } else {
        $screen = $screens | Where-Object { $_.Bounds.Width -eq 3840 -and $_.Bounds.Height -eq 1100 } | Select-Object -First 1
        if (-not $screen) {
            $screen = $screens | Where-Object { $_.Bounds.Width / $_.Bounds.Height -ge 2.8 } |
                Sort-Object { [Math]::Abs($_.Bounds.Width / $_.Bounds.Height - 3840.0 / 1100) } |
                Select-Object -First 1
        }
        if (-not $screen) { $screen = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1 }
        if (-not $screen) { $screen = $screens | Where-Object { $_.Primary } | Select-Object -First 1 }
    }
    $bounds = $screen.Bounds
} finally {
    if ($previousDpi -ne [IntPtr]::Zero) { [void][Orrery.MonitorDpi]::SetThreadDpiAwarenessContext($previousDpi) }
}

$browser = $null
foreach ($product in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
    $name = [IO.Path]::GetFileName($product)
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $browser = $command.Source; break }
    foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:LOCALAPPDATA)) {
        if (-not $root) { continue }
        $candidate = Join-Path $root $product
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $browser = $candidate; break }
    }
    if ($browser) { break }
    foreach ($hive in @('HKCU:', 'HKLM:')) {
        $appPath = Get-Item -LiteralPath "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$name" -ErrorAction SilentlyContinue
        if ($appPath) {
            $candidate = [string]$appPath.GetValue('')
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $browser = $candidate; break }
        }
    }
    if ($browser) { break }
}
if (-not $browser) { throw 'Install Microsoft Edge or Google Chrome to open the Orrery wallboard.' }

$profileDir = Join-Path $env:LOCALAPPDATA 'Orrery\browser-profile'
[void][IO.Directory]::CreateDirectory($profileDir)
$browserArgs = @(
    ('--user-data-dir="{0}"' -f $profileDir),
    ('--app="{0}"' -f $Url.AbsoluteUri),
    "--window-position=$($bounds.X),$($bounds.Y)",
    "--window-size=$($bounds.Width),$($bounds.Height)",
    '--no-first-run',
    '--no-default-browser-check'
)
if ($Kiosk) { $browserArgs += '--kiosk' }
Start-Process -FilePath $browser -ArgumentList $browserArgs
