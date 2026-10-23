# At the shop: scanner and printers checklist

Take this to the shop with the computer. About 20 minutes. Use **Chrome or Edge**, with Velanzo open and up to date (close and open it once).

## 1. Barcode scanner (5 min)

1. Plug the scanner into USB. Windows needs no driver: it works like a keyboard.
2. Set the Windows keyboard to **English (US)** (bottom right, next to the clock).
3. Velanzo: **Settings → Bills & labels → Test the barcode scanner**. Click in the box and scan any barcode.
4. You should see:
   - **Received**: the same digits as printed under the bars
   - **Speed**: "a scanner ✓"
   - **Ends with**: "Enter ✓" (Tab ✓ is fine too)
5. If something is wrong:

| Velanzo shows | What to do |
|---|---|
| Ends with: **nothing** | In the scanner's little manual, scan the setting barcode **"Add Enter / CR suffix"**. |
| Speed: **as slow as typing** | In the manual, choose a faster **USB keyboard speed / transmit speed**. It still works in the scan box. |
| Strange characters, or letters instead of digits | Windows keyboard to **English (US)**. In the manual: **keyboard language USA**. |
| Nothing at all | Try another USB port. Open Notepad and scan: if nothing appears there either, the scanner is the problem, not Velanzo. |

## 2. Receipt printer, shop (5 min)

1. Install the printer's **own Windows driver** (CD or the maker's website). Print a Windows **test page** from the printer settings.
2. Velanzo: **Settings → Bills & labels**: paper width **80 mm** or **58 mm** (measure the roll), then **Print test bill**.
3. In the print window: choose the receipt printer, **Margins: None**, **Scale: Default**, untick **Headers and footers**, then Print. Chrome remembers this next time.
4. Check the test bill: text not cut off on the left or right, and the paper cuts after the bill.
5. Scan the **barcode at the bottom of the bill** in the scanner test box. It should show **TEST-00001**.
6. Optional, so bills print without the print window: close Chrome completely, right-click the Velanzo shortcut → **Properties**, add ` --kiosk-printing` at the end of **Target**, and make the receipt printer the **default printer** in Windows. Only do this on a computer that prints nothing but bills.

## 3. Label printer, warehouse (7 min)

1. Install its Windows driver. In **Printing preferences**: add a paper (stock) size equal to one sticker, for example **50 × 25 mm**, and run **Calibrate** (gap sensor) once.
2. Velanzo: **Settings → Bills & labels**: printer type **Label printer**, the same width and height, then **Print test label**.
3. In the print window: the label printer, **Margins: None**, **Scale: Default**.
4. Check: one label per sticker, nothing cut off, no blank sticker in between.
5. Scan the test label in the scanner test box. It should show **10000001**.
6. If the bars look grey or thin, or it does not scan: raise **darkness**, lower **speed** in the printing preferences, and try again.

## 4. A real sale (3 min)

1. **Sale order**: scan two items. Each scan adds a line, or +1 if it is the same item.
2. Click in **Cash received**, then scan another item. It must go on the bill, and the cash box must stay empty.
3. Press **Done**. The bill prints.
4. Straight away, scan the next item **without clicking anything**. The "Bill saved" window closes and the new bill starts with that item.
5. **Bills**: open the test bill, press **Cancel this bill** (so it does not count), or let the owner reset it.

## What we checked on our side (no hardware needed)

- Code 128 barcodes: the standard pattern table, and 2,000+ codes read back exactly with their check digit.
- Barcodes drawn at 203 dpi and 300 dpi (common thermal printers) read back correctly. Bars are drawn on whole printer dots, so they stay sharp.
- Labels come out exactly 50 × 25 mm, one per page, with nothing spilling over.
- An 80 mm bill prints 72 mm wide and fits on one page.
- A simulated USB scanner (real key presses a few ms apart), in every kind of box: scan box, cash box, a button, a quantity box, the Bill saved window, Tab instead of Enter, and an unknown code. Also UPC/EAN 12- vs 13-digit codes.
