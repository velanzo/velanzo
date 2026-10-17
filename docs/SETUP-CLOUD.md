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
   - Then do the same with the second file, `supabase/migrations/20261017000000_owner_lock_and_pin_reset.sql` (new query, paste, **Run**). It makes sure only **one approved email** can ever become the owner, and adds forgotten-PIN approval.
   - Now say which email is the owner's. New query, with the owner's real email (the one that will receive the emails):

     ```sql
     insert into owner_allow (email) values ('owner@example.com');
     ```

     Until you do this, **nobody** can create the owner account. Don't put this email in the code or on GitHub (the repository is public) — run it only in Supabase.
4. Left menu: **Authentication → Sign In / Providers**.
   - Switch on **Allow anonymous sign-ins**. Shop and warehouse computers use this together with the owner's one-time code.
   - Keep **Email** on, and **keep Confirm email ON**. The owner proves the email is theirs by clicking the link we send; that is what makes the owner lock safe.
   - **Authentication → URL Configuration:** set **Site URL** to the website address (e.g. `https://yourname.github.io/velanzo/`) and add the same address to **Redirect URLs**. The links in emails come back to this address.
   - **Authentication → Email Templates → Magic Link:** change it so the owner knows what they are approving. For example, subject *Velanzo: someone forgot their PIN*, and message: *Someone asked for a new PIN in Velanzo. Open this link and press Approve only if you know who is asking: {{ .ConfirmationURL }}*
5. Left menu: **Project Settings → API** (or **Data API**). Copy two things:
   - the **Project URL** (looks like `https://abcdxyz.supabase.co`),
   - the **anon public** key (or the **publishable** key, starting with `sb_publishable_`).

   These two are safe to publish. The database checks every change itself.

> **Emails must really arrive.** The owner's email receives the confirmation link, password links and PIN approvals. Supabase's built-in mail sender is for testing: it only sends to the people on your Supabase team, a few per hour. Do one of these:
> - **Simple:** Supabase → *Organization → Team → Invite* the owner's email as a member (free), or
> - **Better for the long run:** *Authentication → Emails → SMTP Settings* and use a real mail account (for example Gmail with an app password, or Resend).
>
> Test it before relying on it: sign up, and check that the confirmation email comes.

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

1. Open the address in Chrome or Edge, choose **I'm the owner → New business? Create an owner account**, type the owner's email and a password. Open the email we send, click the link, then sign in and follow the screens (user guide, chapter 2).
2. Add your shops, people and their PINs, then connect each shop and warehouse computer with a code (**Settings → Devices → Add a computer**).
3. On each computer: Chrome menu ⋮ → **Install Velanzo**.

## C2. If someone forgets something

- **A shop or warehouse person forgot their PIN.** On the PIN screen they tap **Forgot your PIN?**. A link goes to the owner's email. The owner opens it (on any phone or computer) and presses **Approve**. The person's screen continues by itself and they choose a new PIN. The owner never sees the PIN. (The owner can also set a new PIN directly in **Settings → People**.)
- **The owner forgot their PIN.** Same: **Forgot your PIN?** on the owner's own computer or phone; the link goes to the owner's email.
- **The owner forgot the password.** Owner sign-in → **Forgot your password?** → a link to the owner's email → choose a new password.
- **The owner's email is lost or no longer works.** In Supabase: *Authentication → Users*, find the owner, and choose *Send password recovery* or set the account's email. If that is not possible either, whoever runs the Supabase project can approve a new owner email: run `delete from owners;` and `insert into owner_allow (email) values ('new@example.com');` in the SQL Editor, then that email creates the owner account (**the shop data stays**; the new owner then signs in on a computer and restores a recent backup if people are missing). Keep the Supabase login safe — it can do this.

## D. Bringing existing data

- **A backup file from the old version:** owner device → **Settings → Backup & data → Restore**. Then give everyone a PIN (**Settings → People**).
- **A computer that already used Velanzo without the cloud** (its `config.js` was empty): sign in there as the owner (**This device → Connect**). Its data is sent up. This only works into an empty cloud.

## E. Good to know

- **Security.** The website and its code are public. Your data is not: devices can only reach it through the database functions, which check the device, the shop's switches and the person's switches.
  - Only the approved owner email can become the owner; only the owner can create shops, warehouses, people and computer codes (a shop computer that tries is refused by the database).
  - Anyone can open the website, but without a one-time code from the owner it shows nothing.
  - Keep the owner's email password and the Supabase login private.
  - Remove lost devices in **Settings → Devices**.
- **Updates.** Change the files and push to `main`; GitHub tests and publishes them. Devices update the next time they open with internet.
- **A new database rule.** Run each new file in `supabase/migrations/` once, in order, in the SQL Editor.
- **Your own address** (e.g. `pos.yourshop.com`) is possible in GitHub → Settings → Pages → *Custom domain*.
