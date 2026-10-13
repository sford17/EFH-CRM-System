'use strict';
const { STAGES } = require('./constants');

const TZ = () => process.env.TZ_BUSINESS || 'Australia/Sydney';

// Today's calendar date (YYYY-MM-DD) in the business time zone.
function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

const nowIso = () => new Date().toISOString();

const stageLabel = (key) => (STAGES.find((s) => s.key === key) || { label: key }).label;

function money(n) {
  if (n === null || n === undefined || n === '') return '';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Number(n));
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(String(d).length === 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(date.getTime())) return String(d);
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function parseTags(tags) {
  return String(tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

class HttpError extends Error {
  // `reason` is a short code the browser can act on (e.g. 'mfa_setup_required').
  constructor(status, message, reason = null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

module.exports = {
  today, addDays, addMonths, daysBetween, nowIso, stageLabel, money, formatDate,
  parseTags, parseJson, HttpError,
};
