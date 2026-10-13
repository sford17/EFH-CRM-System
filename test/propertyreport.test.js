'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const AREAS = {
  areas: [
    {
      suburb: 'Ryde', state: 'NSW', property_type: 'house',
      summary: 'Ryde house prices rose over the past year, helped by the Metro and limited stock.',
      stats: [
        { label: 'Median house price', value: '$2.05m', period: '12 months to Sep 2026', source_name: 'PropTrack', source_url: 'https://www.realestate.com.au/ryde' },
        { label: '12-month change', value: '+5.8%', period: null, source_name: 'Cotality', source_url: 'javascript:alert(1)' },
        { label: '', value: 'dropped' },
      ],
      trend: { title: 'Median house price', unit: '$', items: [{ label: '2022', value: 1800000 }, { label: '2024', value: 1900000 }, { label: '2026', value: 2050000 }] },
      highlights: ['Metro West station construction under way.', '<script>alert(1)</script> New school'],
      sources: [{ title: 'Ryde profile', publisher: 'realestate.com.au', url: 'https://www.realestate.com.au/ryde' }, { title: 'x', publisher: 'x', url: 'ftp://nope' }],
    },
    {
      suburb: 'Parramatta', state: 'NSW', property_type: 'unit', summary: 'Units steady.', stats: [{ label: 'Median unit price', value: '$640k', period: 'Sep 2026', source_name: 'Domain', source_url: 'https://www.domain.com.au/parramatta' }],
      trend: null, highlights: [], sources: [],
    },
  ],
  notes_for_broker: ['Sources differ on the Ryde median.'],
};

const requests = [];
let failWith = null;
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push(body);
  if (failWith) {
    res.writeHead(failWith, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 1, server_tool_use: { web_search_requests: 5 } } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'save_area_data', input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(AREAS) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 600 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

const { today, addMonths } = require('../src/util');
let srv;
let api;
let db;
let reports;
let mia;
let home;
let unit;
let reportId;
before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  reports = require('../src/services/propertyReport');
});
after(() => { srv.close(); claude.close(); });

const waitFor = async (id) => {
  for (let i = 0; i < 60 && (await api.get(`/property-reports/${id}`)).data.status === 'researching'; i += 1) await new Promise((x) => { setTimeout(x, 50); });
  return (await api.get(`/property-reports/${id}`)).data;
};

test('working out the suburb and state', () => {
  assert.deepEqual(reports.locationOf({ address: '3 Park Ave, Ryde NSW 2112' }), { suburb: 'Ryde', state: 'NSW', postcode: '2112' });
  assert.deepEqual(reports.locationOf({ address: '1/20 George St, north parramatta nsw' }), { suburb: 'North Parramatta', state: 'NSW', postcode: null });
  assert.deepEqual(reports.locationOf({ address: '5 Smith St', suburb: 'Box Hill', state: 'vic' }), { suburb: 'Box Hill', state: 'VIC', postcode: null });
  assert.equal(reports.locationOf({ address: 'Lot 5 Somewhere' }).suburb, null);
});

test('setup and the property list', async () => {
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Report', email: 'mia.report@example.com', status: 'client' })).data;
  home = (await api.post('/tracker/properties', { contact_id: mia.id, address: '3 Park Ave, Ryde NSW 2112', purchase_price: 1500000, purchase_date: addMonths(today(), -48) })).data;
  await api.post(`/tracker/properties/${home.id}/valuations`, { method: 'desktop', amount: 1700000, valuation_date: addMonths(today(), -24) });
  await api.post(`/tracker/properties/${home.id}/valuations`, { method: 'avm', amount: 1900000, valuation_date: addMonths(today(), -1) });
  unit = (await api.post('/tracker/properties', { contact_id: mia.id, address: '12/4 Church St, Parramatta NSW', property_type: 'unit', usage: 'investment', valuation: { amount: 650000, method: 'avm' } })).data;
  await api.post('/tracker/loans', { contact_id: mia.id, lender_name: 'Westpac', loan_type: 'home_loan', balance: 950000, interest_rate: 5.79, security_ids: [home.id] });
  const noArea = (await api.post('/tracker/properties', { contact_id: mia.id, address: 'Lot 7 Unknown Road' })).data;

  const list = (await api.get(`/property-reports/contact/${mia.id}`)).data;
  assert.equal(list.configured, false);
  assert.deepEqual(list.properties.map((p) => [p.address, p.suburb, p.ready]), [
    ['3 Park Ave, Ryde NSW 2112', 'Ryde', true], ['12/4 Church St, Parramatta NSW', 'Parramatta', true], ['Lot 7 Unknown Road', null, false]]);
  assert.equal(list.properties[0].valuations, 3, 'purchase price + 2 valuations');

  assert.match((await api.post('/property-reports', { contact_id: mia.id, property_ids: [home.id] })).data.error, /Anthropic API key/);
  await api.put('/ai/config', { api_key: 'sk-ant-api03-propreport12345' });
  const bad = await api.post('/property-reports', { contact_id: mia.id, property_ids: [noArea.id] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /suburb and state for Lot 7 Unknown Road/);
});

test('performance: growth, yearly growth, equity and LVR', () => {
  const p = reports.performance(home.id, mia.id);
  assert.deepEqual(p.points.map((x) => x.amount), [1500000, 1700000, 1900000]);
  assert.equal(p.current_value, 1900000);
  assert.equal(p.growth, 400000);
  assert.ok(Math.abs(p.growth_pct - 26.67) < 0.01);
  assert.ok(p.growth_per_year > 6 && p.growth_per_year < 6.5, `CAGR ${p.growth_per_year}`);
  assert.equal(p.owing, 950000);
  assert.equal(p.equity, 950000);
  assert.equal(p.lvr, 50);
  assert.match(reports.performanceNote(p), /You bought this property for \$1,500,000 .* now valued at \$1,900,000 .*up \$400,000, or 26\.7%.*LVR of 50\.0%/);
});

test('a report researches the areas in the background', async () => {
  const r = await api.post('/property-reports', { contact_id: mia.id, property_ids: [home.id, unit.id] });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.status, 'researching');
  reportId = r.data.id;
  const rep = await waitFor(reportId);
  assert.equal(rep.status, 'ready', rep.error);

  const sent = requests[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.ok(sent.tools.some((t) => t.type === 'web_search_20260209'));
  assert.equal(sent.tools.find((t) => t.name === 'save_area_data').strict, true);
  assert.match(sent.messages[0].content, /Ryde NSW 2112 \(houses\)/);
  assert.match(sent.messages[0].content, /Parramatta NSW \(units\)/);

  assert.equal(rep.content.title, 'Your property report');
  assert.match(rep.content.intro, /^Hi Mia,/);
  const [ryde, parra] = rep.content.areas;
  assert.equal(ryde.suburb, 'Ryde');
  assert.deepEqual(ryde.stats.map((s) => [s.label, s.source_url]), [['Median house price', 'https://www.realestate.com.au/ryde'], ['12-month change', null]], 'bad links and empty stats dropped');
  assert.equal(ryde.trend.items.length, 3);
  assert.equal(ryde.sources.length, 1);
  assert.equal(parra.property_type, 'unit');
  assert.deepEqual(rep.content.notes_for_broker, ['Sources differ on the Ryde median.']);
  assert.equal(rep.usage.web_searches, 5);
  assert.equal(rep.performance.length, 2);
  assert.equal(rep.to, 'mia.report@example.com');
  assert.equal(rep.booking_ready, false);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message = 'Property report ready to review for Mia Report' AND link = ?", `#/property-reports/${reportId}`));
  assert.equal((await api.get(`/property-reports/contact/${mia.id}`)).data.rows[0].property_count, 2);
});

test('editing, the document preview, the email preview and the PDF', async () => {
  const rep = (await api.get(`/property-reports/${reportId}`)).data;
  const content = structuredClone(rep.content);
  content.intro = 'Hi Mia,\n\nA quick look at your properties.';
  content.properties[0].note = 'Your home has done really well.';
  content.areas[0].summary = 'Edited summary for Ryde.';
  content.areas[0].suburb = 'Hacked';
  const saved = (await api.put(`/property-reports/${reportId}`, { content })).data;
  assert.equal(saved.content.intro, 'Hi Mia,\n\nA quick look at your properties.');
  assert.equal(saved.content.properties[0].note, 'Your home has done really well.');
  assert.equal(saved.content.areas[0].summary, 'Edited summary for Ryde.');
  assert.equal(saved.content.areas[0].suburb, 'Ryde', 'the suburb stays');

  const cookie = (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(`${srv.base}/property-reports/${reportId}/${p}`, { headers: { Cookie: cookie } });
  const doc = await get('preview');
  assert.match(doc.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await doc.text();
  for (const s of ['3 Park Ave, Ryde NSW 2112', 'Your home has done really well.', '$1,900,000', 'About Ryde (houses)', 'Median house price', '$2.05m', 'About Parramatta (units)', '<svg', 'general information only']) {
    assert.ok(html.includes(s), `document shows ${s}`);
  }
  assert.ok(!html.includes('<script>alert'), 'escaped');
  await api.put('/newsletters/settings', { booking_url: 'https://calendly.com/efh/30min' });
  assert.equal((await api.get(`/property-reports/${reportId}`)).data.booking_ready, true);
  const email = await (await get('email-preview')).text();
  assert.ok(email.includes('https://calendly.com/efh/30min'), 'booking button');
  for (const s of ['Valuation history', 'Edited summary for Ryde.', '$2.05m', 'Metro West station', 'The full report is attached']) assert.ok(email.includes(s), `email shows ${s}`);
  assert.ok(!email.includes('<script>alert'));
  const pdf = await get('pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.headers.get('content-disposition'), /Your%20property%20report\.pdf/);
});

test('emailing the report with the PDF attached', async () => {
  assert.equal((await api.post(`/property-reports/${reportId}/email`, { to: 'nope' })).status, 400);
  const r = await api.post(`/property-reports/${reportId}/email`, { to: 'mia.report@example.com', subject: 'Your property update' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  const out = db.one('SELECT * FROM outbox WHERE id = ?', r.data.outbox.id);
  assert.equal(out.subject, 'Your property update');
  assert.match(out.html_body, /Valuation history/);
  const files = JSON.parse(out.attachments);
  assert.equal(files[0].filename, 'Your property report.pdf');
  assert.equal(Buffer.from(files[0].data, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.ok(db.one("SELECT 1 FROM activities WHERE contact_id = ? AND body = 'Property report emailed to mia.report@example.com'", mia.id));
});

test('refreshing the area data keeps the wording; failures are friendly', async () => {
  const before = requests.length;
  const r = await api.post(`/property-reports/${reportId}/refresh`, {});
  assert.equal(r.status, 202);
  const rep = await waitFor(reportId);
  assert.equal(requests.length, before + 1);
  assert.equal(rep.content.intro, 'Hi Mia,\n\nA quick look at your properties.', 'wording kept');

  failWith = 429;
  const { id, done } = reports.create(mia.id, [unit.id], 1);
  await done;
  const failed = reports.get(id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /busy/);
  failWith = null;
  assert.equal((await api.del(`/property-reports/${id}`)).data.ok, true);
  assert.equal((await api.get(`/property-reports/${id}`)).status, 404);
});
