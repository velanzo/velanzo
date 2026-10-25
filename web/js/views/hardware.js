'use strict';
// Hardware: everything for the scanner and the two printers of THIS computer, in one place — settings, tests, drivers,
// steps, Windows helper scripts, commands, fixes — and the print queue. Open to everyone (shop and warehouse computers).

const HW_DRIVERS = [
  { what: 'Receipt printer', model: 'Black Copper BC-98AC (80 mm)', file: 'BlackCopper 80mm Printer Driver.exe', ver: '2.17E', size: '2.7 MB',
    page: 'https://oemdrivers.com/printer-black-copper-bc-98ac', sha: 'd2910ad801d507da48a91087e2a244027d4a777d957d2e5122fdae427d667b9e',
    how: 'Run the .exe as administrator with the printer plugged in and switched on. When it says "Printer installed", open Windows → Printers & scanners → the printer → Printer properties → Ports and tick the real USB port (USB002, not "USB PORT:").' },
  { what: 'Label printer', model: 'Black Copper BC-LP1300 (4 inch, made by Xprinter)', file: '15919523892015.zip → For Windows\\Xprinter_4inch_2019.1_M-3.exe', ver: '2019.1.3', size: '41 MB',
    page: 'https://oemdrivers.com/printer-black-copper-bc-lp1300', sha: '1d57397efd72318027014b2fa866c0b50315cec8ba3191f2f5ecbd3395cf4511',
    how: 'Extract the zip, run Xprinter_4inch_2019.1_M-3.exe as administrator. In the wizard choose Install printer drivers → model "Xprinter XP-420B" → the USB port of the printer (USB003) → Finish. Then set the paper size to your sticker size.' },
];

const HW_FIXES = [
  ['Printer beeps and nothing prints', 'No paper, the cover is open, or a jam.', 'Put the roll in, close the cover until it clicks, switch off for 10 seconds, switch on, press Feed once.'],
  ['The bill comes out blank or very pale', 'The paper roll is the wrong way round, or the density is low.', 'Scratch the paper with a fingernail: the side that turns dark is the print side, it must face the print head (up as it leaves the printer). Then raise Density in the printer preferences.'],
  ['The right side of the bill is cut off', 'The printer prints less than the paper is wide (a 3 inch roll is 76 mm).', 'Hardware → Receipt printer → press "Print ruler", read the biggest number you can see, then set Print width a little below it (for example 64) and 1 mm from the left.'],
  ['A job is in the queue with "Error" and nothing prints', 'The printer is on a wrong port (the installer made "USB PORT:"), or it is switched off.', 'Run "Fix printing" (Windows tools below), choose 2. Or Windows → Printers & scanners → the printer → Printer properties → Ports → tick USB002 / USB003.'],
  ['"Save print output as" window appears', 'The default printer is Microsoft Print to PDF.', 'Make the real printer the default (Fix printing, choose 3). Turn off "Let Windows manage my default printer".'],
  ['The default printer keeps changing', 'Windows sets the default to the last printer used.', 'Settings → Bluetooth & devices → Printers & scanners → turn OFF "Let Windows manage my default printer", then set the default again.'],
  ['The print window opens every time', 'Normal for Chrome.', 'For the shop counter only: close Chrome, add  --kiosk-printing  at the end of the Chrome shortcut Target. Everything printed from that Chrome then goes straight to the default printer.'],
  ['Labels print shifted, or two labels are used per sticker', 'The paper size or the gap sensor is not set.', 'Printer preferences: paper = your sticker size, type = labels with gaps. Calibrate the printer (hold Feed a few seconds). Same size in Velanzo → Label printer.'],
  ['The scanner types nothing', 'Not connected (Bluetooth: not paired), or it is in another mode.', 'Open Notepad and scan: if nothing appears there, pair or plug it in again. Bluetooth scanners: scan the "HID keyboard / SPP off" code in the manual.'],
  ['The scanner types but does not press Enter', 'No Enter suffix set.', 'Scan the setting barcode "Add Enter / CR suffix" in the scanner manual, then test again.'],
  ['The scanner types wrong characters', 'Wrong keyboard language.', 'Windows keyboard = English (US). In the scanner manual: keyboard language USA.'],
  ['The printer is "offline" in Windows', 'It is off or unplugged, or "Use printer offline" is ticked.', 'Switch on and re-plug the USB cable. Printers & scanners → the printer → Open print queue → Printer menu → untick "Use Printer Offline".'],
];

const HW_COMMANDS = [
  ['See every printer, its driver and port', 'Get-Printer | Select-Object Name, DriverName, PortName, PrinterStatus | Format-Table -AutoSize'],
  ['See the USB ports (the real one has the printer\'s name)', 'Get-PrinterPort | Where-Object Name -like \'USB*\' | Format-Table Name, Description'],
  ['Check a downloaded file against its SHA-256', 'Get-FileHash ".\\file name here" -Algorithm SHA256'],
  ['Put a printer on the right USB port (as administrator)', 'Set-Printer -Name "PRINTER NAME" -PortName USB002'],
  ['Make a printer the default', 'rundll32 printui.dll,PrintUIEntry /y /n "PRINTER NAME"'],
  ['Print the Windows test page', 'rundll32 printui.dll,PrintUIEntry /k /n "PRINTER NAME"'],
  ['See what is waiting in a printer queue', 'Get-PrintJob -PrinterName "PRINTER NAME" | Format-Table Id, DocumentName, JobStatus'],
  ['Delete everything waiting in a printer queue', 'Get-PrintJob -PrinterName "PRINTER NAME" | Remove-PrintJob'],
  ['See the last printing errors', 'Get-WinEvent -LogName \'Microsoft-Windows-PrintService/Admin\' -MaxEvents 5 | Format-List TimeCreated, Message'],
  ['See the paper sizes a printer offers (mm)', 'Add-Type -AssemblyName System.Drawing; $p = New-Object System.Drawing.Printing.PrinterSettings; $p.PrinterName = "PRINTER NAME"; $p.PaperSizes | ForEach-Object { "{0}  {1:N0} x {2:N0} mm" -f $_.PaperName, ($_.Width*0.254), ($_.Height*0.254) }'],
  ['Restart the Windows print service (as administrator)', 'Restart-Service Spooler'],
];

// ---- what this computer has confirmed (kept on this computer) ----
const HwState = {
  key: () => `vz_hw_${App.device?.id || 0}`,
  get() { try { return JSON.parse(localStorage.getItem(this.key()) || '{}'); } catch { return {}; } },
  set(patch) { try { localStorage.setItem(this.key(), JSON.stringify({ ...this.get(), ...patch })); } catch { /* storage off */ } },
};

function hwTabsHtml(active) {
  const tabs = [...(isAdmin() ? SETTINGS_TABS.filter((t) => !t[2]) : []), ['hardware', 'Hardware', '#/hardware'], ['queue', 'Print queue', '#/hardware/queue']];
  return `<div class="tabs">${tabs.map(([k, t, href]) => `<a href="${href || '#/settings/' + k}" class="${k === active ? 'active' : ''}">${t}</a>`).join('')}</div>`;
}
const copyBtn = (text) => `<button type="button" class="btn sm" data-copy="${esc(text)}">Copy</button>`;
function bindCopy(root) {
  $$('[data-copy]', root).forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Select the text and copy it', 'warn'); }
  }));
}
const since = (at) => (at ? `${fmtDate(at)} ${fmtTime(at)}` : '');
const pill = (cls, text) => `<span class="pill ${cls}">${text}</span>`;

// ---------- Hardware: setup, settings, tests, drivers ----------
View('hardware', {
  title: 'Printers & scanner',
  nav: 'settings',
  async render({ el }) {
    const S = App.settings;
    const st = HwState.get();
    const prints = PrintLog.all();
    const lastOf = (q) => prints.find((p) => p.queue === q && !/^(TEST-|Ruler)/.test(p.title));
    const sample = { name: 'Lawn Kurta Embroidered', size: 'M', color: 'Blue', barcode: '10000001', sale_price: 2450 };
    const status = (ok, none, good) => (ok ? pill('ok', good) : pill('warn', none));
    el.innerHTML = `${hwTabsHtml('hardware')}
      <div class="alert info">These settings belong to <b>this computer</b> (${esc(App.device.label || 'this device')}). Every shop and warehouse computer sets up its own scanner and printers here. You do not need anyone to help: do the steps, press the test buttons, and use the Windows tools if something is wrong.</div>

      <div class="stats">
        <div class="card stat"><div class="label">Barcode scanner</div><div class="value">${st.scanner_at ? 'Tested' : 'Not tested'}</div><div class="sub">${status(!!st.scanner_at, 'press Test below', '✓ ' + esc(since(st.scanner_at)))}</div></div>
        <div class="card stat"><div class="label">Receipt printer</div><div class="value">${st.receipt_ok_at ? 'Working' : lastOf('receipt') ? 'Sent' : 'Not tested'}</div><div class="sub">${st.receipt_ok_at ? pill('ok', '✓ confirmed ' + esc(since(st.receipt_ok_at))) : pill('warn', 'print a test bill and confirm')}</div></div>
        <div class="card stat"><div class="label">Label printer</div><div class="value">${st.label_ok_at ? 'Working' : lastOf('label') ? 'Sent' : 'Not tested'}</div><div class="sub">${st.label_ok_at ? pill('ok', '✓ confirmed ' + esc(since(st.label_ok_at))) : pill('warn', 'print a test label and confirm')}</div></div>
      </div>

      <div class="card" id="secScanner"><h3>${icon('barcode')} 1. Barcode scanner</h3>
        <p class="muted small" style="margin-top:0">A scanner is a keyboard that types a barcode very fast and presses Enter. USB: plug it in. Bluetooth: pair it in Windows (Settings → Bluetooth &amp; devices → Add device) and make sure its light shows connected.</p>
        <input class="input" id="scanTest" placeholder="Click here, then scan any barcode…" autocomplete="off" style="max-width:460px">
        <div id="scanRes" style="margin-top:12px"></div>
        <details><summary>Steps and fixes for the scanner</summary>
          <ol class="steps">
            <li>Switch the Windows keyboard to <b>English (US)</b> (bottom right, next to the clock).</li>
            <li>Click the box above and scan. You should see the code, <b>a scanner ✓</b> and <b>Enter ✓</b> (Tab ✓ is fine too).</li>
            <li>If it says <b>Ends with: nothing</b>: scan the setting barcode <b>"Add Enter / CR suffix"</b> in the scanner's manual.</li>
            <li>If nothing appears at all: open Notepad and scan. Nothing there either → pair or plug the scanner in again.</li>
            <li>On the Sell, Purchase and Dispatch screens a scan always goes to the scan box, even when the cursor is in the cash box.</li>
          </ol></details>
      </div>

      <div class="grid-2">
        <div class="card" id="secReceipt"><h3>${icon('printer')} 2. Receipt printer (bills)</h3>
          <form id="fb" class="form-grid">
            <label class="field">Paper width<select class="input" name="bill_width">${options([['80', '80 mm (3 inch, standard)'], ['58', '58 mm (small)']], S.bill_width)}</select></label>
            <label class="field">Print the bill automatically after each sale<select class="input" name="auto_print_bill">${options([['1', 'Yes'], ['0', 'No: I press Print']], S.auto_print_bill)}</select></label>
            <label class="field">Print width (mm)<input class="input num" name="bill_mm" value="${esc(S.bill_mm || '')}" placeholder="${S.bill_width === '58' ? 48 : 72}" inputmode="numeric"><span class="hint">Empty = normal. Right side cut off? Use a smaller number (try 64).</span></label>
            <label class="field">Space from the left (mm)<input class="input num" name="bill_left" value="${esc(S.bill_left || '')}" placeholder="centred" inputmode="decimal"><span class="hint">Empty = centred. Left side cut off? Try 2.</span></label>
            <div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Save for this computer</button>
              <button type="button" class="btn" id="testBill">${icon('printer')} Print test bill</button><button type="button" class="btn" id="ruler">${icon('printer')} Print ruler</button></div></form>
          <div id="rcOk" style="margin-top:12px"></div>
          <details><summary>Steps, driver and fixes for the receipt printer</summary>
            <ol class="steps">
              <li>Plug the printer in (USB), switch it on, put in the paper roll (print side up as it leaves the printer), close the cover.</li>
              <li>Install its Windows driver (see the table below). Check the file's SHA-256 first.</li>
              <li>Windows → Printers &amp; scanners: the printer must be on its real <b>USB port</b> (USB002…), not "USB PORT:". Press <b>Print Test Page</b> in its properties.</li>
              <li>Make it the <b>default printer</b>, and turn off "Let Windows manage my default printer".</li>
              <li>In the Chrome print window: this printer, <b>Margins: None</b>, <b>Scale: Default</b>, headers and footers off.</li>
              <li>Press <b>Print test bill</b>. Cut off on the right? Press <b>Print ruler</b> and set the Print width.</li>
              <li>Scan the barcode at the bottom of the bill in the scanner box above.</li>
            </ol></details>
        </div>
        <div class="card" id="secLabel"><h3>${icon('tag')} 3. Barcode label printer (stickers)</h3>
          <form id="fl" class="form-grid">
            <label class="field">Printer type<select class="input" name="label_mode">${options([['roll', 'Label printer (roll of stickers)'], ['a4', 'Normal printer (A4 sticker sheet)']], S.label_mode)}</select></label>
            <label class="field">Labels across (A4 only)<input class="input num" name="label_columns" value="${esc(S.label_columns)}" inputmode="numeric"></label>
            <label class="field">Sticker width (mm)<input class="input num" name="label_width" value="${esc(S.label_width)}" inputmode="numeric"></label>
            <label class="field">Sticker height (mm)<input class="input num" name="label_height" value="${esc(S.label_height)}" inputmode="numeric"></label>
            <label class="check"><input type="checkbox" name="label_show_name" ${S.label_show_name !== '0' ? 'checked' : ''}> Show item name</label>
            <label class="check"><input type="checkbox" name="label_show_price" ${S.label_show_price !== '0' ? 'checked' : ''}> Show price</label>
            <div class="full" id="lprev"></div>
            <div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Save for this computer</button>
              <button type="button" class="btn" id="testLbl">${icon('printer')} Print test label</button></div></form>
          <div class="hint" style="margin-top:8px">Common sizes: 50×25, 38×25, 40×30 mm. Measure one sticker, not the roll.</div>
          <div id="lbOk" style="margin-top:12px"></div>
          <details><summary>Steps, driver and fixes for the label printer</summary>
            <ol class="steps">
              <li>Plug the printer in (USB), switch it on, load the label roll, close the cover.</li>
              <li>Install its Windows driver (see the table below). Black Copper BC-LP1300 uses the Xprinter driver: choose <b>Xprinter XP-420B</b> and its USB port.</li>
              <li>Printer preferences: paper = your <b>sticker size</b>, type = <b>labels with gaps</b>. Then <b>calibrate</b> (hold Feed a few seconds, it feeds a few labels).</li>
              <li>Type the same width and height here, press <b>Save</b> and <b>Print test label</b>. In the print window choose the label printer, Margins: None, Scale: Default.</li>
              <li>Scan the test label in the scanner box above: it shows <b>10000001</b>.</li>
              <li>Pale or grey bars: raise darkness, lower speed in the printer preferences.</li>
            </ol></details>
        </div>
      </div>

      <div class="card"><h3>4. Drivers</h3>
        <p class="muted small" style="margin-top:0">Download only these files. After downloading, check the file with the SHA-256 command (copy it below): the result must match exactly, otherwise delete the file.</p>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>For</th><th>Model</th><th>File</th><th>How</th></tr></thead><tbody>
          ${HW_DRIVERS.map((d) => `<tr><td><b>${esc(d.what)}</b></td><td>${esc(d.model)}</td>
            <td><a href="${esc(d.page)}" target="_blank" rel="noopener">${esc(d.file)}</a><div class="muted small">version ${esc(d.ver)} · ${esc(d.size)}</div>
              <div class="mono small" style="word-break:break-all">SHA-256: ${esc(d.sha)}</div></td><td class="small">${esc(d.how)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="muted small" style="margin-bottom:0">Another model? Look for the driver on the maker's own website or the CD that came with it, and print a Windows test page before trying Velanzo.</p>
      </div>

      <div class="card"><h3>5. Windows tools (for this computer)</h3>
        <p class="muted small" style="margin-top:0">Double-click the downloaded file. If Chrome or Windows warns about a .bat file, choose <b>Keep</b> and <b>Run anyway</b>: it is only a list of instructions you can open in Notepad.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <button class="btn primary" id="dlCheck">${icon('download')} Check this computer</button>
          <button class="btn" id="dlFix">${icon('download')} Fix printing</button></div>
        <ul class="muted small" style="margin:6px 0 12px"><li><b>Check this computer</b> only <u>reads</u>: printers, drivers, USB ports, default printer, stuck jobs, errors of the last 24 hours. It tells you what to do and saves a report on the Desktop.</li>
          <li><b>Fix printing</b> asks before each change: clear stuck jobs, put a printer on its real USB port, choose the default printer. It asks for administrator permission.</li></ul>
        <label class="field">Paste the report here (Desktop → Velanzo-hardware-report.txt)<textarea class="input" id="rep" rows="3" placeholder="Paste the report text here…"></textarea></label>
        <div style="margin-top:8px"><button class="btn" id="readRep">Read the report</button></div>
        <div id="repOut" style="margin-top:12px"></div>
        <details style="margin-top:10px"><summary>Commands you can paste in PowerShell yourself</summary>
          <p class="muted small">Windows key → type <b>PowerShell</b> → open it (for changes: right-click → Run as administrator). Replace <b>PRINTER NAME</b> with the name from the first command.</p>
          ${HW_COMMANDS.map(([what, cmd]) => `<div class="cmd-row"><div class="small">${esc(what)}</div><div class="code-line mono small">${esc(cmd)}</div>${copyBtn(cmd)}</div>`).join('')}
        </details>
      </div>

      <div class="card"><h3>6. If something is wrong</h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>What you see</th><th>Why</th><th>What to do</th></tr></thead><tbody>
          ${HW_FIXES.map(([a, b, c]) => `<tr><td><b>${esc(a)}</b></td><td class="small">${esc(b)}</td><td class="small">${esc(c)}</td></tr>`).join('')}
        </tbody></table></div>
      </div>

      <div class="card"><h3>7. Other paper (dispatch notes)</h3>
        <form id="fd" class="form-grid"><label class="field">Dispatch notes print on<select class="input" name="dispatch_paper">${options([['a4', 'A4 paper (normal printer)'], ['receipt', 'The receipt printer']], S.dispatch_paper)}</select></label>
          <div class="full"><button class="btn primary">Save for this computer</button></div></form></div>`;

    // ---- scanner test ----
    const sT = $('#scanTest', el), sR = $('#scanRes', el);
    let times = [], idle = null;
    const report = async (endKey) => {
      clearTimeout(idle);
      const code = sT.value.trim();
      const n = times.length;
      const avg = n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 0;
      times = [];
      if (!code) return;
      let item = null;
      try { item = await GET('/api/products/lookup', { code }); } catch { /* not an item */ }
      const fast = n >= 6 && avg <= Scanner.AVG;
      const rows = [
        ['Received', `<b class="mono">${esc(code)}</b> (${code.length} characters)`],
        ['Speed', `${Math.round(avg)} ms between characters: ${fast ? pill('ok', 'a scanner ✓') : n < 6 ? pill('warn', 'too short to tell') : pill('warn', 'as slow as typing')}`],
        ['Ends with', endKey ? pill('ok', esc(endKey) + ' ✓') : pill('red', 'nothing')],
        ['Item', item ? `${pill('ok', '✓')} ${esc(pname(item))} · ${money(item.sale_price)}` : '<span class="muted">not an item in Velanzo (fine for a test)</span>'],
      ];
      const tips = [];
      if (!endKey) tips.push('The scanner does not press Enter after the code. In its manual, scan the setting barcode <b>"Add Enter / CR suffix"</b>.');
      if (n >= 6 && !fast) tips.push('This is as slow as a person typing. It still works in the scan box. In the scanner\'s manual choose a faster <b>USB keyboard speed</b>.');
      if (/[^\x20-\x7e]/.test(code)) tips.push('Strange characters arrived: Windows keyboard to <b>English (US)</b>.');
      if (endKey && n >= 4) HwState.set({ scanner_at: nowStr(), scanner_code: code });
      sR.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${tips.map((t) => `<div class="alert" style="margin:10px 0 0">${t}</div>`).join('')}`;
      sT.value = '';
    };
    sT.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); report(e.key); return; }
      if (e.key.length === 1) { times.push(performance.now()); clearTimeout(idle); idle = setTimeout(() => report(''), 600); }
    });

    // ---- printer settings (kept on this computer) ----
    const lvals = () => { const v = formValues($('#fl', el)); v.label_show_name = v.label_show_name ? '1' : '0'; v.label_show_price = v.label_show_price ? '1' : '0'; return v; };
    const withForm = (vals, fn) => { const old = App.settings; App.settings = { ...old, ...vals }; try { fn(); } finally { App.settings = old; } };
    const preview = () => withForm(lvals(), () => { $('#lprev', el).innerHTML = labelPreviewHtml(sample); });
    preview();
    $('#fl', el).addEventListener('input', preview);
    const saveForm = (form, vals) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.target.querySelector('button.primary'), async () => { await savePrintSettings(vals()); toast('Saved on this computer'); });
    });
    saveForm($('#fb', el), () => formValues($('#fb', el)));
    saveForm($('#fl', el), lvals);
    saveForm($('#fd', el), () => formValues($('#fd', el)));
    $('#testBill', el).addEventListener('click', () => withForm(formValues($('#fb', el)), () => printBill({
      bill_no: 'TEST-00001', created_at: nowStr(), location_name: shops()[0]?.name || 'Shop', user_name: App.user.name, status: 'done',
      items: [{ ...sample, qty: 2, price: 2450 }, { name: 'Cotton Shirt', size: 'L', color: 'White', barcode: '10000002', qty: 1, price: 1800 }],
      subtotal: 6700, discount: 200, total: 6500, paid: 7000, change_due: 500, payment_method: 'cash' })));
    $('#ruler', el).addEventListener('click', () => withForm(formValues($('#fb', el)), printRuler));
    $('#testLbl', el).addEventListener('click', () => withForm(lvals(), () => printLabels([{ product: sample, copies: 1 }])));

    // "did it print right?" confirmations
    const confirmBlock = (id, key, what) => {
      const box = $(id, el);
      const paint = () => {
        const at = HwState.get()[key];
        box.innerHTML = at ? `${pill('ok', '✓ ' + what + ' confirmed ' + esc(since(at)))} <a href="#" data-undo>not right any more</a>`
          : `<span class="muted small">After the test: did it print correctly?</span> <button type="button" class="btn sm" data-yes>Yes, it printed correctly</button>`;
        $('[data-yes]', box)?.addEventListener('click', () => { HwState.set({ [key]: nowStr() }); router(); });
        $('[data-undo]', box)?.addEventListener('click', (e) => { e.preventDefault(); HwState.set({ [key]: '' }); router(); });
      };
      paint();
    };
    confirmBlock('#rcOk', 'receipt_ok_at', 'Receipt printer');
    confirmBlock('#lbOk', 'label_ok_at', 'Label printer');

    // ---- Windows tools ----
    $('#dlCheck', el).addEventListener('click', () => saveFile({ name: 'Velanzo-check-this-computer.bat', type: 'application/octet-stream', content: HwScripts.checkBat() }));
    $('#dlFix', el).addEventListener('click', () => saveFile({ name: 'Velanzo-fix-printing.bat', type: 'application/octet-stream', content: HwScripts.fixBat() }));
    $('#readRep', el).addEventListener('click', () => {
      const lines = $('#rep', el).value.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^(OK|FIX|WARN|INFO):/.test(x));
      if (!lines.length) { $('#repOut', el).innerHTML = '<div class="muted small">Nothing to read. Paste the whole text of Velanzo-hardware-report.txt.</div>'; return; }
      const cls = { OK: 'ok', FIX: 'red', WARN: 'warn', INFO: '' };
      const count = (l) => lines.filter((x) => x.startsWith(l)).length;
      $('#repOut', el).innerHTML = `<div class="small" style="margin-bottom:8px">${count('FIX') ? pill('red', count('FIX') + ' to fix') : pill('ok', 'nothing to fix')} ${count('WARN') ? pill('warn', count('WARN') + ' to look at') : ''} ${pill('ok', count('OK') + ' fine')}</div>
        ${[...lines.filter((x) => x.startsWith('FIX')), ...lines.filter((x) => x.startsWith('WARN')), ...lines.filter((x) => x.startsWith('OK')), ...lines.filter((x) => x.startsWith('INFO'))].map((x) => {
          const [lvl, ...rest] = x.split(':');
          return `<div class="rep-row"><span class="pill ${cls[lvl]}">${esc(lvl)}</span> <span>${esc(rest.join(':').trim())}</span></div>`;
        }).join('')}`;
    });
    bindCopy(el);
  },
});

// ---------- Print queue: what this computer sent to its printers ----------
View('hardware/queue', {
  title: 'Print queue',
  nav: 'settings',
  async render({ el }) {
    const QUEUES = [['receipt', 'Receipt printer', 'printer', 'Bills and dispatch receipts'], ['label', 'Barcode label printer', 'tag', 'Barcode labels'], ['paper', 'Other paper (A4)', 'file', 'Dispatch notes on A4']];
    const paint = () => {
      const all = PrintLog.all();
      const today = todayStr();
      el.innerHTML = `${hwTabsHtml('queue')}
        <div class="alert info">This list is what <b>this computer</b> sent to its printers. Velanzo cannot see inside the printer: "Sent to Windows" means the print went out. If nothing came out on paper, press <b>Print again</b>, or use the Windows tools on the <a href="#/hardware">Hardware</a> page (they show the real Windows queue and fix stuck jobs).</div>
        <div class="toolbar no-print"><button class="btn" id="rePrintBill">${icon('printer')} Print last bill again</button>
          <a class="btn" href="#/hardware">Printer settings &amp; tests</a>
          <button class="btn" id="dlCheck">${icon('download')} Check Windows queue</button>
          <button class="btn" id="dlFix">${icon('download')} Clear stuck jobs / fix port</button></div>
        <div class="grid-2">${QUEUES.slice(0, 2).map(([q, name, ic, sub]) => section(all, q, name, ic, sub, today)).join('')}</div>
        <div style="margin-top:16px">${section(all, 'paper', QUEUES[2][1], QUEUES[2][2], QUEUES[2][3], today)}</div>`;
      $('#dlCheck', el).addEventListener('click', () => saveFile({ name: 'Velanzo-check-this-computer.bat', type: 'application/octet-stream', content: HwScripts.checkBat() }));
      $('#dlFix', el).addEventListener('click', () => saveFile({ name: 'Velanzo-fix-printing.bat', type: 'application/octet-stream', content: HwScripts.fixBat() }));
      $('#rePrintBill', el).addEventListener('click', () => { const e = all.find((x) => x.queue === 'receipt' && x.body && !/^Ruler/.test(x.title)); if (!e) return toast('No bill to print again yet', 'error'); again(e.id); });
    };
    el.addEventListener('click', (ev) => {
      const r = ev.target.closest('[data-again]'), d = ev.target.closest('[data-del]'), c = ev.target.closest('[data-clear]');
      if (r) again(+r.dataset.again);
      if (d) { PrintLog.remove(+d.dataset.del); paint(); }
      if (c) { PrintLog.clear(c.dataset.clear); paint(); }
    });
    function section(all, q, name, ic, sub, today) {
      const list = all.filter((e) => e.queue === q);
      const todayN = list.filter((e) => e.at.slice(0, 10) === today).length;
      return `<div class="card flush"><div class="card-head pad"><h3>${icon(ic)} ${esc(name)}</h3><div class="actions"><span class="muted small">${todayN} today</span>${list.length ? `<button class="btn sm" data-clear="${q}">Clear list</button>` : ''}</div></div>
        <div class="muted small" style="padding:0 18px 8px">${esc(sub)}</div>
        ${list.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>What</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>
          ${list.slice(0, 25).map((e) => `<tr><td class="nowrap">${esc(fmtTime(e.at))}<div class="muted small">${esc(fmtDate(e.at))}</div></td>
            <td><b>${esc(e.title)}</b>${/^(TEST-|Ruler)/.test(e.title) ? ' <span class="pill blue">test</span>' : ''}${e.reprint ? ' <span class="pill">again</span>' : ''}${e.pages > 1 ? `<div class="muted small">${e.pages} labels</div>` : ''}</td>
            <td class="small">${esc(e.user)}</td>
            <td>${e.status === 'sent' ? '<span class="pill ok">Sent to Windows</span>' : e.status === 'failed' ? `<span class="pill red" title="${esc(e.error || '')}">Failed</span>` : '<span class="pill warn">Sending…</span>'}</td>
            <td class="r nowrap">${e.body ? `<button class="btn sm" data-again="${e.id}">Print again</button>` : `<span class="muted small" title="Too big to keep">${e.big ? 'too big' : 'old'}</span>`} <button class="icon-btn" data-del="${e.id}" title="Remove from the list">✕</button></td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Nothing printed from this computer yet.</div>'}</div>`;
    }
    function again(id) {
      const e = PrintLog.all().find((x) => x.id === id);
      if (!e || !e.body) return toast('This one is not kept any more', 'error');
      printDoc(e.body, e.css, e.title, e.kind, e.pageSize, { reprint: true });
      toast('Sent to the printer again');
      setTimeout(() => { if (el.isConnected) paint(); }, 1500);
    }
    paint();
    const timer = setInterval(() => { if (!el.isConnected) return clearInterval(timer); if (!document.hidden && !document.querySelector('.modal-wrap')) paint(); }, 5000);
    onCleanup(() => clearInterval(timer));
  },
});
