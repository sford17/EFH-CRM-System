'use strict';
const db = require('./index');
const auth = require('../auth');
const commissions = require('../services/commissions');
const documents = require('../services/documents');
const tracker = require('../services/tracker');
const { today, addDays, addMonths } = require('../util');

// Sample data so the CRM can be explored straight away. Only runs on an empty
// contacts table.
function seedDemo() {
  if (db.one('SELECT 1 FROM contacts LIMIT 1')) {
    console.log('Contacts already exist – skipping demo data.');
    return;
  }
  const t0 = today();
  const lender = (name) => db.one('SELECT id FROM lenders WHERE name = ?', name)?.id ?? null;

  db.transaction(() => {
    const userId = (email, name, role) => db.one('SELECT id FROM users WHERE email = ?', email)?.id
      ?? db.insert('users', { name, email, role, password_hash: auth.hashPassword('changeme123'), phone: '0400 000 000' });
    const admin = userId('admin@efh.local', 'Sam Ford', 'admin');
    const broker = userId('broker@efh.local', 'Jordan Lee', 'broker');
    userId('assistant@efh.local', 'Casey Nguyen', 'assistant');

    const partner = (row) => db.insert('referral_partners', row);
    const reAgent = partner({ name: 'Alex Morgan', company: 'Harbourside Realty', type: 'real_estate', email: 'alex@harbourside.example', referral_fee_pct: 0 });
    const accountant = partner({ name: 'Priya Shah', company: 'Shah & Co Accountants', type: 'accountant', email: 'priya@shahco.example', referral_fee_pct: 20 });
    partner({ name: 'Tom Barker', company: 'Barker Conveyancing', type: 'solicitor', email: 'tom@barker.example' });

    const contact = (row) => db.insert('contacts', { owner_id: admin, marketing_opt_in: 1, ...row });
    const c = {
      olivia: contact({ first_name: 'Olivia', last_name: 'Brown', email: 'olivia@example.com', mobile: '0411 111 111', status: 'lead', lead_source: 'website', employment_type: 'payg', annual_income: 98000, suburb: 'Parramatta', state: 'NSW' }),
      liam: contact({ first_name: 'Liam', last_name: 'Wilson', email: 'liam@example.com', mobile: '0422 222 222', status: 'prospect', lead_source: 'referral', referral_partner_id: reAgent, employment_type: 'payg', annual_income: 145000, suburb: 'Manly', state: 'NSW' }),
      ava: contact({ first_name: 'Ava', last_name: 'Taylor', email: 'ava@example.com', mobile: '0433 333 333', status: 'prospect', lead_source: 'referral', referral_partner_id: accountant, employment_type: 'self_employed', annual_income: 210000, suburb: 'Fitzroy', state: 'VIC', owner_id: broker }),
      noah: contact({ first_name: 'Noah', last_name: 'Smith', email: 'noah@example.com', mobile: '0444 444 444', status: 'prospect', lead_source: 'social', annual_income: 88000, suburb: 'Ipswich', state: 'QLD', tags: 'first home buyer' }),
      mia: contact({ first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com', mobile: '0455 555 555', status: 'client', lead_source: 'repeat', dob: `1985-${t0.slice(5)}`, suburb: 'Newtown', state: 'NSW', tags: 'investor' }),
      jack: contact({ first_name: 'Jack', last_name: 'Williams', email: 'jack@example.com', mobile: '0466 666 666', status: 'client', lead_source: 'referral', referral_partner_id: reAgent, suburb: 'Glenelg', state: 'SA' }),
      grace: contact({ first_name: 'Grace', last_name: 'Martin', email: 'grace@example.com', mobile: '0477 777 777', status: 'past_client', lead_source: 'website', suburb: 'Subiaco', state: 'WA', next_review_date: addDays(t0, -1) }),
      ethan: contact({ first_name: 'Ethan', last_name: 'Clarke', email: 'ethan@example.com', mobile: '0488 888 888', status: 'lost', lead_source: 'website', suburb: 'Belconnen', state: 'ACT', tags: 'nurture' }),
      tom: contact({ first_name: 'Tom', last_name: 'Jones', email: 'tom@example.com', mobile: '0455 555 556', status: 'client', lead_source: 'repeat', suburb: 'Newtown', state: 'NSW', employment_type: 'payg', annual_income: 132000 }),
      zoe: contact({ first_name: 'Zoe', last_name: 'Clarke', email: 'zoe@example.com', mobile: '0499 999 999', status: 'prospect', lead_source: 'walk_in', suburb: 'Belconnen', state: 'ACT' }),
    };

    // Mia and Tom are married and share their finances.
    db.insert('contact_relationships', { contact_id: c.mia, related_id: c.tom, relationship: 'spouse', shared_finances: 1 });

    const deal = (row, history = []) => {
      const id = db.insert('deals', { owner_id: admin, ...row });
      let from = null;
      for (const stage of [...history, row.stage]) {
        db.insert('deal_stage_history', { deal_id: id, from_stage: from, to_stage: stage, changed_by: admin });
        from = stage;
      }
      documents.createChecklist(id);
      return id;
    };

    deal({ title: 'Olivia Brown – first home', contact_id: c.olivia, loan_purpose: 'first_home', property_value: 650000, loan_amount: 585000, stage: 'lead' });
    deal({ title: 'Liam Wilson – purchase Manly', contact_id: c.liam, loan_purpose: 'purchase', property_value: 1650000, loan_amount: 1200000, lender_id: lender('Macquarie Bank'), interest_rate: 5.89, stage: 'fact_find', referral_partner_id: reAgent }, ['lead']);
    deal({ title: 'Ava Taylor – investment', contact_id: c.ava, loan_purpose: 'investment', property_value: 820000, loan_amount: 656000, lender_id: lender('ING'), interest_rate: 6.09, stage: 'pre_approval', pre_approval_expiry: addDays(t0, 10), owner_id: broker, referral_partner_id: accountant }, ['lead', 'fact_find']);
    deal({ title: 'Noah Smith – first home Ipswich', contact_id: c.noah, loan_purpose: 'first_home', property_value: 540000, loan_amount: 513000, lender_id: lender('Commonwealth Bank'), interest_rate: 5.99, stage: 'application_lodged', finance_due_date: addDays(t0, 3), application_ref: 'CBA-2210931' }, ['lead', 'fact_find', 'pre_approval']);
    deal({ title: 'Zoe Clarke – refinance', contact_id: c.zoe, loan_purpose: 'refinance', property_value: 900000, loan_amount: 540000, lender_id: lender('NAB'), interest_rate: 5.74, stage: 'conditional_approval' }, ['lead', 'fact_find', 'application_lodged']);
    deal({ title: 'Mia Jones – investment #2', contact_id: c.mia, loan_purpose: 'investment', property_value: 720000, loan_amount: 576000, lender_id: lender('ANZ'), interest_rate: 6.04, stage: 'settlement_booked', settlement_date: addDays(t0, 2) }, ['lead', 'fact_find', 'application_lodged', 'conditional_approval', 'unconditional_approval']);

    const settled = [
      { title: 'Mia & Tom Jones – home loan', contact_id: c.mia, co_borrower_id: c.tom, loan_purpose: 'purchase', property_address: '8 King St, Newtown NSW 2042', property_value: 950000, loan_amount: 760000, lender_id: lender('Westpac'), interest_rate: 5.69, rate_type: 'fixed', fixed_expiry_date: addDays(t0, 75), settlement_date: addMonths(t0, -34) },
      { title: 'Jack Williams – purchase Glenelg', contact_id: c.jack, loan_purpose: 'purchase', property_address: '27 Seaview Tce, Glenelg SA 5045', property_value: 1100000, loan_amount: 880000, lender_id: lender('Bankwest'), interest_rate: 5.84, settlement_date: addMonths(t0, -12), referral_partner_id: reAgent },
      { title: 'Grace Martin – refinance', contact_id: c.grace, loan_purpose: 'refinance', property_address: '5 Rokeby Rd, Subiaco WA 6008', property_value: 780000, loan_amount: 450000, lender_id: lender('Suncorp'), interest_rate: 5.95, rate_type: 'split', fixed_expiry_date: addMonths(t0, 8), settlement_date: addMonths(t0, -5) },
    ];
    for (const s of settled) {
      const id = deal({ ...s, stage: 'settled', stage_changed_at: `${s.settlement_date}T00:00:00.000Z`, created_at: `${addDays(s.settlement_date, -42)}T00:00:00.000Z` }, ['lead', 'application_lodged', 'unconditional_approval']);
      db.run("UPDATE documents SET status = 'verified' WHERE deal_id = ?", id);
      commissions.generateForDeal(id);
      tracker.createFromDeal(id);
    }
    db.run("UPDATE commissions SET status = 'received', received_at = period || '-15' WHERE period < ?", t0.slice(0, 7));

    // Mia is an investor: a fuller mortgage-tracker picture.
    const miaHome = db.one("SELECT id FROM properties WHERE contact_id = ? AND address LIKE '8 King St%'", c.mia).id;
    const val = (propertyId, monthsAgo, amount, method, provider) => db.insert('valuations', {
      property_id: propertyId, valuation_date: addMonths(t0, -monthsAgo), amount, method, provider,
    });
    val(miaHome, 14, 1050000, 'full', 'Herron Todd White');
    val(miaHome, 7, 1120000, 'desktop', 'Westpac');
    val(miaHome, 1, 1185000, 'avm', 'CoreLogic');
    db.update('properties', miaHome, { property_type: 'house', bedrooms: 3, co_owner_id: c.tom });
    const miaUnit = db.insert('properties', {
      contact_id: c.mia, address: '12/45 Enmore Rd, Newtown NSW 2042', property_type: 'unit', usage: 'investment', bedrooms: 2,
      purchase_date: addMonths(t0, -52), purchase_price: 560000, rental_income_weekly: 620,
    });
    val(miaUnit, 52, 560000, 'contract_price', null);
    val(miaUnit, 2, 655000, 'avm', 'CoreLogic');
    const westpac = lender('Westpac');
    const invLoan = db.insert('loans', {
      contact_id: c.mia, lender_id: westpac, loan_type: 'investment_loan', account_number: 'WBC-448812', limit_amount: 480000, balance: 476500,
      balance_date: t0, interest_rate: 6.24, rate_type: 'variable', repayment_type: 'io', io_expiry_date: addDays(t0, 70),
      repayment_amount: 2478, settlement_date: addMonths(t0, -52), loan_term_years: 30, offset_balance: 18000,
    });
    db.run('INSERT INTO loan_securities (loan_id, property_id) VALUES (?, ?), (?, ?)', invLoan, miaHome, invLoan, miaUnit);
    db.insert('loans', {
      contact_id: c.mia, lender_name: 'NAB', lender_id: lender('NAB'), loan_type: 'credit_card', limit_amount: 10000, balance: 3200,
      balance_date: t0, interest_rate: 20.99, arranged_by_us: 0,
    });
    db.insert('client_assets', { contact_id: c.mia, asset_type: 'superannuation', institution: 'AustralianSuper', value: 212000, value_date: t0 });
    db.insert('client_assets', { contact_id: c.tom, asset_type: 'superannuation', institution: 'HESTA', value: 168000, value_date: t0 });
    db.insert('client_assets', { contact_id: c.mia, asset_type: 'savings', institution: 'ING', description: 'Emergency fund', value: 35000, value_date: t0 });

    deal({ title: 'Ethan Clarke – purchase', contact_id: c.ethan, loan_purpose: 'purchase', property_value: 700000, loan_amount: 630000, stage: 'lost', lost_reason: 'Went direct to bank' }, ['lead', 'fact_find']);

    const task = (row) => db.insert('tasks', { assigned_to: admin, created_by: admin, ...row });
    task({ title: 'Call Olivia – new enquiry', contact_id: c.olivia, due_date: t0, priority: 'high' });
    task({ title: 'Collect payslips from Liam', contact_id: c.liam, due_date: addDays(t0, -1) });
    task({ title: 'Order valuation for Zoe refinance', contact_id: c.zoe, due_date: addDays(t0, 1) });

    const note = (contactId, type, body) => db.insert('activities', { contact_id: contactId, user_id: admin, type, body });
    note(c.liam, 'call', 'Initial call. Looking at 3-bed houses in Manly, budget ~$1.6m. Pre-approval needed within 2 weeks.');
    note(c.ava, 'meeting', 'Met with Ava and accountant. Company financials FY24 & FY25 to come.');
    note(c.noah, 'note', 'Using First Home Guarantee – 5% deposit, no LMI.');
  });
}

module.exports = { seedDemo };
