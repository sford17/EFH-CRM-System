'use strict';
// Calendly integration (API v2, personal access tokens). Each user connects
// their own Calendly account. The CRM polls for scheduled events, stores them
// as appointments, links them to contacts, and fires appointment automations.
// Webhooks would need a paid Calendly plan and a public URL, so polling is used.
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError, today } = require('../util');

const apiBase = () => (process.env.CALENDLY_API_URL || 'https://api.calendly.com').replace(/\/$/, '');
const LOOKBACK_DAYS = 30;
const CONTACT_REF = /^crm-contact-(\d+)$/;

async function request(token, pathOrUrl) {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${apiBase()}${pathOrUrl}`;
  if (!url.startsWith(apiBase())) throw new Error('Unexpected Calendly URL');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(res.status === 401
      ? 'Calendly rejected the access token – it may have been revoked. Please reconnect.'
      : `Calendly: ${data.message || data.title || `request failed (${res.status})`}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function collect(token, path, maxPages = 20) {
  const items = [];
  let next = path;
  for (let page = 0; next && page < maxPages; page++) {
    const data = await request(token, next);
    items.push(...(data.collection || []));
    next = data.pagination?.next_page || null;
  }
  return items;
}

// ---- Accounts --------------------------------------------------------------

async function connect(userId, token) {
  const clean = String(token || '').trim();
  if (clean.length < 20) throw new HttpError(400, 'Paste the full personal access token from Calendly');
  let me;
  try {
    me = (await request(clean, '/users/me')).resource;
  } catch (err) {
    throw new HttpError(400, err.status === 401 ? 'Calendly didn\'t accept that token. Check you copied all of it.' : err.message);
  }
  const fields = {
    token: encrypt(clean),
    user_uri: me.uri,
    name: me.name || null,
    email: me.email || null,
    scheduling_url: me.scheduling_url || null,
    connected: 1,
    sync_error: null,
    connected_at: nowIso(),
  };
  const existing = db.one('SELECT id, user_uri FROM calendly_accounts WHERE user_id = ?', userId);
  if (existing) {
    if (existing.user_uri !== me.uri) fields.last_sync_at = null;
    db.update('calendly_accounts', existing.id, fields);
  } else {
    db.insert('calendly_accounts', { user_id: userId, ...fields });
  }
  return accountFor(userId);
}

function disconnect(userId) {
  db.run('UPDATE calendly_accounts SET connected = 0, token = NULL WHERE user_id = ?', userId);
}

const accountFor = (userId) => db.one('SELECT * FROM calendly_accounts WHERE user_id = ? AND connected = 1', userId) || null;

function publicAccount(row) {
  if (!row) return null;
  return {
    name: row.name, email: row.email, scheduling_url: row.scheduling_url, connected: Boolean(row.connected),
    last_sync_at: row.last_sync_at, sync_error: row.sync_error,
  };
}

async function eventTypes(userId) {
  const account = accountFor(userId);
  if (!account) throw new HttpError(400, 'Connect your Calendly account in Settings first');
  const types = await collect(decrypt(account.token), `/event_types?user=${encodeURIComponent(account.user_uri)}&active=true&count=100`);
  return types
    .filter((t) => t.active !== false && !t.secret)
    .map((t) => ({ name: t.name, duration: t.duration, scheduling_url: t.scheduling_url }));
}

// Booking link pre-filled with the client's details. utm_content carries the
// contact id back to us in the booking, so it links even if they use another email.
function bookingLink(baseUrl, contact, { short = false } = {}) {
  const url = new URL(baseUrl);
  if (contact && short) {
    url.searchParams.set('utm_content', `crm-contact-${contact.id}`);
  } else if (contact) {
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
    if (name) url.searchParams.set('name', name);
    if (contact.email) url.searchParams.set('email', contact.email);
    url.searchParams.set('utm_source', 'efh-crm');
    url.searchParams.set('utm_content', `crm-contact-${contact.id}`);
  }
  return url.toString();
}

// ---- Sync ------------------------------------------------------------------

const fmtWhen = (iso) => new Intl.DateTimeFormat('en-AU', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ_BUSINESS || 'Australia/Sydney',
}).format(new Date(iso));

function eventContext(appt) {
  return {
    appointment_id: appt.id,
    title: appt.title,
    date: today(new Date(appt.start_at)),
    when: fmtWhen(appt.start_at),
    start_at: appt.start_at,
    location: appt.location || '',
    join_url: appt.join_url || '',
    cancel_reason: appt.cancel_reason || '',
  };
}

function findContact(invitee, ownerId) {
  const ref = CONTACT_REF.exec(invitee?.tracking?.utm_content || '');
  if (ref) {
    const byRef = db.one('SELECT id FROM contacts WHERE id = ?', Number(ref[1]));
    if (byRef) return { id: byRef.id, created: false };
  }
  const email = String(invitee?.email || '').trim().toLowerCase();
  if (email) {
    const byEmail = db.one('SELECT id FROM contacts WHERE lower(email) = ? ORDER BY id LIMIT 1', email);
    if (byEmail) return { id: byEmail.id, created: false };
  }
  if (!invitee || db.getSetting('calendly_create_leads', '1') === '0') return null;

  // Someone new booked: add them as a lead.
  const first = invitee.first_name || String(invitee.name || '').split(' ')[0] || 'Unknown';
  const last = invitee.last_name || String(invitee.name || '').split(' ').slice(1).join(' ') || null;
  const qa = (invitee.questions_and_answers || []).map((q) => `${q.question}: ${q.answer}`).join('\n');
  const id = db.insert('contacts', {
    first_name: first,
    last_name: last,
    email: email || null,
    mobile: invitee.text_reminder_number || null,
    status: 'lead',
    lead_source: 'calendly',
    owner_id: ownerId,
    background: qa || null,
  });
  db.insert('activities', { contact_id: id, user_id: ownerId, type: 'system', body: 'Contact created from a Calendly booking' });
  return { id, created: true };
}

function location(ev) {
  const loc = ev.location || {};
  const joinUrl = /^https:\/\//.test(loc.join_url || '') ? loc.join_url : null;
  const where = loc.location || (loc.type ? loc.type.replace(/_/g, ' ') : null);
  return { location_type: loc.type || null, location: where, join_url: joinUrl };
}

// Saves one scheduled event; returns what happened for automations.
async function upsertEvent(account, token, ev) {
  const existing = db.one('SELECT * FROM appointments WHERE external_uri = ?', ev.uri);
  if (existing && existing.external_updated_at === ev.updated_at) return null;

  const invitees = await collect(token, `${ev.uri}/invitees?count=100`, 2);
  const invitee = invitees.find((i) => i.status === 'active') || invitees[0] || null;
  const match = existing?.contact_id ? { id: existing.contact_id, created: false } : findContact(invitee, account.user_id);
  let dealId = existing?.deal_id ?? null;
  if (!dealId && match) {
    const open = db.all("SELECT id FROM deals WHERE (contact_id = ? OR id IN (SELECT deal_id FROM deal_borrowers WHERE contact_id = ?)) AND stage NOT IN ('settled','lost')", match.id, match.id);
    if (open.length === 1) dealId = open[0].id;
  }
  const qa = (invitee?.questions_and_answers || []).map((q) => `${q.question}: ${q.answer}`).join('\n');
  const fields = {
    user_id: account.user_id,
    title: ev.name || 'Meeting',
    start_at: ev.start_time,
    end_at: ev.end_time || null,
    status: ev.status === 'canceled' ? 'canceled' : 'active',
    ...location(ev),
    invitee_name: invitee?.name || null,
    invitee_email: invitee?.email || null,
    invitee_phone: invitee?.text_reminder_number || null,
    contact_id: match?.id ?? null,
    deal_id: dealId,
    cancel_url: invitee?.cancel_url || null,
    reschedule_url: invitee?.reschedule_url || null,
    notes: qa || null,
    cancel_reason: ev.cancellation?.reason || null,
    rescheduled: invitee?.rescheduled ? 1 : 0,
    external_updated_at: ev.updated_at || null,
    updated_at: nowIso(),
  };

  let id;
  if (existing) {
    db.update('appointments', existing.id, fields);
    id = existing.id;
  } else {
    id = db.insert('appointments', { source: 'calendly', external_uri: ev.uri, ...fields });
  }
  const appt = db.one('SELECT * FROM appointments WHERE id = ?', id);
  const isNewBooking = !existing && appt.status === 'active';
  const justCancelled = existing && existing.status === 'active' && appt.status === 'canceled';
  // Bookings made before the account was connected are history, not news.
  const fresh = (ev.created_at || ev.updated_at || '') >= account.connected_at;

  if (match && (isNewBooking || justCancelled)) {
    const when = fmtWhen(appt.start_at);
    const body = isNewBooking
      ? `Appointment booked: ${appt.title} – ${when}`
      : `Appointment ${appt.rescheduled ? 'rescheduled' : 'cancelled'}: ${appt.title} – ${when}${appt.cancel_reason ? ` (${appt.cancel_reason})` : ''}`;
    db.insert('activities', { contact_id: match.id, deal_id: dealId, user_id: account.user_id, type: 'meeting', body });
  }
  if (!match || !fresh) return null;
  if (isNewBooking) return { trigger: 'appointment.booked', appt, contactCreated: match.created };
  if (justCancelled && !appt.rescheduled) return { trigger: 'appointment.cancelled', appt };
  return null;
}

async function runSync(accountId) {
  const account = db.one('SELECT * FROM calendly_accounts WHERE id = ?', accountId);
  if (!account || !account.connected) return { synced: 0 };
  const token = decrypt(account.token);
  const since = new Date(Date.now() - (account.last_sync_at ? 7 : LOOKBACK_DAYS) * 86400000).toISOString();
  const started = nowIso();
  let synced = 0;
  const fired = [];
  try {
    const events = await collect(
      token,
      `/scheduled_events?user=${encodeURIComponent(account.user_uri)}&min_start_time=${encodeURIComponent(since)}&count=100&sort=start_time:asc`,
    );
    for (const ev of events) {
      const result = await upsertEvent(account, token, ev);
      synced++;
      if (result) fired.push(result);
    }
    db.update('calendly_accounts', account.id, { last_sync_at: started, sync_error: null });
  } catch (err) {
    if (err.status === 401) db.update('calendly_accounts', account.id, { connected: 0 });
    db.update('calendly_accounts', account.id, { sync_error: err.message });
    throw err;
  }
  const automation = require('./automation'); // loaded lazily to avoid a require cycle
  for (const f of fired) {
    automation.emit(f.trigger, { contactId: f.appt.contact_id, dealId: f.appt.deal_id, ...eventContext(f.appt) });
  }
  return { synced, new_events: fired.length };
}

const running = new Map();
function syncAccount(accountId) {
  if (!running.has(accountId)) running.set(accountId, runSync(accountId).finally(() => running.delete(accountId)));
  return running.get(accountId);
}

async function syncAll(log = console) {
  let total = 0;
  for (const { id, email } of db.all('SELECT id, email FROM calendly_accounts WHERE connected = 1')) {
    try {
      total += (await syncAccount(id)).new_events;
    } catch (err) {
      log.error(`[calendly] sync failed for ${email}: ${err.message}`);
    }
  }
  return total;
}

module.exports = {
  connect, disconnect, accountFor, publicAccount, eventTypes, bookingLink, syncAccount, syncAll, eventContext, fmtWhen,
};
