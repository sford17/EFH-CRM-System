# Going live on Fly.io (Sydney)

This guide moves the CRM from your PC to a small server in Fly.io's **Sydney** data centre, at an https web address like `https://efh-crm-yourname.fly.dev`. Once it's live:

- It runs 24/7: newsletters on the 20th, reminders, automations and backups happen even when your PC is off.
- You and your team sign in from anywhere, on any computer or phone.
- Clients can open their fact-find links.
- **Updates go live when you approve them on GitHub.** The tests run first, and your data is backed up before any database change.

**Time:** about an hour, once. **Cost:** about US$6–10 a month for Fly.io (a small always-on server with 1 GB of memory, plus 1 GB of storage). The daily server snapshots fit in Fly's free 10 GB. See the cost notes at the end.

> **Before you start:** set up two-factor sign-in for yourself on your current CRM (Settings → Two-factor sign-in). It moves across with your data.

---

## Part A – Fly.io account and server (about 20 minutes)

1. **Create a Fly.io account** at <https://fly.io> (Sign up) and add a payment card under **Billing**.

2. **Install Fly's command tool on Windows.** Click Start, type **PowerShell**, open it, paste this line and press Enter:

   ```
   iwr https://fly.io/install.ps1 -useb | iex
   ```

   Close PowerShell and open it again, then check it worked:

   ```
   fly version
   ```

3. **Sign in to Fly** from PowerShell (a browser window opens to confirm):

   ```
   fly auth login
   ```

4. **Choose your app's name.** Use lowercase letters, numbers and dashes, e.g. `efh-crm-ford`. It becomes your web address: `https://efh-crm-ford.fly.dev`. In the commands below, replace **`YOUR-APP-NAME`** with your choice.

5. **Create the app:**

   ```
   fly apps create YOUR-APP-NAME
   ```

   If it says the name is taken, pick another.

6. **Create the storage for your data in Sydney** (1 GB is plenty to start with):

   ```
   fly volumes create crm_data --region syd --size 1 --app YOUR-APP-NAME
   ```

   If it warns that a single volume has no redundancy, type **y**. Your data is still protected by the CRM's own backups and Fly's daily snapshots.

7. **Create a key so GitHub can update the app:**

   ```
   fly tokens create deploy --app YOUR-APP-NAME
   ```

   Copy **everything** it prints, starting with `FlyV1`. You'll paste it in the next part. Keep it private.

## Part B – Connect GitHub (about 10 minutes)

8. Open your repository on GitHub: <https://github.com/sford17/EFH-CRM-System>
   1. Go to **Settings → Secrets and variables → Actions**.
   2. **Secrets** tab → **New repository secret**. Name: `FLY_API_TOKEN`. Secret: paste the key from step 7. Click **Add secret**.
   3. **Variables** tab → **New repository variable**. Name: `FLY_APP_NAME`. Value: your app name. Click **Add variable**.

9. **Create the "live" branch, which starts the first deployment.**
   1. Go to the repository's **Code** tab.
   2. Click the branch menu (it shows `claude/mortgage-crm-system-1fo26s`), type **`main`**, and click **Create branch main from claude/mortgage-crm-system-1fo26s**.

10. Open the **Actions** tab and click the running **Deploy to Fly.io**. The tests run first (about 2 minutes), then the CRM is built and started in Sydney (about 3–5 minutes). A green tick means it's live.

    Open `https://YOUR-APP-NAME.fly.dev` and you'll see the set-up screen.

## Part C – Move your data across (about 10 minutes)

11. On the **live** CRM's set-up screen, create a **temporary** administrator, e.g. `temp@example.com` with any password. It's replaced in step 13.

12. On your **current CRM (on your PC)**:
    1. Go to **Settings → Backups** and click **Back up now**.
    2. Open the backup folder shown on that card (by default `data\backups` inside the CRM folder). The newest folder holds `crm.db` and `secret.key`.

13. On the **live** CRM:
    1. Go to **Settings → Backups → Restore from a backup**.
    2. Choose `crm.db` and `secret.key` from that folder, click **Restore this backup** and type `RESTORE`.
    3. Sign in with your **usual** email and password (and your authenticator code).

    Your clients, deals, documents, settings and saved connections are all there now.

14. **Stop the CRM on your PC for good.** Close its black window and don't run `npm start` there again. Otherwise both copies would send emails, texts and newsletters twice. Keep that folder for a few weeks as an extra copy, then delete it.

## Part D – Finish setting up the live CRM (about 15 minutes)

15. **Settings → Business → CRM web address:** enter `https://YOUR-APP-NAME.fly.dev` and save. This is used for fact-find links, reminders and one-click unsubscribe.

16. **Settings → Two-factor sign-in:** tick **Require two-factor sign-in for everyone**.

17. **Reconnect the services that sign you in through a web page.** Their "return address" changed.
    - **Outlook / Microsoft 365:**
      1. In the Microsoft Entra admin centre (Azure portal), open **App registrations →** your CRM app **→ Authentication**.
      2. Add the redirect URI `https://YOUR-APP-NAME.fly.dev/api/outlook/callback` and save.
      3. Each person then goes to **Settings → Outlook** and connects again.
    - **LinkedIn / Instagram** (if used):
      1. In each developer app, add the redirect URL `https://YOUR-APP-NAME.fly.dev/api/social/callback/linkedin` (or `/instagram`).
      2. Reconnect on the **Social** page.
    - **No change needed:** ClickSend, Calendly, Adobe Sign, Quickli and the Anthropic (AI) key. They moved across with your data.

18. **Backups on the server:**
    - The nightly backup now runs on the server, and Fly takes daily snapshots of the storage.
    - Once a month, also download the newest backup's `crm.db` and `secret.key` (**Settings → Backups**) into your OneDrive, so there's always a copy away from Fly.

19. **Optional:** switch on the **"Fact Find stage: send the online fact find"** automation (**Automations**), now that clients can open the links.

You're live. 🎉

---

## Updates from now on

1. I build and test the change on the working branch, then open a **pull request** into `main`.
2. You click **Merge pull request** on GitHub.
3. GitHub runs all the tests and, if they pass, updates the live CRM. If any test fails, nothing changes.
4. The CRM restarts in under a minute. If the update changes the database, a backup is made first.

There's no more downloading ZIPs or running `npm` on your PC.

## Your own web address (optional)

To use something like `crm.yourbusiness.com.au` instead of `.fly.dev`:

1. In PowerShell:
   ```
   fly certs add crm.yourbusiness.com.au --app YOUR-APP-NAME
   ```
2. Add the DNS records it shows at your domain provider (usually one `CNAME`). The https certificate is issued automatically, usually within minutes.
3. Update **Settings → Business → CRM web address**, and the Outlook, LinkedIn and Instagram redirect addresses from step 17.

## If something goes wrong

- **See what the server is doing:** `fly logs --app YOUR-APP-NAME`
- **Is it running?** `fly status --app YOUR-APP-NAME`
- **Restart it:** `fly apps restart YOUR-APP-NAME`
- **A deployment failed:** open the red ✗ in GitHub's **Actions** tab. The live CRM keeps running the previous version. Send me a screenshot.
- **Restoring an older backup:** **Settings → Backups → Restore from a backup**. For a Fly snapshot, use `fly volumes snapshots list` and ask me for help.

## Costs

| | Approximate monthly cost |
|---|---|
| Fly.io server (shared CPU, 1 GB memory, always on, Sydney) | US$6–9 |
| Fly.io storage (1 GB) | US$0.15 |
| Fly.io daily snapshots | Free (first 10 GB) |
| Web address | Free with `.fly.dev`; a domain is about A$20–40 a year if you want your own |
| Anthropic (AI) and ClickSend (SMS) | As now. See **Reports → Running costs** |

Fly bills monthly to your card. You can see current charges in Fly's dashboard under **Billing**.
