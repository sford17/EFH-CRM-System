# EFH CRM

A CRM built for a mortgage broking business. It tracks leads, clients and loans from first enquiry through settlement, and automates the follow-ups that keep a broking pipeline moving: welcome emails, document chasing, pre-approval and finance-date warnings, settlement tasks, fixed-rate expiry reviews, birthdays and annual reviews.

## Features

| Area | What it does |
| --- | --- |
| **Dashboard** | Open pipeline, settlements against a monthly target, commission, overdue tasks, upcoming finance/settlement/expiry dates, recent activity |
| **Contacts** | Leads → prospects → clients, with owner, lead source, referral partner, tags, income and employment details, marketing opt-in, review date. Full activity timeline (calls, emails, meetings, notes). CSV export |
| **Spreadsheet import** | Import existing clients and their loans from Excel (.xlsx) or CSV. Columns are matched automatically, with a preview, duplicate handling and one-click undo. Imported clients aren't sent welcome or stage messages |
| **Pipeline** | Kanban board across New Lead → Fact Find → Pre-Approval → Application Lodged → Conditional → Unconditional → Settlement Booked → Settled / Lost. Drag and drop, or use the stage menu |
| **Deals** | Loan amount, property value, auto-calculated LVR, lender, product, rate, fixed-rate expiry, pre-approval expiry, finance and settlement dates, co-borrower, stage history |
| **Document checklists** | Standard checklist built automatically by loan purpose (plus self-employed docs), with status tracking and a one-click "email the client what's outstanding" |
| **Tasks** | Personal and team tasks, overdue/today/upcoming views, tasks auto-created by automations |
| **Automations** | Rules engine: *when* (event or schedule) → *only if* (conditions) → *then* (actions). 18 ready-made automations, fully editable in the UI |
| **Outlook email sync** | Each team member connects their Microsoft 365 / Outlook mailbox. Emails to and from clients are filed against the client automatically (in both directions), and you can read, reply and send from inside the CRM. Everything the CRM sends goes out from your own mailbox |
| **SMS** | Texts at every deal stage, on birthdays, and alongside the Annual Review and Rate Reduction emails, sent through ClickSend from each broker's own mobile number. Manual texts from any contact, with opt-out handling for marketing texts |
| **Mortgage tracker** | A tab on each contact covering their properties, valuation history by method (full, desktop, kerbside, AVM, contract price…), loans and the properties securing them, and other assets. Shows LVR, equity, usable equity and net position, plus a lending structure diagram that flags cross-collateralisation and LVRs over 80% |
| **Client lending reviews** | A branded review document built from the mortgage tracker, with four commentary sections (Loan Review, Actions to Consider, Broker to Action, Next Steps) pre-filled with suggestions. Preview it live, download as PDF or Word, or email it to the client with the PDF attached |
| **Calendar (Calendly)** | Calendly bookings appear on a Calendar page, the dashboard and each client's record. Bookings are matched to clients (newcomers become leads), cancellations get a follow-up task, and a **Booking link** button copies, emails or texts a pre-filled Calendly link |
| **Branding & signatures** | Your logo and colours across the CRM (light and dark mode) and on the sign-in page. Emails are sent as formatted HTML with your logo, brand colour and each sender's own signature, with images embedded |
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

## Mortgage tracker

Open a contact and choose the **Mortgage tracker** tab.

- **Properties:** address, type, use (owner-occupied, investment…), purchase date and price, rent, and co-owner.
- **Valuations:** each one records its method (*Full*, *Desktop*, *Kerbside*, *AVM*, *Contract price*, *Agent appraisal*, *Client estimate* or *Other*), date, amount, provider, the ordering lender and a reference. The latest valuation is the property's current value. You also see the change against the previous valuation and the latest figure from each method side by side. You can filter by method, and `GET /api/tracker/valuations?method=avm` lists valuations across all clients.
- **Loans:** lender (from your list or typed in), type (home, investment, line of credit, construction, car, credit card…), account number, limit and balance, rate, fixed-rate expiry, interest-only expiry, repayments, offset, status, whether you arranged it, and **which properties secure it**.
- **Other assets:** savings, super, shares, vehicles, business and so on.
- **Lending structure:** lenders and their loans on one side, properties on the other, with lines showing the security. A loan secured by several properties is spread across them by value, so each property gets its own LVR, equity and usable equity (to 80% LVR). Cross-collateralisation, a property securing loans with more than one lender, LVRs over 80% and properties without a valuation are flagged. Hover a loan or property to highlight what it's connected to.

When a deal settles, its loan, security property and recorded value are added to the tracker automatically. Imported settled loans are added too. **Fixed-rate expiry** reminders run from tracker loans, so they also cover loans arranged elsewhere or refixed since. There's also an **Interest-only period ending** reminder (90 days ahead by default). Templates can use `{{loan.lender_name}}`, `{{loan.fixed_expiry_date|date}}`, `{{loan.io_expiry_date|date}}`, `{{loan.balance|money}}` and `{{loan.interest_rate}}`.

## Client lending reviews

On a contact, click **Lending review** (or **+ New review** under *Lending reviews*). The review takes a snapshot of the client's mortgage tracker, so the document shows the figures as at the review date even if the tracker changes later. Use *refresh from the mortgage tracker* to update the figures; your commentary is kept.

- **The document** includes your logo, colours and business details; a position summary (property value, total lending, LVR, usable equity, net position); a loans table; the lending structure diagram; property LVRs; valuations by method; other assets; and a general-information disclaimer with your ACL / credit representative number.
- **Commentary:** there are four sections: *Loan Review*, *Actions to Consider*, *Broker to Action* (shown to the client as "What we'll do") and *Next Steps*. They start with suggestions drawn from the figures, covering fixed-rate and interest-only expiries, cross-collateralisation, LVRs over 80%, rates worth repricing, expensive unsecured debt, usable equity, savings without an offset, and valuations older than 12 months. Edit them freely, and use "-" or "•" for bullet points. The preview updates as you type.
- **Download** as **PDF** or **Word** (.docx, editable).
- **Email to client** sends the PDF as an attachment from your Outlook, with your signature added. The review is marked *Sent*, a timeline entry is added, and the client's next review date is set 12 months out if they don't already have a future one.

## Importing existing clients

Go to **Contacts → Import from spreadsheet** and drop in an Excel (.xlsx) or CSV file. Up to 20,000 rows are supported, and a downloadable template is provided.

1. **Match columns.** Common headings are recognised automatically, such as "Client Name", "Surname", "D.O.B.", "Mobile Phone", "Bank", "Loan Amount", "Fixed Expiry" and "Date Settled". Title rows above the headings are skipped. If the workbook has several sheets, pick the one to import.
2. **Choose options.** Set the default status, who owns the clients, what to do with clients already in the CRM (skip them, or fill in their missing details without overwriting anything), the stage for imported loans (usually *Settled*), a tag for everyone imported, and marketing consent.
3. **Preview.** Rows with problems are listed first, along with any new lenders that will be added.
4. **Import.** Every import is listed with an **Undo** button, which deletes everyone it added.

The importer understands Australian day-first dates (`04/03/1985`, `4/3/85`, `1 Jan 2020`), real Excel dates, amounts like `$450,000` or `450k`, rates like `5.89%` or Excel percentages, mobiles that lost their leading 0 in Excel, full state names, and common lender abbreviations (CBA, WBC, STG, BOQ and others).

Imports never trigger welcome emails or deal-stage texts. By default, scheduled messages that are already due at the time of import are held, for example a fixed rate expiring next month, an overdue review, today's birthdays, or "uncontacted lead" chasers. Future fixed-rate expiries, anniversaries and birthdays still trigger as normal.

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

## Branding and email signatures

- **Settings → Branding** (admin): upload a PNG or JPG logo, then choose a main colour (colours from your logo are suggested) and a sidebar colour. Colours are adjusted automatically where needed so text stays readable. You can choose a *Branded* email style (logo and colour band) or a *Plain* one that looks like a normal email.
- **Settings → My email signature** (each user): Outlook doesn't let other apps read your signature, so copy it from Outlook and paste it in. Images embedded in the signature are kept. Images that only exist on your PC (common when copying from Outlook desktop) can't be copied; add them with **Insert image**. Without a signature, your name, business name and phone are used.
- The signature is added when an email is sent, so templates end with just "Kind regards,". Replies sent from the CRM get your signature above the quoted conversation.
- Logos and signature images are embedded in the email itself, so clients see them without clicking "download pictures", even when the CRM runs on your own computer.
- **Preview** buttons (Settings, new email, Send template) show exactly how an email will look.

## Calendly

Each broker connects their own Calendly account in **Settings → Calendly**. In Calendly, go to *Integrations → API & Webhooks → Personal access tokens*, generate a token, and paste it into the CRM. This works on every Calendly plan, including the free one.

- **Syncing:** the CRM checks Calendly every few minutes. It imports bookings from the last 30 days and all upcoming ones. Calendly webhooks would need a paid plan and a public web address, so the CRM checks on a schedule instead.
- **Matching:** each booking is linked to a contact. A booking made from a link sent from the CRM is matched by its hidden reference, otherwise by email address. Someone new is added as a lead (`lead_source = calendly`), with their booking answers saved as background notes; this can be turned off in Settings. If the contact has one open deal, the booking is linked to that deal.
- **Automations:** two default automations are included. *Appointment booked* alerts the broker and adds a prep task for the day of the meeting. *Appointment cancelled* creates a high-priority follow-up task (reschedules don't count as cancellations). There are also **Appointment booked**, **Appointment cancelled** and **Appointment coming up** triggers for your own automations, with merge fields `{{event.title}}`, `{{event.when}}`, `{{event.location}}` and `{{event.join_url}}`.
- **Booking links:** the **Booking link** button on a contact lists your meeting types. You can copy the link, or email or text it. The link is pre-filled with the client's name and email. `{{broker.booking_link}}` adds the same pre-filled link to any email template, SMS or automation.

## Sending SMS

Texts go through [ClickSend](https://www.clicksend.com/au/), an Australian SMS service that charges per message with no monthly fee. Set it up in **Settings → SMS**:

1. **Admin:** create a ClickSend account, then copy the username and API key from *Developers → API Credentials* into the CRM.
2. **Each broker:** in ClickSend, verify your mobile under *Sender IDs → Own Numbers*. ClickSend texts you a 6-digit code, and the number must be re-verified every 12 months. Then enter the same number under **My mobile number** in the CRM and click **Send me a test**.

Clients then receive texts from the broker's own mobile number, and their replies go straight to that phone. A text goes out as the person who triggered it, otherwise the owner of the deal or contact. If the broker has no verified number, the fallback sender is used. Until ClickSend is connected, texts are only logged, never sent.

What is texted by default (all editable under **Automations** and **Email templates**):

| When | Text |
| --- | --- |
| New deal opened at New Lead | Thanks for choosing us |
| Fact Find | Documents list emailed |
| Pre-Approval | Pre-approved with the lender |
| Application Lodged | Application lodged |
| Conditional Approval | Conditionally approved |
| Unconditional Approval | Formally approved, loan docs coming |
| Settlement Booked | Settlement date confirmed |
| Settled | Congratulations |
| Birthday | Happy birthday *(marketing)* |
| "Annual loan review" email sent | Time for your annual review *(marketing)* |
| "Rate reduction" email sent | Rates have dropped *(marketing)* |

Any email template can have a companion SMS, which is sent whenever that email is sent. Automations can also use a **Send an SMS** action.

Marketing texts follow the Spam Act. They only go to contacts who allow marketing, and they end with "Reply STOP to opt out". Because replies come to your phone rather than the CRM, when a client replies STOP, tick **Opted out of all SMS** on their contact record, and the CRM won't text them again. Service updates about a client's own loan are always sent unless they have opted out of SMS.

## How automations work

Each automation has three parts:

1. **When**: one of two kinds of trigger.
   - *Event triggers* run immediately: contact created, contact status changed, deal created, deal stage changed, task completed.
   - *Scheduled triggers* run every few minutes from the background scheduler: fixed-rate expiry, pre-approval expiry, finance due, settlement upcoming, settlement anniversary, birthday, review date reached, stale deal, uncontacted lead. Each fires **once per record and date**, so they never spam a client.
2. **Only if**: optional conditions, all of which must match. Example: `event.to_stage equals settled`, or `deal.loan_amount ≥ 1000000`.
3. **Then**: one or more actions:
   - create a task
   - send a template email (optionally delayed)
   - send an SMS (optionally delayed; service update or marketing)
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
