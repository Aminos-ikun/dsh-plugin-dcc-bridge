# dsh-plugin-dcc-bridge — Windows desktop agent.
#
# A long-lived Windows PowerShell process that speaks one JSON object per line
# on stdin and writes exactly one JSON object per line on stdout. All native
# work lives in the embedded C# below so the PowerShell layer stays a thin
# dispatcher: Add-Type is compiled once per process, which is the whole reason
# this process outlives a single call.
#
# Request:  {"id":"<opaque>","action":"<name>","params":{...}}
# Response: {"id":"<opaque>","ok":true,"data":{...}}
#           {"id":"<opaque>","ok":false,"error":"..."}
#
# Two transports, because a confined parent process may be unable to create
# anonymous pipes for stdio:
#   * listen mode  — -Listen <port>: serve request lines over a loopback socket
#                    (the parent stays warm and fast; the socket binds 127.0.0.1
#                    only and every request must carry the startup token).
#   * batch mode   — -Request <in.json> -Response <out.json>: handle exactly one
#                    request and exit, touching only files.
# Without either switch the process reads request lines from stdin.

param(
    [string]$Request,
    [string]$Response,
    [int]$Listen = 0,
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Add-Type -TypeDefinition does not inherit the assemblies loaded with
# -AssemblyName here, so the two GDI assemblies the native layer compiles
# against are named explicitly.
$dshReferences = @(
    ([System.Drawing.Bitmap].Assembly.Location),
    ([System.Windows.Forms.Screen].Assembly.Location)
) | Where-Object { $_ } | Select-Object -Unique

Add-Type -ReferencedAssemblies $dshReferences -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshNative
{
    // ---------------------------------------------------------------- types
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg; public ushort wParamL; public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;

    static readonly Dictionary<string, ushort> VK = BuildVkTable();

    static Dictionary<string, ushort> BuildVkTable()
    {
        var m = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
        string[] letters = { "a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z" };
        for (int i = 0; i < letters.Length; i++) m[letters[i]] = (ushort)(0x41 + i);
        for (int i = 0; i <= 9; i++) m[i.ToString()] = (ushort)(0x30 + i);
        for (int i = 1; i <= 24; i++) m["f" + i] = (ushort)(0x6F + i);
        m["backspace"] = 0x08; m["back"] = 0x08; m["tab"] = 0x09; m["clear"] = 0x0C;
        m["enter"] = 0x0D; m["return"] = 0x0D; m["shift"] = 0x10; m["ctrl"] = 0x11;
        m["control"] = 0x11; m["alt"] = 0x12; m["pause"] = 0x13; m["capslock"] = 0x14;
        m["esc"] = 0x1B; m["escape"] = 0x1B; m["space"] = 0x20; m["pageup"] = 0x21;
        m["pagedown"] = 0x22; m["end"] = 0x23; m["home"] = 0x24;
        m["left"] = 0x25; m["up"] = 0x26; m["right"] = 0x27; m["down"] = 0x28;
        m["printscreen"] = 0x2C; m["insert"] = 0x2D; m["delete"] = 0x2E; m["del"] = 0x2E;
        m["win"] = 0x5B; m["lwin"] = 0x5B; m["rwin"] = 0x5C;
        m["numlock"] = 0x90; m["scrolllock"] = 0x91;
        m["semicolon"] = 0xBA; m[";"] = 0xBA; m["equals"] = 0xBB; m["="] = 0xBB;
        m["comma"] = 0xBC; m[","] = 0xBC; m["minus"] = 0xBD; m["-"] = 0xBD;
        m["period"] = 0xBE; m["."] = 0xBE; m["slash"] = 0xBF; m["/"] = 0xBF;
        m["backtick"] = 0xC0; m["`"] = 0xC0;
        m["lbracket"] = 0xDB; m["["] = 0xDB; m["backslash"] = 0xDC; m["\\"] = 0xDC;
        m["rbracket"] = 0xDD; m["]"] = 0xDD; m["quote"] = 0xDE; m["'"] = 0xDE;
        return m;
    }

    public static void EnableDpiAwareness()
    {
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    // --------------------------------------------------------------- input
    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags;
        return i;
    }

    static INPUT MouseInput(uint flags, uint data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = flags;
        i.u.mi.mouseData = data;
        return i;
    }

    static void Dispatch(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent == 0)
        {
            // Fall back to the legacy entry points, still current on every
            // desktop Windows build; some secured desktops reject SendInput.
            foreach (INPUT i in inputs)
            {
                if (i.type == INPUT_MOUSE) mouse_event(i.u.mi.dwFlags, i.u.mi.dx, i.u.mi.dy, i.u.mi.mouseData, UIntPtr.Zero);
            }
        }
    }

    public static string MoveCursor(int x, int y)
    {
        if (!SetCursorPos(x, y)) throw new Exception("SetCursorPos failed for (" + x + ", " + y + ")");
        POINT p; GetCursorPos(out p);
        return p.X + "," + p.Y;
    }

    public static string CursorPosition()
    {
        POINT p; GetCursorPos(out p);
        return p.X + "," + p.Y;
    }

    public static string ClickAt(int x, int y, string button, int count, int intervalMs)
    {
        MoveCursor(x, y);
        uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
        string b = (button ?? "left").ToLowerInvariant();
        if (b == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (b == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        if (count < 1) count = 1;
        if (count > 3) count = 3;
        for (int n = 0; n < count; n++)
        {
            Dispatch(new INPUT[] { MouseInput(down, 0), MouseInput(up, 0) });
            if (n < count - 1) Thread.Sleep(intervalMs > 0 ? intervalMs : 60);
        }
        return CursorPosition();
    }

    public static string DragTo(int x1, int y1, int x2, int y2, string button)
    {
        MoveCursor(x1, y1);
        string b = (button ?? "left").ToLowerInvariant();
        uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
        if (b == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (b == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        Dispatch(new INPUT[] { MouseInput(down, 0) });
        Thread.Sleep(40);
        // Interpolate: a single jump reads as a teleport to drag-aware
        // applications (3D viewports, timeline scrubbers, sliders).
        int steps = 12;
        for (int s = 1; s <= steps; s++)
        {
            int x = x1 + (x2 - x1) * s / steps;
            int y = y1 + (y2 - y1) * s / steps;
            SetCursorPos(x, y);
            Thread.Sleep(12);
        }
        SetCursorPos(x2, y2);
        Thread.Sleep(40);
        Dispatch(new INPUT[] { MouseInput(up, 0) });
        return CursorPosition();
    }

    public static string ScrollAt(int x, int y, int amount)
    {
        MoveCursor(x, y);
        if (amount == 0) amount = 1;
        Dispatch(new INPUT[] { MouseInput(MOUSEEVENTF_WHEEL, unchecked((uint)(amount * 120))) });
        return CursorPosition();
    }

    public static void TypeText(string text)
    {
        if (text == null || text.Length == 0) return;
        List<INPUT> list = new List<INPUT>(text.Length * 2);
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            // Surrogate pairs are already UTF-16 code units; sending each unit
            // with KEYEVENTF_UNICODE is exactly how the pair is delivered.
            list.Add(KeyInput(0, c, KEYEVENTF_UNICODE));
            list.Add(KeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        Dispatch(list.ToArray());
    }

    public static void KeyStroke(string name)
    {
        ushort vk;
        if (!VK.TryGetValue((name ?? "").Trim(), out vk))
            throw new Exception("unknown key name: " + name);
        Dispatch(new INPUT[] { KeyInput(vk, 0, 0), KeyInput(vk, 0, KEYEVENTF_KEYUP) });
    }

    public static void KeyChord(string[] names)
    {
        if (names == null || names.Length == 0) throw new Exception("hotkey requires at least one key");
        List<INPUT> down = new List<INPUT>();
        foreach (string n in names)
        {
            ushort vk;
            if (!VK.TryGetValue((n ?? "").Trim(), out vk))
                throw new Exception("unknown key name: " + n);
            down.Add(KeyInput(vk, 0, 0));
        }
        List<INPUT> all = new List<INPUT>(down);
        for (int i = down.Count - 1; i >= 0; i--)
        {
            INPUT k = down[i];
            k.u.ki.dwFlags = KEYEVENTF_KEYUP;
            all.Add(k);
        }
        Dispatch(all.ToArray());
    }

    // ------------------------------------------------------------- windows
    public static List<string> ListWindows()
    {
        List<string> rows = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            try
            {
                if (!IsWindowVisible(h)) return true;
                int len = GetWindowTextLengthW(h);
                if (len <= 0) return true;
                StringBuilder sb = new StringBuilder(len + 2);
                GetWindowTextW(h, sb, sb.Capacity);
                string title = sb.ToString();
                if (title.Trim().Length == 0) return true;
                StringBuilder cls = new StringBuilder(256);
                GetClassNameW(h, cls, cls.Capacity);
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                RECT r;
                GetWindowRect(h, out r);
                rows.Add(string.Join("\u0001", new string[] {
                    h.ToInt64().ToString(),
                    pid.ToString(),
                    title.Replace("\u0001", " "),
                    cls.ToString(),
                    r.Left.ToString(), r.Top.ToString(),
                    (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
                    IsIconic(h) ? "1" : "0"
                }));
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return rows;
    }

    public static string[] FindWindows(string match, string hwndText)
    {
        List<string> rows = ListWindows();
        List<string> hits = new List<string>();
        long want = -1;
        long.TryParse(hwndText, out want);
        string needle = (match ?? "").Trim();
        foreach (string row in rows)
        {
            string[] f = row.Split('\u0001');
            if (want > 0 && f[0] == want.ToString()) { hits.Add(row); continue; }
            if (needle.Length > 0 && f[2].IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) hits.Add(row);
        }
        return hits.ToArray();
    }

    public static string ForegroundWindow()
    {
        return GetForegroundWindow().ToInt64().ToString();
    }

    public static string WindowShow(long h, int cmd)
    {
        IntPtr p = new IntPtr(h);
        if (!IsWindow(p)) throw new Exception("no such window: " + h);
        ShowWindow(p, cmd);
        return "ok";
    }

    public static string WindowFocus(long h)
    {
        IntPtr p = new IntPtr(h);
        if (!IsWindow(p)) throw new Exception("no such window: " + h);
        if (IsIconic(p)) ShowWindow(p, 9); // SW_RESTORE
        ShowWindow(p, 5);                  // SW_SHOW
        bool ok = SetForegroundWindow(p);
        return ok ? "ok" : "requested";
    }

    public static string WindowMove(long h, int x, int y, int w, int t)
    {
        IntPtr p = new IntPtr(h);
        if (!IsWindow(p)) throw new Exception("no such window: " + h);
        if (IsIconic(p)) ShowWindow(p, 9);
        if (!MoveWindow(p, x, y, w, t, true)) throw new Exception("MoveWindow failed");
        return "ok";
    }

    public static string WindowClose(long h)
    {
        IntPtr p = new IntPtr(h);
        if (!IsWindow(p)) throw new Exception("no such window: " + h);
        PostMessageW(p, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
        return "ok";
    }

    public static bool CaptureWindowToFile(long h, string path, uint flags)
    {
        IntPtr p = new IntPtr(h);
        if (!IsWindow(p)) throw new Exception("no such window: " + h);
        RECT r;
        if (!GetWindowRect(p, out r)) throw new Exception("GetWindowRect failed");
        int w = r.Right - r.Left, t = r.Bottom - r.Top;
        if (w <= 0 || t <= 0) throw new Exception("window has no area");
        using (Bitmap bmp = new Bitmap(w, t, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(p, hdc, flags); }
                finally { g.ReleaseHdc(hdc); }
                if (!ok) return false;
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return true;
    }

    public static string VirtualScreen()
    {
        Rectangle r = System.Windows.Forms.SystemInformation.VirtualScreen;
        return r.Left + "," + r.Top + "," + r.Width + "," + r.Height;
    }

    public static string MonitorList()
    {
        StringBuilder sb = new StringBuilder();
        System.Windows.Forms.Screen[] screens = System.Windows.Forms.Screen.AllScreens;
        for (int i = 0; i < screens.Length; i++)
        {
            if (i > 0) sb.Append("\u0001");
            Rectangle b = screens[i].Bounds;
            sb.Append(i + "," + b.Left + "," + b.Top + "," + b.Width + "," + b.Height + "," + (screens[i].Primary ? "1" : "0"));
        }
        return sb.ToString();
    }

    public static void CaptureRectToFile(int x, int y, int w, int t, string path)
    {
        if (w <= 0 || t <= 0) throw new Exception("capture area has no size");
        using (Bitmap bmp = new Bitmap(w, t, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, t), CopyPixelOperation.SourceCopy);
            }
            bmp.Save(path, ImageFormat.Png);
        }
    }
}
'@

[DshNative]::EnableDpiAwareness() | Out-Null

function ConvertTo-DshWindow {
    param([string]$Row)
    $f = $Row -split ([char]1)
    $pid2 = 0
    [void][int]::TryParse($f[1], [ref]$pid2)
    $name = $null
    try {
        $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
        if ($p) { $name = $p.ProcessName }
    } catch { }
    $entry = [ordered]@{
        handle    = $f[0]
        pid       = $pid2
        title     = $f[2]
        class     = $f[3]
        x         = [int]$f[4]
        y         = [int]$f[5]
        width     = [int]$f[6]
        height    = [int]$f[7]
        minimized = ($f[8] -eq '1')
    }
    # Omitted rather than null: the registry validates tool output against the
    # declared schema, and a null where a string is declared fails the call.
    if ($name) { $entry.process = $name }
    return $entry
}

function Get-DshCursorXY {
    $p = [DshNative]::CursorPosition() -split ','
    return @([int]$p[0], [int]$p[1])
}

function Resolve-DshWindow {
    param($Params)
    if ($Params.handle) {
        $h = [int64]$Params.handle
        return [ordered]@{ handle = $h.ToString(); title = $null; pid = 0 }
    }
    if (-not $Params.match) { throw 'window: pass either `match` (a title substring) or `handle`' }
    $rows = [DshNative]::FindWindows([string]$Params.match, $null)
    if ($rows.Length -eq 0) { throw ("no visible top-level window matches '" + $Params.match + "'") }
    $w = ConvertTo-DshWindow $rows[0]
    return [ordered]@{ handle = $w.handle; title = $w.title; pid = $w.pid; process = $w.process }
}

function Invoke-DshAction {
    param([string]$Action, $Params)
    if ($null -eq $Params) { $Params = [pscustomobject]@{} }

    switch ($Action) {
        'ping' {
            return [ordered]@{
                psversion = $PSVersionTable.PSVersion.ToString()
                edition   = $PSVersionTable.PSEdition
                apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString()
                machine   = $env:COMPUTERNAME
                user      = $env:USERNAME
                cursor    = [DshNative]::CursorPosition()
                virtual   = [DshNative]::VirtualScreen()
            }
        }
        'screen.info' {
            $monitors = @()
            $raw = [DshNative]::MonitorList()
            if ($raw.Length -gt 0) {
                foreach ($m in ($raw -split ([char]1))) {
                    $p = $m -split ','
                    $monitors += [ordered]@{
                        index   = [int]$p[0]
                        x       = [int]$p[1]
                        y       = [int]$p[2]
                        width   = [int]$p[3]
                        height  = [int]$p[4]
                        primary = ($p[5] -eq '1')
                    }
                }
            }
            $v = [DshNative]::VirtualScreen() -split ','
            return [ordered]@{
                monitors = $monitors
                virtual  = [ordered]@{ x = [int]$v[0]; y = [int]$v[1]; width = [int]$v[2]; height = [int]$v[3] }
                cursor   = (Get-DshCursor)
            }
        }
        'screen.capture' {
            if (-not $Params.path) { throw 'screen.capture requires `path`' }
            $path = [string]$Params.path
            $dir = Split-Path -Parent $path
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            $method = if ($Params.method) { [string]$Params.method } else { 'auto' }
            $info = [ordered]@{ path = $path; target = 'screen' }

            if ($Params.window -or $Params.match) {
                $w = Resolve-DshWindow $Params
                $info.target = 'window'
                $info.window = $w
                $flags = 2
                $ok = $false
                if ($method -ne 'screen') {
                    $ok = [DshNative]::CaptureWindowToFile([int64]$w.handle, $path, $flags)
                }
                if (-not $ok) {
                    if ($method -eq 'printwindow') { throw 'PrintWindow failed for this window (try method: "screen")' }
                    $rows = [DshNative]::FindWindows($null, $w.handle)
                    if ($rows.Length -eq 0) { throw 'window disappeared before capture' }
                    $wf = ConvertTo-DshWindow $rows[0]
                    [DshNative]::CaptureRectToFile($wf.x, $wf.y, $wf.width, $wf.height, $path)
                    $info.method = 'screen-region'
                    $info.width = $wf.width
                    $info.height = $wf.height
                } else {
                    $info.method = 'printwindow'
                }
            }
            else {
                $x = 0; $y = 0; $width = 0; $height = 0
                if ($Params.x -ne $null -and $Params.y -ne $null -and $Params.width -ne $null -and $Params.height -ne $null) {
                    $x = [int]$Params.x; $y = [int]$Params.y
                    $width = [int]$Params.width; $height = [int]$Params.height
                    $info.target = 'region'
                }
                elseif ($Params.monitor -ne $null) {
                    $raw = [DshNative]::MonitorList() -split ([char]1)
                    $idx = [int]$Params.monitor
                    if ($idx -lt 0 -or $idx -ge $raw.Length) { throw ("monitor index " + $idx + " out of range (0.." + ($raw.Length - 1) + ")") }
                    $p = $raw[$idx] -split ','
                    $x = [int]$p[1]; $y = [int]$p[2]; $width = [int]$p[3]; $height = [int]$p[4]
                    $info.target = 'monitor'
                    $info.monitor = $idx
                }
                else {
                    $v = [DshNative]::VirtualScreen() -split ','
                    $x = [int]$v[0]; $y = [int]$v[1]; $width = [int]$v[2]; $height = [int]$v[3]
                    $info.target = 'virtual-screen'
                }
                if ($width -le 0 -or $height -le 0) { throw 'capture area has no size' }
                [DshNative]::CaptureRectToFile($x, $y, $width, $height, $path)
                $info.method = 'screen-region'
                $info.x = $x; $info.y = $y; $info.width = $width; $info.height = $height
            }
            $f = Get-Item $path
            $info.bytes = [int]$f.Length
            if (-not $info.Contains('width')) {
                Add-Type -AssemblyName System.Drawing
                $img = [System.Drawing.Image]::FromFile($path)
                try { $info.width = $img.Width; $info.height = $img.Height } finally { $img.Dispose() }
            }
            return $info
        }
        'mouse' {
            $a = if ($Params.action) { [string]$Params.action } else { throw 'mouse requires `action`' }
            switch ($a) {
                'position' {
                    $xy = Get-DshCursorXY
                    return [ordered]@{ action = 'position'; x = $xy[0]; y = $xy[1] }
                }
                'move' {
                    if ($Params.x -eq $null -or $Params.y -eq $null) { throw 'mouse move requires x and y' }
                    [void][DshNative]::MoveCursor([int]$Params.x, [int]$Params.y)
                    $xy = Get-DshCursorXY
                    return [ordered]@{ action = 'move'; x = $xy[0]; y = $xy[1] }
                }
                'click' { }
                'double_click' { }
                'right_click' { }
                'middle_click' { }
                default {
                    if ($a -eq 'drag') { break }
                    if ($a -eq 'scroll') { break }
                    throw ("unknown mouse action: " + $a)
                }
            }
            if ($a -eq 'drag') {
                if ($Params.x -eq $null -or $Params.y -eq $null) { throw 'mouse drag requires x and y (the drop point)' }
                $from = Get-DshCursorXY
                if ($Params.from_x -ne $null -and $Params.from_y -ne $null) { $from = @([int]$Params.from_x, [int]$Params.from_y) }
                if ($Params.from_window -or $Params.from_match) {
                    $w = Resolve-DshWindow ([pscustomobject]@{ match = $Params.from_match; window = $Params.from_window })
                    $rows = [DshNative]::FindWindows($null, $w.handle)
                    $wf = ConvertTo-DshWindow $rows[0]
                    $from = @([int]($wf.x + [int]($wf.width / 2)), [int]($wf.y + [int]($wf.height / 2)))
                }
                $button = if ($Params.button) { [string]$Params.button } else { 'left' }
                [void][DshNative]::DragTo([int]$from[0], [int]$from[1], [int]$Params.x, [int]$Params.y, $button)
                $xy = Get-DshCursorXY
                return [ordered]@{
                    action = 'drag'; x = $xy[0]; y = $xy[1]
                    from_x = [int]$from[0]; from_y = [int]$from[1]; button = $button
                }
            }
            if ($a -eq 'scroll') {
                $xy = Get-DshCursorXY
                if ($Params.x -ne $null -and $Params.y -ne $null) { $xy = @([int]$Params.x, [int]$Params.y) }
                $amount = if ($Params.amount -ne $null) { [int]$Params.amount } else { 1 }
                [void][DshNative]::ScrollAt($xy[0], $xy[1], $amount)
                return [ordered]@{ action = 'scroll'; x = $xy[0]; y = $xy[1]; amount = $amount }
            }
            $button = 'left'
            if ($a -eq 'right_click') { $button = 'right' }
            if ($a -eq 'middle_click') { $button = 'middle' }
            if ($Params.button) { $button = [string]$Params.button }
            $count = 1
            if ($a -eq 'double_click') { $count = 2 }
            if ($Params.count -ne $null) { $count = [int]$Params.count }
            $x = $Params.x; $y = $Params.y
            if ($x -eq $null -or $y -eq $null) {
                $cur = Get-DshCursorXY
                if ($x -eq $null) { $x = $cur[0] }
                if ($y -eq $null) { $y = $cur[1] }
            }
            [void][DshNative]::ClickAt([int]$x, [int]$y, $button, $count, 60)
            $xy = Get-DshCursorXY
            return [ordered]@{ action = $a; x = $xy[0]; y = $xy[1]; button = $button; count = $count }
        }
        'keyboard' {
            $a = if ($Params.action) { [string]$Params.action } else { throw 'keyboard requires `action`' }
            switch ($a) {
                'type' {
                    if ($Params.text -eq $null) { throw 'keyboard type requires `text`' }
                    $text = [string]$Params.text
                    [DshNative]::TypeText($text)
                    return [ordered]@{ typed = $text.Length }
                }
                'key' {
                    if (-not $Params.key) { throw 'keyboard key requires `key`' }
                    [DshNative]::KeyStroke([string]$Params.key)
                    return [ordered]@{ key = [string]$Params.key }
                }
                'hotkey' {
                    if (-not $Params.keys) { throw 'keyboard hotkey requires `keys` (array of key names)' }
                    $keys = @($Params.keys | ForEach-Object { [string]$_ })
                    [DshNative]::KeyChord($keys)
                    return [ordered]@{ keys = $keys }
                }
                default { throw ("unknown keyboard action: " + $a) }
            }
        }
        'window.list' {
            $rows = [DshNative]::ListWindows()
            $fg = [DshNative]::ForegroundWindow()
            $list = @()
            foreach ($r in $rows) {
                $w = ConvertTo-DshWindow $r
                $w.foreground = ($w.handle -eq $fg)
                if ($Params.match -and $w.title -notlike ("*" + [string]$Params.match + "*")) { continue }
                if ($Params.exclude_minimized -eq $true -and $w.minimized) { continue }
                $list += $w
            }
            return [ordered]@{ windows = $list; count = $list.Count }
        }
        'window.action' {
            $a = if ($Params.action) { [string]$Params.action } else { throw 'window.action requires `action`' }
            $w = Resolve-DshWindow $Params
            switch ($a) {
                'focus' { $r = [DshNative]::WindowFocus([int64]$w.handle) }
                'minimize' { $r = [DshNative]::WindowShow([int64]$w.handle, 6) }
                'maximize' { $r = [DshNative]::WindowShow([int64]$w.handle, 3) }
                'restore' { $r = [DshNative]::WindowShow([int64]$w.handle, 9) }
                'hide' { $r = [DshNative]::WindowShow([int64]$w.handle, 0) }
                'close' { $r = [DshNative]::WindowClose([int64]$w.handle) }
                'move' {
                    $rows = [DshNative]::FindWindows($null, $w.handle)
                    if ($rows.Length -eq 0) { throw 'window disappeared' }
                    $cur = ConvertTo-DshWindow $rows[0]
                    $x = if ($Params.x -ne $null) { [int]$Params.x } else { $cur.x }
                    $y = if ($Params.y -ne $null) { [int]$Params.y } else { $cur.y }
                    $width = if ($Params.width -ne $null) { [int]$Params.width } else { $cur.width }
                    $height = if ($Params.height -ne $null) { [int]$Params.height } else { $cur.height }
                    $r = [DshNative]::WindowMove([int64]$w.handle, $x, $y, $width, $height)
                    return [ordered]@{ action = $a; window = $w; x = $x; y = $y; width = $width; height = $height }
                }
                default { throw ("unknown window action: " + $a) }
            }
            return [ordered]@{ action = $a; window = $w; result = $r }
        }
        'process.list' {
            $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -gt 4 }
            if ($Params.match) { $procs = $procs | Where-Object { $_.ProcessName -like ("*" + [string]$Params.match + "*") } }
            $list = @()
            foreach ($p in $procs) {
                $path = $null
                try { $path = $p.Path } catch { }
                $list += [ordered]@{
                    pid      = $p.Id
                    name     = $p.ProcessName
                    title    = $p.MainWindowTitle
                    path     = $path
                    memoryMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
                }
            }
            $list = $list | Sort-Object name, pid
            $limit = if ($Params.limit) { [int]$Params.limit } else { 200 }
            return [ordered]@{ processes = @($list | Select-Object -First $limit); total = $list.Count }
        }
        'process.launch' {
            if (-not $Params.path) { throw 'process.launch requires `path`' }
            $args2 = @()
            if ($Params.args) { $args2 = @($Params.args | ForEach-Object { [string]$_ }) }
            $sp = @{ FilePath = [string]$Params.path; PassThru = $true }
            if ($args2.Count -gt 0) { $sp.ArgumentList = $args2 }
            if ($Params.workdir) { $sp.WorkingDirectory = [string]$Params.workdir }
            $p = Start-Process @sp
            return [ordered]@{ pid = $p.Id; path = [string]$Params.path }
        }
        'process.kill' {
            if (-not $Params.pid) { throw 'process.kill requires `pid`' }
            $p = Get-Process -Id ([int]$Params.pid) -ErrorAction Stop
            $name = $p.ProcessName
            Stop-Process -Id ([int]$Params.pid) -Force -ErrorAction Stop
            return [ordered]@{ pid = [int]$Params.pid; name = $name; killed = $true }
        }
        'clipboard.read' {
            $t = $null
            # The clipboard is a shared, single-owner resource: a momentary lock
            # held by another process is the normal failure, so retry before
            # giving up and fall back to the WinForms accessor.
            for ($attempt = 0; $attempt -lt 5; $attempt++) {
                try { $t = Get-Clipboard -Raw -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 120 }
            }
            if ($null -eq $t) {
                for ($attempt = 0; $attempt -lt 3; $attempt++) {
                    try { $t = [System.Windows.Forms.Clipboard]::GetText(); break } catch { Start-Sleep -Milliseconds 150 }
                }
            }
            if ($null -eq $t) { $t = '' }
            return [ordered]@{ text = [string]$t }
        }
        'clipboard.write' {
            if ($Params.text -eq $null) { throw 'clipboard.write requires `text`' }
            $value = [string]$Params.text
            $ok = $false
            for ($attempt = 0; $attempt -lt 5; $attempt++) {
                try { Set-Clipboard -Value $value -ErrorAction Stop; $ok = $true; break } catch { Start-Sleep -Milliseconds 120 }
            }
            if (-not $ok) {
                for ($attempt = 0; $attempt -lt 3; $attempt++) {
                    try { [System.Windows.Forms.Clipboard]::SetText($value); $ok = $true; break } catch { Start-Sleep -Milliseconds 150 }
                }
            }
            if (-not $ok) { throw 'the clipboard was locked by another process; nothing was written' }
            return [ordered]@{ length = $value.Length }
        }
        'clipboard.clear' {
            Set-Clipboard -Value $null -ErrorAction SilentlyContinue
            return [ordered]@{ cleared = $true }
        }
        default { throw ("unknown action: " + $Action) }
    }
}

function Get-DshCursor {
    $p = [DshNative]::CursorPosition() -split ','
    return [ordered]@{ x = [int]$p[0]; y = [int]$p[1] }
}

$out = [Console]::Out

function Invoke-DshLine {
    param([string]$Line)
    $id = $null
    try {
        $req = $Line | ConvertFrom-Json
        $id = $req.id
        $data = Invoke-DshAction -Action ([string]$req.action) -Params $req.params
        $resp = [ordered]@{ id = $id; ok = $true; data = $data }
    }
    catch {
        $resp = [ordered]@{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    return ($resp | ConvertTo-Json -Depth 24 -Compress)
}

if ($Listen -gt 0) {
    # Warm loopback transport. The listener is single-client by design: this
    # process drives one interactive desktop on behalf of one parent.
    $idleMinutes = 30
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Listen)
    $listener.Start()
    $noBom = New-Object System.Text.UTF8Encoding($false)
    $deadline = (Get-Date).AddMinutes($idleMinutes)
    try {
        while ((Get-Date) -lt $deadline) {
            if (-not $listener.Pending()) { Start-Sleep -Milliseconds 40; continue }
            $client = $listener.AcceptTcpClient()
            $client.NoDelay = $true
            $stream = $client.GetStream()
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $writer = New-Object System.IO.StreamWriter($stream, $noBom)
            $writer.AutoFlush = $true
            try {
                while ($true) {
                    $line = $reader.ReadLine()
                    if ($null -eq $line) { break }
                    if ($line.Trim().Length -eq 0) { continue }
                    $deadline = (Get-Date).AddMinutes($idleMinutes)
                    if ($Token.Length -gt 0) {
                        $ok = $false
                        try { $ok = (($line | ConvertFrom-Json).token -eq $Token) } catch { $ok = $false }
                        if (-not $ok) {
                            $writer.WriteLine('{"id":null,"ok":false,"error":"unauthorized: bad or missing token"}')
                            continue
                        }
                    }
                    $writer.WriteLine((Invoke-DshLine -Line $line))
                }
            }
            finally {
                $reader.Dispose(); $writer.Dispose(); $client.Close()
            }
        }
    }
    finally {
        $listener.Stop()
    }
    exit 0
}

if ($Request) {
    # Batch transport: one request in, one response out, only files touched.
    $text = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8)
    $json = Invoke-DshLine -Line $text
    if (-not $Response) { throw 'batch mode requires -Response' }
    [System.IO.File]::WriteAllText($Response, $json, (New-Object System.Text.UTF8Encoding($false)))
    exit 0
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $out.WriteLine((Invoke-DshLine -Line $line))
    $out.Flush()
}
