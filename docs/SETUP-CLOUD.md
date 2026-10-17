# Connecting Velanzo to your own Supabase and GitHub

Do this once, about 20 minutes. Afterwards every shop, the warehouse and your phone use Velanzo at one web address, with the data in your Supabase account. Make both accounts with the **business owner's email**, so the business owns them.

You need: this project folder, a computer with Chrome, and the owner's email.

## A. Supabase — the cloud database (about 10 minutes)

1. Go to <https://supabase.com>, **Start your project**, and sign up.
2. **New project**:
   - Name: `velanzo`.
   - Database password: click **Generate**, then keep it somewhere safe. Velanzo itself doesn't need it.
   - Region: the one closest to the shops (for Pakistan: *Mumbai* or *Singapore*).
   - Click **Create** and wait about a minute.
3. Left menu: **SQL Editor → New query**.
   - Open `supabase/migrations/20261016000000_velanzo.sql` from this folder in Notepad, copy all of it, and paste it into the query box.
   - Click **Run**. It should say *Success. No rows returned*.
4. Left menu: **Authentication → Sign In / Providers**.
   - Switch on **Allow anonymous sign-ins**. Shop and warehouse computers use this together with the owner's one-time code.
   - Keep **Email** on.
   - Optional: switch off **Confirm email**, so the owner account works without clicking an email link.
5. Left menu: **Project Settings → API** (or **Data API**). Copy two things:
   - the **Project URL** (looks like `https://abcdxyz.supabase.co`),
   - the **anon public** key (or the **publishable** key, starting with `sb_publishable_`).

   These two are safe to publish. The database checks every change itself.

> **Free plan:** enough for years of a clothing business. A free project goes to sleep after **7 days without use**. Normal daily use keeps it awake; if it sleeps, open supabase.com and click *Restore*. The paid plan (about US$25/month) never sleeps and adds Supabase's own daily backups. Either way, download a Velanzo backup now and then (**Settings → Backup & data**).

## B. GitHub — the website (about 10 minutes)

1. Go to <https://github.com>, **Sign up**.
2. **New repository**: name `velanzo`, **Public**, then **Create repository**.
3. Put this folder in it. The easiest way is **GitHub Desktop** (<https://desktop.github.com>):
   1. *File → Add local repository* → choose this folder → *create a repository* if it asks.
   2. *Publish repository* to the `velanzo` repository.

   The files that must stay private (`node_modules`, `.dev-cloud`) are already excluded.
4. In GitHub, open the repository → **Settings → Pages** → under *Build and deployment*, set **Source: GitHub Actions**.
5. Open `web/config.js` (in GitHub: click it → ✏️ *Edit*), paste the two values from A5, and **Commit changes**:

   ```js
   window.VELANZO_CONFIG = {
     supabaseUrl: 'https://abcdxyz.supabase.co',
     supabaseAnonKey: 'eyJhbGciOi… or sb_publishable_…',
   };
   ```
6. Open the **Actions** tab. *Publish Velanzo* runs the tests and publishes the site, which takes about 2 minutes. When it's green, the address is shown there, e.g. **https://yourname.github.io/velanzo/**.

## C. First use

1. Open the address in Chrome or Edge, choose **I'm the owner → New business? Create an owner account**, and follow the screens (user guide, chapter 2).
2. Add your shops, people and their PINs, then connect each shop and warehouse computer with a code (**Settings → Devices → Add a computer**).
3. On each computer: Chrome menu ⋮ → **Install Velanzo**.

## D. Bringing existing data

- **A backup file from the old version:** owner device → **Settings → Backup & data → Restore**. Then give everyone a PIN (**Settings → People**).
- **A computer that already used Velanzo without the cloud** (its `config.js` was empty): sign in there as the owner (**This device → Connect**). Its data is sent up. This only works into an empty cloud.

## E. Good to know

- **Security.** The website and its code are public. Your data is not: devices can only reach it through the database functions, which check the device, the shop's switches and the person's switches.
  - Keep the owner's email and password private.
  - Remove lost devices in **Settings → Devices**.
- **Updates.** Change the files and push to `main`; GitHub tests and publishes them. Devices update the next time they open with internet.
- **A new database rule.** Run each new file in `supabase/migrations/` once, in order, in the SQL Editor.
- **Your own address** (e.g. `pos.yourshop.com`) is possible in GitHub → Settings → Pages → *Custom domain*.
