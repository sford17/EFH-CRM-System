'use strict';
const express = require('express');
const db = require('../db');
const calendly = require('../services/calendly');
const { HttpError } = require('../util');
const { notFound } = require('./helpers');

// ---- Calendly connection -----------------------------------------------------
const calendlyRouter = express.Router();

calendlyRouter.get('/status', (req, res) => {
  res.json({
    account: calendly.publicAccount(db.one('SELECT * FROM calendly_accounts WHERE user_id = ?', req.user.id)),
    create_leads: db.getSetting('calendly_create_leads', '1') !== '0',
    team: db.all(`SELECT u.name, c.scheduling_url, c.connected FROM calendly_accounts c JOIN users u ON u.id = c.user_id ORDER BY u.name`),
  });
});

calendlyRouter.post('/connect', async (req, res) => {
  const account = await calendly.connect(req.user.id, req.body?.token);
  const sync = await calendly.syncAccount(account.id).catch((err) => ({ error: err.message }));
  res.json({ account: calendly.publicAccount(calendly.accountFor(req.user.id)), sync });
});

calendlyRouter.post('/disconnect', (req, res) => {
  calendly.disconnect(req.user.id);
  res.json({ ok: true });
});

calendlyRouter.post('/sync', async (req, res) => {
  const account = calendly.accountFor(req.user.id);
  if (!account) throw new HttpError(400, 'Connect your Calendly account first');
  try {
    res.json(await calendly.syncAccount(account.id));
  } catch (err) {
    throw new HttpError(502, err.message);
  }
});

calendlyRouter.put('/settings', (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can change this');
  db.setSetting('calendly_create_leads', req.body?.create_leads ? '1' : '0');
  res.json({ create_leads: Boolean(req.body?.create_leads) });
});

// Booking links: the main scheduling page plus each event type, pre-filled
// for a contact when contact_id is given.
calendlyRouter.get('/links', async (req, res) => {
  const account = calendly.accountFor(req.user.id);
  if (!account) throw new HttpError(400, 'Connect your Calendly account in Settings first');
  const contact = req.query.contact_id
    ? notFound(db.one('SELECT id, first_name, last_name, email, mobile FROM contacts WHERE id = ?', Number(req.query.contact_id)), 'Contact')
    : null;
  let types = [];
  try {
    types = await calendly.eventTypes(req.user.id);
  } catch (err) {
    if (err.status) throw err;
    throw new HttpError(502, err.message);
  }
  // short_url (no name/email pre-fill) keeps text messages to fewer SMS.
  const link = (name, duration, base) => ({
    name, duration, url: calendly.bookingLink(base, contact), short_url: calendly.bookingLink(base, contact, { short: true }),
  });
  const links = [
    link('All my meeting types', null, account.scheduling_url),
    ...types.map((t) => link(t.name, t.duration, t.scheduling_url)),
  ];
  res.json({ links, contact });
});

// ---- Appointments --------------------------------------------------------------
const appointments = express.Router();

const SELECT = `
  SELECT a.*, u.name AS owner_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, d.title AS deal_title
  FROM appointments a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN contacts c ON c.id = a.contact_id
  LEFT JOIN deals d ON d.id = a.deal_id`;

appointments.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.mine === '1') { where.push('a.user_id = ?'); params.push(req.user.id); }
  if (req.query.contact_id) { where.push('a.contact_id = ?'); params.push(Number(req.query.contact_id)); }
  if (req.query.when === 'past') {
    where.push('a.start_at < ?'); params.push(new Date().toISOString());
  } else if (req.query.when !== 'all') {
    // Upcoming, including meetings that started within the last hour.
    where.push('a.start_at >= ?'); params.push(new Date(Date.now() - 3600000).toISOString());
  }
  if (req.query.include_cancelled !== '1') where.push("a.status = 'active'");
  const order = req.query.when === 'past' ? 'DESC' : 'ASC';
  res.json({
    rows: db.all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.start_at ${order} LIMIT 300`, ...params),
  });
});

appointments.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  notFound(db.one('SELECT 1 FROM appointments WHERE id = ?', id), 'Appointment');
  const contactId = req.body?.contact_id ? Number(req.body.contact_id) : null;
  if (contactId) notFound(db.one('SELECT 1 FROM contacts WHERE id = ?', contactId), 'Contact');
  db.update('appointments', id, { contact_id: contactId, updated_at: new Date().toISOString() });
  res.json(db.one(`${SELECT} WHERE a.id = ?`, id));
});

module.exports = { calendlyRouter, appointments };
