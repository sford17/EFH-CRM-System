'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
let db;
let buildEmail;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  ({ buildEmail } = require('../src/services/emailHtml'));
});
after(() => srv.close());

const { today, addDays, addMonths } = require('../src/util');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
let client;
let deal;
let loan;

test('setup: a client with a deal, documents and a mortgage tracker', async () => {
  client = (await api.post('/contacts', { first_name: 'Ava', last_name: 'Graph', email: 'ava@example.com', status: 'client' })).data;
  const wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  deal = (await api.post('/deals', {
    contact_id: client.id, loan_purpose: 'purchase', loan_amount: 640000, property_value: 800000, lender_id: wbc,
    interest_rate: 5.89, property_address: '1 <b>Bold</b> St, Ryde NSW', finance_due_date: addDays(today(), 6), settlement_date: addDays(today(), 30),
  })).data;
  await api.post(`/deals/${deal.id}/stage`, { stage: 'fact_find' });
  await api.post(`/deals/${deal.id}/stage`, { stage: 'pre_approval' });
  await api.post(`/deals/${deal.id}/stage`, { stage: 'application_lodged' });
  const docs = db.all('SELECT id FROM documents WHERE deal_id = ? ORDER BY id', deal.id);
  await api.patch(`/documents/${docs[0].id}`, { status: 'received' });

  const home = (await api.post('/tracker/properties', { contact_id: client.id, address: '3 Park Ave, Ryde NSW', valuation: { amount: 900000, method: 'contract_price' } })).data;
  db.run('UPDATE valuations SET valuation_date = ? WHERE property_id = ?', addMonths(today(), -24), home.id);
  await api.post(`/tracker/properties/${home.id}/valuations`, { method: 'avm', amount: 1000000, valuation_date: today() });
  loan = (await api.post('/tracker/loans', {
    contact_id: client.id, lender_id: wbc, loan_type: 'home_loan', balance: 600000, interest_rate: 5.69, rate_type: 'fixed',
    fixed_expiry_date: addDays(today(), 75), settlement_date: addMonths(today(), -24), security_ids: [home.id],
  })).data;
  assert.ok(loan.id);
});

const build = (body, context = { contactId: client.id, dealId: deal.id }, opts = {}) => buildEmail({ body: `Hi Ava,\n\n${body}\n\nKind regards,`, context, ...opts });

test('deal graphics: progress, loan details, key dates and documents', () => {
  const e = build('[[progress]]\n\n[[loan_summary]]\n\n[[key_dates]]\n\n[[documents]]');
  assert.match(e.html, /Your loan progress/);
  assert.match(e.html, /Current stage: <strong[^>]*>Lodged<\/strong>/);
  assert.match(e.html, /Next: Conditional/);
  assert.match(e.html, /Westpac/);
  assert.match(e.html, /\$640,000/);
  assert.match(e.html, /80%/);
  assert.match(e.html, /1 &lt;b&gt;Bold&lt;\/b&gt; St/, 'client data is escaped');
  assert.doesNotMatch(e.html, /<b>Bold<\/b>/);
  assert.match(e.html, /Finance due/);
  assert.match(e.html, /In 6 days/);
  assert.match(e.html, /1 of \d+<\/strong> received/);
  // Plain-text versions for the text part of the email.
  assert.match(e.text, /Your loan progress: Lodged \(step 3 of 7\)/);
  assert.match(e.text, /\[x\] Fact find\n\[x\] Pre-approval\n\[>\] Lodged/);
  assert.match(e.text, /Loan amount: \$640,000/);
  assert.match(e.text, /Finance due: .* \(in 6 days\)/);
  assert.match(e.text, /Still needed:\n {2}- /);
  assert.equal(e.plain.includes('[['), false);
});

test('tracker graphics: position, lending structure, equity, value history and fixed rate', () => {
  const e = build('[[position]]\n\n[[lending_structure]]\n\n[[equity_chart]]\n\n[[value_history]]\n\n[[fixed_rate]]', { contactId: client.id });
  assert.match(e.html, /Your position at a glance/);
  assert.match(e.html, /\$1m/);
  assert.match(e.html, /60%/);
  assert.match(e.html, /How your lending is structured/);
  assert.match(e.html, /Secured by 3 Park Ave/);
  assert.match(e.html, /Your property equity/);
  assert.match(e.html, /3 Park Ave: estimated value/);
  assert.match(e.html, /Up <strong[^>]*>11.1%<\/strong>/);
  assert.match(e.html, />75<\/div><div[^>]*>days to go/);
  assert.match(e.text, /Your fixed rate ends on .* – 75 days to go/);
  assert.match(e.text, /Westpac – \$600k\n {2}- Home loan \$600k at 5.69% fixed, secured by 3 Park Ave/);
});

test('graphics without the data they need are left out (or flagged in previews)', () => {
  const lonely = (async () => (await api.post('/contacts', { first_name: 'Solo' })).data)();
  return lonely.then((solo) => {
    const sent = build('[[progress]]\n\n[[position]]\n\n[[fixed_rate]]', { contactId: solo.id });
    assert.doesNotMatch(sent.html, /progress|position|fixed rate/i);
    assert.match(sent.text, /^Hi Ava,\n\nKind regards,/, 'nothing left where the graphics were');
    const preview = build('[[progress]]', { contactId: solo.id }, { preview: true });
    assert.match(preview.html, /Loan progress tracker not shown: this email isn&#39;t linked to a deal/);
    // Unknown tags are just text.
    assert.match(build('[[nonsense]]').html, /\[\[nonsense\]\]/);
  });
});

test('buttons only link to web, email or phone addresses', () => {
  const ok = build('[[button: Book a time | https://calendly.com/sam]]');
  assert.match(ok.html, /<a href="https:\/\/calendly.com\/sam"[^>]*>Book a time<\/a>/);
  assert.match(ok.text, /Book a time: https:\/\/calendly.com\/sam/);
  assert.match(build('[[button: Visit | efh.example]]').html, /href="https:\/\/efh.example"/);
  for (const bad of ['javascript:alert(1)', '', '"><script>x</script>']) {
    const e = build(`[[button: Click | ${bad}]]`);
    assert.doesNotMatch(e.html, /Click<\/a>|<script>x/);
  }
  assert.match(build('[[button: Say "hi" <b> | https://x.example]]').html, /Say &quot;hi&quot; &lt;b&gt;/);
});

test('template images: uploaded as email images and shown full width', async () => {
  const bad = await api.post('/templates/images', { image: 'data:text/html;base64,PHNjcmlwdD4=' });
  assert.equal(bad.status, 400);
  const r = await api.post('/templates/images', { image: PNG, alt: 'Happy | birthday]]' });
  assert.equal(r.status, 201);
  assert.match(r.data.tag, new RegExp(`^\\[\\[image: ${r.data.id} \\| Happy\\s+birthday\\]\\]$`), 'characters that would break the tag are removed');
  const e = build(`[[image: ${r.data.id} | Happy birthday]]`);
  assert.match(e.html, /src="cid:asset-\d+@efh-crm"/, 'embedded in the email');
  assert.equal(e.attachments.length >= 1, true);
  assert.match(e.html, /alt="Happy birthday"/);
  // Other kinds of image (e.g. someone's signature) can't be pulled in.
  const sig = db.insert('assets', { kind: 'signature', mime: 'image/png', data: Buffer.from('x'), width: 2, height: 2 });
  assert.doesNotMatch(build(`[[image: ${sig}]]`).html, new RegExp(`asset-${sig}@`));
});

test('headings and bullet points in template text', () => {
  const e = build('# What happens next\n\n- We order a valuation\n- You sign the documents');
  assert.match(e.html, /<h2[^>]*>What happens next<\/h2>/);
  assert.match(e.html, /<ul[^>]*><li[^>]*>We order a valuation<\/li><li[^>]*>You sign the documents<\/li><\/ul>/);
});

test('branded emails: colour banner, business details footer and footer note', async () => {
  for (const [k, v] of Object.entries({ business_phone: '02 9000 0000', business_email: 'hello@efh.example', business_website: 'efh.example', acl_number: 'Credit Representative 123456' })) {
    db.setSetting(k, v);
  }
  assert.equal((await api.put('/branding', { primary: '#0f766e', email_footer: 'General advice only.\nACL 654321.' })).status, 200);
  const brand = (await api.get('/branding')).data;
  assert.equal(brand.email_style, 'banner', 'banner is the default');
  const e = build('Hello');
  assert.match(e.html, /bgcolor="#0f766e"/);
  assert.match(e.html, /02 9000 0000/);
  assert.match(e.html, /href="https:\/\/efh.example"/);
  assert.match(e.html, /Credit Representative 123456/);
  assert.match(e.html, /General advice only.<br>ACL 654321./);

  await api.put('/branding', { email_footer_details: false });
  assert.doesNotMatch(build('Hello').html, /02 9000 0000/);
  await api.put('/branding', { email_style: 'plain', email_footer_details: true });
  const plain = build('[[progress]]');
  assert.doesNotMatch(plain.html, /<!doctype/);
  assert.match(plain.html, /Your loan progress/, 'graphics still appear in plain emails');
  assert.equal((await api.put('/branding', { email_style: 'fancy' })).status, 400);
  assert.equal((await api.put('/branding', { email_footer: 'x'.repeat(601) })).status, 400);
  await api.put('/branding', { email_style: 'banner' });
});

test('standard templates come with graphics, and previews use example figures', async () => {
  const body = (name) => db.one('SELECT body FROM email_templates WHERE name = ?', name).body;
  assert.match(body('Application lodged'), /\[\[progress\]\]\n\n\[\[loan_summary\]\]/);
  assert.match(body('Document request'), /\[\[documents\]\]/);
  assert.doesNotMatch(body('Document request'), /outstanding_documents/);
  assert.match(body('Annual loan review'), /\[\[lending_structure\]\][\s\S]*\[\[button: Book my health check \| \{\{broker.booking_link\}\}\]\]\n\nKind regards,$/);

  const tpl = db.one("SELECT id FROM email_templates WHERE name = 'Annual loan review'").id;
  const sample = (await api.post('/email-preview', { template_id: tpl })).data;
  assert.equal(sample.sample, true);
  const html = await (await fetch(`${srv.base.replace('/api', '')}${sample.url}`, { headers: { Cookie: await cookie() } })).text();
  assert.match(html, /Hi Jane,/);
  assert.match(html, /How your lending is structured/);
  assert.match(html, /8 Sample St/);

  const real = (await api.post('/email-preview', { template_id: tpl, contact_id: client.id })).data;
  assert.equal(real.sample, false);
  const realHtml = await (await fetch(`${srv.base.replace('/api', '')}${real.url}`, { headers: { Cookie: await cookie() } })).text();
  assert.match(realHtml, /Hi Ava,/);
  assert.match(realHtml, /3 Park Ave/);
  // No Calendly connected, so the booking button is flagged in the preview.
  assert.match(realHtml, /Button not shown/);
});

test('emails remember the loan they are about, for the fixed-rate countdown', () => {
  const mailer = require('../src/services/mailer');
  const tpl = db.one("SELECT id FROM email_templates WHERE name = 'Fixed rate expiry review'").id;
  const { id } = mailer.queueTemplate(tpl, { loanId: loan.id });
  const row = db.one('SELECT * FROM outbox WHERE id = ?', id);
  assert.equal(row.loan_id, loan.id);
  assert.match(row.body, /\[\[fixed_rate\]\]/);
  const e = buildEmail({ body: row.body, context: { contactId: row.contact_id, dealId: row.deal_id, loanId: row.loan_id } });
  assert.match(e.html, /days to go/);
});

test('upgrading: untouched standard templates gain graphics, edited ones are left alone', () => {
  const { addGraphicsDefaults } = require('../src/db/migrations');
  const { TEMPLATES } = require('../src/db/seed');
  const original = (name) => TEMPLATES.find((t) => t[0] === name)[3];
  db.run('UPDATE email_templates SET body = ? WHERE name = ?', original('Application lodged'), 'Application lodged');
  db.run('UPDATE email_templates SET body = ? WHERE name = ?', `${original('Settlement reminder')}\n\nPS edited`, 'Settlement reminder');
  db.setSetting('brand_email_style', 'branded');
  addGraphicsDefaults(db);
  assert.match(db.one("SELECT body FROM email_templates WHERE name = 'Application lodged'").body, /\[\[progress\]\]/);
  assert.doesNotMatch(db.one("SELECT body FROM email_templates WHERE name = 'Settlement reminder'").body, /\[\[/);
  assert.equal(db.getSetting('brand_email_style'), 'banner');
  db.setSetting('brand_email_style', 'plain');
  addGraphicsDefaults(db);
  assert.equal(db.getSetting('brand_email_style'), 'plain', 'a deliberate plain choice is kept');
});

async function cookie() {
  const res = await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
