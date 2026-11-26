[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)][int]$MonitorIndex,
    [uri]$Url = 'http://127.0.0.1:4318',
    [switch]$Windowed,
    [switch]$Kiosk
)

$ErrorActionPreference = 'Stop'
if (-not $Url.IsAbsoluteUri -or $Url.Scheme -notin @('http', 'https')) {
    throw 'Supply an absolute HTTP or HTTPS URL.'
}

$useFullscreen = -not $Windowed.IsPresent

Add-Type -AssemblyName System.Windows.Forms
if (-not ('Orrery.Win32Snap' -as [type])) {
    Add-Type -Namespace Orrery -Name Win32Snap -MemberDefinition @'
using System;
using System.Runtime.InteropServices;

[DllImport("user32.dll")]
public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

[DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

public static IntPtr FindMainWindowByPid(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, _) => {
        uint winPid;
        GetWindowThreadProcessId(hwnd, out winPid);
        if ((int)winPid == pid && IsWindowVisible(hwnd)) {
            found = hwnd;
            return false;
        }
        return true;
    }, IntPtr.Zero);
    return found;
}

public static void SnapBorderlessFullscreen(IntPtr hwnd, int x, int y, int w, int h) {
    const int GWL_STYLE = -16;
    const long WS_CAPTION = 0x00C00000L;
    const long WS_THICKFRAME = 0x00040000L;
    const long WS_MINIMIZEBOX = 0x00020000L;
    const long WS_MAXIMIZEBOX = 0x00010000L;
    const long WS_SYSMENU = 0x00080000L;
    const long WS_POPUP = 0x80000000L;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_SHOWWINDOW = 0x0040;

    SetThreadDpiAwarenessContext(new IntPtr(-4));
    ShowWindow(hwnd, 9); // SW_RESTORE
    long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
    style &= ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
    style |= WS_POPUP;
    SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(style));

    // Pass 1: move onto target monitor so mixed-DPI Windows switches monitor DPI first.
    SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    System.Threading.Thread.Sleep(120);
    // Pass 2: apply exact physical rcMonitor pixels after DPI change settles.
    SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
}
'@
}

# WinForms screen bounds must be physical pixels, including on mixed-DPI desktops.
$previousDpi = [Orrery.Win32Snap]::SetThreadDpiAwarenessContext([IntPtr](-4))
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
    if ($previousDpi -ne [IntPtr]::Zero) { [void][Orrery.Win32Snap]::SetThreadDpiAwarenessContext($previousDpi) }
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
if ($useFullscreen -or $Kiosk) {
    $browserArgs += '--start-fullscreen'
}

$proc = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru

if ($useFullscreen) {
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $hwnd = [IntPtr]::Zero
    while ([DateTime]::UtcNow -lt $deadline) {
        $hwnd = [Orrery.Win32Snap]::FindMainWindowByPid($proc.Id)
        if ($hwnd -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 150
    }
    if ($hwnd -ne [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 350
        [Orrery.Win32Snap]::SnapBorderlessFullscreen($hwnd, $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
    }
}
