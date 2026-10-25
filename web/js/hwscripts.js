'use strict';
// Windows helper scripts for the Hardware page. They are handed out as .bat files (double-click, no PowerShell setup):
// the .bat starts PowerShell and runs the script written after the "#PS#" line. Plain ASCII only.
//  - "Check this computer": only READS (printers, ports, queue, default printer, errors) and writes a report.
//  - "Fix printing": asks before every change (clear stuck jobs, repair the USB port, choose the default printer).
const HwScripts = (() => {
  const CRLF = '\r\n';
  const launch = (title, admin) => [
    '@echo off',
    `title ${title}`,
    ...(admin ? ['net session >nul 2>&1', 'if %errorlevel% neq 0 ( powershell -NoProfile -Command "Start-Process -FilePath \'%~f0\' -Verb RunAs" & exit /b )'] : []),
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = [IO.File]::ReadAllText(\'%~f0\'); $i = $t.IndexOf(\'#\'+\'PS#\'); Invoke-Expression $t.Substring($i)"',
    'echo.',
    'pause',
    'exit /b',
    '#PS#',
  ];

  const COMMON = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$virtual = 'OneNote|XPS|Print to PDF|PDF|Fax|AnyDesk|Root Print'
function Real-Printers { Get-Printer | Where-Object { $_.Name -notmatch $virtual } }
function Mm($v) { [math]::Round($v * 0.254, 1) }
`;

  const CHECK = String.raw`
$lines = New-Object System.Collections.ArrayList
function Say($lvl, $msg) {
  $col = @{ OK = 'Green'; FIX = 'Red'; WARN = 'Yellow'; INFO = 'Gray' }[$lvl]
  Write-Host ("{0,-5} {1}" -f $lvl, $msg) -ForegroundColor $col
  [void]$lines.Add(("{0}: {1}" -f $lvl, $msg))
}
Write-Host ''
Write-Host 'Velanzo - check this computer (this only reads, it changes nothing)' -ForegroundColor Cyan
Write-Host ''
$os = (Get-CimInstance Win32_OperatingSystem).Caption
Say INFO ("Computer: $env:COMPUTERNAME, $os, " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))

# 1. Windows print service
$sp = Get-Service Spooler
if ($sp.Status -eq 'Running') { Say OK 'Windows print service (Spooler) is running' } else { Say FIX 'Windows print service (Spooler) is NOT running. Run "Fix printing" and choose 1.' }

# 2. default printer
$def = (Get-CimInstance Win32_Printer | Where-Object Default).Name
$mode = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows').LegacyDefaultPrinterMode
if (-not $def) { Say FIX 'There is no default printer. Run "Fix printing" and choose 3.' }
elseif ($def -match $virtual) { Say FIX "The default printer is '$def' (a file, not paper). Bills would not print on paper. Run 'Fix printing' and choose 3." }
else { Say OK "Default printer: $def" }
if ($mode -eq 1) { Say OK 'Windows does not change the default printer by itself' } else { Say INFO 'If the default printer keeps changing by itself, run Fix printing and choose 3 (it stops Windows doing that).' }

# 3. printers and USB ports
$usbPorts = Get-PrinterPort | Where-Object { $_.Name -like 'USB0*' }
$usbDev = Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -eq 'USB Printing Support' }
$printers = @(Real-Printers)
Say INFO ("USB printers Windows can see: {0}; USB ports: {1}" -f @($usbDev).Count, (($usbPorts | ForEach-Object { "$($_.Name) ($($_.Description))" }) -join ', '))
if ($printers.Count -eq 0) { Say FIX 'No real printer is installed (only PDF/OneNote/Fax). Install the driver for each printer: see Hardware > Receipt printer / Label printer.' }
foreach ($p in $printers) {
  $cim = Get-CimInstance Win32_Printer -Filter ("Name='" + $p.Name.Replace("'", "''") + "'")
  $jobs = @(Get-PrintJob -PrinterName $p.Name)
  $bad = @($jobs | Where-Object { $_.JobStatus -match 'Error|Blocked|Offline|Paper' })
  Say INFO ("Printer '{0}': driver {1}, port {2}" -f $p.Name, $p.DriverName, $p.PortName)
  if ($cim.WorkOffline) { Say FIX "'$($p.Name)' shows as OFFLINE. Switch the printer on and plug in its USB cable. If it is on and still offline: Windows Printers & scanners, the printer, Open print queue, menu Printer, untick 'Use Printer Offline'." }
  if ($p.Name -match '\([0-9]+\)$') { Say WARN "'$($p.Name)' looks like a duplicate of another printer. Use the one without (1) in its name; you can remove this one in Windows." }
  if ($p.PortName -eq 'USB PORT:' -or $p.PortName -eq '') { Say FIX "'$($p.Name)' uses the port '$($p.PortName)', which the installer made by mistake. Run 'Fix printing' and choose 2 to point it at the real USB port." }
  elseif ($p.PortName -like 'USB0*') { Say OK "'$($p.Name)' is on the USB port $($p.PortName)" }
  if ($bad.Count -gt 0) { Say FIX ("'{0}' has {1} stuck job(s) in error. Run 'Fix printing' and choose 1." -f $p.Name, $bad.Count) }
  elseif ($jobs.Count -gt 0) { Say WARN ("'{0}' has {1} job(s) waiting in its queue." -f $p.Name, $jobs.Count) }
  else { Say OK "'$($p.Name)' has an empty queue" }
  if ($cim.DetectedErrorState -in 3, 4, 5, 6, 7, 8, 9, 10, 11) { Say FIX "'$($p.Name)' reports a problem: paper out, jammed, cover open or offline (code $($cim.DetectedErrorState)). Check the paper and the cover." }
  Add-Type -AssemblyName System.Drawing
  $ps = New-Object System.Drawing.Printing.PrinterSettings
  $ps.PrinterName = $p.Name
  if ($ps.IsValid) {
    $d = $ps.DefaultPageSettings
    Say INFO ("   paper: {0} x {1} mm ({2}), prints at {3} dpi" -f (Mm $d.PaperSize.Width), (Mm $d.PaperSize.Height), $d.PaperSize.PaperName, $d.PrinterResolution.X)
  }
}
# a USB printer is plugged in, but fewer printers are installed than the ones Windows can see
$onUsb = @($printers | Where-Object { $_.PortName -like 'USB0*' }).Count
if (@($usbDev).Count -gt $onUsb) { Say WARN ("Windows sees {0} USB printer(s) plugged in, but only {1} installed printer(s) use a USB port. A printer may still need its driver (see Hardware)." -f @($usbDev).Count, $onUsb) }
elseif (@($usbDev).Count -eq 0) { Say INFO 'No USB printer is plugged in and switched on right now.' }

# 4. recent errors
$since = (Get-Date).AddHours(-24)
$errs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PrintService/Admin'; Id = 372; StartTime = $since } -MaxEvents 5)
if ($errs.Count -eq 0) { Say OK 'No printing errors in the last 24 hours' }
else {
  Say FIX ("{0} printing error(s) in the last 24 hours. Latest: {1}" -f $errs.Count, ($errs[0].Message -replace '\s+', ' ').Substring(0, [math]::Min(220, ($errs[0].Message -replace '\s+', ' ').Length)))
  if ($errs[0].Message -match 'cannot find the path') { Say FIX 'That error means the printer is on a wrong port: run Fix printing, choice 2.' }
}

# 5. keyboards (a scanner shows up as a keyboard)
$kb = @(Get-PnpDevice -PresentOnly -Class Keyboard | Where-Object { $_.FriendlyName -match 'HID Keyboard' })
Say INFO ("Keyboard-type devices (a barcode scanner is one): {0}. Test it in Velanzo > Hardware > Scanner." -f $kb.Count)

$desk = [Environment]::GetFolderPath('Desktop')
$file = Join-Path $desk 'Velanzo-hardware-report.txt'
$lines | Set-Content -Path $file -Encoding UTF8
Write-Host ''
Write-Host "Report saved on the Desktop: Velanzo-hardware-report.txt" -ForegroundColor Cyan
Write-Host 'You can paste it in Velanzo > Hardware > "Paste the report".' -ForegroundColor Cyan
`;

  const FIX = String.raw`
function Pick($title, $items) {
  Write-Host ''
  Write-Host $title -ForegroundColor Cyan
  for ($i = 0; $i -lt $items.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $items[$i]) }
  $a = Read-Host 'Type a number (or press Enter to skip)'
  if ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $items.Count) { return [int]$a - 1 }
  return -1
}
function Clear-Queue {
  Write-Host 'Stopping the print service, deleting stuck jobs, starting it again...'
  Stop-Service Spooler -Force
  Start-Sleep 2
  Remove-Item "$env:SystemRoot\System32\spool\PRINTERS\*" -Force -ErrorAction SilentlyContinue
  Start-Service Spooler
  Start-Sleep 2
  Write-Host 'Done. The queues are empty.' -ForegroundColor Green
}
function Fix-Ports {
  $usbPorts = @(Get-PrinterPort | Where-Object { $_.Name -like 'USB0*' -and $_.Description -notmatch 'Virtual printer port' })
  $bad = @(Real-Printers | Where-Object { $_.PortName -eq 'USB PORT:' -or $_.PortName -eq '' })
  if ($bad.Count -eq 0) { Write-Host 'No printer is on a wrong port.' -ForegroundColor Green; return }
  if ($usbPorts.Count -eq 0) { Write-Host 'No printer is plugged in on USB. Plug it in, switch it on, and try again.' -ForegroundColor Yellow; return }
  foreach ($p in $bad) {
    $labels = $usbPorts | ForEach-Object { "$($_.Name)  ($($_.Description))" }
    $i = Pick ("Which USB port is '$($p.Name)' on?") $labels
    if ($i -ge 0) { Set-Printer -Name $p.Name -PortName $usbPorts[$i].Name; Write-Host "'$($p.Name)' now uses $($usbPorts[$i].Name)." -ForegroundColor Green }
  }
}
function Set-Default {
  $names = @(Real-Printers | ForEach-Object { $_.Name })
  if ($names.Count -eq 0) { Write-Host 'No real printer is installed.' -ForegroundColor Yellow; return }
  $i = Pick 'Which printer should be the default? (Velanzo prints bills to the default printer)' $names
  if ($i -ge 0) {
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name LegacyDefaultPrinterMode -Value 1 -Type DWord
    (New-Object -ComObject WScript.Network).SetDefaultPrinter($names[$i])
    Write-Host "'$($names[$i])' is now the default, and Windows will not change it by itself." -ForegroundColor Green
  }
}
Write-Host ''
Write-Host 'Velanzo - fix printing (it asks before each change)' -ForegroundColor Cyan
do {
  $m = Pick 'What do you want to fix?' @('Clear stuck print jobs (restarts the print service)', 'Point a printer at its real USB port (when it says path not found)', 'Choose the default printer (and stop Windows changing it)', 'Do all three')
  switch ($m) { 0 { Clear-Queue } 1 { Fix-Ports } 2 { Set-Default } 3 { Clear-Queue; Fix-Ports; Set-Default } }
  if ($m -ge 0) { $again = Read-Host 'Fix something else? (y/n)' } else { $again = 'n' }
} while ($again -eq 'y')
Write-Host ''
Write-Host 'Now print a test page from Velanzo > Hardware.' -ForegroundColor Cyan
`;

  const join = (lines) => lines.join(CRLF) + CRLF;
  return {
    checkBat: () => join([...launch('Velanzo - check this computer', false), ...(COMMON + CHECK).split('\n')]),
    fixBat: () => join([...launch('Velanzo - fix printing', true), ...(COMMON + FIX).split('\n')]),
    // the same code, to test it
    checkPs: () => COMMON + CHECK,
    fixPs: () => COMMON + FIX,
  };
})();
if (typeof module !== 'undefined') module.exports = HwScripts;
