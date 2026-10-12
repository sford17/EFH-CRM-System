# EFH CRM

A CRM built for a mortgage broking business. It tracks leads, clients and loans from first enquiry through settlement, and automates the follow-ups that keep a broking pipeline moving: welcome emails, document chasing, pre-approval and finance-date warnings, settlement tasks, fixed-rate expiry reviews, birthdays and annual reviews.

## Features

| Area | What it does |
| --- | --- |
| **Dashboard** | Open pipeline, settlements against a monthly target, commission, overdue tasks, upcoming finance/settlement/expiry dates, recent activity |
| **Contacts** | Leads → prospects → clients, with owner, lead source, referral partner, tags, income and employment details, marketing opt-in, review date. Full activity timeline (calls, emails, meetings, notes). CSV import/export |
| **Pipeline** | Kanban board across New Lead → Fact Find → Pre-Approval → Application Lodged → Conditional → Unconditional → Settlement Booked → Settled / Lost. Drag and drop, or use the stage menu |
| **Deals** | Loan amount, property value, auto-calculated LVR, lender, product, rate, fixed-rate expiry, pre-approval expiry, finance and settlement dates, co-borrower, stage history |
| **Document checklists** | Standard checklist built automatically by loan purpose (plus self-employed docs), with status tracking and a one-click "email the client what's outstanding" |
| **Tasks** | Personal and team tasks, overdue/today/upcoming views, tasks auto-created by automations |
| **Automations** | Rules engine: *when* (event or schedule) → *only if* (conditions) → *then* (actions). 18 ready-made automations, fully editable in the UI |
| **Outlook email sync** | Each team member connects their Microsoft 365 / Outlook mailbox. Emails to and from clients are filed against the client automatically (in both directions), and you can read, reply and send from inside the CRM. Everything the CRM sends goes out from your own mailbox |
| **Email templates** | 14 editable templates with merge fields, previews, an outbox with delayed sending, cancel/retry, and SMTP delivery as a fallback |
| **Commissions** | Upfront, trail (first 12 months), referral fees and clawbacks, generated automatically at settlement from lender rates. Ledger with received tracking and a clawback-exposure report |
| **Referral partners** | Agents, accountants, planners and others, with referral counts, settled volume and fee splits |
| **Lenders** | Commission rates, clawback periods, BDM contacts, settled volume |
| **Reports** | Settlements by month, stage movement, lead-source conversion, lender split, partner performance, commission by month, lost reasons, average days to settle |
| **Calculators** | Repayments (P&I / IO), borrowing power (estimate), LVR & indicative LMI, refinance savings and break-even |
| **Team** | Admin, broker and assistant roles, with notifications for automation alerts |

## Getting started

Requires **Node.js 22.13 or newer** (it uses Node's built-in SQLite, so there is no database server to install).

```bash
npm install
npm run seed     # optional: loads demo data (sign in as admin@efh.local / changeme123)
npm start        # http://localhost:3000
```

Without the demo seed, the first visit asks you to create the administrator account. The 12 major lenders, the email templates and the default automations are added automatically on first start.

Run the tests with `npm test`.

### Configuration

Settings come from environment variables; see [`.env.example`](.env.example). The most important ones are:

- **`SMTP_*`**: connects your mailbox (Microsoft 365, Google Workspace or any SMTP provider). Until this is set, emails are recorded in the Outbox and timeline as *logged* but not delivered. This lets you test the automations safely.
- **`TZ_BUSINESS`**: the time zone used to decide what "today" is for scheduled automations. The default is `Australia/Sydney`.
- **`HOST` / `COOKIE_SECURE` / `TRUST_PROXY`**: for running on a server behind HTTPS.

Business details (name, phone, email, ACL number, monthly settlement target) are set in the app under **Settings**.

## Connecting Outlook

The CRM connects to Outlook through Microsoft Graph, Microsoft's official API. It never sees your password, and the access tokens it stores are encrypted.

1. **One-time admin setup, about 10 minutes.** Go to **Settings → Outlook email** in the CRM, open *One-time setup* and follow the steps. You'll register the CRM as an app in [Microsoft Entra](https://entra.microsoft.com), using the redirect address shown on that page, then paste the app's IDs and client secret back into the CRM.
2. **Each team member connects their own mailbox.** They click **Connect Outlook** in Settings and sign in with Microsoft.

What happens next:

- The CRM checks Inbox and Sent Items every few minutes. The first check imports the last 30 days, which you can change with `MAIL_SYNC_DAYS`.
- Every email to or from a contact's email address is stored against that contact and appears on their timeline. If the contact has one open deal, the email is also linked to that deal. Emails with people who aren't contacts are ignored.
- New client emails notify the mailbox owner and can trigger automations ("Email received from a contact").
- Emails written in the CRM, sent from templates, or sent by automations go out from the sender's Outlook and appear in their Sent Items. The sender is the person who wrote it, otherwise the deal or contact owner. Without a connected mailbox, the CRM falls back to SMTP, or just logs the email.
- **Client emails** in the menu lists all filed emails. Open any email to read it or reply in the same Outlook conversation.

Notes:

- Use **http://localhost:3000** (not 127.0.0.1) when connecting, because Microsoft only accepts `localhost` redirect addresses. When hosted, use your real HTTPS address and add it as a redirect URI in Entra too.
- Client secrets expire, after at most 24 months. Create a new one in Entra before then and paste it into Settings.
- Attachments stay in Outlook. Use **Open in Outlook** on an email to view them.
- Back up `data/secret.key` together with `data/crm.db`. Without the key, Outlook has to be reconnected.

## How automations work

Each automation has three parts:

1. **When**: one of two kinds of trigger.
   - *Event triggers* run immediately: contact created, contact status changed, deal created, deal stage changed, task completed.
   - *Scheduled triggers* run every few minutes from the background scheduler: fixed-rate expiry, pre-approval expiry, finance due, settlement upcoming, settlement anniversary, birthday, review date reached, stale deal, uncontacted lead. Each fires **once per record and date**, so they never spam a client.
2. **Only if**: optional conditions, all of which must match. Example: `event.to_stage equals settled`, or `deal.loan_amount ≥ 1000000`.
3. **Then**: one or more actions:
   - create a task
   - send a template email (optionally delayed)
   - add a note
   - add or remove a tag
   - set the contact status
   - move the deal stage
   - notify the owner
   - add the document checklist
   - generate commissions

Merge fields such as `{{contact.first_name}}`, `{{deal.loan_amount|money}}` and `{{deal.fixed_expiry_date|date}}` work in task titles, notes and email templates. Templates in the `marketing` category are never sent to contacts who have opted out.

### Included automations

| Trigger | Automation |
| --- | --- |
| New lead | Welcome email, urgent "call them" task, notification |
| Deal created | Build the document checklist |
| → Fact Find | Email the client the list of documents needed, plus a review task |
| → Pre-Approval | Pre-approval email (amount and expiry), plus a property-search check-in task |
| → Application Lodged | Client update email, plus a "chase lender" task |
| → Conditional Approval | Client update, plus an urgent "satisfy conditions" task |
| → Unconditional | Congratulations email, plus a "loan docs and settlement" task |
| → Settled | Congratulations email, contact becomes a client, `settled` tag, commissions booked, 30-day check-in task, review request 14 days later |
| → Lost | `nurture` tag, re-engage task in 90 days |
| Fixed rate expires in 90 days | Rate review email and task |
| Pre-approval expires in 14 days | Email and task |
| Finance due in 3 days (not yet unconditional) | Urgent task and notification |
| Settlement in 2 days | Client reminder email and task |
| Settlement anniversary | Annual review email and task |
| Birthday | Birthday email |
| Review date reached | Review task |
| Open deal with no activity for 10 days | Follow-up task (repeats every 10 days) |
| Lead not contacted after 2 days | Follow-up email and second-attempt call task |

## Project structure

```
src/
  server.js            entry point (HTTP server + scheduler)
  app.js               Express app, security headers, routing, error handling
  auth.js              password hashing (scrypt), sessions, role checks
  constants.js         pipeline stages, document checklists, triggers & actions
  db/                  schema, migrations, connection helpers, default + demo seed data
  secrets.js           encryption for stored tokens and secrets
  routes/              REST API (contacts, deals, tasks, automations, comms, admin, insights)
  services/            automation engine, scheduler, mailer, Outlook (Microsoft Graph), templating, commissions, calculators
public/                single-page web app (no build step)
test/                  API tests (node:test)
```

## Security notes

- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies, and logins are rate-limited.
- Write requests must be JSON, which blocks cross-site form posts. The app sends a strict Content-Security-Policy.
- Assistants cannot manage users or business settings.
- CSV exports neutralise spreadsheet formulas. Document links must be http(s).
- Outlook tokens and the Microsoft client secret are encrypted (AES-256-GCM) with a key kept in `data/secret.key`, or in `ENCRYPTION_KEY` if set.
- Back up the `data` folder regularly. It holds personal and financial information, so store backups securely.

## Updating to a new version

Your data lives in the `data` folder: `crm.db` and `secret.key`. To update, download the new version, copy your old `data` folder into it, then run `npm install` and `npm start`. Database changes are applied automatically on start.

## Disclaimer

The calculators give estimates for client conversations and are not a lender's credit assessment. Default lender commission rates are indicative; update them to match your aggregator's schedule.
