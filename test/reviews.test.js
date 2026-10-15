'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

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

const { today, addDays, addMonths } = require('../src/util');
let client;
let reviewId;

async function binary(path) {
  const cookie = await (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${srv.base}${path}`, { headers: { Cookie: cookie } });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

test('a new review snapshots the tracker and drafts commentary', async () => {
  await api.put('/settings', { business_name: 'EFH Mortgage Broking', acl_number: 'Credit Rep 123456', business_phone: '02 9000 0000' });
  client = (await api.post('/contacts', { first_name: 'Rhys', last_name: 'Review', email: 'rhys@example.com', status: 'client' })).data;
  const home = (await api.post('/tracker/properties', { contact_id: client.id, address: '3 Park Ave, Ryde NSW', valuation: { amount: 1000000, method: 'full' } })).data;
  db.run('UPDATE valuations SET valuation_date = ? WHERE property_id = ?', addMonths(today(), -20), home.id);
  const unit = (await api.post('/tracker/properties', { contact_id: client.id, address: '7/9 Beach St, Coogee NSW', usage: 'investment', valuation: { amount: 600000, method: 'avm' } })).data;
  const cba = db.one("SELECT id FROM lenders WHERE name = 'Commonwealth Bank'").id;
  await api.post('/tracker/loans', { contact_id: client.id, lender_id: cba, loan_type: 'home_loan', balance: 650000, interest_rate: 5.79, rate_type: 'fixed', fixed_expiry_date: addDays(today(), 80), security_ids: [home.id] });
  await api.post('/tracker/loans', { contact_id: client.id, lender_id: cba, loan_type: 'investment_loan', balance: 420000, interest_rate: 6.4, repayment_type: 'io', io_expiry_date: addDays(today(), 200), security_ids: [home.id, unit.id] });
  await api.post('/tracker/loans', { contact_id: client.id, lender_name: 'Amex', loan_type: 'credit_card', balance: 6000, interest_rate: 21.99 });
  await api.post('/tracker/assets', { contact_id: client.id, asset_type: 'savings', value: 40000 });

  const r = (await api.post('/reviews', { contact_id: client.id })).data;
  reviewId = r.id;
  assert.equal(r.status, 'draft');
  assert.equal(r.snapshot, undefined, 'snapshot not sent to the browser');
  assert.match(r.loan_review, /You have 3 active loans totalling \$1,076,000 with 2 lenders/);
  assert.match(r.loan_review, /• Commonwealth Bank home loan: \$650,000 at 5\.79% fixed until/);
  const consider = r.actions_to_consider;
  assert.match(consider, /fixed rate on the Commonwealth Bank home loan ends on/);
  assert.match(consider, /interest-only period on the Commonwealth Bank investment loan ends/);
  assert.match(consider, /cross-collateralised/);
  assert.match(consider, /variable rate of 6\.4%/);
  assert.match(consider, /\$6,000 on the Amex credit card is costing 21\.99%/);
  assert.match(consider, /offset account/);
  assert.match(r.broker_to_action, /Order an updated valuation for 3 Park Ave \(last: Full valuation/);
  assert.match(r.next_steps, /next review is due around/);
  assert.ok((await api.get(`/contacts/${client.id}`)).data.activities.some((a) => a.body === 'Lending review started'));
});

test('commentary edits are saved; refreshing updates figures but keeps commentary', async () => {
  await api.patch(`/reviews/${reviewId}`, { loan_review: 'Your loans are in good shape.\n- Point one\n- Point two', next_steps: '1. Call us\n2. Book review' });
  assert.equal((await api.patch(`/reviews/${reviewId}`, { title: '' })).status, 400);
  const unitVal = db.one("SELECT p.id FROM properties p WHERE p.address LIKE '7/9 Beach%'");
  await api.post(`/tracker/properties/${unitVal.id}/valuations`, { valuation_date: today(), amount: 700000, method: 'desktop' });
  let r = (await api.get(`/reviews/${reviewId}`)).data;
  assert.equal(r.totals.property_value, 1600000, 'snapshot is frozen until refreshed');
  await api.post(`/reviews/${reviewId}/refresh`);
  r = (await api.get(`/reviews/${reviewId}`)).data;
  assert.equal(r.totals.property_value, 1700000);
  assert.equal(r.loan_review, 'Your loans are in good shape.\n- Point one\n- Point two');
});

test('preview, PDF and Word versions', async () => {
  const { res: pre, buf: html } = await binary(`/reviews/${reviewId}/preview`);
  assert.match(pre.headers.get('content-security-policy'), /default-src 'none'/);
  const h = html.toString();
  for (const s of ['Client Lending Review', 'Prepared for <strong>Rhys Review</strong>', 'LOAN REVIEW', 'Loan review', 'Your loans', 'Lending structure', 'Valuations by method',
    'Other assets', 'Actions to consider', 'broker to action', 'Next steps', '<li>Point one</li>', '<li>Call us</li>', 'Credit Rep 123456', '<svg']) {
    assert.ok(h.toLowerCase().includes(s.toLowerCase()), `preview contains ${s}`);
  }
  assert.doesNotMatch(h, /<script/i);
  // Each valuation type shown is explained, and only those.
  const gl = h.slice(h.indexOf('class="glossary"'));
  assert.match(gl, /About the valuation types/);
  for (const m of require('../src/services/tracker').VALUATION_METHODS) {
    const shown = h.slice(0, h.indexOf('class="glossary"')).includes(`>${m.label}<`) || h.slice(0, h.indexOf('class="glossary"')).includes(`${m.label}<br>`);
    assert.equal(gl.includes(m.description.replace(/'/g, '&#39;')), shown, `${m.label} explained only when shown`);
  }

  const { res: pdfRes, buf: pdf } = await binary(`/reviews/${reviewId}/pdf`);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  assert.match(pdfRes.headers.get('content-disposition'), /Client Lending Review - Rhys Review - \d{4}-\d{2}-\d{2}\.pdf/);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5000);
  // Decompress page streams and join the hex-encoded text pieces: <4c4f414e20> → "LOAN ".
  const streams = [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)]
    .map((m) => { try { return zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { return ''; } }).join('');
  const text = [...streams.matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  assert.match(text, /LOAN REVIEW/);
  assert.match(text, /NEXT STEPS/);

  const { res: docRes, buf: docx } = await binary(`/reviews/${reviewId}/docx`);
  assert.match(docRes.headers.get('content-type'), /wordprocessingml/);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file('word/document.xml').async('string');
  for (const s of ['Client Lending Review', 'Rhys Review', 'Point one', 'Call us', 'ACTIONS TO CONSIDER', 'Commonwealth Bank', 'About the valuation types']) assert.ok(xml.includes(s), `docx contains ${s}`);
});

test('emailing attaches the PDF, marks the review sent and books the next review', async () => {
  const r = (await api.post(`/reviews/${reviewId}/email`, { to: 'rhys@example.com', subject: 'Your lending review', body: 'Hi Rhys,\n\nPlease find your review attached.\n\nKind regards,' })).data;
  assert.equal(r.status, 'logged', 'no mailbox connected in tests');
  const out = db.one('SELECT * FROM outbox WHERE id = ?', r.id);
  const files = JSON.parse(out.attachments);
  assert.equal(files.length, 1);
  assert.match(files[0].filename, /\.pdf$/);
  assert.equal(Buffer.from(files[0].data, 'base64').subarray(0, 5).toString(), '%PDF-');
  const list = (await api.get('/outbox')).data.rows.find((m) => m.id === r.id);
  assert.equal(list.attachments, undefined, 'file data not sent in lists');
  assert.equal(list.attachment_names.length, 1);
  const review = (await api.get(`/reviews/${reviewId}`)).data;
  assert.equal(review.status, 'sent');
  assert.equal(review.sent_to, 'rhys@example.com');
  assert.equal(db.one('SELECT next_review_date FROM contacts WHERE id = ?', client.id).next_review_date, addMonths(today(), 12));
  const rows = (await api.get(`/reviews?contact_id=${client.id}`)).data.rows;
  assert.equal(rows.length, 1);
  assert.equal((await api.post(`/reviews/${reviewId}/email`, { to: 'rhys@example.com' })).status, 400);
});

test('a client with nothing in the tracker still gets a valid document', async () => {
  const empty = (await api.post('/contacts', { first_name: 'Empty', status: 'lead' })).data;
  const r = (await api.post('/reviews', { contact_id: empty.id })).data;
  assert.match(r.loan_review, /No loans are currently recorded/);
  const { buf } = await binary(`/reviews/${r.id}/pdf`);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const { buf: docx } = await binary(`/reviews/${r.id}/docx`);
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  assert.equal((await api.del(`/reviews/${r.id}`)).status, 200);
});
