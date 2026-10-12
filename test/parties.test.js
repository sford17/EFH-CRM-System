'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

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

let client;
let solicitor;
let dealId;

test('the directory takes buyer\'s agents, conveyancers and mobiles', async () => {
  const ba = await api.post('/partners', { name: 'Ben Carter', company: 'NB Buyers Agency', type: 'buyers_agent', mobile: '0434 567 890' });
  assert.equal(ba.status, 201);
  assert.equal(ba.data.mobile, '0434 567 890');
  solicitor = (await api.post('/partners', { name: 'Tom Barker', company: 'Barker Conveyancing', type: 'conveyancer', email: 'tom@barker.example' })).data;
  assert.equal((await api.post('/partners', { name: 'X', type: 'astronaut' })).status, 400);
  const meta = (await api.get('/meta')).data;
  assert.deepEqual(meta.party_roles.slice(0, 3).map((r) => r.key), ['real_estate_agent', 'solicitor', 'buyers_agent']);
});

test('parties are captured when a deal is created', async () => {
  client = (await api.post('/contacts', { first_name: 'Noah', last_name: 'Smith', email: 'noah@example.com', mobile: '0444 444 444' })).data;
  const r = await api.post('/deals', {
    contact_id: client.id, loan_purpose: 'purchase', property_address: '14 Brisbane St, Ipswich QLD', loan_amount: 500000,
    parties: [
      { role: 'real_estate_agent', new_partner: { name: 'Kylie Nguyen', company: 'Ipswich First National', email: 'kylie@ipswichfn.example', mobile: '0423 456 789' } },
      { role: 'solicitor', partner_id: solicitor.id },
      { role: 'buyers_agent' }, // left blank
    ],
  });
  assert.equal(r.status, 201);
  dealId = r.data.id;
  const deal = (await api.get(`/deals/${dealId}`)).data;
  assert.deepEqual(deal.parties.map((p) => [p.role, p.name]), [['real_estate_agent', 'Kylie Nguyen'], ['solicitor', 'Tom Barker']]);
  assert.equal(deal.parties[0].role_label, 'Real estate agent');
  assert.equal(deal.parties[0].mobile, '0423 456 789');
  const kylie = db.one("SELECT * FROM referral_partners WHERE name = 'Kylie Nguyen'");
  assert.equal(kylie.type, 'real_estate');
  assert.ok(deal.activities.some((a) => a.body === 'Real estate agent: Kylie Nguyen (Ipswich First National)'));
});

test('a bad party stops the whole deal being created', async () => {
  const count = () => db.one('SELECT COUNT(*) AS n FROM deals').n;
  const n = count();
  const noName = await api.post('/deals', { contact_id: client.id, parties: [{ role: 'solicitor', new_partner: { email: 'a@b.example' } }] });
  assert.equal(noName.status, 400);
  const badEmail = await api.post('/deals', { contact_id: client.id, parties: [{ role: 'solicitor', new_partner: { name: 'Al', email: 'nope' } }] });
  assert.equal(badEmail.status, 400);
  const badRole = await api.post('/deals', { contact_id: client.id, parties: [{ role: 'constructor', partner_id: solicitor.id }] });
  assert.equal(badRole.status, 400);
  assert.equal(count(), n, 'no half-created deals');
});

test('adding an agent who is already in the directory reuses them', async () => {
  const before = db.one('SELECT COUNT(*) AS n FROM referral_partners').n;
  const r = await api.put(`/deals/${dealId}/parties/buyers_agent`, { new_partner: { name: 'Benjamin Carter', email: 'BEN@nbba.example' } });
  assert.equal(r.status, 200);
  // Different email from Ben's record, so this is a new person…
  assert.equal(db.one('SELECT COUNT(*) AS n FROM referral_partners').n, before + 1);
  // …but adding Kylie again by email reuses her and fills in her phone.
  const again = await api.put(`/deals/${dealId}/parties/real_estate_agent`, { new_partner: { name: 'Kylie N', email: 'KYLIE@ipswichfn.example', phone: '07 3200 0000' } });
  assert.equal(db.one('SELECT COUNT(*) AS n FROM referral_partners').n, before + 1);
  const kylie = again.data.parties.find((p) => p.role === 'real_estate_agent');
  assert.equal(kylie.name, 'Kylie Nguyen');
  assert.equal(kylie.phone, '07 3200 0000');
});

test('parties can be changed and removed', async () => {
  const r = await api.put(`/deals/${dealId}/parties/accountant`, { new_partner: { name: 'Priya Shah' }, notes: 'Does the tax returns' });
  assert.equal(r.data.parties.find((p) => p.role === 'accountant').notes, 'Does the tax returns');
  assert.equal(db.one("SELECT type FROM referral_partners WHERE name = 'Priya Shah'").type, 'accountant');
  assert.equal((await api.put(`/deals/${dealId}/parties/plumber`, { partner_id: solicitor.id })).status, 400);
  assert.equal((await api.put(`/deals/${dealId}/parties/solicitor`, {})).status, 400);
  assert.equal((await api.put(`/deals/${dealId}/parties/solicitor`, { partner_id: 99999 })).status, 400);
  assert.equal((await api.put('/deals/99999/parties/solicitor', { partner_id: solicitor.id })).status, 404);
  assert.equal((await api.del(`/deals/${dealId}/parties/accountant`)).status, 200);
  assert.equal((await api.del(`/deals/${dealId}/parties/accountant`)).status, 404);
  const partners = (await api.get('/partners')).data.rows;
  assert.equal(partners.find((p) => p.name === 'Tom Barker').deals_involved, 1);
});

test('templates can go to the agent or solicitor, with their own merge fields', async () => {
  const tpl = db.one("SELECT id FROM email_templates WHERE name = 'Finance approved – note to agent'").id;
  const p = (await api.post(`/templates/${tpl}/preview`, { contact_id: client.id, deal_id: dealId, recipient_role: 'real_estate_agent' })).data;
  assert.equal(p.to, 'kylie@ipswichfn.example');
  assert.match(p.body, /^Hi Kylie,/);
  assert.match(p.body, /Noah Smith's purchase of 14 Brisbane St/);
  assert.equal(p.sms, null, 'the client\'s companion text is not sent with emails to others');

  // Client templates can mention the agent too.
  const custom = (await api.post('/templates', { name: 'Who is who', category: 'deal', subject: 'Your team', body: 'Agent: {{agent.name}} ({{agent.company}}). Solicitor: {{solicitor.name}}. Buyer\'s agent: {{buyers_agent.name}}.' })).data;
  const c = (await api.post(`/templates/${custom.id}/preview`, { contact_id: client.id, deal_id: dealId })).data;
  assert.equal(c.body, "Agent: Kylie Nguyen (Ipswich First National). Solicitor: Tom Barker. Buyer's agent: Benjamin Carter.");
  assert.equal(c.to, 'noah@example.com');

  const sent = await api.post(`/templates/${tpl}/send`, { contact_id: client.id, deal_id: dealId, recipient_role: 'solicitor' });
  assert.equal(sent.status, 201);
  const row = db.one('SELECT to_email, contact_id, deal_id FROM outbox ORDER BY id DESC LIMIT 1');
  assert.deepEqual({ ...row }, { to_email: 'tom@barker.example', contact_id: client.id, deal_id: dealId });
  const noBuyerEmail = await api.post(`/templates/${tpl}/send`, { contact_id: client.id, deal_id: dealId, recipient_role: 'buyers_agent' });
  assert.equal(noBuyerEmail.status, 201, 'Benjamin has an email');
});

test('agent and solicitor automations ship switched off, and skip missing parties', async () => {
  const autos = db.all("SELECT * FROM automations WHERE name IN ('Unconditional approval: tell the agents', 'Settlement booked: confirm with the solicitor')");
  assert.equal(autos.length, 2);
  assert.ok(autos.every((a) => a.enabled === 0));
  const tell = autos.find((a) => a.name.startsWith('Unconditional'));
  assert.equal(JSON.parse(tell.actions).every((a) => a.template_id), true);
  await api.patch(`/automations/${tell.id}`, { enabled: 1 });

  await api.del(`/deals/${dealId}/parties/buyers_agent`);
  const before = db.one('SELECT MAX(id) AS id FROM outbox').id;
  await api.post(`/deals/${dealId}/stage`, { stage: 'unconditional_approval' });
  const emails = db.all('SELECT to_email, body FROM outbox WHERE id > ?', before);
  assert.ok(emails.some((e) => e.to_email === 'kylie@ipswichfn.example' && /^Hi Kylie,/.test(e.body)), 'agent told');
  const run = db.one('SELECT detail FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 1', tell.id);
  assert.match(run.detail, /email skipped: No buyer's agent on this deal/);
});

test('removing someone from the directory takes them off deals', async () => {
  assert.equal((await api.del(`/partners/${solicitor.id}`)).status, 200);
  assert.equal((await api.get(`/deals/${dealId}`)).data.parties.some((p) => p.role === 'solicitor'), false);
});
