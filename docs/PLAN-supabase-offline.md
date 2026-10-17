# Plan: website on GitHub Pages + Supabase, works offline

The user agreed this on 2026-10-16 and it was built the same day. Only connecting the real accounts is left (step 7).

## Agreed with the user
- Velanzo becomes a public website on GitHub Pages (free, public repo) and can be installed from Chrome. Phones work too. No .exe.
- Data, logins and access rules live in Supabase. No PC needs to stay on.
- Everything works offline (selling, returns, purchases, dispatch, receiving, corrections) and syncs when the internet is back. Reports, item history and settings may need internet.
- Settings → Shops has switches for what each place may do:
  - Selling: sell, returns, discounts, change prices.
  - Stock: receive, buy from suppliers, send stock, add items and labels, correct stock.
  - Money: expenses, see cost and profit.
  - Proposed extra switch: cancel bills.
- Each user has their own switches, which can only narrow what their shop allows. The warehouse is just a place with buying and sending switched on. The owner can do everything.
- Simpler screens, as in the approved mockups:
  - Sell screen with a big scan box, total and "Done — print bill".
  - Warehouse home with four tiles.
  - Owner home with three numbers, a live card per place and a "Latest" list.
  - Login: tap your name and type a 4-digit PIN.
- Printing shows the print window. A Chrome `--kiosk-printing` shortcut on counter PCs skips it.

## How it will work (technical)
**The app logic runs in the browser.**
- Port `src/` (db helpers + routes) to ES modules: the "engine".
- In the browser it runs in a Web Worker on SQLite WASM (`@sqlite.org/sqlite-wasm`, `opfs-sahpool` VFS, which needs no COOP/COEP headers).
- In Node tests it runs on `node:sqlite`.
- The page's `api(method, url, body)` sends messages to the worker instead of using `fetch`, so most views keep working.
- Downloads come back as `{filename, content}` blobs.
- Ask for `navigator.storage.persist()`. OPFS allows only one tab, so show "already open in another tab".

**IDs stay integers but are unique worldwide.**
- `id = deviceNo * 1e9 + counter`. Old data (ids < 1e9) keeps its ids, so old backups restore unchanged.
- Device 1 is reserved for rows the server creates.
- Each device has a code letter used in numbers: bill `S1-A00042`, purchase `P-A00004`, dispatch `D-A00003`.
- New barcodes: `2` + 2-digit device number + 5-digit counter.

**Local sync tables.**
- `outbox` (filled by triggers on synced tables, grouped per action) and `sync_state` (cursor, device, an "applying pull" flag).
- Counters become per device and are no longer backed up.

**Supabase side (`supabase/migrations/*.sql`).**
- The same tables plus `rev bigint` (from one global sequence, set by trigger) and `updated_at`.
- RLS is on with no policies. All access goes through `security definer` RPCs.
- `push(device_id, user_id, groups)`:
  - Takes `pg_advisory_xact_lock(1)` so revs commit in order and pulls never miss rows.
  - Validates each row: owner-only tables; the device's place must match on both new and existing rows; the switch must allow it; non-owners may update only allowed columns; movements are insert-only.
  - Fills `sale_items.cost` and `dispatch_items.cost` from the product.
  - Works out `stock` as the sum of movements.
  - Idempotent; each group runs in its own savepoint and returns per-group results.
- `pull(device_id, since, limit)` returns `(tbl, rev, row)` for what the device may see:
  - Shop devices get their place's rows and stock everywhere.
  - Purchases and suppliers only go to places allowed to buy.
  - Cost columns are removed unless the place may see cost.
  - Owner devices get everything.
- Other RPCs: `create_owner` (only when no owner exists), `register_owner_device`, `create_setup_code(location)` (owner, valid 24 h, hashed, limited attempts), `claim_device(code)`, `remove_device`, and a restore wipe for the owner.

**Logins.**
- The owner signs in with email + password (Supabase Auth). Each owner browser registers as a device.
- Shop and warehouse devices are set up with the owner's setup code using an anonymous Supabase sign-in, so no owner password is typed at a shop.
- The PIN is checked on the device (PBKDF2 hash, also works offline) and records who did what.
- The security boundary is the device: on a shop device even the owner's PIN is limited by that shop's switches.

**Presence and the owner's live view.**
- Push and pull update `devices.last_seen_at` / `last_user_id` at most once a minute.
- The owner device pulls about every 15 s. The existing Activity and dashboard SQL runs locally.

**Backups.**
- The owner device builds the same JSON format locally, uploads one a day to Supabase Storage (keeping 60) and offers "Download backup".
- Restore and old backups (int ids, roles admin/warehouse/shop → staff) are owner-only and online.

**Testing without accounts.** PGlite (with a stub `auth.uid()`) for the SQL, plus a small fake Supabase gateway for end-to-end tests. Docker and the GitHub CLI are not installed.

**Publishing.** The static site goes in `web/` and a GitHub Actions workflow deploys it to Pages. Supabase URL + anon key go in `web/config.js` (they are public by design).

## Steps
1. [x] Engine ported (ESM, adapter, global ids, device numbering, switch-based permissions) — `tools/test-engine.mjs`, 59 checks.
2. [x] Supabase SQL: tables, push/pull, device and owner RPCs — `tools/test-sync.mjs` (3 devices on PGlite), 54 checks.
3. [x] Browser: SQLite worker (OPFS), outbox, sync loop, "waiting / saved online" pill.
4. [x] Device setup (owner sign-in, setup codes), PIN login, Settings → Shops/People switches, Settings → Devices, This device.
5. [x] Simpler screens per the mockups (top bar, Sell, owner home, warehouse home).
6. [x] Installable app (manifest + service worker) and the GitHub Pages workflow (`.github/workflows/pages.yml`).
7. [ ] **Waiting for the user:** create GitHub + Supabase accounts and connect them — step by step in `docs/SETUP-CLOUD.md`.
8. [x] Data move (restore old backups; a no-cloud computer can join the cloud with its data), new user guide + PDF, old server/desktop removed.

Browser tests (preview running): `tools/test-browser.mjs` (offline selling, reopening offline, syncing after), `tools/test-local-to-cloud.mjs`.
