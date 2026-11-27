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
