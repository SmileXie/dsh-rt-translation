param([switch]$SelfTest, [switch]$SelfTestMeeting, [switch]$SelfTestHold, [string]$ConfigBase64 = '')

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
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    public static void MakeClickThrough(IntPtr hwnd)
    {
        int ex = GetWindowLong(hwnd, -20);
        ex |= 0x20 | 0x08000000 | 0x00000080;
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
  fontSize = 32
  maxLines = 3
  position = 'bottom'
  marginPercent = 8
  widthPercent = 78
  opacity = 0.72
  background = $true
  bilingual = $true
  display = 'primary'
  fontFamily = 'Microsoft YaHei UI'
  minReadMs = 1800
}

$script:cues = New-Object System.Collections.ArrayList
$script:seq = 0
$script:syncing = $true
$script:shuttingDown = $false
$script:hwndSub = [IntPtr]::Zero
$script:displayedId = ''
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
      'fontSize' { $script:style.fontSize = [int](Clamp-Number $property.Value 12 96 32) }
      'maxLines' { $script:style.maxLines = [int](Clamp-Number $property.Value 1 6 3) }
      'widthPercent' { $script:style.widthPercent = Clamp-Number $property.Value 30 100 78 }
      'opacity' { $script:style.opacity = Clamp-Number $property.Value 0.1 1 0.72 }
      'marginPercent' { $script:style.marginPercent = Clamp-Number $property.Value 0 30 8 }
      'position' { if ($property.Value -eq 'top' -or $property.Value -eq 'bottom') { $script:style.position = [string]$property.Value } }
      'background' { $script:style.background = [bool]$property.Value }
      'bilingual' { $script:style.bilingual = [bool]$property.Value }
      'display' { if ($property.Value -eq 'primary' -or $property.Value -eq 'all') { $script:style.display = [string]$property.Value } }
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
  $script:subWindow.IsHitTestVisible = $false

  $script:subBorder = New-Object System.Windows.Controls.Border
  $script:subBorder.CornerRadius = New-Object System.Windows.CornerRadius 10
  $script:subBorder.Padding = New-Object System.Windows.Thickness 18, 10, 18, 10
  $script:subPanel = New-Object System.Windows.Controls.StackPanel
  $script:subBorder.Child = $script:subPanel
  $script:subWindow.Content = $script:subBorder
}

function Get-WindowHandle($window) {
  $helper = New-Object System.Windows.Interop.WindowInteropHelper ($window)
  return $helper.Handle
}

function Position-SubtitleWindow {
  $area = [System.Windows.SystemParameters]::WorkArea
  $width = [math]::Round($area.Width * [double]$script:style.widthPercent / 100)
  if ($width -lt 240) { $width = 240 }
  $script:subWindow.Width = $width
  $script:subWindow.UpdateLayout()
  $height = $script:subWindow.ActualHeight
  if ([double]::IsNaN($height) -or $height -le 0) { $height = 120 }
  $left = $area.Left + ($area.Width - $width) / 2
  if ($script:style.position -eq 'top') {
    $top = $area.Top + $area.Height * [double]$script:style.marginPercent / 100
  } else {
    $top = $area.Bottom - $height - $area.Height * [double]$script:style.marginPercent / 100
  }
  $script:subWindow.Left = $left
  $script:subWindow.Top = $top
}

function Test-CueTarget($cue) {
  foreach ($line in @($cue.lines)) {
    if ($line.kind -eq 'target' -and ([string]$line.text).Trim() -ne '') { return $true }
  }
  return $false
}

# Choose the one cue `display = primary` renders. A translation (or any settled
# line) owns the screen until it has been readable for minReadMs and stopped
# streaming, so the next sentence's original can never cut a translation short.
function Select-DisplayedCue {
  if ($script:cues.Count -eq 0) { return $null }
  $now = Get-Now
  $latest = $script:cues[$script:cues.Count - 1]
  $displayed = $null
  foreach ($cue in $script:cues) { if ($cue.id -eq $script:displayedId) { $displayed = $cue; break } }
  if ($null -eq $displayed) {
    $latest.shownAt = $now
    $script:displayedId = $latest.id
    return $latest
  }

  if ($null -eq $displayed.readAt) {
    # Source-only partial: follow the newest line while the segment is recognized.
    if ($displayed.id -ne $latest.id) {
      $latest.shownAt = $now
      $script:displayedId = $latest.id
      return $latest
    }
    $displayed.shownAt = $now
    return $displayed
  }

  $readMs = ($now - $displayed.readAt).TotalMilliseconds
  # Only a finished cue may be replaced: cutting a streaming translation leaves half a sentence.
  $settled = $displayed.finished
  if ($readMs -ge [int]$script:style.minReadMs -and $settled) {
    $newer = $null
    for ($i = $script:cues.Count - 1; $i -ge 0; $i--) {
      $candidate = $script:cues[$i]
      if ($candidate.seq -le $displayed.seq) { break }
      if ($null -ne $candidate.readAt) { $newer = $candidate; break }
    }
    if ($null -ne $newer) {
      $newer.shownAt = $now
      $script:displayedId = $newer.id
      return $newer
    }
  }

  if (($now - $displayed.at).TotalMilliseconds -gt [math]::Max(250, [int]$displayed.holdMs)) {
    $latest.shownAt = $now
    $script:displayedId = $latest.id
    return $latest
  }
  return $displayed
}

function Render-Cues {
  $script:subPanel.Children.Clear()
  $visible = @($script:cues | Sort-Object seq)
  if ($script:style.display -eq 'primary') {
    $chosen = Select-DisplayedCue
    $visible = if ($null -eq $chosen) { @() } else { @($chosen) }
  } elseif ($visible.Count -gt [int]$script:style.maxLines) {
    $visible = @($visible | Select-Object -Last ([int]$script:style.maxLines))
  }

  $rendered = 0
  foreach ($cue in $visible) {
    if ($rendered -ge [int]$script:style.maxLines) { break }
    $hasTarget = $false
    foreach ($candidate in @($cue.lines)) {
      if ($candidate.kind -eq 'target' -and ([string]$candidate.text).Trim() -ne '') { $hasTarget = $true; break }
    }
    foreach ($line in @($cue.lines)) {
      if ($rendered -ge [int]$script:style.maxLines) { break }
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
        $block.Opacity = 0.78
        $block.Margin = New-Object System.Windows.Thickness 0, 1, 0, 3
      } else {
        $block.FontSize = [double]$script:style.fontSize
        $block.FontWeight = [System.Windows.FontWeights]::SemiBold
        $block.Foreground = [System.Windows.Media.Brushes]::White
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
      shownAt = $null
    }
    [void]$script:cues.Add($entry)
  }
  while ($script:cues.Count -gt 12) { $script:cues.RemoveAt(0) }
  return $true
}

function Upsert-Cue($cue) {
  if (Store-Cue $cue) { Render-Cues }
}

function Expire-Cues {
  $now = Get-Now
  $removed = $false
  for ($index = $script:cues.Count - 1; $index -ge 0; $index--) {
    $cue = $script:cues[$index]
    $last = $cue.at
    if ($null -ne $cue.shownAt -and $cue.shownAt -gt $last) { $last = $cue.shownAt }
    if (($now - $last).TotalMilliseconds -gt [math]::Max(250, [int]$cue.holdMs)) {
      if ($cue.id -eq $script:displayedId) { $script:displayedId = '' }
      $script:cues.RemoveAt($index)
      $removed = $true
    }
  }
  if ($removed) { Render-Cues }
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

function Initialize-Tray {
  if ($null -ne $script:notify) { return }
  $script:notify = New-Object System.Windows.Forms.NotifyIcon
  $script:notify.Icon = [System.Drawing.SystemIcons]::Application
  $script:notify.Text = 'DSH 实时字幕'
  $script:notify.Visible = $true
  $script:notify.add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Action 'toggle' }
  })

  $menu = New-Object System.Windows.Forms.ContextMenuStrip

  $startItem = New-Object System.Windows.Forms.ToolStripMenuItem '开始翻译'
  $startItem.add_Click({ Send-Action 'start' })
  [void]$menu.Items.Add($startItem)

  $stopItem = New-Object System.Windows.Forms.ToolStripMenuItem '停止'
  $stopItem.add_Click({ Send-Action 'stop' })
  [void]$menu.Items.Add($stopItem)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $modeMenu = New-Object System.Windows.Forms.ToolStripMenuItem '模式'
  $meetingItem = New-Object System.Windows.Forms.ToolStripMenuItem '会议'
  $meetingItem.add_Click({ Send-Action 'setMode' 'meeting' })
  [void]$modeMenu.DropDownItems.Add($meetingItem)
  $mediaItem = New-Object System.Windows.Forms.ToolStripMenuItem '影视'
  $mediaItem.add_Click({ Send-Action 'setMode' 'media' })
  [void]$modeMenu.DropDownItems.Add($mediaItem)
  [void]$menu.Items.Add($modeMenu)

  $sourceMenu = New-Object System.Windows.Forms.ToolStripMenuItem '源语言'
  foreach ($pair in @(@('自动', 'auto'), @('中文', 'zh'), @('English', 'en'), @('日本語', 'ja'), @('한국어', 'ko'), @('粤语', 'yue'))) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem $pair[0]
    $language = $pair[1]
    $item.add_Click({ Send-Action 'setSource' $language }.GetNewClosure())
    [void]$sourceMenu.DropDownItems.Add($item)
  }
  [void]$menu.Items.Add($sourceMenu)

  $targetMenu = New-Object System.Windows.Forms.ToolStripMenuItem '目的语言'
  foreach ($pair in @(@('中文', 'zh'), @('English', 'en'), @('日本語', 'ja'), @('한국어', 'ko'), @('粤语', 'yue'))) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem $pair[0]
    $language = $pair[1]
    $item.add_Click({ Send-Action 'setTarget' $language }.GetNewClosure())
    [void]$targetMenu.DropDownItems.Add($item)
  }
  [void]$menu.Items.Add($targetMenu)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $appItem = New-Object System.Windows.Forms.ToolStripMenuItem '只采集指定应用…'
  $appItem.add_Click({ Show-AppDialog })
  [void]$menu.Items.Add($appItem)

  $systemItem = New-Object System.Windows.Forms.ToolStripMenuItem '恢复系统声音'
  $systemItem.add_Click({ Send-Action 'setApp' '' })
  [void]$menu.Items.Add($systemItem)

  $restartItem = New-Object System.Windows.Forms.ToolStripMenuItem '重新连接音频'
  $restartItem.add_Click({ Send-Action 'restart' })
  [void]$menu.Items.Add($restartItem)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $fontUpItem = New-Object System.Windows.Forms.ToolStripMenuItem '字号 +'
  $fontUpItem.add_Click({ Send-Action 'setFontSize' ([int]$script:style.fontSize + 2) })
  [void]$menu.Items.Add($fontUpItem)

  $fontDownItem = New-Object System.Windows.Forms.ToolStripMenuItem '字号 -'
  $fontDownItem.add_Click({ Send-Action 'setFontSize' ([int]$script:style.fontSize - 2) })
  [void]$menu.Items.Add($fontDownItem)

  $clearItem = New-Object System.Windows.Forms.ToolStripMenuItem '清空字幕'
  $clearItem.add_Click({ Send-Action 'clear' })
  [void]$menu.Items.Add($clearItem)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $quitItem = New-Object System.Windows.Forms.ToolStripMenuItem '退出'
  $quitItem.add_Click({ Send-Action 'quit'; Shutdown-Overlay })
  [void]$menu.Items.Add($quitItem)

  $script:notify.ContextMenuStrip = $menu
}

function Show-AppDialog {
  $dialog = New-Object System.Windows.Window
  $dialog.Title = '只采集指定应用'
  $dialog.Width = 380
  $dialog.Height = 180
  $dialog.Topmost = $true
  $dialog.ShowInTaskbar = $false
  $dialog.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $dialog.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen

  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Object System.Windows.Thickness 14
  $hint = New-Object System.Windows.Controls.TextBlock
  $hint.Text = '输入进程名（例如 chrome.exe）。留空并确定可恢复系统声音。'
  $hint.TextWrapping = [System.Windows.TextWrapping]::Wrap
  [void]$panel.Children.Add($hint)

  $box = New-Object System.Windows.Controls.TextBox
  $box.Margin = New-Object System.Windows.Thickness 0, 10, 0, 10
  [void]$panel.Children.Add($box)

  $buttons = New-Object System.Windows.Controls.StackPanel
  $buttons.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $buttons.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right

  $ok = New-Object System.Windows.Controls.Button
  $ok.Content = '确定'
  $ok.Width = 70
  $ok.Margin = New-Object System.Windows.Thickness 0, 0, 8, 0
  $ok.add_Click({
    $name = ([string]$box.Text).Trim()
    Send-Action 'setApp' $name
    $dialog.Close()
  })
  [void]$buttons.Children.Add($ok)

  $cancel = New-Object System.Windows.Controls.Button
  $cancel.Content = '取消'
  $cancel.Width = 70
  $cancel.add_Click({ $dialog.Close() })
  [void]$buttons.Children.Add($cancel)

  [void]$panel.Children.Add($buttons)
  $dialog.Content = $panel
  [void]$dialog.ShowDialog()
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
  foreach ($timer in @($script:stdinTimer, $script:housekeepingTimer, $script:topmostTimer, $script:subtitleTimer)) {
    try { if ($null -ne $timer) { $timer.Stop() } } catch { }
  }
  if ($null -ne $script:hotkeyHost) {
    foreach ($id in @($script:hotkeys.Keys)) { try { $script:hotkeyHost.Unregister([int]$id) } catch { } }
    try { $script:hotkeyHost.Destroy() } catch { }
  }
  if ($null -ne $script:notify) {
    try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
  }
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

  $script:housekeepingTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:housekeepingTimer.Interval = [TimeSpan]::FromMilliseconds(250)
  $script:housekeepingTimer.add_Tick({ Expire-Cues })

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
  $script:style.fontSize = 34
  if ($SelfTestMeeting) { $script:style.bilingual = $true }
  Update-StyleVisuals
  $script:subWindow.Show()
  $script:hwndSub = Get-WindowHandle $script:subWindow
  [RtNative]::MakeClickThrough($script:hwndSub)
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

function Assert-Displayed([string]$stage, [string]$expected) {
  $chosen = Select-DisplayedCue
  $actual = if ($null -eq $chosen) { '<none>' } else { $chosen.id }
  $ok = ($actual -eq $expected)
  if (-not $ok) { $script:selfTestStatus = 1 }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("{0} {1}: expected={2} actual={3}" -f $mark, $stage, $expected, $actual)
}

# Pure state-machine check: no windows, no stdin. Verifies that a finished
# translation owns the line for minReadMs and that the next original cannot
# replace it before its own translation is ready.
function Run-SelfTestHold {
  $script:style.minReadMs = 1800
  $script:style.display = 'primary'
  $script:testBase = [DateTime]::UtcNow
  $script:nowOverride = $script:testBase
  $script:cues.Clear()
  $script:displayedId = ''

  Set-TestClock 0
  [void](Store-Cue (New-TestCue 'c1' '第一句话' '' $false))
  Assert-Displayed 't=0 原文先上屏' 'c1'
  Set-TestClock 100
  [void](Store-Cue (New-TestCue 'c1' '第一句话' 'First' $false))
  Assert-Displayed 't=100 译文开始流式输出' 'c1'
  Set-TestClock 200
  [void](Store-Cue (New-TestCue 'c1' '第一句话' 'First sentence.' $true))
  Assert-Displayed 't=200 译文定稿' 'c1'

  Set-TestClock 400
  [void](Store-Cue (New-TestCue 'c2' '第二句话' '' $false))
  Assert-Displayed 't=400 下一句原文不抢占译文' 'c1'

  Set-TestClock 900
  [void](Store-Cue (New-TestCue 'c2' '第二句话' 'Second' $false))
  Assert-Displayed 't=900 下一句译文未满阅读窗口' 'c1'

  Set-TestClock 1500
  [void](Store-Cue (New-TestCue 'c2' '第二句话' 'Second sentence.' $true))
  Assert-Displayed 't=1500 阅读窗口未满仍保留' 'c1'

  Set-TestClock 1950
  Assert-Displayed 't=1950 阅读窗口满足后切换' 'c2'

  Set-TestClock 2100
  [void](Store-Cue (New-TestCue 'c3' '第三句话' '' $false))
  Assert-Displayed 't=2100 第三句原文不抢占' 'c2'

  Set-TestClock 9000
  Assert-Displayed 't=9000 超时后跟随最新一段' 'c3'

  $script:cues.Clear()
  $script:displayedId = ''
  Set-TestClock 10000
  [void](Store-Cue (New-TestCue 'd1' '原文一' '译文一' $false))
  Assert-Displayed 't=10000 流式译文先上屏' 'd1'
  Set-TestClock 11000
  [void](Store-Cue (New-TestCue 'd1' '原文一' '译文一还在增长' $false))
  Set-TestClock 12500
  [void](Store-Cue (New-TestCue 'd2' '原文二' '译文二' $false))
  Assert-Displayed 't=12500 流式输出中不切断' 'd1'
  Set-TestClock 13000
  [void](Store-Cue (New-TestCue 'd1' '原文一' '译文一还在增长。' $true))
  Assert-Displayed 't=13000 定稿且阅读窗口满后切换' 'd2'

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
  [RtNative]::MakeClickThrough($script:hwndSub)
  $script:subWindow.Hide()

  Initialize-Tray
  Initialize-Hotkeys
  Initialize-Timers
  [RtIo]::Start()

  $script:stdinTimer.Start()
  $script:housekeepingTimer.Start()
  $script:topmostTimer.Start()

  Send-Json @{ op = 'ready' }
  [System.Windows.Threading.Dispatcher]::Run()
}

if ($SelfTestHold) {
  Run-SelfTestHold
  exit $script:selfTestStatus
}

Initialize-Windows

if ($SelfTest -or $SelfTestMeeting) {
  Run-SelfTest
} else {
  Run-Overlay
}

exit 0
