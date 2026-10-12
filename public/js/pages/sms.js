// SMS: compose, history, settings card.
import { api, h, modal, attempt, toast, dateTime, field, readForm, state, table, badge } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const STATUS_KIND = { sent: 'ok', logged: 'info', queued: 'warn', failed: 'danger', cancelled: '' };

// Mirrors the server's count so people can see what a text will cost.
export function segmentInfo(text) {
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const per = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const n = text.length <= per ? 1 : Math.ceil(text.length / multi);
  return `${text.length} characters · ${n} SMS${gsm ? '' : ' (emoji or special characters use more SMS)'}`;
}

export function counted(textarea) {
  const info = h('div.muted.small', segmentInfo(textarea.value || ''));
  textarea.addEventListener('input', () => { info.textContent = segmentInfo(textarea.value); });
  return info;
}

export async function smsDialog({ contactId, dealId, mobile, name, body: initial = '' }) {
  const status = await api('/sms/status');
  const body = h('textarea', { rows: 5, maxlength: 918, 'aria-label': 'Message', placeholder: `Hi ${name || ''}, …` }, initial);
  const send = h('button', { type: 'button' }, 'Send SMS');
  const from = status.my_from || status.default_from;
  const d = modal(`Text ${name || mobile}`, [
    h('div.muted.small', `To ${mobile}${from ? ` · from ${from}` : ''}`),
    body,
    counted(body),
    status.configured ? null : h('p.small.text-warn', 'ClickSend isn\'t connected yet, so this will be logged but not sent. Set it up in Settings.'),
    h('div.actions', send),
  ]);
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      const r = await attempt(() => api('/sms', { method: 'POST', body: { contact_id: contactId, deal_id: dealId || null, body: body.value } }));
      if (r.status === 'failed') toast(`Not sent: ${r.error}`, 'error');
      else toast(r.status === 'sent' ? 'SMS sent' : 'SMS logged (ClickSend not connected)');
      d.close();
      refresh();
    } finally {
      send.disabled = false;
    }
  });
  body.focus();
}

export function smsCard({ sms, contactId, dealId, mobile, name }) {
  return h('section.card',
    h('div.card-head', h('h2', 'Text messages'),
      mobile ? h('button.small', { type: 'button', onclick: () => smsDialog({ contactId, dealId, mobile, name }) }, '+ New SMS') : null),
    !mobile ? h('p.empty', 'No mobile number on file.') : null,
    sms.length
      ? h('ul.plain.sms-list', sms.map((m) => h('li',
        m.partner_name ? h('div.small.muted', `To referral partner ${m.partner_name}`) : null,
        h('div.sms-bubble', m.body),
        h('div.muted.small', badge(m.status, STATUS_KIND[m.status]), ' ', m.status === 'queued' ? `scheduled ${dateTime(m.send_after)}` : dateTime(m.sent_at || m.send_after),
          m.from_number ? ` · from ${m.from_number}` : '', m.error ? h('span.text-danger', ` · ${m.error}`) : null))))
      : mobile ? h('p.empty', 'No texts yet.') : null);
}

// SMS log section for the Outbox page.
export async function smsLog() {
  const { rows } = await api('/sms');
  const act = (path, msg) => async () => { await attempt(() => api(path, { method: 'POST', body: {} }), msg); refresh(); };
  return h('section.card', h('h2', 'Text messages'), table([
    { label: 'Created', value: (m) => dateTime(m.created_at) },
    {
      label: 'To',
      value: (m) => (m.contact_id ? h('a', { href: `#/contacts/${m.contact_id}` }, m.contact_name || m.to_number)
        : m.partner_name ? h('a', { href: '#/partners' }, `${m.partner_name} (referral partner)`) : m.to_number),
    },
    { label: 'Message', value: (m) => h('div.small', m.body) },
    { label: 'Source', value: (m) => (m.automation_name ? h('span', { title: m.automation_name }, '⚡ automation') : m.template_name ? `with "${m.template_name}"` : 'manual') },
    { label: 'Status', value: (m) => h('div', badge(m.status, STATUS_KIND[m.status]), m.error ? h('div.small.text-danger', m.error) : null, m.from_number ? h('div.muted.small', `from ${m.from_number}`) : null) },
    {
      label: '', value: (m) => (m.status === 'queued'
        ? h('button.link.small', { type: 'button', onclick: act(`/sms/${m.id}/cancel`, 'Cancelled') }, 'Cancel')
        : ['failed', 'cancelled'].includes(m.status) ? h('button.link.small', { type: 'button', onclick: act(`/sms/${m.id}/retry`, 'Retried') }, 'Retry') : null),
    },
  ], rows, { empty: 'No text messages yet.' }));
}

export async function smsSettingsCard() {
  const s = await api('/sms/status');
  const isAdmin = state.user.role === 'admin';

  const myFields = [{ name: 'sms_from', label: 'My mobile number (texts are sent from this number)', placeholder: '0412 345 678' }];
  const myForm = h('form.inline-form', myFields.map((f) => field(f, s.my_from || '')),
    h('button.secondary', { type: 'submit' }, 'Save'),
    h('button.secondary', { type: 'button', onclick: async () => {
      const r = await attempt(() => api('/sms/test', { method: 'POST', body: {} }));
      if (r.status === 'failed') toast(`Test failed: ${r.error}`, 'error');
      else toast(r.status === 'sent' ? 'Test SMS sent – check your phone' : 'Logged only – ClickSend not connected');
    } }, 'Send me a test'));
  myForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await attempt(() => api('/sms/me', { method: 'PUT', body: readForm(myForm, myFields) }), 'Saved');
    refresh();
  });

  let adminSection = null;
  if (isAdmin) {
    const fields = [
      { name: 'username', label: 'ClickSend username', required: true },
      { name: 'api_key', label: s.app.has_key ? 'API key (saved – enter only to change)' : 'API key', type: 'password', required: !s.app.has_key },
      { name: 'default_from', label: 'Fallback sender (business mobile, or a registered name up to 11 characters)', full: true },
    ];
    const form = h('form.grid-form', fields.map((f) => field(f, f.name === 'api_key' ? '' : s.app[f.name])),
      h('div.actions.full', h('button', { type: 'submit' }, 'Save ClickSend details')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = readForm(form, fields);
      if (!v.api_key) delete v.api_key;
      await attempt(() => api('/sms/config', { method: 'PUT', body: v }), 'Saved');
      refresh();
    });
    adminSection = h('details.outlook-setup', { open: !s.configured },
      h('summary', h('strong', s.configured ? 'ClickSend setup (done)' : 'One-time setup (admin)')),
      h('ol.setup-steps',
        h('li', 'Create an account at ', h('a', { href: 'https://www.clicksend.com/au/', target: '_blank', rel: 'noopener noreferrer' }, 'clicksend.com'), ' and add some credit. You pay per text, with no monthly fee.'),
        h('li', 'In the ClickSend dashboard open ', h('strong', 'Developers → API Credentials'), ' and copy your ', h('strong', 'username'), ' and ', h('strong', 'API key'), ' into the boxes below.'),
        h('li', 'Each broker who wants texts to come from their own mobile: in ClickSend open ', h('strong', 'Sender IDs → Own Numbers → Add'), ', enter your mobile and type in the 6-digit code ClickSend texts you. This needs redoing once a year.'),
        h('li', 'Enter that same mobile number under ', h('strong', 'My mobile number'), ' above, then click ', h('strong', 'Send me a test'), '.')),
      form);
  }

  return h('section.card',
    h('h2', 'SMS'),
    h('div.outlook-status' + (s.configured ? '.ok' : ''),
      h('div',
        h('strong', s.configured ? 'ClickSend connected' : 'ClickSend not connected – texts are logged but not sent'),
        h('div.muted.small', s.my_from
          ? `Your texts are sent from ${s.my_from}. Replies go straight to that phone.`
          : `Add your mobile below so clients see texts from you${s.default_from ? ` (until then they come from ${s.default_from})` : ''}.`))),
    myForm,
    h('p.muted.small', 'Opt-outs: marketing texts (birthdays, reviews, rate offers) end with "Reply STOP to opt out" and only go to contacts who allow marketing. Because replies come to your phone, when someone replies STOP, tick "Opted out of SMS" on their contact record.'),
    adminSection);
}
