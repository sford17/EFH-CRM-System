# EFH CRM

A CRM built for a mortgage broking business. It tracks leads, clients and loans from first enquiry through settlement, and automates the follow-ups that keep a broking pipeline moving: welcome emails, document chasing, pre-approval and finance-date warnings, settlement tasks, fixed-rate expiry reviews, birthdays and annual reviews.

## Features

| Area | What it does |
| --- | --- |
| **Dashboard** | Open pipeline, settlements against a monthly target, commission, overdue tasks, upcoming finance/settlement/expiry dates, recent activity |
| **Contacts** | Leads → prospects → clients, with owner, lead source, referral partner, tags, income and employment details, marketing opt-in, review date. Full activity timeline (calls, emails, meetings, notes). CSV export |
| **Related contacts & households** | Link partners, family, guarantors and advisers. Couples who share finances see one combined mortgage tracker on both profiles, keep a shared address, become joint borrowers on new deals by default, and can have emails, templates and lending reviews addressed to one or both of them |
| **Spreadsheet import** | Import existing clients and their loans from Excel (.xlsx) or CSV. Columns are matched automatically, with a preview, duplicate handling and one-click undo. Imported clients aren't sent welcome or stage messages |
| **Pipeline** | Kanban board across New Lead → Fact Find → Pre-Approval → Application Lodged → Conditional → Unconditional → Settlement Booked → Settled / Lost. Drag and drop, or use the stage menu |
| **Deals** | Loan amount, property value, auto-calculated LVR, lender, product, rate, fixed-rate expiry, pre-approval expiry, finance and settlement dates, co-borrower, stage history |
| **Agent & solicitor** | Record the real estate agent, solicitor/conveyancer and buyer's agent (plus accountant, builder or planner) on each deal, straight from the New deal form. They're kept in a directory so you pick them again next time, can be emailed from the deal, appear in merge fields, and can be kept updated automatically |
| **Document checklists** | Standard checklist built automatically by loan purpose (plus self-employed docs), with status tracking and a one-click "email the client what's outstanding" |
| **Tasks** | Personal and team tasks, overdue/today/upcoming views, tasks auto-created by automations |
| **Automations** | Rules engine: *when* (event or schedule) → *only if* (conditions) → *then* (actions). 28 ready-made automations, fully editable in the UI |
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
| **Commissions** | Upfront, trail (first 12 months), referral fees and clawbacks, generated automatically at settlement from lender rates. Ledger with received tracking and a clawback-exposure report |
| **Partners & agents** | One directory of real estate agents, buyer's agents, solicitors, conveyancers, accountants, planners and builders, with referral counts, settled volume, fee splits and the deals they're on |
| **Lenders** | Your accreditation numbers (each broker's own, with renewal dates), BDMs and other lender contacts, emailing the BDM (filed on the client when it's about one, replies included), commission rates, clawback periods, settled volume, and logos shown across the pipeline, tracker, review documents and client emails |
| **Internal refinance register** | A record of every client you've moved from one of your loans to a new one, with the existing loan beside the new loan (borrowers, lender, account, product, amounts, rates, settlement and pay-out dates, broker), plus the reason, clawback and cashback. Every field is editable. It's added automatically when a refinance deal settles, and a CSV export is there for sale or trail-book records |
| **Social** | Connect each broker's LinkedIn profile and Instagram professional account, then write a post with a picture, see a preview for each, and post now, schedule it or save a draft. Post ideas, a general-advice disclaimer, links to the live posts, and retry if a network refuses a post |
| **Reports** | Running settlements by financial year (settled and expected, month by month, with client, lender, loan type, amount and commission), plus settlements by month, stage movement, lead-source conversion, lender split, partner performance, commission by month, lost reasons, average days to settle |
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
