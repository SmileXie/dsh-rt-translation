param([switch]$SelfTest, [string]$ConfigBase64 = '')

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
}

$script:cues = New-Object System.Collections.ArrayList
$script:seq = 0
$script:syncing = $true
$script:shuttingDown = $false
$script:hwndSub = [IntPtr]::Zero
$script:hwndBar = [IntPtr]::Zero
$script:barStickyUntil = [DateTime]::MinValue
$script:awaySince = $null
$script:hotkeys = @{}
$script:pendingSubtitle = @{}

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
  if ($null -ne $script:settingsFontLabel) { $script:settingsFontLabel.Text = ('字号 ' + [string][int]$script:style.fontSize) }
  if ($null -ne $script:settingsLinesLabel) { $script:settingsLinesLabel.Text = ('行数 ' + [string][int]$script:style.maxLines) }
  if ($null -ne $script:settingsOpacityLabel) { $script:settingsOpacityLabel.Text = ('背景透明度 ' + [string][math]::Round([double]$script:style.opacity, 2)) }
  if ($null -ne $script:settingsWidthLabel) { $script:settingsWidthLabel.Text = ('字幕宽度 ' + [string][math]::Round([double]$script:style.widthPercent) + '%') }
  if ($null -ne $script:settingsMarginLabel) { $script:settingsMarginLabel.Text = ('底边距 ' + [string][math]::Round([double]$script:style.marginPercent) + '%') }
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

function Render-Cues {
  $script:subPanel.Children.Clear()
  $visible = @($script:cues | Sort-Object seq)
  if ($script:style.display -eq 'primary') {
    $visible = @($visible | Select-Object -Last 1)
  } elseif ($visible.Count -gt [int]$script:style.maxLines) {
    $visible = @($visible | Select-Object -Last ([int]$script:style.maxLines))
  }

  $rendered = 0
  foreach ($cue in $visible) {
    if ($rendered -ge [int]$script:style.maxLines) { break }
    foreach ($line in @($cue.lines)) {
      if ($rendered -ge [int]$script:style.maxLines) { break }
      $text = [string]$line.text
      if ($text.Trim() -eq '') { continue }
      if (-not $script:style.bilingual -and $line.kind -eq 'source') { continue }

      $block = New-Object System.Windows.Controls.TextBlock
      $block.Text = $text
      $block.TextWrapping = [System.Windows.TextWrapping]::Wrap
      $block.TextAlignment = [System.Windows.TextAlignment]::Center
      $block.FontFamily = New-Object System.Windows.Media.FontFamily ($script:style.fontFamily)
      if ($line.kind -eq 'source') {
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
  Position-ControlBar
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

function Upsert-Cue($cue) {
  if ($null -eq $cue -or [string]$cue.id -eq '') { return }
  $existing = $null
  foreach ($item in $script:cues) { if ($item.id -eq [string]$cue.id) { $existing = $item; break } }
  if ($null -ne $existing) {
    $existing.lines = @($cue.lines)
    $existing.holdMs = [int]$cue.holdMs
    $existing.at = [DateTime]::UtcNow
  } else {
    $script:seq++
    $entry = [pscustomobject]@{
      id = [string]$cue.id
      lines = @($cue.lines)
      holdMs = [int]$cue.holdMs
      at = [DateTime]::UtcNow
      seq = $script:seq
    }
    [void]$script:cues.Add($entry)
  }
  while ($script:cues.Count -gt 12) { $script:cues.RemoveAt(0) }
  Render-Cues
}

function Expire-Cues {
  $now = [DateTime]::UtcNow
  $removed = $false
  for ($index = $script:cues.Count - 1; $index -ge 0; $index--) {
    $cue = $script:cues[$index]
    if (($now - $cue.at).TotalMilliseconds -gt [math]::Max(250, $cue.holdMs)) {
      $script:cues.RemoveAt($index)
      $removed = $true
    }
  }
  if ($removed) { Render-Cues }
}

function Initialize-ControlBar {
  $script:bar = New-Object System.Windows.Window
  $script:bar.WindowStyle = [System.Windows.WindowStyle]::None
  $script:bar.AllowsTransparency = $true
  $script:bar.Background = [System.Windows.Media.Brushes]::Transparent
  $script:bar.ShowInTaskbar = $false
  $script:bar.Topmost = $true
  $script:bar.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $script:bar.SizeToContent = [System.Windows.SizeToContent]::Manual
  $script:bar.Width = 420
  $script:bar.Height = 44
  $script:bar.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $script:bar.ShowActivated = $false

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = New-Object System.Windows.CornerRadius 12
  $border.Background = New-SolidBrush 238 26 26 30
  $border.Padding = New-Object System.Windows.Thickness 8, 5, 8, 5

  $stack = New-Object System.Windows.Controls.StackPanel
  $stack.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $stack.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

  $script:statusDot = New-Object System.Windows.Shapes.Ellipse
  $script:statusDot.Width = 9
  $script:statusDot.Height = 9
  $script:statusDot.Fill = [System.Windows.Media.Brushes]::Gray
  $script:statusDot.Margin = New-Object System.Windows.Thickness 2, 0, 6, 0
  $script:statusDot.ToolTip = "绿=识别中 / 黄=准备中 / 蓝=已暂停 / 灰=已停止`n独占全屏应用下字幕可能被遮挡，请改用窗口化全屏或提升置顶层级"
  [void]$stack.Children.Add($script:statusDot)

  $script:playButton = New-FlatButton '▶' 30
  $script:playButton.ToolTip = '开始 / 停止'
  $script:playButton.add_Click({
    if ($script:stateRunning -or $script:statePhase -eq 'listening' -or $script:statePhase -eq 'preparing') {
      Send-Action 'stop'
    } else {
      Send-Action 'start'
    }
  })
  [void]$stack.Children.Add($script:playButton)

  $script:sourceCombo = New-Object System.Windows.Controls.ComboBox
  $script:sourceCombo.Width = 82
  $script:sourceCombo.Height = 24
  $script:sourceCombo.FontSize = 12
  $script:sourceCombo.Margin = New-Object System.Windows.Thickness 3, 0, 2, 0
  foreach ($pair in @(@('自动', 'auto'), @('中文', 'zh'), @('English', 'en'), @('日本語', 'ja'), @('한국어', 'ko'), @('粤语', 'yue'))) {
    $item = New-Object System.Windows.Controls.ComboBoxItem
    $item.Content = $pair[0]
    $item.Tag = $pair[1]
    [void]$script:sourceCombo.Items.Add($item)
  }
  $script:sourceCombo.SelectedIndex = 0
  $script:sourceCombo.add_SelectionChanged({
    if ($script:syncing) { return }
    $item = $script:sourceCombo.SelectedItem
    if ($null -ne $item) { Send-Action 'setSource' ([string]$item.Tag) }
  })
  [void]$stack.Children.Add($script:sourceCombo)

  $arrow = New-Object System.Windows.Controls.TextBlock
  $arrow.Text = '→'
  $arrow.Foreground = [System.Windows.Media.Brushes]::Gainsboro
  $arrow.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $arrow.Margin = New-Object System.Windows.Thickness 1, 0, 1, 0
  [void]$stack.Children.Add($arrow)

  $script:targetCombo = New-Object System.Windows.Controls.ComboBox
  $script:targetCombo.Width = 82
  $script:targetCombo.Height = 24
  $script:targetCombo.FontSize = 12
  $script:targetCombo.Margin = New-Object System.Windows.Thickness 2, 0, 6, 0
  foreach ($pair in @(@('中文', 'zh'), @('English', 'en'), @('日本語', 'ja'), @('한국어', 'ko'), @('粤语', 'yue'))) {
    $item = New-Object System.Windows.Controls.ComboBoxItem
    $item.Content = $pair[0]
    $item.Tag = $pair[1]
    [void]$script:targetCombo.Items.Add($item)
  }
  $script:targetCombo.SelectedIndex = 0
  $script:targetCombo.add_SelectionChanged({
    if ($script:syncing) { return }
    $item = $script:targetCombo.SelectedItem
    if ($null -ne $item) { Send-Action 'setTarget' ([string]$item.Tag) }
  })
  [void]$stack.Children.Add($script:targetCombo)

  $script:meetingButton = New-FlatButton '会议' 44
  $script:meetingButton.add_Click({ Send-Action 'setMode' 'meeting' })
  [void]$stack.Children.Add($script:meetingButton)

  $script:mediaButton = New-FlatButton '影视' 44
  $script:mediaButton.add_Click({ Send-Action 'setMode' 'media' })
  [void]$stack.Children.Add($script:mediaButton)

  $script:settingsButton = New-FlatButton '⋯' 32
  $script:settingsButton.ToolTip = '设置'
  $script:settingsButton.add_Click({ Toggle-Settings })
  [void]$stack.Children.Add($script:settingsButton)

  $border.Child = $stack
  $script:bar.Content = $border
}

function Position-ControlBar {
  if ($null -eq $script:bar) { return }
  $area = [System.Windows.SystemParameters]::WorkArea
  $width = $script:bar.Width
  $height = $script:bar.Height
  $left = $area.Left + ($area.Width - $width) / 2
  $bottom = $area.Bottom - 48
  if ($script:subWindow.IsVisible) {
    $bottom = $script:subWindow.Top - 10
  }
  $top = $bottom - $height
  if ($top -lt $area.Top + 8) { $top = $area.Top + 8 }
  $script:bar.Left = $left
  $script:bar.Top = $top
}

function Show-ControlBar([bool]$activate = $false) {
  Position-ControlBar
  if (-not $script:bar.IsVisible) { $script:bar.Show() }
  if ($script:hwndBar -ne [IntPtr]::Zero) { [RtNative]::KeepTopmost($script:hwndBar) }
  if ($activate) { [void]$script:bar.Activate() }
  $script:barStickyUntil = [DateTime]::UtcNow.AddSeconds(8)
  $script:awaySince = $null
}

function Hide-ControlBar {
  if ($script:bar.IsVisible) { $script:bar.Hide() }
  Hide-Settings
  $script:awaySince = $null
}

function Toggle-ControlBar {
  if ($script:bar.IsVisible) { Hide-ControlBar } else { Show-ControlBar $true }
}

function Initialize-SettingsWindow {
  $script:settings = New-Object System.Windows.Window
  $script:settings.Title = '字幕设置'
  $script:settings.Width = 300
  $script:settings.Height = 440
  $script:settings.Topmost = $true
  $script:settings.ShowInTaskbar = $false
  $script:settings.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $script:settings.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen
  $script:settings.Background = New-SolidBrush 255 32 32 36

  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Object System.Windows.Thickness 14

  $script:settingsFontLabel = New-Object System.Windows.Controls.TextBlock
  $script:settingsFontLabel.Text = ('字号 ' + [string][int]$script:style.fontSize)
  $script:settingsFontLabel.Foreground = [System.Windows.Media.Brushes]::White
  $script:settingsFontLabel.Margin = New-Object System.Windows.Thickness 0, 8, 0, 3
  [void]$panel.Children.Add($script:settingsFontLabel)

  $fontSlider = New-Object System.Windows.Controls.Slider
  $fontSlider.Minimum = 12
  $fontSlider.Maximum = 96
  $fontSlider.Value = [double]$script:style.fontSize
  $fontSlider.IsSnapToTickEnabled = $true
  $fontSlider.TickFrequency = 1
  $fontSlider.add_ValueChanged({
    if ($script:syncing) { return }
    $script:style.fontSize = [int]$fontSlider.Value
    $script:settingsFontLabel.Text = ('字号 ' + [string][int]$script:style.fontSize)
    Render-Cues
    Queue-Subtitle @{ fontSize = [int]$script:style.fontSize }
  })
  [void]$panel.Children.Add($fontSlider)

  $script:settingsLinesLabel = New-Object System.Windows.Controls.TextBlock
  $script:settingsLinesLabel.Text = ('行数 ' + [string][int]$script:style.maxLines)
  $script:settingsLinesLabel.Foreground = [System.Windows.Media.Brushes]::White
  $script:settingsLinesLabel.Margin = New-Object System.Windows.Thickness 0, 8, 0, 3
  [void]$panel.Children.Add($script:settingsLinesLabel)

  $linesSlider = New-Object System.Windows.Controls.Slider
  $linesSlider.Minimum = 1
  $linesSlider.Maximum = 6
  $linesSlider.Value = [double]$script:style.maxLines
  $linesSlider.IsSnapToTickEnabled = $true
  $linesSlider.TickFrequency = 1
  $linesSlider.add_ValueChanged({
    if ($script:syncing) { return }
    $script:style.maxLines = [int]$linesSlider.Value
    $script:settingsLinesLabel.Text = ('行数 ' + [string][int]$script:style.maxLines)
    Render-Cues
    Queue-Subtitle @{ maxLines = [int]$script:style.maxLines }
  })
  [void]$panel.Children.Add($linesSlider)

  $positionLabel = New-Object System.Windows.Controls.TextBlock
  $positionLabel.Text = '位置'
  $positionLabel.Foreground = [System.Windows.Media.Brushes]::White
  $positionLabel.Margin = New-Object System.Windows.Thickness 0, 8, 0, 3
  [void]$panel.Children.Add($positionLabel)

  $script:positionCombo = New-Object System.Windows.Controls.ComboBox
  $script:positionCombo.Height = 24
  foreach ($pair in @(@('底部', 'bottom'), @('顶部', 'top'))) {
    $item = New-Object System.Windows.Controls.ComboBoxItem
    $item.Content = $pair[0]
    $item.Tag = $pair[1]
    [void]$script:positionCombo.Items.Add($item)
  }
  $script:positionCombo.SelectedIndex = 0
  $script:positionCombo.add_SelectionChanged({
    if ($script:syncing) { return }
    $item = $script:positionCombo.SelectedItem
    if ($null -ne $item) {
      $script:style.position = [string]$item.Tag
      Render-Cues
      Queue-Subtitle @{ position = [string]$item.Tag }
    }
  })
  [void]$panel.Children.Add($script:positionCombo)

  $script:bilingualCheck = New-Object System.Windows.Controls.CheckBox
  $script:bilingualCheck.Content = '显示原文（双语）'
  $script:bilingualCheck.Foreground = [System.Windows.Media.Brushes]::White
  $script:bilingualCheck.Margin = New-Object System.Windows.Thickness 0, 12, 0, 0
  $script:bilingualCheck.IsChecked = [bool]$script:style.bilingual
  $script:bilingualCheck.add_Click({
    if ($script:syncing) { return }
    $script:style.bilingual = [bool]$script:bilingualCheck.IsChecked
    Render-Cues
    Queue-Subtitle @{ bilingual = [bool]$script:style.bilingual }
  })
  [void]$panel.Children.Add($script:bilingualCheck)

  $script:settingsOpacityLabel = New-Object System.Windows.Controls.TextBlock
  $script:settingsOpacityLabel.Text = ('背景透明度 ' + [string][math]::Round([double]$script:style.opacity, 2))
  $script:settingsOpacityLabel.Foreground = [System.Windows.Media.Brushes]::White
  $script:settingsOpacityLabel.Margin = New-Object System.Windows.Thickness 0, 8, 0, 3
  [void]$panel.Children.Add($script:settingsOpacityLabel)

  $opacitySlider = New-Object System.Windows.Controls.Slider
  $opacitySlider.Minimum = 0.1
  $opacitySlider.Maximum = 1
  $opacitySlider.Value = [double]$script:style.opacity
  $opacitySlider.add_ValueChanged({
    if ($script:syncing) { return }
    $script:style.opacity = [double]$opacitySlider.Value
    $script:settingsOpacityLabel.Text = ('背景透明度 ' + [string][math]::Round([double]$script:style.opacity, 2))
    Update-StyleVisuals
    Queue-Subtitle @{ opacity = [math]::Round([double]$script:style.opacity, 2) }
  })
  [void]$panel.Children.Add($opacitySlider)

  $script:settingsWidthLabel = New-Object System.Windows.Controls.TextBlock
  $script:settingsWidthLabel.Text = ('字幕宽度 ' + [string][math]::Round([double]$script:style.widthPercent) + '%')
  $script:settingsWidthLabel.Foreground = [System.Windows.Media.Brushes]::White
  $script:settingsWidthLabel.Margin = New-Object System.Windows.Thickness 0, 8, 0, 3
  [void]$panel.Children.Add($script:settingsWidthLabel)

  $widthSlider = New-Object System.Windows.Controls.Slider
  $widthSlider.Minimum = 30
  $widthSlider.Maximum = 100
  $widthSlider.Value = [double]$script:style.widthPercent
  $widthSlider.add_ValueChanged({
    if ($script:syncing) { return }
    $script:style.widthPercent = [double]$widthSlider.Value
    $script:settingsWidthLabel.Text = ('字幕宽度 ' + [string][math]::Round([double]$script:style.widthPercent) + '%')
    Position-SubtitleWindow
    Queue-Subtitle @{ widthPercent = [math]::Round([double]$script:style.widthPercent) }
  })
  [void]$panel.Children.Add($widthSlider)

  $script:settingsMarginLabel = New-Object System.Windows.Controls.TextBlock
  $script:settingsMarginLabel.Text = ('底边距 ' + [string][math]::Round([double]$script:style.marginPercent) + '%')
  $script:settingsMarginLabel.Foreground = [System.Windows.Media.Brushes]::White
  $script:settingsMarginLabel.Margin = New-Object System.Windows.Thickness 0, 8, 0, 3
  [void]$panel.Children.Add($script:settingsMarginLabel)

  $marginSlider = New-Object System.Windows.Controls.Slider
  $marginSlider.Minimum = 0
  $marginSlider.Maximum = 30
  $marginSlider.Value = [double]$script:style.marginPercent
  $marginSlider.add_ValueChanged({
    if ($script:syncing) { return }
    $script:style.marginPercent = [double]$marginSlider.Value
    $script:settingsMarginLabel.Text = ('底边距 ' + [string][math]::Round([double]$script:style.marginPercent) + '%')
    Position-SubtitleWindow
    Queue-Subtitle @{ marginPercent = [math]::Round([double]$script:style.marginPercent) }
  })
  [void]$panel.Children.Add($marginSlider)

  $script:settings.Content = $panel
  $script:settings.add_Closing({ param($sender, $args) $args.Cancel = $true; Hide-Settings })
}

function Show-Settings {
  $script:syncing = $true
  if ($script:style.position -eq 'top') { $script:positionCombo.SelectedIndex = 1 } else { $script:positionCombo.SelectedIndex = 0 }
  $script:bilingualCheck.IsChecked = [bool]$script:style.bilingual
  $script:syncing = $false
  $script:settings.Show()
  [void]$script:settings.Activate()
}

function Hide-Settings {
  if ($null -ne $script:settings -and $script:settings.IsVisible) { $script:settings.Hide() }
}

function Toggle-Settings {
  if ($script:settings.IsVisible) { Hide-Settings } else { Show-Settings }
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
  $script:notify = New-Object System.Windows.Forms.NotifyIcon
  $script:notify.Icon = [System.Drawing.SystemIcons]::Application
  $script:notify.Text = 'DSH 实时字幕'
  $script:notify.Visible = $true
  $script:notify.add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Toggle-ControlBar }
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

function Initialize-Hotkeys {
  $script:hotkeyHost = New-Object RtHotkeyHost
  $script:hotkeyHost.OnHotkey = [Action[int]]{ param($id) Handle-Hotkey $id }
  $modifiers = 0x0001 -bor 0x0002
  $definitions = @(
    @{ id = 1; vk = 0x53; name = 'toggle' },
    @{ id = 2; vk = 0x43; name = 'clear' },
    @{ id = 3; vk = 0x48; name = 'panel' },
    @{ id = 4; vk = 0x26; name = 'fontUp' },
    @{ id = 5; vk = 0x28; name = 'fontDown' },
    @{ id = 6; vk = 0x42; name = 'bilingual' }
  )
  foreach ($definition in $definitions) {
    if ($script:hotkeyHost.Register([int]$definition.id, $modifiers, [int]$definition.vk)) {
      $script:hotkeys[[int]$definition.id] = [string]$definition.name
    } else {
      Send-Log ('热键注册失败: ' + [string]$definition.name)
    }
  }
}

function Handle-Hotkey([int]$id) {
  $name = $script:hotkeys[$id]
  switch ($name) {
    'toggle' { Send-Action 'toggle' }
    'clear' { Send-Action 'clear' }
    'panel' { Send-Action 'showPanel' }
    'fontUp' { Send-Action 'setFontSize' ([int]$script:style.fontSize + 2) }
    'fontDown' { Send-Action 'setFontSize' ([int]$script:style.fontSize - 2) }
    'bilingual' {
      $script:style.bilingual = -not [bool]$script:style.bilingual
      Render-Cues
      Queue-Subtitle @{ bilingual = [bool]$script:style.bilingual }
    }
  }
}

function Apply-State($state) {
  if ($null -eq $state) { return }
  $script:stateRunning = [bool]$state.running
  $script:statePhase = [string]$state.phase
  if ($null -ne $script:playButton) {
    if ($script:stateRunning -or $script:statePhase -eq 'listening' -or $script:statePhase -eq 'preparing') {
      $script:playButton.Content = '⏸'
    } else {
      $script:playButton.Content = '▶'
    }
  }
  if ($null -ne $script:statusDot) {
    switch ($script:statePhase) {
      'listening' { $script:statusDot.Fill = [System.Windows.Media.Brushes]::LimeGreen }
      'preparing' { $script:statusDot.Fill = [System.Windows.Media.Brushes]::Gold }
      'paused' { $script:statusDot.Fill = [System.Windows.Media.Brushes]::DodgerBlue }
      'error' { $script:statusDot.Fill = [System.Windows.Media.Brushes]::Red }
      default { $script:statusDot.Fill = [System.Windows.Media.Brushes]::Gray }
    }
  }

  $script:syncing = $true
  if ($null -ne $script:sourceCombo) {
    $index = 0
    for ($i = 0; $i -lt $script:sourceCombo.Items.Count; $i++) {
      if ([string]$script:sourceCombo.Items[$i].Tag -eq [string]$state.source) { $index = $i }
    }
    $script:sourceCombo.SelectedIndex = $index
  }
  if ($null -ne $script:targetCombo) {
    $index = 0
    for ($i = 0; $i -lt $script:targetCombo.Items.Count; $i++) {
      if ([string]$script:targetCombo.Items[$i].Tag -eq [string]$state.target) { $index = $i }
    }
    $script:targetCombo.SelectedIndex = $index
  }
  $script:syncing = $false

  if ($null -ne $script:meetingButton -and $null -ne $script:mediaButton) {
    if ([string]$state.preset -eq 'media') {
      $script:meetingButton.Background = [System.Windows.Media.Brushes]::Transparent
      $script:mediaButton.Background = New-SolidBrush 255 58 110 165
    } else {
      $script:mediaButton.Background = [System.Windows.Media.Brushes]::Transparent
      $script:meetingButton.Background = New-SolidBrush 255 58 110 165
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
      'cue' { Upsert-Cue $message.cue }
      'state' { Apply-State $message.state }
      'clear' { Clear-Cues }
      'panel' {
        if ([string]$message.visible -eq 'toggle') { Toggle-ControlBar }
        elseif ([bool]$message.visible) { Show-ControlBar $true }
        else { Hide-ControlBar }
      }
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
  foreach ($window in @($script:subWindow, $script:bar, $script:settings)) {
    try { if ($null -ne $window) { $window.Close() } } catch { }
  }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
}

function Test-MouseZone {
  if ($null -eq $script:bar) { return }
  $point = [System.Windows.Forms.Cursor]::Position
  $area = [System.Windows.SystemParameters]::WorkArea
  $center = $area.Left + $area.Width / 2
  $nearBottom = ($point.Y -ge ($area.Bottom - 5)) -and ([math]::Abs($point.X - $center) -lt 260)
  if ($nearBottom -and -not $script:bar.IsVisible) { Show-ControlBar $false }

  if ($script:bar.IsVisible -and -not $script:settings.IsVisible) {
    $overBar = $script:bar.IsMouseOver
    $active = $script:bar.IsActive
    if ([DateTime]::UtcNow -lt $script:barStickyUntil -or $overBar -or $active) {
      $script:awaySince = $null
    } else {
      if ($null -eq $script:awaySince) {
        $script:awaySince = [DateTime]::UtcNow
      } elseif (([DateTime]::UtcNow - $script:awaySince).TotalSeconds -gt 3) {
        Hide-ControlBar
      }
    }
  }
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
  $script:housekeepingTimer.add_Tick({
    Expire-Cues
    Test-MouseZone
  })

  $script:topmostTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:topmostTimer.Interval = [TimeSpan]::FromSeconds(2)
  $script:topmostTimer.add_Tick({
    if ($script:hwndSub -ne [IntPtr]::Zero -and $script:subWindow.IsVisible) { [RtNative]::KeepTopmost($script:hwndSub) }
    if ($script:hwndBar -ne [IntPtr]::Zero -and $script:bar.IsVisible) { [RtNative]::KeepTopmost($script:hwndBar) }
  })

  $script:subtitleTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:subtitleTimer.Interval = [TimeSpan]::FromMilliseconds(180)
  $script:subtitleTimer.add_Tick({ Flush-SubtitlePatch })
}

function Initialize-Windows {
  Initialize-SubtitleWindow
  Initialize-ControlBar
  Initialize-SettingsWindow
  $script:syncing = $false
  Update-StyleVisuals
}

function Run-SelfTest {
  $script:style.fontSize = 34
  Update-StyleVisuals
  $script:subWindow.Show()
  $script:hwndSub = Get-WindowHandle $script:subWindow
  [RtNative]::MakeClickThrough($script:hwndSub)
  Upsert-Cue ([pscustomobject]@{
    id = 'selftest'
    holdMs = 5000
    lines = @(
      [pscustomobject]@{ kind = 'target'; text = '实时字幕叠加窗自检'; live = $false },
      [pscustomobject]@{ kind = 'source'; text = 'Subtitle overlay self-test'; live = $false }
    )
  })
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

  $script:bar.Show()
  $script:hwndBar = Get-WindowHandle $script:bar
  [RtNative]::MakeToolWindow($script:hwndBar)
  $script:bar.Hide()
  Position-ControlBar

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

Initialize-Windows

if ($SelfTest) {
  Run-SelfTest
} else {
  Run-Overlay
}

exit 0
