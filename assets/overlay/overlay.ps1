param([switch]$SelfTest, [switch]$SelfTestMeeting, [switch]$SelfTestRows, [switch]$SelfTestHold, [switch]$SelfTestPosition, [switch]$SelfTestIcon, [string]$ConfigBase64 = '')

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$nativeSource = @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class RtNative
{
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);


    public static void MakeToolWindow(IntPtr hwnd)
    {
        int ex = GetWindowLong(hwnd, -20);
        ex |= 0x00000080;
        SetWindowLong(hwnd, -20, ex);
    }

    public static void KeepTopmost(IntPtr hwnd)
    {
        SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }
}

public sealed class RtHotkeyHost : System.Windows.Forms.NativeWindow
{
    public Action<int> OnHotkey;

    public RtHotkeyHost()
    {
        CreateHandle(new System.Windows.Forms.CreateParams());
    }

    protected override void WndProc(ref System.Windows.Forms.Message m)
    {
        if (m.Msg == 0x0312 && OnHotkey != null) OnHotkey(m.WParam.ToInt32());
        base.WndProc(ref m);
    }

    public bool Register(int id, uint modifiers, uint vk)
    {
        return RtNative.RegisterHotKey(Handle, id, modifiers, vk);
    }

    public void Unregister(int id)
    {
        RtNative.UnregisterHotKey(Handle, id);
    }

    public void Destroy()
    {
        DestroyHandle();
    }
}

public static class RtIo
{
    private static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static volatile bool Eof;

    public static void Start()
    {
        var thread = new Thread(ReadLoop);
        thread.IsBackground = true;
        thread.Start();
    }

    private static void ReadLoop()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null) Lines.Enqueue(line);
        Eof = true;
    }

    public static bool TryRead(out string line)
    {
        return Lines.TryDequeue(out line);
    }

    public static void Write(string text)
    {
        Console.Out.WriteLine(text);
        Console.Out.Flush();
    }
}
"@

Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies System.Windows.Forms, System.Drawing

try { [void][RtNative]::SetProcessDpiAwarenessContext([IntPtr]-4) } catch { }

$script:style = [pscustomobject]@{
  fontSize = 20
  maxLines = 3
  marginPercent = 8
  widthPercent = 78
  opacity = 0.72
  background = $true
  bilingual = $true
  fontFamily = 'Microsoft YaHei UI'
  minReadMs = 1800
}

$script:cues = New-Object System.Collections.ArrayList
$script:seq = 0
$script:syncing = $true
$script:shuttingDown = $false
$script:hwndSub = [IntPtr]::Zero
$script:trayIconHandle = [IntPtr]::Zero
$script:userPositioned = $false
$script:dragging = $false
$script:manualLeft = $null
$script:manualTop = $null
$script:nowOverride = $null
$script:selfTestStatus = 0
$script:hotkeys = @{}
$script:pendingSubtitle = @{}
$script:ui = [pscustomobject]@{
  tray = $true
  hotkeysEnabled = $true
}

function Clamp-Number($value, [double]$min, [double]$max, [double]$fallback) {
  $parsed = 0.0
  if (-not [double]::TryParse([string]$value, [ref]$parsed)) { return $fallback }
  if ($parsed -lt $min) { return $min }
  if ($parsed -gt $max) { return $max }
  return $parsed
}

function Send-Json($payload) {
  try { [RtIo]::Write(($payload | ConvertTo-Json -Compress -Depth 10)) } catch { }
}

function Send-Action([string]$name, $value = $null) {
  $payload = @{ op = 'action'; name = $name }
  if ($null -ne $value) { $payload.value = $value }
  Send-Json $payload
}

function Send-Log([string]$text) {
  Send-Json @{ op = 'log'; text = $text }
}

function New-SolidBrush([int]$alpha, [int]$red, [int]$green, [int]$blue) {
  return New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb($alpha, $red, $green, $blue))
}

function Set-FlatButton($button) {
  $xaml = '<ControlTemplate TargetType="Button" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Border Background="{TemplateBinding Background}" CornerRadius="6" Padding="4,2"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border></ControlTemplate>'
  $button.Template = [System.Windows.Markup.XamlReader]::Parse($xaml)
}

function New-FlatButton([string]$text, [double]$width = 0) {
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $text
  $button.Foreground = [System.Windows.Media.Brushes]::White
  $button.Background = [System.Windows.Media.Brushes]::Transparent
  $button.BorderThickness = New-Object System.Windows.Thickness 0
  $button.FontSize = 13
  $button.Padding = New-Object System.Windows.Thickness 6, 2, 6, 2
  $button.Margin = New-Object System.Windows.Thickness 2, 0, 2, 0
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  if ($width -gt 0) { $button.Width = $width }
  Set-FlatButton $button
  return $button
}

function Update-StyleVisuals {
  if ($script:style.background) {
    $alpha = [byte][math]::Round(255 * [double]$script:style.opacity)
    $script:subBorder.Background = New-SolidBrush $alpha 12 12 14
  } else {
    $script:subBorder.Background = [System.Windows.Media.Brushes]::Transparent
  }
}

function Get-Now {
  if ($null -ne $script:nowOverride) { return [DateTime]$script:nowOverride }
  return [DateTime]::UtcNow
}

function Apply-Style($incoming) {
  if ($null -eq $incoming) { return }
  foreach ($property in $incoming.PSObject.Properties) {
    switch ($property.Name) {
      'fontSize' { $script:style.fontSize = [int](Clamp-Number $property.Value 12 96 20) }
      'maxLines' { $script:style.maxLines = [int](Clamp-Number $property.Value 2 5 3) }
      'widthPercent' { $script:style.widthPercent = Clamp-Number $property.Value 30 100 78 }
      'opacity' { $script:style.opacity = Clamp-Number $property.Value 0.1 1 0.72 }
      'marginPercent' { $script:style.marginPercent = Clamp-Number $property.Value 0 30 8 }
      'background' { $script:style.background = [bool]$property.Value }
      'bilingual' { $script:style.bilingual = [bool]$property.Value }
      'fontFamily' { if ([string]$property.Value -ne '') { $script:style.fontFamily = [string]$property.Value } }
      'minReadMs' { $script:style.minReadMs = [int](Clamp-Number $property.Value 0 30000 1800) }
    }
  }
  Update-StyleVisuals
}

function Initialize-SubtitleWindow {
  $script:subWindow = New-Object System.Windows.Window
  $script:subWindow.WindowStyle = [System.Windows.WindowStyle]::None
  $script:subWindow.AllowsTransparency = $true
  $script:subWindow.Background = [System.Windows.Media.Brushes]::Transparent
  $script:subWindow.ShowInTaskbar = $false
  $script:subWindow.Topmost = $true
  $script:subWindow.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $script:subWindow.SizeToContent = [System.Windows.SizeToContent]::Height
  $script:subWindow.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $script:subWindow.ShowActivated = $false

  $script:subBorder = New-Object System.Windows.Controls.Border
  $script:subBorder.CornerRadius = New-Object System.Windows.CornerRadius 10
  $script:subBorder.Padding = New-Object System.Windows.Thickness 18, 10, 18, 10
  $script:subPanel = New-Object System.Windows.Controls.StackPanel
  $script:subBorder.Child = $script:subPanel
  $script:subWindow.Content = $script:subBorder
  # Remember the drop point before a cue render can reposition the window.
  # `dragging` suppresses placement because DragMove's nested message loop
  # still lets the stdin timer deliver cues while the mouse is held down.
  $script:subWindow.add_MouseLeftButtonDown({
    $script:dragging = $true
    try { $script:subWindow.DragMove() } catch { }
    finally {
      $script:dragging = $false
      $script:userPositioned = $true
      $script:manualLeft = $script:subWindow.Left
      $script:manualTop = $script:subWindow.Top
    }
  })}

function Get-WindowHandle($window) {
  $helper = New-Object System.Windows.Interop.WindowInteropHelper ($window)
  return $helper.Handle
}

function Test-FiniteNumber($value) {
  if ($null -eq $value) { return $false }
  $number = 0.0
  if (-not [double]::TryParse([string]$value, [ref]$number)) { return $false }
  return (-not [double]::IsNaN($number) -and -not [double]::IsInfinity($number))
}

# Pure placement math (no WPF calls) so the multi-monitor rules are testable
# with -SelfTestPosition. A dragged position is returned verbatim: clamping it
# against the primary monitor's WorkArea moved the overlay back to the primary
# screen whenever it had been dragged to another monitor. Only the default
# spot (not dragged yet) is derived from the primary work area.
function Resolve-SubtitlePlacement($area, [double]$width, [double]$height, $manualLeft, $manualTop, [double]$marginPercent) {
  if ((Test-FiniteNumber $manualLeft) -and (Test-FiniteNumber $manualTop)) {
    return [pscustomobject]@{ left = [double]$manualLeft; top = [double]$manualTop }
  }
  if ([double]::IsNaN($height) -or [double]::IsInfinity($height) -or $height -le 0) { $height = 120 }
  $left = $area.Left + ($area.Width - $width) / 2
  $top = $area.Bottom - $height - $area.Height * $marginPercent / 100
  return [pscustomobject]@{ left = $left; top = $top }
}

function Position-SubtitleWindow {
  # A cue can arrive while DragMove pumps messages; do not fight the drag.
  if ($script:dragging) { return }
  $area = [System.Windows.SystemParameters]::WorkArea
  $width = [math]::Round($area.Width * [double]$script:style.widthPercent / 100)
  if ($width -lt 240) { $width = 240 }
  $script:subWindow.Width = $width
  $script:subWindow.UpdateLayout()
  $height = $script:subWindow.ActualHeight
  $manualLeft = $null
  $manualTop = $null
  if ($script:userPositioned) {
    $manualLeft = $script:manualLeft
    $manualTop = $script:manualTop
  }
  $placement = Resolve-SubtitlePlacement $area $width $height $manualLeft $manualTop ([double]$script:style.marginPercent)
  $script:subWindow.Left = $placement.left
  $script:subWindow.Top = $placement.top
}

function Test-CueTarget($cue) {
  foreach ($line in @($cue.lines)) {
    if ($line.kind -eq 'target' -and ([string]$line.text).Trim() -ne '') { return $true }
  }
  return $false
}

function Get-RowLimit {
  $limit = [int]$script:style.maxLines
  if ($limit -lt 2) { return 2 }
  if ($limit -gt 5) { return 5 }
  return $limit
}

# Visible rows, oldest first: the last row is the sentence being spoken and the
# rows above it are recent history. A translation that just appeared keeps one
# extra row until minReadMs passed, so new speech cannot scroll it away early.
function Select-VisibleCues {
  if ($script:cues.Count -eq 0) { return @() }
  $now = Get-Now
  $limit = Get-RowLimit
  $count = [math]::Min($limit, $script:cues.Count)
  $start = $script:cues.Count - $count
  if ($start -gt 0) {
    $older = $script:cues[$start - 1]
    if ($null -ne $older.readAt -and ($now - $older.readAt).TotalMilliseconds -lt [int]$script:style.minReadMs) {
      $start--
    }
  }
  $visible = @()
  for ($index = $start; $index -lt $script:cues.Count; $index++) { $visible += $script:cues[$index] }
  return $visible
}

function Render-Cues {
  $script:subPanel.Children.Clear()
  $visible = @(Select-VisibleCues)
  $newestId = if ($visible.Count -gt 0) { $visible[$visible.Count - 1].id } else { '' }
  $rendered = 0
  foreach ($cue in $visible) {
    $hasTarget = Test-CueTarget $cue
    $isCurrent = ($cue.id -eq $newestId)
    $rowOpacity = if ($isCurrent) { 1.0 } else { 0.7 }
    $rowLines = 0
    foreach ($line in @($cue.lines)) {
      $text = [string]$line.text
      if ($text.Trim() -eq '') { continue }
      if (-not $script:style.bilingual -and $hasTarget -and $line.kind -eq 'source') { continue }

      $block = New-Object System.Windows.Controls.TextBlock
      $block.Text = $text
      $block.TextWrapping = [System.Windows.TextWrapping]::Wrap
      $block.TextAlignment = [System.Windows.TextAlignment]::Center
      $block.FontFamily = New-Object System.Windows.Media.FontFamily ($script:style.fontFamily)
      if ($line.kind -eq 'source' -and $script:style.bilingual -and $hasTarget) {
        $block.FontSize = [math]::Max(10, [double]$script:style.fontSize * 0.62)
        $block.Foreground = New-SolidBrush 255 214 214 218
        $block.Opacity = 0.78 * $rowOpacity
        $block.Margin = New-Object System.Windows.Thickness 0, 1, 0, 2
      } else {
        $block.FontSize = [double]$script:style.fontSize
        $block.FontWeight = [System.Windows.FontWeights]::SemiBold
        $block.Foreground = [System.Windows.Media.Brushes]::White
        $block.Opacity = $rowOpacity
        $block.Margin = New-Object System.Windows.Thickness 0, 0, 0, 1
      }
      $effect = New-Object System.Windows.Media.Effects.DropShadowEffect
      $effect.BlurRadius = 4
      $effect.ShadowDepth = 0
      $effect.Opacity = 0.65
      $effect.Color = [System.Windows.Media.Colors]::Black
      $block.Effect = $effect
      [void]$script:subPanel.Children.Add($block)
      $rendered++
      $rowLines++
    }
    if ($rowLines -gt 0 -and -not $isCurrent) {
      $gap = New-Object System.Windows.Controls.Border
      $gap.Height = 4
      [void]$script:subPanel.Children.Add($gap)
    }
  }

  if ($rendered -eq 0) { Hide-Subtitles } else { Show-Subtitles }
  Position-SubtitleWindow
}

function Show-Subtitles {
  if (-not $script:subWindow.IsVisible) { $script:subWindow.Show() }
  if ($script:hwndSub -ne [IntPtr]::Zero) { [RtNative]::KeepTopmost($script:hwndSub) }
}

function Hide-Subtitles {
  if ($script:subWindow.IsVisible) { $script:subWindow.Hide() }
}

function Clear-Cues {
  $script:cues.Clear()
  Render-Cues
}

function Store-Cue($cue) {
  if ($null -eq $cue -or [string]$cue.id -eq '') { return $false }
  $now = Get-Now
  $lines = @($cue.lines)
  $hasTarget = $false
  foreach ($line in $lines) {
    if ($line.kind -eq 'target' -and ([string]$line.text).Trim() -ne '') { $hasTarget = $true; break }
  }
  $finished = [bool]$cue.finished
  $existing = $null
  foreach ($item in $script:cues) { if ($item.id -eq [string]$cue.id) { $existing = $item; break } }
  if ($null -ne $existing) {
    $existing.lines = $lines
    $existing.holdMs = [int]$cue.holdMs
    $existing.at = $now
    $existing.finished = $finished
    if ($null -eq $existing.readAt -and ($hasTarget -or $finished)) { $existing.readAt = $now }
  } else {
    $script:seq++
    $entry = [pscustomobject]@{
      id = [string]$cue.id
      lines = $lines
      holdMs = [int]$cue.holdMs
      at = $now
      seq = $script:seq
      finished = $finished
      readAt = $(if ($hasTarget -or $finished) { $now } else { $null })
    }
    [void]$script:cues.Add($entry)
  }
  while ($script:cues.Count -gt 12) { $script:cues.RemoveAt(0) }
  return $true
}

function Upsert-Cue($cue) {
  if (Store-Cue $cue) { Render-Cues }
}


function Queue-Subtitle($patchTable) {
  foreach ($key in $patchTable.Keys) { $script:pendingSubtitle[$key] = $patchTable[$key] }
  if (-not $script:subtitleTimer.IsEnabled) { $script:subtitleTimer.Start() }
}

function Flush-SubtitlePatch {
  $script:subtitleTimer.Stop()
  if ($script:pendingSubtitle.Count -eq 0) { return }
  $json = $script:pendingSubtitle | ConvertTo-Json -Compress
  $script:pendingSubtitle = @{}
  Send-Action 'setSubtitle' $json
}

function Dispose-TrayIcon {
  if ($script:trayIconHandle -ne [IntPtr]::Zero) {
    [void][RtNative]::DestroyIcon($script:trayIconHandle)
    $script:trayIconHandle = [IntPtr]::Zero
  }
}

# Draw the plugin artwork (assets/icon.jpeg) into a tray-sized icon. The shell
# asks for 16-32 px, so a 32 px high-quality downscale keeps the glyph crisp.
function New-TrayIcon {
  $iconPath = Join-Path $PSScriptRoot '..\icon.jpeg'
  try {
    if (-not (Test-Path -LiteralPath $iconPath)) { return [System.Drawing.SystemIcons]::Application }
    $source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $iconPath).Path)
    try {
      $size = 32
      $bitmap = New-Object System.Drawing.Bitmap $size, $size
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.DrawImage($source, 0, 0, $size, $size)
        } finally { $graphics.Dispose() }
        $handle = $bitmap.GetHicon()
      } finally { $bitmap.Dispose() }
      if ($script:trayIconHandle -ne [IntPtr]::Zero) { Dispose-TrayIcon }
      $script:trayIconHandle = $handle
      return [System.Drawing.Icon]::FromHandle($handle)
    } finally { $source.Dispose() }
  } catch {
    Send-Log ('无法加载托盘图标: ' + [string]$_.Exception.Message)
    return [System.Drawing.SystemIcons]::Application
  }
}

function Initialize-Tray {
  if ($null -ne $script:notify) { return }
  $script:notify = New-Object System.Windows.Forms.NotifyIcon
  $script:notify.Icon = New-TrayIcon
  $script:notify.Text = 'DSH 实时字幕'
  $script:notify.Visible = $true
  $script:notify.add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Action 'toggle' }
  })

  # The tray menu is an exit control only; everything else lives in the DSH panel.
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $quitItem = New-Object System.Windows.Forms.ToolStripMenuItem '退出'
  $quitItem.add_Click({ Send-Action 'quit'; Shutdown-Overlay })
  [void]$menu.Items.Add($quitItem)
  $script:notify.ContextMenuStrip = $menu
}

function Convert-Hotkey([string]$text) {
  $result = @{ modifiers = 0; vk = 0; ok = $false }
  if ([string]::IsNullOrWhiteSpace($text)) { return $result }
  $parts = @($text.Split('+') | ForEach-Object { $_.Trim() })
  if ($parts.Count -lt 1) { return $result }
  $modifiers = 0
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    switch ($parts[$i].ToLowerInvariant()) {
      'ctrl' { $modifiers = $modifiers -bor 0x0002 }
      'control' { $modifiers = $modifiers -bor 0x0002 }
      'alt' { $modifiers = $modifiers -bor 0x0001 }
      'shift' { $modifiers = $modifiers -bor 0x0004 }
      'win' { $modifiers = $modifiers -bor 0x0008 }
      default { return $result }
    }
  }
  $key = $parts[$parts.Count - 1].ToUpperInvariant()
  $vk = 0
  if ($key -match '^[A-Z0-9]$') {
    $vk = [int][char]$key
  } elseif ($key -match '^F([1-9]|1[0-2])$') {
    $vk = 0x70 + [int]$Matches[1] - 1
  } else {
    return $result
  }
  return @{ modifiers = $modifiers; vk = $vk; ok = $true }
}

function Register-Hotkey([int]$id, [int]$modifiers, [int]$vk, [string]$name) {
  if ($null -eq $script:hotkeyHost -or $script:hotkeys.ContainsKey($id)) { return }
  if ($script:hotkeyHost.Register($id, $modifiers, $vk)) {
    $script:hotkeys[$id] = $name
  } else {
    Send-Log ('热键注册失败: ' + $name)
  }
}

function Register-Hotkeys {
  if ($null -eq $script:hotkeyHost -or -not $script:ui.hotkeysEnabled) { return }
  $modifiers = 0x0001 -bor 0x0002
  foreach ($definition in @(
    @{ id = 1; vk = 0x53; name = 'toggle' },
    @{ id = 2; vk = 0x43; name = 'clear' },
    @{ id = 4; vk = 0x26; name = 'fontUp' },
    @{ id = 5; vk = 0x28; name = 'fontDown' },
    @{ id = 6; vk = 0x42; name = 'bilingual' }
  )) {
    Register-Hotkey ([int]$definition.id) $modifiers ([int]$definition.vk) ([string]$definition.name)
  }
}

function Unregister-Hotkeys {
  if ($null -ne $script:hotkeyHost) {
    foreach ($id in @($script:hotkeys.Keys)) {
      try { $script:hotkeyHost.Unregister([int]$id) } catch { }
    }
  }
  $script:hotkeys = @{}
}

function Initialize-Hotkeys {
  if ($null -eq $script:hotkeyHost) {
    $script:hotkeyHost = New-Object RtHotkeyHost
    $script:hotkeyHost.OnHotkey = [Action[int]]{ param($id) Handle-Hotkey $id }
  }
  Register-Hotkeys
}

function Apply-Ui($incoming) {
  if ($null -eq $incoming) { return }
  foreach ($property in $incoming.PSObject.Properties) {
    switch ($property.Name) {
      'tray' { $script:ui.tray = [bool]$property.Value }
      'hotkeysEnabled' { $script:ui.hotkeysEnabled = [bool]$property.Value }
    }
  }
  if ($script:ui.tray) {
    Initialize-Tray
  } elseif ($null -ne $script:notify) {
    try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
    $script:notify = $null
    Dispose-TrayIcon
  }
  if ($script:ui.hotkeysEnabled) { Register-Hotkeys } else { Unregister-Hotkeys }
}

function Handle-Hotkey([int]$id) {
  $name = $script:hotkeys[$id]
  switch ($name) {
    'toggle' { Send-Action 'toggle' }
    'clear' { Send-Action 'clear' }
    'fontUp' { Send-Action 'setFontSize' ([int]$script:style.fontSize + 2) }
    'fontDown' { Send-Action 'setFontSize' ([int]$script:style.fontSize - 2) }
    'bilingual' {
      $script:style.bilingual = -not [bool]$script:style.bilingual
      Render-Cues
      Queue-Subtitle @{ bilingual = [bool]$script:style.bilingual }
    }
  }
}

function Process-Line([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  try {
    $message = $line | ConvertFrom-Json
  } catch {
    Send-Json @{ op = 'error'; text = 'bad json' }
    return
  }
  try {
    switch ([string]$message.op) {
      'style' { Apply-Style $message.style; Render-Cues }
      'ui' { Apply-Ui $message.ui }
      'cue' { Upsert-Cue $message.cue }
      'clear' { Clear-Cues }
      'shutdown' { Shutdown-Overlay }
    }
  } catch {
    Send-Json @{ op = 'error'; text = [string]$_.Exception.Message }
  }
}

function Shutdown-Overlay {
  if ($script:shuttingDown) { return }
  $script:shuttingDown = $true
  foreach ($timer in @($script:stdinTimer, $script:topmostTimer, $script:subtitleTimer)) {
    try { if ($null -ne $timer) { $timer.Stop() } } catch { }
  }
  if ($null -ne $script:hotkeyHost) {
    foreach ($id in @($script:hotkeys.Keys)) { try { $script:hotkeyHost.Unregister([int]$id) } catch { } }
    try { $script:hotkeyHost.Destroy() } catch { }
  }
  if ($null -ne $script:notify) {
    try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
  }
  Dispose-TrayIcon
  if ($null -ne $script:subWindow) {
    try { $script:subWindow.Close() } catch { }
  }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
}

function Initialize-Timers {
  $script:stdinTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:stdinTimer.Interval = [TimeSpan]::FromMilliseconds(40)
  $script:stdinTimer.add_Tick({
    $line = $null
    $count = 0
    while ($count -lt 80 -and [RtIo]::TryRead([ref]$line)) {
      Process-Line $line
      $count++
    }
    if ([RtIo]::Eof -and -not $script:shuttingDown) { Shutdown-Overlay }
  })


  $script:topmostTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:topmostTimer.Interval = [TimeSpan]::FromSeconds(2)
  $script:topmostTimer.add_Tick({
    if ($script:hwndSub -ne [IntPtr]::Zero -and $script:subWindow.IsVisible) { [RtNative]::KeepTopmost($script:hwndSub) }
  })

  $script:subtitleTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:subtitleTimer.Interval = [TimeSpan]::FromMilliseconds(180)
  $script:subtitleTimer.add_Tick({ Flush-SubtitlePatch })
}

function Initialize-Windows {
  Initialize-SubtitleWindow
  $script:syncing = $false
  Update-StyleVisuals
}

function Run-SelfTest {
  $script:style.fontSize = 20
  if ($SelfTestMeeting) { $script:style.bilingual = $true }
  Update-StyleVisuals
  $script:subWindow.Show()
  $script:hwndSub = Get-WindowHandle $script:subWindow
  [RtNative]::MakeToolWindow($script:hwndSub)
  if ($SelfTestMeeting) {
    Upsert-Cue ([pscustomobject]@{
      id = 'selftest'
      holdMs = 5000
      finished = $false
      lines = @(
        [pscustomobject]@{ kind = 'source'; text = '会议模式双语文案自检'; live = $true },
        [pscustomobject]@{ kind = 'target'; text = 'Meeting mode bilingual self-test'; live = $true }
      )
    })
  } else {
    Upsert-Cue ([pscustomobject]@{
      id = 'selftest'
      holdMs = 5000
      finished = $false
      lines = @(
        [pscustomobject]@{ kind = 'target'; text = '实时字幕叠加窗自检'; live = $false },
        [pscustomobject]@{ kind = 'source'; text = 'Subtitle overlay self-test'; live = $false }
      )
    })
  }
  Send-Log ('selftest window visible=' + [string]$script:subWindow.IsVisible)
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds(1500)
  $timer.add_Tick({
    $timer.Stop()
    try { $script:subWindow.Close() } catch { }
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
  })
  $timer.Start()
  [System.Windows.Threading.Dispatcher]::Run()
}

function New-TestCue([string]$id, [string]$source, [string]$target, [bool]$finished) {
  $lines = @([pscustomobject]@{ kind = 'source'; text = $source; live = $false })
  if ($target -ne '') { $lines = @($lines + [pscustomobject]@{ kind = 'target'; text = $target; live = $false }) }
  return [pscustomobject]@{ id = $id; lines = $lines; holdMs = 6000; finished = $finished }
}

function Set-TestClock([int]$milliseconds) {
  $script:nowOverride = $script:testBase.AddMilliseconds($milliseconds)
}

function Assert-Rows([string]$stage, [string]$expected) {
  $visible = @(Select-VisibleCues)
  $ids = @($visible | ForEach-Object { $_.id })
  $actual = if ($ids.Count -eq 0) { '<none>' } else { $ids -join ',' }
  $ok = ($actual -eq $expected)
  if (-not $ok) { $script:selfTestStatus = 1 }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("{0} {1}: expected={2} actual={3}" -f $mark, $stage, $expected, $actual)
}

# Pure state-machine check: no windows, no stdin. Verifies the rolling row
# window, that the last row is the sentence being spoken, and that a fresh
# translation keeps its row until minReadMs passed.
function Run-SelfTestRows {
  $script:style.maxLines = 3
  $script:style.minReadMs = 1800
  $script:testBase = [DateTime]::UtcNow
  $script:nowOverride = $script:testBase
  $script:cues.Clear()

  Set-TestClock 0
  [void](Store-Cue (New-TestCue 'c1' '第一句' 'First.' $true))
  Assert-Rows 't=0 第一句' 'c1'

  Set-TestClock 1000
  [void](Store-Cue (New-TestCue 'c2' '第二句' '' $false))
  Assert-Rows 't=1000 当前句在最后一行' 'c1,c2'

  Set-TestClock 1200
  [void](Store-Cue (New-TestCue 'c2' '第二句' 'Second.' $true))
  Assert-Rows 't=1200 第二句定稿' 'c1,c2'

  Set-TestClock 2000
  [void](Store-Cue (New-TestCue 'c3' '第三句' 'Third.' $true))
  Assert-Rows 't=2000 三行窗口' 'c1,c2,c3'

  Set-TestClock 2300
  [void](Store-Cue (New-TestCue 'c4' '第四句' '' $false))
  Assert-Rows 't=2300 第一句已读满，滚出窗口' 'c2,c3,c4'

  Set-TestClock 2500
  [void](Store-Cue (New-TestCue 'c5' '第五句' '' $false))
  Assert-Rows 't=2500 第二句译文未满阅读时间，多保留一行' 'c2,c3,c4,c5'

  Set-TestClock 4000
  Assert-Rows 't=4000 阅读时间满足后收起多保留行' 'c3,c4,c5'

  Set-TestClock 4500
  [void](Store-Cue (New-TestCue 'c6' '第六句' '' $false))
  Assert-Rows 't=4500 最后一行为当前句' 'c4,c5,c6'

  Set-TestClock 11000
  Assert-Rows 't=11000 静音后保留历史行' 'c4,c5,c6'

  Write-Output ('SUMMARY failures=' + $script:selfTestStatus)
}

function Assert-Placement([string]$stage, [double]$expectedLeft, [double]$expectedTop, $placement) {
  $actual = '<none>'
  $ok = ($null -ne $placement)
  if ($ok) {
    $actual = ('{0},{1}' -f $placement.left, $placement.top)
    $ok = ([math]::Abs([double]$placement.left - $expectedLeft) -lt 0.5 -and
      [math]::Abs([double]$placement.top - $expectedTop) -lt 0.5)
  }
  if (-not $ok) { $script:selfTestStatus = 1 }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("{0} {1}: expected={2},{3} actual={4}" -f $mark, $stage, $expectedLeft, $expectedTop, $actual)
}

# Pure placement check: the default spot is bottom-center on the primary work
# area, while a user drag to any monitor keeps its own coordinates. This is the
# regression test for the overlay jumping back to the primary screen.
function Run-SelfTestPosition {
  $primary = New-Object System.Windows.Rect 0, 0, 1920, 1040
  $width = [math]::Round($primary.Width * 78 / 100)
  $height = 120
  $margin = 8
  $defaultLeft = ($primary.Width - $width) / 2
  $defaultTop = $primary.Bottom - $height - $primary.Height * $margin / 100

  $placement = Resolve-SubtitlePlacement $primary $width $height $null $null $margin
  Assert-Placement '初始位置在主屏底部居中' $defaultLeft $defaultTop $placement

  # Regression: 2500 used to be clamped to 1920 - width (422) and snapped the
  # window back across the primary screen's right edge.
  $placement = Resolve-SubtitlePlacement $primary $width $height 2500 120 $margin
  Assert-Placement '拖到右侧副屏后保持位置' 2500 120 $placement

  # A monitor left of/above the primary uses negative virtual-screen coordinates.
  $placement = Resolve-SubtitlePlacement $primary $width $height -1180 -20 $margin
  Assert-Placement '拖到左侧/上方副屏后保持位置' -1180 -20 $placement

  # A taller monitor must not have its bottom clamped to the primary work area.
  $placement = Resolve-SubtitlePlacement $primary $width $height 2400 1100 $margin
  Assert-Placement '副屏下缘位置不被主屏钳制' 2400 1100 $placement

  # Broken coordinates fall back to the default spot instead of throwing.
  $placement = Resolve-SubtitlePlacement $primary $width $height ([double]::NaN) 120 $margin
  Assert-Placement '非法拖动坐标回退默认位置' $defaultLeft $defaultTop $placement

  Write-Output ('SUMMARY failures=' + $script:selfTestStatus)
}
function Run-Overlay {
  if ($ConfigBase64 -ne '') {
    try {
      $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64))
      Apply-Style ($json | ConvertFrom-Json)
    } catch {
      Send-Json @{ op = 'error'; text = ('bad config: ' + [string]$_.Exception.Message) }
    }
  }

  $script:subWindow.Show()
  $script:hwndSub = Get-WindowHandle $script:subWindow
  [RtNative]::MakeToolWindow($script:hwndSub)
  $script:subWindow.Hide()

  Initialize-Tray
  Initialize-Hotkeys
  Initialize-Timers
  [RtIo]::Start()

  $script:stdinTimer.Start()
  $script:topmostTimer.Start()

  Send-Json @{ op = 'ready' }
  [System.Windows.Threading.Dispatcher]::Run()
}

function Run-SelfTestIcon {
  $icon = New-TrayIcon
  $ok = ($script:trayIconHandle -ne [IntPtr]::Zero)
  if (-not $ok) { $script:selfTestStatus = 1 }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("{0} tray icon {1}x{2}" -f $mark, $icon.Width, $icon.Height)
  Dispose-TrayIcon
}

if ($SelfTestIcon) {
  Run-SelfTestIcon
  exit $script:selfTestStatus
}

if ($SelfTestRows -or $SelfTestHold) {
  Run-SelfTestRows
  exit $script:selfTestStatus
}

if ($SelfTestPosition) {
  Run-SelfTestPosition
  exit $script:selfTestStatus
}

Initialize-Windows

if ($SelfTest -or $SelfTestMeeting) {
  Run-SelfTest
} else {
  Run-Overlay
}

exit 0
