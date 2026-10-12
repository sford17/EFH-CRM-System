'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { default: writeXlsxFile } = require('write-excel-file/node');

let srv;
let api;
let db;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => srv.close());

const importer = require('../src/services/importer');
const { addDays, today } = require('../src/util');

test('value parsing: Australian dates, money, rates, phones', () => {
  assert.equal(importer.parseDate('04/03/1985').value, '1985-03-04', 'day first');
  assert.equal(importer.parseDate('4/3/85').value, '1985-03-04');
  assert.equal(importer.parseDate('15-07-2024').value, '2024-07-15');
  assert.equal(importer.parseDate('2024-07-15').value, '2024-07-15');
  assert.equal(importer.parseDate('1 Jan 2020').value, '2020-01-01');
  assert.equal(importer.parseDate('March 5, 2021').value, '2021-03-05');
  assert.equal(importer.parseDate(45488).value, '2024-07-15', 'Excel serial number');
  assert.equal(importer.parseDate(new Date('2024-07-15T00:00:00Z')).value, '2024-07-15');
  const us = importer.parseDate('12/31/2024');
  assert.equal(us.value, '2024-12-31');
  assert.match(us.warning, /month\/day/);
  assert.ok(importer.parseDate('31/02/2024').error);
  assert.ok(importer.parseDate('soon').error);

  assert.equal(importer.parseMoney('$450,000').value, 450000);
  assert.equal(importer.parseMoney('450k').value, 450000);
  assert.equal(importer.parseMoney('1.2m').value, 1200000);
  assert.ok(importer.parseMoney('lots').error);
  assert.equal(importer.parsePercent('5.89%').value, 5.89);
  assert.equal(importer.parsePercent(0.0589).value, 5.89, 'Excel percent cell');
  assert.ok(importer.parsePercent('89').error);
  assert.equal(importer.parsePhone(412345678).value, '0412 345 678', 'Excel dropped the leading 0');
  assert.equal(importer.parsePhone('+61 412 345 678').value, '0412 345 678');
  assert.equal(importer.parsePhone('0298765432').value, '(02) 9876 5432');
  assert.deepEqual(importer.splitName('Citizen, Jane'), { first_name: 'Jane', last_name: 'Citizen' });
  assert.deepEqual(importer.splitName('Mary Jane Smith'), { first_name: 'Mary', last_name: 'Jane Smith' });
});

test('column headers are matched to fields', () => {
  const headers = ['Client Name', 'Given Name', 'Surname', 'E-mail', 'Mobile Phone', 'D.O.B.', 'Bank', 'Loan Amt', 'Loan Amount ($)', 'Fixed Rate Expiry', 'Date Settled', 'Favourite colour'];
  const m = importer.guessMapping(headers);
  assert.deepEqual(m, ['', 'first_name', 'last_name', 'email', 'mobile', 'dob', 'lender', '', 'loan_amount', 'fixed_expiry_date', 'settlement_date', '']);
});

async function xlsxBase64(rows) {
  const data = rows.map((r) => r.map((v) => (v instanceof Date ? { type: Date, value: v, format: 'dd/mm/yyyy' } : typeof v === 'number' ? { type: Number, value: v } : { value: v })));
  const buf = await writeXlsxFile([{ data: [[{ value: 'Exported from old CRM' }], [], ...data], sheet: 'Clients' }, { data: [[{ value: 'Notes' }, { value: 'x' }]], sheet: 'Other' }]).toBuffer();
  return buf.toString('base64');
}

let parsed;
const soon = addDays(today(), 40);

test('parsing an Excel workbook finds the header row and guesses the mapping', async () => {
  await api.post('/contacts', { first_name: 'Existing', email: 'existing@example.com', mobile: '0400 000 001', status: 'client' });
  const data = await xlsxBase64([
    ['Name', 'Email', 'Mobile', 'DOB', 'Status', 'Lender', 'Loan Amount', 'Rate', 'Fixed Expiry', 'Settlement Date', 'State'],
    ['Jane Citizen', 'JANE@example.com', 412345678, new Date('1985-03-04T00:00:00Z'), 'Active client', 'CBA', 520000, 0.0589, soon, '15/07/2024', 'new south wales'],
    ['Bob Builder', 'bob@example.com', '0422 222 222', '', 'Past', 'Tiny Credit Union', '$300k', '6.2%', '', '1/2/2019', 'VIC'],
    ['Jane Citizen', 'jane@example.com', '', '', '', '', '', '', '', '', ''],
    ['Existing Person', 'Existing@Example.com', '', '', 'client', 'NAB', 410000, 6.1, '', '2022-05-01', ''],
    ['', '', '0499 999 999', '', '', '', '', '', '', '', ''],
    ['Lee Lead', 'lee@example.com', '', '31/02/1990', 'enquiry', '', '', '', '', '', 'QLD'],
  ]);
  const r = await api.post('/import/parse', { filename: 'clients.xlsx', data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.sheets.map((s) => s.name), ['Clients', 'Other']);
  parsed = r.data.sheets[0];
  assert.equal(parsed.header_row, 3, 'title and blank rows above the headers are skipped');
  assert.equal(parsed.rows.length, 6);
  assert.deepEqual(parsed.mapping, ['full_name', 'email', 'mobile', 'dob', 'status', 'lender', 'loan_amount', 'interest_rate', 'fixed_expiry_date', 'settlement_date', 'state']);
  assert.equal(parsed.rows[0][3], '1985-03-04', 'Excel dates come through as dates');
});

test('preview flags problems, duplicates and new lenders', async () => {
  const body = { filename: 'clients.xlsx', sheet: 'Clients', headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, options: {} };
  const { summary, records } = (await api.post('/import/preview', body)).data;
  assert.deepEqual(
    { create: summary.create, skip: summary.skip, loans: summary.loans, errors: summary.with_errors },
    { create: 3, skip: 3, loans: 2, errors: 1 },
  );
  assert.deepEqual(summary.new_lenders, ['Tiny Credit Union']);
  const byRow = Object.fromEntries(records.map((r) => [r.row, r]));
  assert.equal(byRow[1].contact.first_name, 'Jane');
  assert.equal(byRow[1].contact.email, 'jane@example.com');
  assert.equal(byRow[1].contact.mobile, '0412 345 678');
  assert.equal(byRow[1].contact.status, 'client');
  assert.equal(byRow[1].contact.state, 'NSW');
  assert.equal(byRow[1].loan.lender_name, 'Commonwealth Bank');
  assert.equal(byRow[1].loan.interest_rate, 5.89);
  assert.equal(byRow[1].loan.rate_type, 'fixed', 'fixed expiry implies a fixed rate');
  assert.equal(byRow[2].contact.status, 'past_client');
  assert.equal(byRow[2].loan.loan_amount, 300000);
  assert.match(byRow[3].warnings.join(), /Same person as row 1/);
  assert.equal(byRow[4].duplicate_of > 0, true);
  assert.match(byRow[4].warnings.join(), /Already in the CRM – skipped/);
  assert.deepEqual(byRow[5].errors, ['No name']);
  assert.match(byRow[6].warnings.join(), /31\/02\/1990/);
  assert.equal(byRow[6].contact.status, 'lead');

  const missingName = await api.post('/import/preview', { ...body, mapping: parsed.mapping.map((m) => (m === 'full_name' ? '' : m)) });
  assert.equal(missingName.status, 400);
});

test('import creates clients and loans without messaging anyone; undo removes them', async () => {
  const outboxBefore = db.one('SELECT COUNT(*) AS n FROM outbox').n;
  const smsBefore = db.one('SELECT COUNT(*) AS n FROM sms_messages').n;
  const body = {
    filename: 'clients.xlsx', sheet: 'Clients', headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping,
    options: { duplicates: 'update', tag: 'imported', default_status: 'client' },
  };
  const r = (await api.post('/import/commit', body)).data;
  assert.equal(r.contacts_created, 3);
  assert.equal(r.contacts_updated, 1, 'existing contact had blanks filled');
  assert.equal(r.deals_created, 3, 'Jane, Bob and the existing person each get their loan');
  assert.ok(r.held_automations >= 1, 'fixed-rate expiry due within 90 days is held');

  const jane = db.one("SELECT * FROM contacts WHERE email = 'jane@example.com'");
  assert.equal(jane.tags, 'imported');
  assert.equal(jane.dob, '1985-03-04');
  const loan = db.one('SELECT d.*, l.name AS lender FROM deals d JOIN lenders l ON l.id = d.lender_id WHERE d.contact_id = ?', jane.id);
  assert.equal(loan.stage, 'settled');
  assert.equal(loan.lender, 'Commonwealth Bank');
  assert.equal(loan.fixed_expiry_date, soon);
  assert.equal(loan.settlement_date, '2024-07-15');
  assert.ok(db.one("SELECT 1 AS x FROM lenders WHERE name = 'Tiny Credit Union'"), 'unknown lender added');
  const existing = db.one("SELECT * FROM contacts WHERE email = 'existing@example.com'");
  assert.equal(existing.first_name, 'Existing', 'existing details are not overwritten');
  assert.match(existing.tags, /imported/);

  // Nothing went out: no welcome emails, no stage texts, and the already-due
  // fixed-rate review was held rather than sent.
  await api.post('/automations/run-scheduled');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM outbox').n, outboxBefore);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM sms_messages').n, smsBefore);
  assert.ok(db.one("SELECT 1 AS x FROM automation_runs WHERE status = 'skipped' AND entity_type = 'deal' AND entity_id = ?", loan.id));
  const lee = db.one("SELECT id FROM contacts WHERE email = 'lee@example.com'");
  assert.ok(db.one("SELECT 1 AS x FROM automation_runs WHERE status = 'skipped' AND entity_id = ? AND run_key LIKE '%:contact:%'", lee.id), 'stale-lead chaser held for imported leads');

  const history = (await api.get('/import/history')).data.rows;
  assert.equal(history[0].contacts_created, 3);

  const u = (await api.post(`/import/${r.import_id}/undo`)).data;
  assert.deepEqual(u, { contacts_removed: 3, deals_removed: 3 });
  assert.equal(db.one("SELECT COUNT(*) AS n FROM contacts WHERE email IN ('jane@example.com','bob@example.com','lee@example.com')").n, 0);
  assert.ok(db.one("SELECT 1 AS x FROM contacts WHERE email = 'existing@example.com'"), 'pre-existing contact kept');
  assert.equal((await api.post(`/import/${r.import_id}/undo`)).status, 400);
});

test('CSV files (semicolon separated) and bad files', async () => {
  const csvText = 'First Name;Last Name;Email;Settlement Date;Loan Amount;Lender\nAmy;Lee;amy@example.com;01/02/2023;350000;Westpac\n';
  const r = (await api.post('/import/parse', { filename: 'export.csv', data: Buffer.from(csvText).toString('base64') })).data;
  const s = r.sheets[0];
  assert.deepEqual(s.mapping, ['first_name', 'last_name', 'email', 'settlement_date', 'loan_amount', 'lender']);
  const c = (await api.post('/import/commit', { filename: 'export.csv', headers: s.headers, rows: s.rows, mapping: s.mapping, options: {} })).data;
  assert.equal(c.contacts_created, 1);
  assert.equal(c.deals_created, 1);

  const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]).toString('base64');
  assert.match((await api.post('/import/parse', { filename: 'old.xls', data: xls })).data.error, /Save As/);
  const tpl = await api.get('/import/template.csv');
  assert.match(tpl.data, /^First Name,Surname,Email,Mobile,DOB/);
});
