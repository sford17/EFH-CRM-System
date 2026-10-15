# EFH CRM

A CRM built for a mortgage broking business. It tracks leads, clients and loans from first enquiry through settlement, and automates the follow-ups that keep a broking pipeline moving: welcome emails, document chasing, pre-approval and finance-date warnings, settlement tasks, fixed-rate expiry reviews, birthdays and annual reviews.

## Features

| Area | What it does |
| --- | --- |
| **AI assistant** | Ask questions about your clients, deals, loans, tasks and reports in plain English, or give it tasks: create tasks, add notes, create contacts, update deals, email or text clients. It looks things up itself; anything that changes the CRM or contacts someone waits for your approval (emails and texts can be edited first) |
| **Dashboard** | Open pipeline, settlements against a monthly target, commission, overdue tasks, upcoming finance/settlement/expiry dates, recent activity |
| **Lead Generator** | Describe the leads you want (e.g. "real estate agents in Parramatta who sell a lot of first homes") and AI searches the web for matching businesses and professionals, with why they fit, how to approach them, their published contact details and the source. Add the good ones as leads or referral partners in one click |
| **Contacts** | Leads → prospects → clients, with owner, lead source, referral partner, tags, income and employment details, marketing opt-in, review date. Full activity timeline (calls, emails, meetings, notes). CSV export |
| **Related contacts & households** | Link partners, family, guarantors and advisers. Couples who share finances see one combined mortgage tracker on both profiles, keep a shared address, become joint borrowers on new deals by default, and can have emails, templates and lending reviews addressed to one or both of them |
| **Spreadsheet import** | Import existing clients and their loans from Excel (.xlsx) or CSV. Columns are matched automatically, with a preview, duplicate handling and one-click undo. Imported clients aren't sent welcome or stage messages |
| **Pipeline** | Kanban board across New Lead → Fact Find → Pre-Approval → Application Lodged → Conditional → Unconditional → Settlement Booked → Settled / Lost. Drag and drop, or use the stage menu |
| **Deals** | Loan amount, property value, auto-calculated LVR, lender, product, rate, fixed-rate expiry, pre-approval expiry, finance and settlement dates, co-borrower, stage history |
| **Agent & solicitor** | Record the real estate agent, solicitor/conveyancer and buyer's agent (plus accountant, builder or planner) on each deal, straight from the New deal form. They're kept in a directory so you pick them again next time, can be emailed from the deal, appear in merge fields, and can be kept updated automatically |
| **Online fact find** | A branded fact find you send to clients, with your logo and colours on every page, that works on a phone. It's pre-filled with what the CRM knows, and the questions adapt to the answers: a partner's section when applying together, previous addresses and jobs only when needed, income questions that match how each person works, and different questions for buying, refinancing, building or using equity. It works out which documents to ask for (payslips, tax returns, visa, statements for each account and debt…) for the client to upload, saves as they go and sends reminders. You review the answers and documents, then import everything into the contact, household, mortgage tracker and deal in one click. There's also a **documents-only** request for clients whose details you already have |
| **Document checklists** | Standard checklist built automatically by loan purpose (plus self-employed docs), with status tracking and a one-click "email the client what's outstanding" |
| **Tasks** | Personal and team tasks, overdue/today/upcoming views, tasks auto-created by automations |
| **Automations** | Rules engine: *when* (event or schedule) → *only if* (conditions) → *then* (actions). 30 ready-made automations, fully editable in the UI |
| **Outlook email sync** | Each team member connects their Microsoft 365 / Outlook mailbox. Emails to and from clients are filed against the client automatically (in both directions), and you can read, reply and send from inside the CRM. Everything the CRM sends goes out from your own mailbox |
| **SMS** | Texts at every deal stage, on birthdays, and alongside the Annual Review and Rate Reduction emails, sent through ClickSend from each broker's own mobile number. Manual texts from any contact, with opt-out handling for marketing texts |
| **Mortgage tracker** | A tab on each contact covering their properties, valuation history by method (full, desktop, kerbside, AVM, contract price…), loans and the properties securing them, and other assets. Shows LVR, equity, usable equity and net position, plus a lending structure diagram that flags cross-collateralisation and LVRs over 80% |
| **Client lending reviews** | A branded review document built from the mortgage tracker, with four commentary sections (Loan Review, Actions to Consider, Broker to Action, Next Steps) pre-filled with suggestions. Preview it live, download as PDF or Word, or email it to the client with the PDF attached |
| **E-signatures (Adobe Sign)** | Send a PDF or Word document (or a lending review) to clients for signature through Adobe Acrobat Sign, in order or all at once, with you countersigning if needed. Track who has signed, chase, cancel, and keep the signed PDF in the CRM; a deal checklist item can be ticked off automatically when it's signed |
| **Calendar (Calendly)** | Calendly bookings appear on a Calendar page, the dashboard and each client's record. Bookings are matched to clients (newcomers become leads), cancellations get a follow-up task, and a **Booking link** button copies, emails or texts a pre-filled Calendly link |
| **Branding & signatures** | Your logo and colours across the CRM (light and dark mode) and on the sign-in page. Every email has your logo on a band of your brand colour, a footer with your business details and disclaimer, and each sender's own signature, with images embedded |
| **Email templates** | 18 editable templates with merge fields, headings and bullet points, previews, an outbox with delayed sending, cancel/retry, and SMTP delivery as a fallback |
| **Email graphics** | Charts and diagrams built from each client's details, in your brand colours: loan progress tracker, loan details card, key dates, document checklist, position summary, lending structure diagram, equity chart, property value chart and fixed-rate countdown. Also branded buttons (e.g. "Book a time") and your own images. They show even when a client's email blocks pictures |
| **Settlement letters** | A branded letter and email for the client when their loan settles: borrowers, loan amount and splits, interest rate, repayments, direct debit account and first repayment date, with the letter attached as a PDF. Fill it in by hand, or upload the loan documents and AI (Claude) fills it in for you to check |
| **Quickli** | Send a deal's borrowers, household, income, properties, existing loans, debts and the new loan to Quickli as a servicing scenario in one click (and update it later), see what Quickli still needs, link existing scenarios, and record the results (max borrowing, lenders passing, best lender, surplus) on the deal |
| **Commissions** | Upfront, trail (first 12 months), referral fees and clawbacks, generated automatically at settlement from lender rates. Ledger with received tracking and a clawback-exposure report |
| **Partners & agents** | One directory of real estate agents, buyer's agents, solicitors, conveyancers, accountants, planners and builders, with referral counts, settled volume, fee splits and the deals they're on |
| **Lenders** | Your accreditation numbers (each broker's own, with renewal dates), BDMs and other lender contacts, emailing the BDM (filed on the client when it's about one, replies included), commission rates, clawback periods, settled volume, and logos shown across the pipeline, tracker, review documents and client emails |
| **Internal refinance register** | A record of every client you've moved from one of your loans to a new one, with the existing loan beside the new loan (borrowers, lender, account, product, amounts, rates, settlement and pay-out dates, broker), plus the reason, clawback and cashback. Every field is editable. It's added automatically when a refinance deal settles, and a CSV export is there for sale or trail-book records |
| **Newsletter** | A monthly client newsletter written by AI from the month's banking, finance and property news (AFR, RBA, Cotality and more), with key-number tiles, bar charts, your branding and a "Book a meeting" button. Each client's copy compares their own interest rates with the market average. Written automatically on the 20th; you get an email to review it, then send it |
| **Partner newsletter** | A monthly newsletter for your referral partners (agents, accountants, solicitors and others): a client story you write in your own words (AI can tidy it into a short, anonymous case study, with ideas from your recent settlements) and industry updates researched by AI, each with "what it means for your clients". Written on the 20th; you get a reminder a few days before to add the story, then an email when it's ready to review and send. Includes a "Refer a client" button and an unsubscribe link |
| **Social** | Connect each broker's LinkedIn profile and Instagram professional account, then write a post with a picture, see a preview for each, and post now, schedule it or save a draft. Post ideas, a general-advice disclaimer, links to the live posts, and retry if a network refuses a post |
| **Reports** | Running costs (what Claude and SMS have cost, month by month and in total), running settlements by financial year (settled and expected, month by month, with client, lender, loan type, amount and commission), plus settlements by month, stage movement, lead-source conversion, lender split, partner performance, commission by month, lost reasons, average days to settle |
| **Calculators** | Purchase calculation (funds to complete: price, loan and LVR, deposit, stamp duty, LMI, legal and other costs, total client contribution; also saved on purchase deals), stamp duty for residential and commercial property in every state and territory (2026-27 rates, with owner-occupier and first home buyer concessions and foreign surcharges), repayments (P&I / IO), borrowing power (estimate), LVR & indicative LMI, refinance savings and break-even |
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
- **Valuations:** each one records its method (*Full*, *Desktop*, *Kerbside*, *AVM*, *Contract price*, *Agent appraisal*, *Client estimate* or *Other*), date, amount, provider, the ordering lender and a reference. The property's current value comes from the **highest recent valuation**. The CRM takes the most recent valuation of each method, keeps those within 12 months of the newest one, and uses the highest. For example, a desktop valuation of $845k from two months ago beats an AVM of $790k from last month. Client estimates only count when there's nothing else. The value used is ticked and highlighted, with a note explaining the choice. That value flows into the lending structure, LVR, equity, lending reviews and email charts. To use a different valuation for a property, click **Use this** on that row; **Choose automatically** goes back to the automatic choice. In **Settings → Business** you can switch to *Most recent valuation only*, change the 12 months (0 = no limit), or count client estimates too. You also see the change against the previous valuation and the latest figure from each method side by side. You can filter by method, and `GET /api/tracker/valuations?method=avm` lists valuations across all clients.
- **Loans:** lender (from your list or typed in), type (home, investment, line of credit, construction, car, credit card…), account number, limit and balance, rate, fixed-rate expiry, interest-only expiry, repayments, offset, status, whether you arranged it, and **which properties secure it**.
- **Other assets:** savings, super, shares, vehicles, business and so on.
- **Lending structure:** lenders and their loans on one side, properties on the other, with lines showing the security. A loan secured by several properties is spread across them by value, so each property gets its own LVR, equity and usable equity (to 80% LVR). Cross-collateralisation, a property securing loans with more than one lender, LVRs over 80% and properties without a valuation are flagged. Hover a loan or property to highlight what it's connected to.

When a deal settles, its loan, security property and recorded value are added to the tracker automatically. Imported settled loans are added too. **Fixed-rate expiry** reminders run from tracker loans, so they also cover loans arranged elsewhere or refixed since. There's also an **Interest-only period ending** reminder (90 days ahead by default). Templates can use `{{loan.lender_name}}`, `{{loan.fixed_expiry_date|date}}`, `{{loan.io_expiry_date|date}}`, `{{loan.balance|money}}` and `{{loan.interest_rate}}`.

## Valuation types explained

When a client document shows how a property was valued, a short **About the valuation types** section underneath explains each type that appears, in plain words. Only the types actually shown are explained, for example full valuation, desktop, kerbside, AVM, contract price, agent appraisal, client estimate or purchase price. It appears in:
- the property report (PDF, preview and email)
- the client lending review (PDF, Word and preview)
- the *property value chart* graphic in emails

The same description shows under the method when you add or edit a valuation on the Mortgage tracker tab.

## Lender logos

On **Lenders**, each lender has **Upload** (PNG/JPG) and **Fetch** buttons. *Fetch* uses the lender's website icon and is quick but low resolution. For the best result, upload the logo from the lender's broker portal or your aggregator. Website addresses are pre-filled for the standard lenders.

Logos appear:

- **In the CRM:** pipeline cards, the deals list and deal page, the client's deals, and the mortgage tracker (loans table and lending structure diagram).
- **In lending reviews:** the loans table and diagram, in the preview, PDF and Word versions.
- **In emails to clients:** any email that mentions a lender by name gets that lender's logo, top-right opposite yours (or above the signature in the *Plain* style). Up to three lenders are shown. Short names like ANZ, NAB and ING only match in capitals, so ordinary words never trigger them. Replies stay plain.

## Client lending reviews

On a contact, click **Lending review** (or **+ New review** under *Lending reviews*). The review takes a snapshot of the client's mortgage tracker, so the document shows the figures as at the review date even if the tracker changes later. Use *refresh from the mortgage tracker* to update the figures; your commentary is kept.

- **The document** includes your logo, colours and business details; a position summary (property value, total lending, LVR, usable equity, net position); a loans table; the lending structure diagram; property LVRs; valuations by method; other assets; and a general-information disclaimer with your ACL / credit representative number.
- **Commentary:** there are four sections: *Loan Review*, *Actions to Consider*, *Broker to Action* (shown to the client as "What we'll do") and *Next Steps*. They start with suggestions drawn from the figures, covering fixed-rate and interest-only expiries, cross-collateralisation, LVRs over 80%, rates worth repricing, expensive unsecured debt, usable equity, savings without an offset, and valuations older than 12 months. Edit them freely, and use "-" or "•" for bullet points. The preview updates as you type.
- **Download** as **PDF** or **Word** (.docx, editable).
- **Email to client** sends the PDF as an attachment from your Outlook, with your signature added. The review is marked *Sent*, a timeline entry is added, and the client's next review date is set 12 months out if they don't already have a future one.

## Borrowers: several co-borrowers, companies and trusts

**Several co-borrowers:** a deal can have as many borrowers as the loan has. In the **Borrowers** box on the New deal and Edit forms, the main borrower is at the top (on Edit you can change who that is). Below it:
- **+ Add co-borrower** adds another row. The client's related contacts come first in the list, then everyone else.
- **×** removes a co-borrower. The order you set is the order they're shown in.
- The client's partner is added for you on a new deal.

Everyone on the deal sees it on their own contact page, deal search finds it by any borrower's name, and the loan created at settlement carries every borrower to the mortgage tracker. Emails and automations addressed to "the client" go to all the borrowers ("Hi Mia, Tom and Ava"). Settlement letters, the internal refinance register and the settlements report list them all.

**Companies and trusts:** a contact can be a **Person**, a **Company** or a **Trust**. Choose at the top of **+ New contact**, or click **+ Company or trust** on a client's *Related contacts* card, which creates it already linked to that client.
- A company or trust has a name, ABN, ACN (for a trust, its corporate trustee's) and the kind of trust. Personal details like date of birth and income are left off, and it starts opted out of marketing.
- **Linking people:** link its directors, shareholders, trustees, beneficiaries, appointors or guarantors on its page (**+ Link person**). The client's page shows *Trustee of Jones Family Trust* and so on, and lists the trust's or company's deals too.
- **As a borrower:** pick it in the Borrowers box like anyone else, or click **+ New company or trust** right there.
- **Emails** about its loans go to the people linked to it, since a company or trust can't read email. They're greeted by name, not as "Hi Jones Family Trust".
- **Quickli:** its directors or trustees are sent as the applicants, with a reminder to add the trust's or company's own income in Quickli.
- **Automations:** creating a company or trust doesn't trigger new-lead automations.

## Related contacts & households

On a contact's overview, use **+ Link contact** in the *Related contacts* card to link an existing contact, or create their partner on the spot. A new partner gets the same surname, status, owner, lead source and address. Relationships include spouse, de facto, partner, parent/child, sibling, business partner, guarantor, accountant and solicitor.

Tick **Shares finances** for a couple (it's ticked automatically for spouses and partners). Contacts who share finances form a *household*:

- **One mortgage tracker:** their properties, loans and assets appear on both profiles, so they only need entering once. Each item still records whose name it's in, with owner/co-owner and borrower/co-borrower choices.
- **Shared address:** when one of them moves, the other moves too, if they were at the same address. When you link them, a blank address is filled from the partner's.
- **Joint deals:** a new deal makes the partner the co-borrower automatically, and you can change it in the deal form. Joint deals show on both contacts.
- **Emails to one or both:** *Send template*, *Email* and *Lending review* each have an **Address to** choice. With both ticked, the email goes to both addresses and `{{contact.first_name}}` reads "Mia and Tom". Templates and reviews default to both; a one-off email defaults to the person you're on.
- **Automations:** stage-change and reminder emails on a joint deal or loan go to both borrowers. To send to just the main client, choose *Main client only* under *Send to* in the automation.
- **Lending reviews:** a review is prepared for the household (for example "Mia & Tom Jones", which also appears in the PDF and Word file names). Untick a name to address it to one person only.

To separate a couple's finances again, edit the relationship and untick *Shares finances*, or click **Unlink**. Both contacts and all their records are kept.

## Sending documents for signing (Adobe Sign)

**Connect once (admin):** in **Settings → Adobe Sign**:

1. In Adobe Acrobat Sign (signed in as an account administrator), go to **Account → Acrobat Sign API → API Information → Integration Key**.
2. Name it "EFH CRM" and tick the **user_read, agreement_read, agreement_write and agreement_send** scopes.
3. Save, open the key and copy it, then paste it into the CRM and click **Connect**.

Integration keys come with Acrobat Sign business and enterprise plans. If *Acrobat Sign API* isn't in your account menu, ask Adobe support to switch on API access. The key is stored encrypted.

**Send a document:** on a contact or deal, click **✍ Send for signing** in the *Documents for signing* card.

- **Document:** upload a PDF or Word document (up to 10 MB), or choose one of the client's lending reviews.
- **Signers:** the client and their partner are listed (tick who needs to sign), and you can add anyone else. Choose whether everyone signs at the same time or one after another. Tick *I need to sign too* to countersign after the clients.
- **Deal:** optionally link it to a deal, and pick a checklist item (e.g. *Signed privacy consent*) to tick off automatically when it's signed.
- **Message, reminders and expiry:** add a message, and choose automatic reminders (daily, every 3 days or weekly) and an expiry.

Adobe Sign emails each signer a secure link. If your document has no signature fields, Adobe adds a signature block at the end. For precise placement, add fields in Adobe, or use Adobe *text tags* in your Word/PDF template (e.g. `{{Sig_es_:signer1:signature}}`).

**Tracking:** the card shows each signer's progress (*waiting to sign*, *after the others*, *✓ signed*, *✗ declined*). The CRM checks Adobe every 10 minutes, or click **Check now**. Use **Send reminder** to chase whoever is up next, or **Cancel** to withdraw it. When everyone has signed:

- the signed PDF is saved (**⬇ Signed copy**);
- it's logged on the client's timeline;
- you get a notification;
- the linked checklist item is ticked off;
- the **Document signed (Adobe Sign)** automation trigger fires, so you can add a task or a thank-you message, for example.

Documents go out from the connected Adobe account. To send each broker's documents from their own Adobe account, tick *Send as each team member* in Settings (each broker must also be a user in your Acrobat Sign account).

## Stamp duty calculators

**Calculators** has two stamp duty calculators covering every state and territory.

**Residential:** enter the state, price, property type (established, new, off-the-plan or vacant land), whether the buyer will live in it or invest, and whether they're a first home buyer and/or a foreign purchaser. The result shows:

- the duty at general rates;
- any concessions, such as owner-occupier or principal place of residence rates (VIC, QLD, ACT) and first home buyer exemptions and concessions;
- the foreign purchaser surcharge;
- the total and the effective rate;
- the eligibility conditions to check;
- the same purchase in every other state.

**Commercial:** enter the state and price (excluding GST). It handles the differences between states:

- Victoria's Commercial and Industrial Property Tax;
- South Australia charging no duty on commercial land;
- the ACT's $2.1 million threshold;
- NSW premium duty applying to residential land only.

**Keeping the rates current:** the rates are for contracts from 1 July 2026 (2026-27) and are kept in `src/services/stampDutyRates.js`. NSW and the ACT change their figures every 1 July, and states often change concessions in their budgets, so review the file each July.

A few items couldn't be checked against the official calculators when they were loaded. Results that rely on them show a **Please confirm** note:

- the NSW first home buyer concession formula;
- the WA first home vacant land rate;
- the ACT investor rates.

Every result links to that state's official calculator. Land titles registration fees and off-the-plan concessions (VIC, WA) aren't included.

## Lead Generator

**Searching:** describe who you're looking for, optionally with an area, the type (referral partners, business clients or either) and how many results you want. For example:
- "Real estate agents in Parramatta who sell a lot of first homes"
- "Accountants in Penrith who look after small businesses"
- "Builders offering house and land packages in Western Sydney"

Claude searches the web (agency sites, business directories, professional listings) and returns a card for each match. Each card shows:
- name, role and business, category and location
- **why they fit**, plus a suggested **first approach**
- website, published email and phone
- the **source page**

**Using the results:**
- If someone is already in the CRM (matched by email, phone, website or name), the card says so.
- **Add as lead** creates a contact with status *Lead*, tagged *lead-generator*, with the reasons and source in their background notes.
- **Add as referral partner** adds them to Partners & agents with the right type (agent, accountant, builder…).
- **Dismiss** hides a result.
- Searches take a few minutes and run in the background; you get a notification when one finishes. Past searches are kept on the Lead Generator page.

**Privacy and spam rules:**
- The generator only collects contact details businesses publish themselves for enquiries. It never collects personal mobiles or emails from social media, forums or people-search sites, and it skips private individuals.
- Added leads have **no marketing consent**, so they don't get newsletters or marketing texts until they agree to.
- Before reaching out: email only about their business role, identify yourself and offer an opt-out, check phone numbers against the Do Not Call Register before cold calling, and check details on the source page.

Each search costs roughly a dollar on your Anthropic account (web searches plus reading).

## Property reports

Send a client a report on how their properties have performed, with the latest market data and news for their area.

**Creating one:**
1. Open the client, go to the **Mortgage tracker** tab, and click **📈 Property report** (under Properties).
2. Tick the properties to include. Each one needs a suburb and state, either in its address (e.g. "3 Park Ave, Ryde NSW 2112") or in the property's fields.
3. Claude researches each area on the web while you carry on working, usually in 2–5 minutes. You get a notification when it's ready.

**What's in it, for each property:**
- **Current value, growth** since purchase (or the first valuation), **growth per year, equity and LVR**
- A plain-English paragraph you can edit
- A **valuation history chart** and table, built from the valuations on the tracker tab plus the purchase price
- **About the area:**
  - a summary of the local market
  - headline figures (median price, 12-month change, rents, yield, days on market and so on), each with its period and source
  - a price trend
  - local developments (transport, rezoning, schools)
- A closing note, a **Book a time to chat** button (from Calendly or your newsletter booking link), the sources and a general-information disclaimer

**Reviewing and sending:**
- Everything is editable: title, introduction, each property's paragraph, area summaries, figures, local news and the closing. Anything the AI wasn't sure about is listed at the top.
- The preview switches between the **Email** (with charts) and the **PDF document**.
- **Email to client** sends it from your mailbox with the PDF attached and logs it on the client's timeline. **Download PDF** saves a copy.
- **Refresh area data** researches the areas again. Your own wording is kept.
- Past reports are listed on the client's tracker tab.

Each report costs roughly 50c–$1 on your Anthropic account, depending on how many areas it covers. Area figures come from third-party sites, so check them before sending.

## Online fact find & document requests

Send clients a branded online fact find, or just ask for documents.

**Sending one:**
- On a client's page, click **📝 Fact find** (top of the page, or in the "Fact finds & documents" card). On a deal, use **📝 Fact find** or **📎 Upload link** in the Documents card.
- Choose:
  - **Full fact find**: their details, finances and plans, plus documents.
  - **Request documents only**: tick documents from the list or type your own.
- Pick the deal and how long the link works (30 days by default). Then either **email it** (from your mailbox, with a branded button) or **just create the link** to send another way.
- To send it automatically when a deal reaches **Fact Find**, switch on the automation "Fact Find stage: send the online fact find" in **Automations**. It's off until you do.

**What the client sees:**
- Your logo, brand colours and contact details on every page, on a phone or a computer.
- Nine short steps: About you · Where you live · Work & income · Your plans · What you own · What you owe · Living expenses · Documents · Review & submit.
- It's pre-filled from the CRM (and from their last fact find), so returning clients only check and update.
- Everything saves as they go. They can leave and come back using the same link.

**How the questions adapt:**
- **"Me and my partner"** adds a second applicant. If you've linked them as a household, the partner is pre-filled.
- **Temporary visa holders** are asked for their visa subclass and expiry.
- **Moved in the last 3 years?** It asks for previous addresses until 3 years are covered.
- **In their job less than 2 years?** It asks for previous work until 2 years are covered.
- **Employment type changes the questions:**
  - employees: employer, start date and salary, plus overtime, commission, bonuses or allowances if they tick them
  - casuals: hours
  - parental leave: their return-to-work date
  - self-employed: business, structure and two years of profit (plus wages if it's a company or trust)
- **Dependants** bring in childcare and school costs, and Centrelink options.
- **What they want to do changes the questions:**
  - buying: found a property, price, contract, finance and settlement dates, deposit and where it's from (a gift asks the amount), first home schemes
  - refinancing: reasons, cash-out amount and what it's for
  - building: land and build price
  - using equity: how much and what for
- **Owning their home** adds it to "What you own", plus a home loan to fill in if it has a mortgage.
- **Aged 50 or over:** applicants are asked how they'd repay after retirement, and everyone is asked about expected changes (responsible lending).
- **Living expenses** use the same categories as Quickli, with rent filled in from their living situation and a running monthly total.

**Documents adapt too.** The list is built from their answers, with each person's name:
- ID and Medicare (passport and visa instead, for visa holders)
- payslips from each employer (and the contract if they're new or contracting)
- income statements if they're casual or get bonuses or commission
- tax returns, financials and the ATO portal statement for self-employed applicants
- Centrelink and child support statements
- the account their pay goes into
- statements for each savings account and each debt (6 months for the home loan when refinancing)
- leases for investment properties, and rates notices when refinancing
- the contract of sale, gift letter, building contract and plans, or renovation quotes

Clients can take photos with their phone or upload PDF, Word or Excel files (up to 15 MB each), and add documents after submitting. Each file's type is checked from its contents. When a file arrives for a deal, the matching checklist item is ticked off and links to it.

**Reviewing it:**
- You get a notification and an email when the client submits. The "Fact find completed: review it" automation also creates a task.
- **Fact finds** in the menu lists everything you've sent: waiting on the client, to review, and done. Each one shows its progress and documents received.
- Open one to see:
  - the answers, set out by section
  - the documents, with each file to view or download
  - when the link was sent, opened, saved and completed
- From there you can:
  - **Copy the link**, **Send a reminder**, **Extend** an expired link or **Cancel** it
  - **Let them make changes** (reopens a submitted fact find)
  - **Download PDF** (the answers and declaration, for your file)
- **Import into CRM** fills in:
  - the contact's details, employment and income
  - their partner, added or updated and linked as a household
  - properties (with the client's estimate of value), debts and assets in the mortgage tracker
  - the deal's purpose, property, amounts and co-borrower

  Anything the client wrote in "Anything else" or about upcoming changes goes on the timeline. Importing again updates the same records.
- **Quickli:** after importing, sending the deal to Quickli includes:
  - their declared living expenses
  - their income broken down (base, overtime, bonus, Centrelink and so on)
  - business profits for self-employed applicants

**Reminders:** if the client hasn't finished, they're emailed a reminder after 3 days, then 4 days later. You can switch this off in Settings → Business. Expired or cancelled links stop working.

**Privacy:**
- Each link is a long random code, kept encrypted.
- The client agrees to a privacy consent and declares their answers are true before submitting.
- Uploaded documents are stored in the CRM's database in the `data` folder, so keep that folder (and its backups) secure.

### Putting the CRM online for clients

Clients open their fact find from their own phone or computer, so the CRM has to be reachable from the internet over **https**. While it only runs on this PC (`http://localhost:3000`), the CRM warns you that clients can't open links yet.

**The ready-made way: Fly.io in Sydney.** Follow **[docs/GO-LIVE.md](docs/GO-LIVE.md)**, a step-by-step guide that takes about an hour, once. It's set up so your data stays in Australia, the CRM runs 24/7, and updates go live when you approve them on GitHub (after the tests pass). It costs about US$6–10 a month.

Other options:
- Another host, using the included `Dockerfile` (keep `/data` on persistent storage; set `COOKIE_SECURE=true` and `TRUST_PROXY=true`).
- A secure tunnel from this PC, such as Cloudflare Tunnel. This only works while the PC is on and the CRM is running.

Then go to **Settings → Business → CRM web address** and enter the https address. Links in fact finds, reminders and emails use it.

Once the CRM is online, anyone can reach its sign-in page. Give every user a strong password and **require two-factor sign-in** (Settings → Two-factor sign-in).

## AI assistant

Open **Assistant** in the menu (or **✧ Ask AI** at the top of any page) and type a question or a task.

**Questions** are answered from your CRM data, with links straight to the records, for example:
- "Which clients have fixed rates ending in the next 90 days?"
- "What's settling this month, and is anything overdue?"
- "Summarise Mia Jones: her loans, her deals and what's outstanding."
- "How are settlements and commission tracking this financial year?"
- "What's the stamp duty on an $850k home in NSW for a first home buyer?" (it uses the CRM's calculators)
- "What did the RBA do this month?" (it can search the web)

**Tasks:** it can **create tasks**, **add notes** or logged calls to a client's timeline, **create contacts**, **update deals** (move stage, change dates, amount, rate or lender), and **email** or **text** clients.

**You stay in control:**
- Looking things up happens straight away.
- Anything that changes the CRM or contacts someone appears as a card with **Approve** and **Decline**.
- You can edit an email or text before approving it. The assistant is told what was actually sent.
- Nothing happens until you press **Confirm**.
- Moving a deal's stage runs that stage's automations, as it would if you moved it yourself. The card warns you about this.

**How it works:**
- The assistant acts as you: emails go from your mailbox with your signature, and tasks are assigned to you unless you say otherwise.
- Conversations are private to each user and kept on the left so you can return to them.
- It uses the Anthropic API key from Settings → AI. Each question costs a few cents (more for long conversations or web searches).
- The details it looks at are sent to Anthropic to be processed.

## Monthly newsletter

**Written for you:** on the **20th of each month** (you can change the day), Claude researches the month's banking, finance and property news on the web and writes the newsletter. It prefers the AFR and official and data sources such as the RBA, ABS, APRA and Cotality (CoreLogic); the list of sources can be edited. The newsletter includes:
- a headline and introduction
- **key-number tiles** (e.g. cash rate, home value change, average variable rate)
- 3–5 sections (interest rates, the property market, banking and lending news, a tip for borrowers), with **bar charts** where there are figures worth showing, and links to the sources
- the current **average home loan rates**, with their source

**You review it first:** when it's ready, you get an email and a notification with a link to the **Newsletter** page.
- Anything the AI thinks needs checking is listed at the top.
- Every part can be edited: subject, preview line, headline, introduction, numbers, sections, charts and average rates.
- The live preview shows exactly what a chosen client will receive.
- **Send a test to me** emails you a copy.
- **Rewrite with AI** starts again.
- Nothing goes to clients until you press **Send to … clients** and confirm. You can untick anyone who shouldn't get it that month.

**Each client's copy is personal:**
- **How does your rate compare?** shows each of their active home and investment loans (from the mortgage tracker, including their partner's) as a bar against the matching market average: owner-occupier or investor, variable or fixed.
- If they're above the average, it shows about how much extra interest that is a year, and suggests a review.
- Clients without loans on file see the average rates instead.
- Each copy ends with a **Book a meeting with me** button. This uses their broker's Calendly link, or else the booking link in Newsletter settings, or else your website.
- It's sent from their broker's mailbox, in your branding (logo, colours, signature and footer), with a general-advice note and an **unsubscribe** link.

**Who receives it:** clients (you can add past clients or prospects) with an email address who haven't opted out of marketing, one copy per email address.

**Unsubscribing:** when the CRM has a public https web address (Settings → Business → CRM web address), the unsubscribe link works in one click. Otherwise it opens an email to you asking to unsubscribe. Either way, untick *Marketing OK* on that contact.

**Needs:** the Anthropic API key (Settings → AI). Writing a newsletter uses web searches and usually costs around a dollar or two on your Anthropic account (web searches plus the reading and writing). Charts are built from plain email tables, so they show in every email program, including Outlook, even when pictures are blocked.

## Partner newsletter

A monthly email to your referral partners with two parts:
- **A client story:** a scenario where you helped a client.
- **Industry updates:** what's happening in lending and property.

Open **Newsletter** in the menu and choose the **Referral partners** tab.

**The client story (free text):**
- Write it any time during the month: click **Write the [month] client story**. Notes are fine, for example the situation, the challenge, what you did and the result.
- **✨ Tidy up with AI** turns your notes into a short, anonymous story with a headline and highlight tiles (e.g. "Deposit: 5%", "Approved in 6 days"). Names, addresses and employers are left out. You can edit the result, or use your own words as they are.
- **Ideas from your recent settlements** lists recently settled deals as starting points (purpose, amount, lender and days to settle, with no names or street addresses), so you just add the challenge and the result.
- Check the client is happy to be featured if they could be recognised.

**Industry updates:**
- On the **20th** of each month (you can change the day), Claude researches the month's news and writes 3 or 4 updates for your partners. Topics include rates and the RBA, lender policy, government schemes and stamp duty, and the property market.
- Each update has a **"For your clients"** line, plus sources.
- If you've written your notes, the client story is written up at the same time.
- The news sources are the ones in the client newsletter settings, plus a few industry sites (Mortgage Professional Australia, Australian Broker, Real Estate Business).

**Reminders:**
- **3 days before**, if you haven't written a client story yet, you get an email and a notification asking for one.
- **On the day**, you get an email when the newsletter is ready to review. If the story is still missing, the subject says so.
- It goes to the people set in the client newsletter settings (all admins if none are chosen).

**Reviewing and sending:**
- Edit anything: the subject, headline, introduction, key numbers, the story, each update and the closing. A live preview shows the email as a partner sees it.
- Use **Send a test to me** to check it in your inbox.
- **Send to N partners** goes from your mailbox, addressed to each partner by first name. You can untick anyone for this month. It won't send until there's a client story and at least one update.
- Each email ends with a **Refer a client** button (an email to you, ready to fill in), a link to book a catch-up (your Calendly link, or the newsletter booking link), a general-information note and an **unsubscribe** link.

**Who gets it:**
- Active partners on the **Partners & agents** page with an email address. One copy is sent per email address.
- Switch it off for anyone with the "Send them the monthly partner newsletter" box on their record. The list shows who it's on for.
- Unsubscribing switches it off for them automatically. Settings let you choose which kinds of partner receive it.

**Without AI:** the newsletter is still started on the day (with your client story) and you get the reminder. You write the updates yourself in the editor.

## Settlement letters

Every deal at *Settlement Booked* or later (and any deal with a letter started) has a **Settlement letter** card.

**Prepare letter** opens the letter, already filled in from the deal: borrowers, lender, settlement date, property, loan amount, rate, product and account number. Then add what the deal doesn't have:
- **Loan accounts:** one per split, each with its amount, rate (variable, or fixed until a date), repayment type (P&I, or interest only until a date), repayment amount and frequency, **first repayment date**, loan term and offset account. **+ Add a loan split** adds another.
- **Direct debit account:** bank, account name, BSB and account number. The letter shows only the last 4 digits unless you tick *Show the full account number*.
- **Lender phone:** the lender's customer service number. It's remembered for that lender next time.
- **Letter wording:** the opening and the *What happens next* section are editable.

**Filling it in with AI:** upload up to 6 files: the loan contract or offer, the settlement letter and the direct debit form (PDF, JPG or PNG). Then click **Read documents**.
- Claude reads them and fills in the details.
- Anything it wasn't sure about is **highlighted in yellow**, with notes (for example, where two documents disagree).
- It only uses what the documents say. Blank means it wasn't there.
- The documents are sent to Anthropic to be read and aren't kept in the CRM.
- Always check the details before sending.

**Sending:**
- **Save & preview** shows the branded letter, and **Download PDF** saves it.
- **Email to client** sends a branded email with a summary and the letter attached as a PDF, from your connected mailbox.
- The send is logged on the client and the deal, and the card shows when it was sent and to whom.

**At settlement:** when a deal moves to *Settled*, you get a high-priority task to send the letter, listing anything still missing. The task is ticked off when the letter is sent. To send it automatically instead, tick *email the settlement letter automatically* in **Settings → AI document reading & settlement letters**. A complete letter is then emailed as soon as the deal settles. If anything is missing, you get the task instead.

**Setting up AI reading (admin, once):**
1. Create an API key at console.anthropic.com.
2. Paste it into **Settings → AI document reading & settlement letters**. It's stored encrypted.

Reading a set of loan documents typically costs a few cents on your Anthropic account. You can choose a different Claude model there. If a request is declined, the API automatically retries it on a fallback model.

## Quickli (servicing)

The **Quickli servicing** card on each deal sends the deal to Quickli as a scenario, so nothing is typed twice.

**What's sent** (open *What will be sent to Quickli* on the card to see it first):
- **Household:** the borrowers, married or de facto (a partner sharing finances counts as the second adult even when they aren't borrowing), dependants and postcode.
- **Income:** each borrower's income (PAYG, pension or other) and any HECS balance.
- **Properties:** everything in the mortgage tracker (value, home or investment, rent, who owns it), plus the property being bought.
- **Existing loans:** lender, balance, limit, rate, repayments and fixed or interest-only terms, each linked to its security. Loans being refinanced by this deal are marked as paid out.
- **Other debts:** credit cards, car loans and personal loans.
- **The new loan:** amount, term, owner-occupied or investment, variable or fixed, interest-only and LVR, linked to its security.

**Using it:**
- **Send to Quickli** creates the scenario. **Update Quickli** sends changes to the same scenario.
- **Link existing** connects a scenario you already started in Quickli: paste its ID or link.
- The card shows the scenario ID (with *Open in Quickli* if you've set the scenario link), and whether Quickli says it's **ready to calculate** or what it still needs.
- The card also lists what to add in Quickli, because the CRM doesn't hold it: living expenses, self-employed financials and expected rent on a new investment.
- **Record results** keeps the headline outcome on the deal: maximum borrowing, lenders that pass, best lender and monthly surplus.

**Setting it up** (Settings → Quickli). This uses the Quickli External API (v3), which signs every request with a key registered with Quickli.
1. **Admin:** click **Make a key**. The CRM creates a key pair and keeps the private key encrypted.
2. **Admin:** send the **public key** to Quickli (support@quickli.com.au or your Quickli contact) and ask to connect the CRM to their External API. They give you a **partner ID** and a **key ID**; enter them in Settings. Optionally add the scenario link pattern (e.g. the address of a scenario in Quickli with the ID replaced by `{id}`).
3. **Each broker:** copy your access token from Quickli (*Settings → Integrations*) into **Your connection** and click **Connect**. The CRM checks it with Quickli straight away.

## Purchase calculation (funds to complete)

This works out how much a client needs to put in. Find it at the top of **Calculators**, and on every purchase deal (*Purchase*, *First home*, *Investment*, *Construction* and *Commercial*).

The table runs top to bottom:

1. **Purchase price**
2. **Loan amount** and **LVR**. Type either one and the other updates. You can type a loan amount, or set the LVR the lender allows (e.g. 80%, 90% or 95%) and the loan amount is worked out.
3. **Costs:**
   - **Deposit required** (price less loan)
   - **Stamp duty**, estimated from the state, property type, owner-occupier or investor, first home buyer and foreign purchaser options, using the same rates as the stamp duty calculator
   - **LMI fee**, an indicative estimate when the LVR is over 80%. Tick *Add to the loan* if LMI is capitalised; it's then added to the loan instead of the contribution, and the LVR including LMI is shown.
   - **Legal costs** ($2,000 to start with)
   - any **other costs** you add, such as registration fees, building & pest, lender fees or moving. To take something off the total, such as a grant, enter it as a cost with a minus amount.
4. **Total contribution**
5. Optionally, the client's **funds available**, which gives the **shortfall or surplus**.

Stamp duty and LMI are estimates: type over either one to use your own figure, and click *Use estimate* to go back to the estimate.

**On a deal**, the calculation starts from the deal's property value and loan amount. The state comes from the property address, and the first home buyer and investor settings come from the loan purpose. **Save** keeps it with the deal. **Save & update deal** also copies the purchase price, the loan amount (including any capitalised LMI) and the deposit onto the deal, and notes it in the activity. *Start again from the deal* clears a saved calculation.

## Running settlements report

**Choosing the period (both report tabs):** at the top of **Reports**, pick **Financial year** (July–June, the default), **Calendar year** (January–December) or **Custom dates** (any start and end date, up to 10 years). The period carries over when you switch between *Overview* and *Settlements*, and the CSV export uses it too.

**Reports → Settlements** shows the chosen period month by month:

- **Totals:** settled so far, commission so far (and how much has been received), what's still expected, and the projected total against your target (*Monthly settlement target* in Settings → Business, × the number of months in the period).
- **A chart** of each month's settled (solid) and expected (striped) volume. Hover a month for the figures, or open *Month-by-month table with running totals*.
- **A section per month** listing each loan: settlement date, client (both borrowers on joint loans), lender, loan type (purpose and rate type), loan amount, commission and status. Settled loans come first, then expected ones with their current stage. Each month shows its totals and the running total for the year, and the current month is highlighted.
- **Expected settlements** are open deals with a settlement date in that month. If that date has passed and the loan hasn't settled, it's flagged as **Overdue**. Lodged or approved deals without a settlement date are listed at the bottom, so add the date on the deal and they'll move into their month.
- **Commission** is the upfront commission after any referral fee. For settled loans it comes from the commission ledger (✓ = received). For expected loans it's an estimate (≈) from the lender's upfront rate.

Choose a single broker at the top to see just their loans, and use **Export CSV** to open the report in Excel.

## Running costs (Claude and SMS)

**Reports → Running costs** shows what the CRM's AI features and text messages have cost: this month, the chosen period and a running total since you started, plus a month-by-month table and chart.

**Claude (Anthropic):**
- Every request the CRM makes to Claude is recorded with its tokens, web searches and cost, and which feature made it:
  - AI assistant
  - client and partner newsletters
  - lead generator
  - property reports
  - settlement letter document reading
- Costs are worked out at Anthropic's published prices for the model that actually answered, plus US$10 per 1,000 web searches. Web page reading is free.
- Usage saved before this report existed (newsletters, property reports, lead searches and assistant chats) is included as an estimate. Settlement-letter document reading before this update wasn't recorded.
- Anthropic charges in **US dollars**. Add an exchange rate under **Settings** on the report (A$ per US$1, from your bank or card statement) to see Claude and SMS together in Australian dollars.

**SMS (ClickSend):**
- Texts record the price ClickSend reports when it sends them.
- For texts where it didn't report a price (including texts sent before this update), add your **price per SMS part**. A text over 160 characters goes as two or more parts.
- Texts that were only logged (ClickSend not connected) didn't go anywhere and cost nothing.

**By feature and by sender:** see which features use the most AI (requests, web searches, tokens and cost) and who sent the most texts.

These are close estimates. Your invoices can differ slightly (GST, credits, rounding), so check the Anthropic Console (Billing) and your ClickSend dashboard for exact amounts. ≈ marks estimated and converted figures.

## Internal refinance register

Use **Reports → Internal refinances** to keep a permanent record of clients you've moved from one of your loans to a new loan, usually with a new lender. This is the history a buyer of your business (or your aggregator) will ask for.

**Each entry has two sides, side by side, and every field can be edited:**

- **Existing loan (refinanced away):** lender, borrower(s), account number, product, loan type, rate type, loan amount, balance when refinanced, interest rate, original settlement date, the date it was discharged/paid out, and the broker who wrote it.
- **New loan:** lender, borrower(s), account or application number, product, loan type, rate type, loan amount, interest rate, settlement date and broker.
- **The rest:** the client name as you want it recorded, the status (*Needs review*, *In progress*, *Completed*), the reason (pick a common one or type your own), any clawback on the old loan, any lender cashback, and notes.

**Adding one:** click **+ Record refinance**. You can also click **+ Internal refinance** on a client's *Mortgage tracker* tab. Find the client, then use *Fill the existing loan from* and *Fill the new loan from* to copy the details from their tracker loans and deals. Change anything you like. For a lender you no longer use, choose *Other* and type its name. For loans written before you used the CRM, just type everything in.

**Added automatically:** when a deal with the purpose *Refinance* settles, and the client (or their partner) still has an active loan you arranged with a *different* lender, an entry is created with both sides filled in. Its status is *Needs review*, and you get a notification that opens it. If the client had several possible loans, the one secured by the same property (or else the largest) is chosen, and a note says so. Check the details and set the status to **Completed**. Tick *Mark the existing loan as "Refinanced"* to update the client's Mortgage tracker.

**The report** uses the same period choices as the other report tabs, plus **All dates**. Each refinance is dated by the new loan's settlement date. It shows:

- the number of refinances
- the new lending and the balances it replaced
- how many fell **within the old lender's clawback period** (worked out from the original settlement date and the lender's *clawback months* on the Lenders page)
- the cashbacks recorded
- a chart of **lender movements** (e.g. *Westpac → ANZ*)
- the full register

You can filter by broker, lender and status, or search by client, borrower or account number. **Export CSV** gives a spreadsheet with one row per refinance, with every old-loan and new-loan field, plus months held, the clawback date and the old loan's upfront commission.

## Social (LinkedIn and Instagram)

The **Social** tab lets each broker post to their own LinkedIn profile and Instagram account.

**Writing a post:**
- Write the text. **Post ideas** has ready-made posts, and **+ Disclaimer** adds a general-advice disclaimer with your business name and credit licence number.
- Add a picture, if you like: JPG or PNG, up to 8 MB.
- Tick LinkedIn, Instagram or both, and check the preview for each.
- Then **Post now**, **Schedule** (date and time) or **Save draft**.

**Checks before posting:** the CRM won't let a post go out if it breaks a network's rules:
- LinkedIn: 3,000 characters.
- Instagram: a picture is required, captions up to 2,200 characters, up to 30 hashtags, and the picture must be between portrait 4:5 and landscape 1.91:1.

**After posting:** each post shows **View on LinkedIn / Instagram** links. If a network refuses a post, the error is shown, you get a notification, and **Retry** sends it again. Scheduled posts go out within about 5 minutes of their time, while the CRM is running.

### Setting it up (admin, once)

Click **Set up** on the Social page. It shows each step and the exact addresses to copy.

- **LinkedIn:** at linkedin.com/developers, create an app (it needs your LinkedIn company page) and add the products *Share on LinkedIn* and *Sign In with LinkedIn using OpenID Connect*. Then add the redirect URL shown, and paste the Client ID and Client Secret into the CRM. Each broker then clicks **Connect LinkedIn**. LinkedIn connections last 60 days; the CRM sends you a reminder a week before you need to reconnect.
- **Instagram:** the account must be a **professional** (Business or Creator) account. At developers.facebook.com, create an app with the Instagram use case. Under *API setup with Instagram login*, copy the Instagram app ID and app secret into the CRM. While the app is in development mode, add each broker's account as an Instagram tester. Instagram connections are renewed automatically.

**Instagram and a CRM running on your own computer:** Instagram has two rules that matter when the CRM runs on your PC (http://localhost):
1. **Signing in** only returns to an **https** web address. Until the CRM has one, each broker clicks **Connect with a token** and pastes a token from the Meta App Dashboard (*Generate token*).
2. **Instagram downloads the picture itself** from the internet. Use **Picture from a link**, which is a public https link straight to the JPG or PNG. Once the CRM is on a public https address (set it in Settings → Business → *CRM web address*), uploaded pictures work too, and Instagram can be connected by signing in.

LinkedIn has neither limitation: it works from your PC as is.

## Google reviews

**Set up once:** in **Settings → Business**, paste your **Google review link**. To find it, open your Google Business Profile (search your business name on Google while signed in, or go to business.google.com), click *Ask for reviews* and copy the link (it looks like `https://g.page/r/…/review`). Until the link is added, no review requests are sent.

**After settlement:** the *Settled: ask for a Google review* automation sends the **Review request** email (with a *Leave a Google review* button) and a matching SMS, two days after the deal moves to Settled. Clients marked as having left a review are skipped. You can change the delay (0 sends on the day of settlement), wording or conditions in **Automations**, and edit the email and SMS in **Email templates → Review request**. This replaces the old review email that went 14 days after settlement, so clients aren't asked twice.

**Any time:** click **⭐ Review request** on a contact (or on a settled deal) to send a one-off request. Tick **Email**, **SMS** or both, and adjust the wording first if you like. Each contact's *Details* shows **Google review**: *Not asked yet*, *Asked [date]*, or *⭐ Left a review*. The dialog also warns you if you asked them in the last 90 days. Click **Mark as reviewed** once they've posted one, so they won't be asked again automatically.

Review requests count as marketing, so they're only sent to clients who are happy to receive marketing, and the SMS includes "Reply STOP to opt out." In any template, use `{{business.google_review_link}}`, or *Insert button → My Google review link* in the template editor.

## Annual review reminders (emailed to you)

Fourteen days before a client's annual review, the client's broker gets an email:

> **Annual review due in 14 days: Mia Jones**
> Mia Jones's annual review is due in 14 days (27 October 2026). Here's a quick snapshot to help you prepare.

The email includes:

- Contact details for the client and their partner.
- When their last lending review was done.
- Fixed-rate and interest-only periods ending in the next 12 months.
- Any open deals.
- The client's position summary and lending structure diagram.
- An **Open in the CRM** button.

A bell notification appears in the CRM too.

- **When is a review due?** On the client's *Next review date* (set automatically 12 months after you email them a lending review, or set it yourself on the contact). If there's no date, the anniversary of their most recent settlement is used. Clients and past clients are included; couples who share finances get one reminder between them.
- **Change it** in **Automations → Annual review coming up: email me**. You can set how many days ahead, change the subject or message, send it to a particular team member, or switch off the snapshot.
- **Email me (the broker) a reminder** is also available as an action in any automation, e.g. a reminder before a fixed rate expires.
- These reminders go to the broker's own email address from Outlook (or SMTP). They aren't filed on the client's timeline or emails, and they show as *🔔 reminder to you* in the Outbox.
- **Links in the email** use **Settings → Business → CRM web address**. Leave it blank if you only use the CRM on this computer (it defaults to http://localhost:3000). If you've put the CRM on a server, enter that address instead.

## Thanking referral partners

When a loan settles for a client that a referral partner sent you, the partner gets a text from your mobile, for example *"Hi Alex, great news - Liam Wilson's loan has settled. Thanks so much for the referral! Sam, EFH Mortgage Broking"*.

- The partner is the deal's **Referral partner**, which is filled in from the client's *Referred by* when the deal is created. If the deal doesn't have one, the client's is used.
- The partner needs a **mobile** number on the **Partners & agents** page. Untick *Text them when a client they referred settles* for anyone who'd rather not get these texts. The list shows whether texts are on and how many have been sent.
- The text is noted on the client's timeline and the deal (*SMS to referral partner Alex Morgan (Harbourside Realty) sent…*), but isn't counted as one of the client's own texts.
- Change the wording, add a delay, or switch it off in **Automations → Settled: thank the referral partner**. In any automation, *Send an SMS* can now go to the *Referral partner who referred the client*. Use `{{referrer.first_name}}`, `{{referrer.name}}` and `{{referrer.company}}` in messages and email templates.
- If the text is skipped (no partner, no mobile, or texts switched off), the reason shows in the automation's run history.

## Lenders: accreditation & BDMs

The **Lenders** page lists every lender with *your* accreditation number (and whether it's active, pending or due for renewal), the main BDM with their phone and an **✉ Email** button, open and settled deals, and commission rates. Use the search box to find a lender, BDM or accreditation number. Click a lender to open its page:

- **Accreditation:** your accreditation / broker ID number, status, the date you were accredited and when renewal is due. Renewals within 60 days are flagged, and overdue ones show in red. Each team member records their own; admins can add or edit anyone's with **+ Team member…**. Don't store portal passwords here.
- **BDM & lender contacts:** your BDM plus anyone else you deal with there (assistant BDM, scenario desk, credit, settlements, broker support), with email, mobile, office phone and region. Tick *Main contact* for the one shown on the Lenders list. BDM details recorded before this update were moved here automatically.
- **Emails:** everything sent to or received from that lender's contacts.
- **Open deals** with that lender, each with its own *Email BDM* link.

**Emailing a BDM:** click **✉ Email BDM** on the lender page, on the Lenders list, or on a deal (*Email [lender] BDM*). Choose who it goes to, and optionally *About a client*: start typing their name and pick them, then choose the deal. **+ Insert deal summary** adds the client, loan amount, property value and LVR, security, stage and key dates for you to edit.

When the email is about a client, it's filed on the client's timeline (e.g. *Email sent to Westpac (Hannah Price, BDM): …*), on the deal and on the lender. With Outlook connected, the BDM's replies in that conversation are filed on the client too, and you get a notification. Emails with lender contacts that aren't about a client are kept on the lender's page only.

On each deal, the Loan card shows the broker's **accreditation number** with that lender and the BDM's phone number, ready for lodging or a quick call.

## Agent, solicitor & buyer's agent

When you create a deal, the **New deal** form has an *Agent, solicitor & buyer's agent* section. For each one, pick someone you've worked with before or choose **+ Add a new…** and type their name, agency or firm, email and mobile. Everything there is optional, so you can fill it in later.

On the deal page, the **Agent & solicitor** card shows who's involved. Click an email address to write to them from your Outlook (the email is filed against the client and deal). Use **Change** or **Remove** to update them, and **+ Other…** to add an accountant, financial planner or builder.

Everyone you add is saved under **Partners & agents**, so next time you just pick them from the list. If you type in someone who's already there (same email, or the same name and company), the CRM uses the existing record instead of making a duplicate. The same directory holds your referral partners, so an agent who refers clients to you only needs entering once.

**Emailing them from templates:** on a deal, **Send template** has a *Send to* choice for the agent, solicitor and so on. Three templates are included: *Finance approved – note to agent*, *Settlement booked – note to solicitor* and *Introduction – agent & solicitor*. Merge fields:

| Field | Gives |
| --- | --- |
| `{{recipient.first_name}}`, `{{recipient.name}}` | The agent/solicitor the email is going to |
| `{{agent.name}}`, `{{agent.company}}`, `{{agent.email}}`, `{{agent.mobile}}` | The deal's real estate agent |
| `{{solicitor.name}}`, `{{solicitor.company}}`, … | The client's solicitor/conveyancer |
| `{{buyers_agent.name}}`, … | The buyer's agent |

The client's companion SMS is never sent with an email that's going to an agent or solicitor.

**Automations:** two ready-made automations keep them updated, and both start **switched off**. Only turn them on if your clients are happy for you to share finance updates:
- *Unconditional approval: tell the agents* emails the real estate agent and buyer's agent that finance is approved.
- *Settlement booked: confirm with the solicitor* emails the solicitor/conveyancer the settlement date, lender and loan amount.

You can also choose *The deal's real estate agent* (or solicitor, buyer's agent…) under **Send to** in any *Send an email* action. If the deal doesn't have one, that email is skipped and the reason shows in the automation's run history.

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

- **Settings → Branding** (admin): upload a PNG or JPG logo, then choose a main colour (colours from your logo are suggested) and a sidebar colour. Colours are adjusted automatically where needed so text stays readable.
- **Email style:** *Banner* (the default) puts your logo on a band of your main colour, with a footer in a light tint of it. *Classic* puts your logo on white under a thin colour bar. *Plain* looks like a normal email with just your signature. Every email the CRM sends uses this style: templates, automations, one-off emails and lending reviews. Replies are kept plain so they sit naturally in the conversation.
- **Email footer:** your business name, phone, email, website and ACL / credit representative number (from **Settings → Business**), plus an optional footer note such as a general-advice disclaimer.
- **Settings → My email signature** (each user): Outlook doesn't let other apps read your signature, so copy it from Outlook and paste it in. Images embedded in the signature are kept. Images that only exist on your PC (common when copying from Outlook desktop) can't be copied; add them with **Insert image**. Without a signature, your name, business name and phone are used.
- The signature is added when an email is sent, so templates end with just "Kind regards,". Replies sent from the CRM get your signature above the quoted conversation.
- Logos and signature images are embedded in the email itself, so clients see them without clicking "download pictures", even when the CRM runs on your own computer.
- **Preview** buttons (Settings, new email, Send template) show exactly how an email will look.

## Charts and diagrams in emails

Templates can include graphics that are filled in with each client's details when the email is sent, in your brand colours. In **Email templates**, open a template and use the toolbar above the message:

- **📊 Insert chart or diagram** adds one of these:

  | Graphic | Shows | Needs |
  | --- | --- | --- |
  | Loan progress tracker | Where the loan is up to, from fact find to settled | A deal |
  | Loan details card | Lender (with logo), amount, rate, property and LVR | A deal |
  | Key dates | Pre-approval expiry, finance due date and settlement, with days to go | A deal |
  | Document checklist | Documents still needed and those already received | A deal |
  | Position summary | Property value, total lending, LVR and usable equity | Mortgage tracker |
  | Lending structure diagram | Each lender and loan, what secures it, and each property's LVR | Mortgage tracker |
  | Equity chart | Each property's value split into loan and equity | Mortgage tracker |
  | Property value chart | The main property's valuations over time | Mortgage tracker (2+ valuations) |
  | Fixed rate countdown | Days until the fixed rate ends, with the loan details | A fixed-rate loan |

- **▭ Insert button** adds a button in your brand colour, for example *Book a time* linking to your Calendly booking link.
- **🖼 Insert image** uploads a picture (PNG, JPG or GIF, up to 2 MB), such as a banner, a birthday graphic or your own diagram.
- **👁 Preview** shows the email with example figures.

Each graphic sits on its own line in the message as a tag like `[[progress]]` or `[[button: Book a time | {{broker.booking_link}}]]`, so you can also move or delete it by editing the text. If a client doesn't have the details a graphic needs (e.g. no deal, or no Calendly link for a button), it's simply left out of their email. Previews flag that so you know.

The standard templates now include the right graphics. Stage-update emails have the progress tracker and key dates or loan details, *Document request* has the checklist, *Annual loan review* shows the client's position, lending structure and property value, and *Fixed rate expiry review* has the countdown. If you'd already edited one of these templates, it's left as you had it, so add graphics with the toolbar.

The charts are built from the email's own formatting rather than pictures, so they display even in email programs that block downloaded images (like Outlook does by default). The text-only copy of each email describes them in words.

You can also start a paragraph with `# ` to make it a heading, and start lines with `- ` for bullet points.

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
| Settled, for a referred client | Thank-you text **to the referral partner** ("great news, … has settled") |
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

### Changing an automation (the diagram)

Click an automation to see it as a diagram, read top to bottom: **When** → **Only if** → each step in order → **End**. The Automations list shows the same flow in a single line under each name.

- **Change a step:** click it. Its settings open in the panel on the right (on a phone, just below the step). The diagram updates as you type.
- **Add a step:** click a **+** between two steps (or **Add another step** at the bottom). Pick one of the **Suggestions**, such as *Call the client tomorrow*, *Text the client an update*, *Remind me in 3 days* or *Ask for documents*. These come filled in ready to adjust. Or pick any kind of step from the list below the suggestions.
- **Reorder, copy or delete:** use **↑ ↓**, **⧉** and **×** on the step.
- **Waits:** a step with *Wait before sending* shows **⏱ wait N days** on the line above it.
- **Conditions:** click **Only if** to add them in plain words, e.g. *New deal stage is Settled*. Stages and statuses are picked from a list.
- **Problems:** a step that still needs something, such as an email without a template, is flagged in red, and Save takes you to it.
- **Saving:** click **Save** when you're done. *Unsaved changes* shows until you do.

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

## Adding your team

In **Settings → Team**, click **+ Add user**. Enter their name, work email and role (Admin, Broker or Assistant), and leave **Email them a welcome link** ticked.

- **The welcome email** comes from your Outlook with a **Choose your password** button. The link works once and lasts 7 days. It also lists their first steps: two-factor sign-in, connecting their Outlook and (for brokers) their mobile for texts.
- **They click the button**, choose a password and are signed in. If two-factor sign-in is required, the CRM walks them through setting it up straight away.
- **The Team list** shows when each person last signed in, or *Not yet (welcome email sent …)*. Use **✉ Send again** if the email went astray; the earlier link then stops working.
- **Forgotten password:** for someone who has signed in before, the button is **✉ Password link**. It emails a link to choose a new password, which lasts 24 hours. Their two-factor sign-in stays the same.
- **If the email can't be sent** (for example, your Outlook isn't connected), the CRM shows you the link to pass on by text or Teams instead.

Nobody's password is ever emailed, and the link is removed from the Outbox once it's sent. You can still set a password for someone yourself if you prefer.

## Two-factor sign-in

After your password, the CRM asks for a 6-digit code from an authenticator app on your phone, so a stolen or guessed password isn't enough to get in. **Turn it on before the CRM goes online.**

**Setting it up (each person, about 2 minutes):**
1. Install **Microsoft Authenticator** or **Google Authenticator** on your phone (free).
2. In the CRM, go to **Settings → Two-factor sign-in → Set up two-factor sign-in**.
3. In the app, tap **+** and scan the QR code. If you're on the phone itself, use "Can't scan it?".
4. Type the 6-digit code the app shows.
5. **Save your 10 recovery codes.** Each one lets you sign in once if you lose your phone. Use Download or Copy, and keep them in a password manager or printed and filed.

**Signing in:** email and password, then the code from the app. Tick **Remember this device for 30 days** on your own computer to skip the code there.

**Lost your phone?**
- Sign in with a recovery code ("Lost your phone? Use a recovery code"), then set it up on the new phone.
- Or ask an admin to **Reset** you (Settings → Two-factor sign-in → For your team). You'll be signed out and set it up again at your next sign-in.

**For admins:** tick **Require two-factor sign-in for everyone**. Anyone who hasn't set it up is taken to the set-up screen the next time they use the CRM, and can't use anything else until they have. You must set it up for yourself first. The team list shows who has it on.

**Good to know:**
- The phone needs its clock set automatically, because codes change every 30 seconds.
- Turning it on signs you out on other devices.
- New recovery codes need your password, and make the old ones stop working.
- Codes can't be reused, and wrong codes are limited: 5 per sign-in, then the password is asked for again.

## Backups

The CRM backs itself up. Open **Settings → Backups** (admins only).

**What's backed up:** each backup is a folder holding:
- `crm.db`: all your clients, deals, uploaded documents and settings
- `secret.key`: unlocks the saved passwords and connections (Outlook, ClickSend, the AI key…)

Each copy is checked after it's made, and it's a single file that's safe to copy.

**When:**
- **Every day** at the time you choose (11pm by default). The computer must be on with the CRM running at that time, or the backup runs next time it is.
- **Before every update.** When an update changes the database, a copy is made first, before anything changes.
- **Whenever you press "Back up now".**

**Where:** by default, a `backups` folder inside the `data` folder. That only protects against mistakes, not against losing the computer. **Choose a folder that syncs to the cloud**, such as `C:\Users\you\OneDrive\CRM Backups`, a Google Drive or Dropbox folder, or a USB drive you keep elsewhere. The CRM warns you while backups are only on this computer.

**How many are kept:**
- the last 14 days, plus the first backup of each of the last 12 months (both adjustable)
- the last 5 backups made before updates
- every manual backup, until you delete it yourself

Folders the CRM didn't create are never touched.

**If something goes wrong:** admins get a notification and an email when a nightly backup fails, and it's retried an hour later. The dashboard shows a warning when backups are off, failing, or haven't run for more than 3 days.

**Restoring a backup:** in **Settings → Backups → Restore from a backup**, choose the `crm.db` and `secret.key` from one backup folder. The CRM checks them, saves a copy of what's there now, and swaps them in. Everyone then signs in again. This is also how you move the CRM to a new computer or server.

If the CRM won't start, restore by hand:
1. Stop the CRM (close the window running `npm start`).
2. In the `data` folder, rename `crm.db` to `crm-old.db` and `secret.key` to `secret-old.key`, just in case.
3. Copy `crm.db` and `secret.key` from the backup folder into the `data` folder. Delete any `crm.db-wal` or `crm.db-shm` files left in the `data` folder.
4. Start the CRM again (`npm start`).

Backups contain your clients' personal and financial information. Keep the backup folder private, and only share it with people who should see that data.

## Security notes

- Optional (and recommended) two-factor sign-in with an authenticator app; admins can require it for everyone. Secrets are stored encrypted and recovery codes hashed.
- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies, and logins are rate-limited.
- Write requests must be JSON, which blocks cross-site form posts. The app sends a strict Content-Security-Policy.
- Assistants cannot manage users or business settings.
- CSV exports neutralise spreadsheet formulas. Document links must be http(s).
- Outlook tokens and the Microsoft client secret are encrypted (AES-256-GCM) with a key kept in `data/secret.key`, or in `ENCRYPTION_KEY` if set.
- Back up the `data` folder regularly. It holds personal and financial information, including documents clients upload through the online fact find, so store backups securely.
- Online fact-find links are long random codes, stored encrypted. They expire (30 days by default) and can be cancelled. Uploaded files are checked by their contents, and only PDFs, photos, and Word and Excel files are accepted.

## Updating to a new version

Your data lives in the `data` folder: `crm.db` and `secret.key`. To update, download the new version, copy your old `data` folder into it, then run `npm install` and `npm start`. Database changes are applied automatically on start. A backup of your data is made automatically first (see [Backups](#backups)), so you can always go back.

## Disclaimer

The calculators give estimates for client conversations and are not a lender's credit assessment. Default lender commission rates are indicative; update them to match your aggregator's schedule.
