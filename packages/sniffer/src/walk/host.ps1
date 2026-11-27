# The walk tools' Windows host: one long-lived PowerShell process that the sniffer talks to over JSON lines.
# Each stdin line is {"id": n, "op": "...", ...}; each answer is one stdout line {"id": n, "ok": true, ...} or
# {"id": n, "ok": false, "error": "..."}. Nothing here knows any device: the editor is named by its executable.
#
# Screenshots follow S14: only the editor's own window, never the desktop. PrintWindow draws the window itself, so
# nothing that overlaps it can show. When PrintWindow gives a blank frame (a GPU-drawn surface), the fallback copies
# the window's rectangle from the screen only while every sampled point of it belongs to the editor; otherwise the
# shot is refused.
# -ShotRoot is the session's folder for screenshots: a shot is saved only to a .png file under it.
param([Parameter(Mandatory = $true)][string]$ShotRoot)
$ErrorActionPreference = 'Stop'
$ShotRoot = [IO.Path]::GetFullPath($ShotRoot).TrimEnd('\') + '\'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class WalkWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  // The editor's largest visible top-level window among the given process ids.
  public static IntPtr Largest(HashSet<uint> pids) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      RECT r; GetWindowRect(h, out r);
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > bestArea) { best = h; bestArea = a; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static bool Front(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    // Windows lets only the foreground thread hand over focus: borrow its input queue for the call.
    uint pid;
    uint me = GetCurrentThreadId(), fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid),
         tgt = GetWindowThreadProcessId(h, out pid);
    AttachThreadInput(me, fg, true); AttachThreadInput(tgt, fg, true);
    try {
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // ALT unlocks SetForegroundWindow
      if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
      BringWindowToTop(h); SetForegroundWindow(h);
    } finally { AttachThreadInput(me, fg, false); AttachThreadInput(tgt, fg, false); }
    System.Threading.Thread.Sleep(200);
    if (GetForegroundWindow() != h) { SwitchToThisWindow(h, true); System.Threading.Thread.Sleep(300); }
    return GetForegroundWindow() == h;
  }

  // True when every point of a grid over the window's rectangle belongs to the window (nothing overlaps it).
  public static bool Unobscured(IntPtr h, RECT r) {
    for (int i = 0; i <= 16; i++) for (int j = 0; j <= 16; j++) {
      POINT p; p.X = r.Left + 1 + (r.Right - r.Left - 3) * i / 16; p.Y = r.Top + 1 + (r.Bottom - r.Top - 3) * j / 16;
      if (GetAncestor(WindowFromPoint(p), 2) != h) return false; // GA_ROOT
    }
    return true;
  }

  // Range of luminance over a small sample: a blank (all black or all white) frame has almost none.
  public static int Spread(Bitmap b) {
    using (var s = new Bitmap(64, 40)) {
      using (var g = Graphics.FromImage(s)) { g.InterpolationMode = InterpolationMode.Bilinear; g.DrawImage(b, 0, 0, 64, 40); }
      int lo = 255, hi = 0;
      for (int x = 0; x < 64; x++) for (int y = 0; y < 40; y++) {
        var c = s.GetPixel(x, y); int l = (c.R * 299 + c.G * 587 + c.B * 114) / 1000;
        if (l < lo) lo = l; if (l > hi) hi = l;
      }
      return hi - lo;
    }
  }

  public static Bitmap Print(IntPtr h, int w, int hh) {
    var b = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(b)) {
      IntPtr dc = g.GetHdc();
      bool ok;
      try { ok = PrintWindow(h, dc, 2); } finally { g.ReleaseHdc(dc); } // PW_RENDERFULLCONTENT
      if (!ok) { b.Dispose(); return null; }
    }
    return b;
  }

  public static Bitmap FromScreen(RECT r) {
    var b = new Bitmap(r.Right - r.Left, r.Bottom - r.Top, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(r.Left, r.Top, 0, 0, b.Size);
    return b;
  }

  public static void SaveScaled(Bitmap b, string path, int width) {
    int height = (int)Math.Round((double)b.Height * width / b.Width);
    using (var s = new Bitmap(width, height)) {
      using (var g = Graphics.FromImage(s)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(b, 0, 0, width, height); }
      s.Save(path, ImageFormat.Png);
    }
  }
}
'@
[WalkWin]::DpiAware()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

// Mouse and keyboard input through SendInput, at screen coordinates in physical px.
public static class WalkInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);

  // The process and title of the top-level window under a screen point.
  public static uint OwnerPid(int x, int y, out string title) {
    POINT p; p.X = x; p.Y = y;
    IntPtr root = GetAncestor(WindowFromPoint(p), 2); // GA_ROOT
    var sb = new System.Text.StringBuilder(256); GetWindowText(root, sb, 256); title = sb.ToString();
    uint pid; GetWindowThreadProcessId(root, out pid); return pid;
  }

  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, int data) { var i = new INPUT { type = 0 }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = (uint)data; Send(i); }
  static void Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; Send(i); }

  public static void Click(int x, int y, bool right, int count) {
    SetCursorPos(x, y); Thread.Sleep(30);
    uint down = right ? 0x8u : 0x2u, up = right ? 0x10u : 0x4u;
    for (int n = 0; n < count; n++) { Mouse(down, 0); Thread.Sleep(20); Mouse(up, 0); Thread.Sleep(60); }
  }
  public static void Wheel(int x, int y, int notches) {
    SetCursorPos(x, y); Thread.Sleep(30);
    for (int n = 0; n < Math.Abs(notches); n++) { Mouse(0x800, notches > 0 ? 120 : -120); Thread.Sleep(40); }
  }
  // Press, hold, move in steps, hold, release: list widgets that need a long press before they drag.
  public static void Drag(int x0, int y0, int x1, int y1, int steps, int holdMs) {
    SetCursorPos(x0, y0); Thread.Sleep(30); Mouse(0x2, 0); Thread.Sleep(holdMs);
    for (int i = 1; i <= steps; i++) { SetCursorPos(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); Thread.Sleep(20); }
    Thread.Sleep(holdMs); Mouse(0x4, 0);
  }
  public static void Keys(ushort[] vks) {
    foreach (var k in vks) { Key(k, 0, 0); Thread.Sleep(10); }
    for (int i = vks.Length - 1; i >= 0; i--) { Key(vks[i], 0, 2); Thread.Sleep(10); }
  }
  public static void Type(string text) {
    foreach (char c in text) { Key(0, c, 4); Key(0, c, 4 | 2); Thread.Sleep(15); } // KEYEVENTF_UNICODE
  }
}
'@
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// The editor's standard file dialogs through their Win32 controls: the file-name box and buttons are plain Edit and
// Button windows, reachable even when UI Automation doesn't expose them or the dialog sits partly off screen.
public static class WalkDialog {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }

  public static List<IntPtr> Dialogs(uint pid) {
    var out_ = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Class(h) == "#32770") out_.Add(h);
      return true;
    }, IntPtr.Zero);
    return out_;
  }

  public static List<IntPtr> Children(IntPtr d) {
    var out_ = new List<IntPtr>();
    EnumChildWindows(d, (h, l) => { out_.Add(h); return true; }, IntPtr.Zero);
    return out_;
  }

  // The file-name box: the Edit with the common dialogs' id (1001, or 1152 in a folder picker), else the Edit inside
  // the file-name combo box (cmb13). Never another edit (the search box, the address bar).
  public static IntPtr FileBox(IntPtr d) {
    IntPtr combo = IntPtr.Zero;
    foreach (var c in Children(d)) {
      if (Class(c) != "Edit") continue;
      int id = GetDlgCtrlID(c);
      if (id == 1001 || id == 1152) return c;
      var p = GetParent(c);
      // The file-name combo is cmb13 (1148); the address bar is a ComboBoxEx32 too, with another id.
      if (combo == IntPtr.Zero && Class(p) == "ComboBox" && Class(GetParent(p)) == "ComboBoxEx32" && GetDlgCtrlID(GetParent(p)) == 1148) combo = c;
    }
    return combo;
  }

  public static List<IntPtr> Buttons(IntPtr d) {
    var out_ = new List<IntPtr>();
    foreach (var c in Children(d)) if (Class(c) == "Button" && IsWindowVisible(c) && Text(c).Length > 0) out_.Add(c);
    return out_;
  }

  public static void SetText(IntPtr h, string text) { SendMessage(h, 0x000C, IntPtr.Zero, text); } // WM_SETTEXT
  // Posted, not sent: a press can open a modal confirmation, which would block a sent message until it closes.
  public static void Press(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); } // BM_CLICK
}
'@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase  # WindowsBase holds System.Windows.Point

function Find-Editor([string]$exe) {
  $name = [IO.Path]::GetFileNameWithoutExtension($exe)
  $pids = [Collections.Generic.HashSet[uint32]]::new()
  foreach ($p in Get-Process -Name $name -ErrorAction SilentlyContinue) { [void]$pids.Add([uint32]$p.Id) }
  if ($pids.Count -eq 0) { return [IntPtr]::Zero }
  return [WalkWin]::Largest($pids)
}

function Get-Rect([IntPtr]$h) {
  $r = New-Object WalkWin+RECT
  [void][WalkWin]::GetWindowRect($h, [ref]$r)
  return $r
}

function Rect-Json($r) { @{ left = $r.Left; top = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top } }

# Input lands only on the editor: the point must be on a window of the editor's process (its main window, a menu
# or one of its own dialogs). Anything else, such as a chat app's overlay, refuses the input.
function Test-Owner($req) {
  $title = ''
  $owner = [WalkInput]::OwnerPid([int]$req.x, [int]$req.y, [ref]$title)
  if ($owner -ne [uint32]$req.pid) { return @{ done = $false; owner = $title } }
  return $null
}

function Element-Json($e) {
  $c = $e.Current
  $r = $c.BoundingRectangle
  $out = @{ name = $c.Name; controlType = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''; automationId = $c.AutomationId
            className = $c.ClassName; enabled = $c.IsEnabled; pid = $c.ProcessId
            rect = @{ left = [int]$r.Left; top = [int]$r.Top; width = [int]$r.Width; height = [int]$r.Height } }
  $p = $null
  if ($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $out.value = $p.Current.Value; $out.readOnly = $p.Current.IsReadOnly }
  if ($e.TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern, [ref]$p)) {
    $out.range = @{ value = $p.Current.Value; min = $p.Current.Minimum; max = $p.Current.Maximum; step = $p.Current.SmallChange } }
  if ($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $out.toggle = "$($p.Current.ToggleState)" }
  if ($e.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $out.selected = $p.Current.IsSelected }
  return $out
}

function Dialog-Json([IntPtr]$d) {
  @{ title = [WalkDialog]::Text($d); fileBox = ([WalkDialog]::FileBox($d) -ne [IntPtr]::Zero)
     buttons = @([WalkDialog]::Buttons($d) | ForEach-Object { [WalkDialog]::Text($_) -replace '&', '' }) }
}

function Invoke-Op($req) {
  switch ($req.op) {
    'ping' { return @{} }
    'find' {
      $h = Find-Editor $req.app
      if ($h -eq [IntPtr]::Zero) { return @{ found = $false } }
      $wpid = [uint32]0; [void][WalkWin]::GetWindowThreadProcessId($h, [ref]$wpid)
      return @{ found = $true; hwnd = [int64]$h; pid = $wpid; rect = (Rect-Json (Get-Rect $h)); minimized = [WalkWin]::IsIconic($h) }
    }
    'front' { return @{ front = [WalkWin]::Front([IntPtr][int64]$req.hwnd) } }
    'shot' {
      $path = [IO.Path]::GetFullPath([string]$req.path)
      if (-not $path.StartsWith($ShotRoot, [StringComparison]::OrdinalIgnoreCase) -or -not $path.EndsWith('.png')) {
        throw 'a shot is saved only as a .png file in the session folder'
      }
      $h = [IntPtr][int64]$req.hwnd
      $r = Get-Rect $h
      $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
      if ($w -le 0 -or $hh -le 0 -or [WalkWin]::IsIconic($h)) { throw 'the editor window is minimized or has no size' }
      $source = 'window'
      $b = [WalkWin]::Print($h, $w, $hh)
      $spread = if ($b) { [WalkWin]::Spread($b) } else { 0 }
      if ($spread -lt $req.minSpread) {
        # Fall back to the screen only where the editor is in front and nothing covers any part of it (S14).
        if ($b) { $b.Dispose(); $b = $null }
        if ([WalkWin]::GetForegroundWindow() -eq $h -and [WalkWin]::Unobscured($h, $r)) {
          $b = [WalkWin]::FromScreen($r); $spread = [WalkWin]::Spread($b); $source = 'screen'
        }
      }
      if (-not $b) { return @{ saved = $false; spread = $spread; rect = (Rect-Json $r) } }
      try {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
        $width = [Math]::Max(1, [int][Math]::Round($w * $req.scale))
        [WalkWin]::SaveScaled($b, $path, $width)
      } finally { $b.Dispose() }
      return @{ saved = $true; spread = $spread; source = $source; rect = (Rect-Json $r); width = $width }
    }
    'click' {
      if ($refused = Test-Owner $req) { return $refused }
      [WalkInput]::Click([int]$req.x, [int]$req.y, $req.button -eq 'right', [int]$req.count); return @{ done = $true }
    }
    'wheel' {
      if ($refused = Test-Owner $req) { return $refused }
      [WalkInput]::Wheel([int]$req.x, [int]$req.y, [int]$req.notches); return @{ done = $true }
    }
    'drag' {
      if ($refused = Test-Owner $req) { return $refused }
      $end = Test-Owner @{ x = $req.x1; y = $req.y1; pid = $req.pid }
      if ($end) { return $end }
      [WalkInput]::Drag([int]$req.x, [int]$req.y, [int]$req.x1, [int]$req.y1, [int]$req.steps, [int]$req.holdMs); return @{ done = $true }
    }
    'keys' {
      # Keys go to the window in front, so it must be one of the editor's.
      $fg = [WalkWin]::GetForegroundWindow(); $fpid = [uint32]0; [void][WalkWin]::GetWindowThreadProcessId($fg, [ref]$fpid)
      if ($fpid -ne [uint32]$req.pid) { return @{ done = $false; owner = 'the window in front' } }
      if ($req.text) { [WalkInput]::Type([string]$req.text) } else { [WalkInput]::Keys([uint16[]]@($req.vks)) }
      return @{ done = $true }
    }
    'element' {
      $e = [Windows.Automation.AutomationElement]::FromPoint((New-Object Windows.Point([double]$req.x, [double]$req.y)))
      if (-not $e -or $e.Current.ProcessId -ne [int]$req.pid) { return @{ found = $false } }
      return @{ found = $true; element = (Element-Json $e) }
    }
    'dialogs' { return @{ dialogs = @([WalkDialog]::Dialogs([uint32]$req.pid) | ForEach-Object { Dialog-Json $_ }) } }
    'fill' {
      $d = @([WalkDialog]::Dialogs([uint32]$req.pid) | Where-Object { [WalkDialog]::Text($_) -eq $req.title })
      if ($d.Count -ne 1) { return @{ done = $false; why = "$($d.Count) dialogs titled '$($req.title)'" } }
      $box = [WalkDialog]::FileBox($d[0])
      if ($box -eq [IntPtr]::Zero) { return @{ done = $false; why = 'the dialog has no file-name box' } }
      $btn = @([WalkDialog]::Buttons($d[0]) | Where-Object { ([WalkDialog]::Text($_) -replace '&', '') -eq $req.button })
      if ($btn.Count -ne 1) { return @{ done = $false; why = "$($btn.Count) buttons named '$($req.button)'" } }
      [WalkDialog]::SetText($box, [string]$req.path)
      Start-Sleep -Milliseconds 300
      [WalkDialog]::Press($btn[0])
      Start-Sleep -Milliseconds 1000
      return @{ done = $true; remaining = @([WalkDialog]::Dialogs([uint32]$req.pid) | ForEach-Object { [WalkDialog]::Text($_) }) }
    }
    default { throw "unknown op $($req.op)" }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $res = Invoke-Op $req
    $res.id = $id; $res.ok = $true
  } catch {
    $res = @{ id = $id; ok = $false; error = "$($_.Exception.Message)" }
  }
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
