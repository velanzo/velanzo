I'm setting up a shop/warehouse laptop for my business software, "Velanzo". You have no history with it, so here is the context. Please help me get the receipt printer and barcode (label) printer working on THIS laptop.

## What Velanzo is
- A clothing shop POS / warehouse / dispatch / accounts web app. Website: https://velanzo.github.io/velanzo/ (installed as an app with "Get the app" in Chrome). Works offline, syncs through Supabase.
- It is NOT installed software: it is a website in Chrome. Do not try to change its code on this laptop. The owner (me) already made my user, shop and password; I just sign in.
- Printing works through Chrome's print window (or straight to the default Windows printer if Chrome was started with --kiosk-printing).
- Everything about printers is in the app: open my name (top right) -> "Printers & scanner". It has: a "Start here" step list, scanner test, receipt printer settings + "Print test bill" + "Print ruler", label printer settings + "Print test label", a Drivers card with both driver downloads, troubleshooting table, Windows tools ("Check this computer" and "Fix printing" scripts, which are .bat downloads), and a "Print queue" tab (what this computer sent).

## My hardware (same models as on my main laptop, where everything works)
- Receipt printer: Black Copper BC-98AC, 80 mm thermal, USB. Driver: "BlackCopper 80mm Printer Driver.exe" (download button in the app). It creates a printer named "BlackCopper 80mm Series".
- Label (sticker) printer: Black Copper BC-LP1300 (made by Xprinter). Driver: Xprinter_4inch_2019.1_M-3.exe inside the zip from the app. In the wizard choose "Install printer drivers" -> model "Xprinter XP-420B" -> the printer's USB port. Paper size must be set to the sticker size, type "labels with gaps", then calibrate (hold Feed).
- Barcode scanner: Bluetooth, behaves as a keyboard (types the code then Enter). Windows keyboard must be English (US).

## Things we learned on my main laptop (likely causes of "nothing prints")
1. The receipt driver can install the printer on a bogus port called "USB PORT:". Fix: Windows -> Printers & scanners -> printer -> Printer properties -> Ports -> tick the real USB port (e.g. USB002). Printing to "USB PORT:" fails silently or with "path not found".
2. The driver may also create a duplicate printer named "... (1)". Delete the extra one.
3. Windows kept changing the default printer back to "Microsoft Print to PDF". Turn OFF "Let Windows manage my default printer" and set the receipt printer as default. (Matters most when printing straight to the default printer.)
4. Blank paper coming out = the paper roll is in backwards (flip it).
5. Right edge of the bill cut off: in the app set Print width 64 mm and Space from the left 1 mm (Hardware page -> Receipt printer -> Save for this computer). "Print ruler" shows what the printer really prints.
6. Stuck/errored jobs in the Windows print queue block everything: clear them, and make sure the printer is not "Offline" (and not paused).
7. If one laptop has both printers, do not use --kiosk-printing (it prints everything to the default printer); choose the printer in Chrome's print window and use Margins: None, Scale: Default, headers/footers off.
8. Downloads of .exe/.bat may be flagged by Chrome/Windows: choose Keep. The app shows SHA-256 codes for the driver files; the receipt driver's is d2910ad801d507da48a91087e2a244027d4a777d957d2e5122fdae427d667b9e and the label zip's is 1d57397efd72318027014b2fa866c0b50315cec8ba3191f2f5ecbd3395cf4511.

## Where I am now
I installed both drivers and connected the devices, but when I press "Print test bill" in Velanzo, nothing happens. Help me find out why, step by step. Please:
- First ask me what I see: (a) is there a line in Velanzo's Print queue tab, (b) did a Chrome print window open, (c) does Windows' own "Print Test Page" (printer properties) print, (d) is the printer shown as Offline.
- Then walk me through the checks above, one at a time, in simple words. I am not technical.
- Useful read-only PowerShell commands to look at the situation (run in PowerShell, they change nothing):
  Get-Printer | Select Name, DriverName, PortName, PrinterStatus
  Get-PrinterPort | Select Name, Description
  Get-CimInstance Win32_Printer | Where-Object Default | Select Name
  Get-PrintJob -PrinterName "<printer name>"
  Get-WinEvent -LogName "Microsoft-Windows-PrintService/Operational" -MaxEvents 20 | Select TimeCreated, Id, Message
  (The app's "Check this computer" button makes a similar report: you can also read it.)
- Before you change anything on Windows (ports, default printer, deleting printers, clearing jobs), tell me what and why and wait for my yes.
- Don't ask me for passwords. Don't edit Velanzo's code or files here.

When the receipt printer works, do the same for the label printer: print a test label from the app, scan it with the scanner into the app's scanner test box (it should show 10000001), and tell me the sticker size I need to type in the app (I measure one sticker's width x height in mm).
