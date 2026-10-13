'use strict';
// Reads loan documents (loan contract / offer, settlement statement, welcome
// letter…) with Claude and pulls out the details for the settlement letter.
// The broker always checks the result before anything is sent to a client.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { HttpError } = require('../util');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_FILES = 6;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // the API takes requests up to 32 MB (base64 adds a third)
const TYPES = { 'application/pdf': 'document', 'image/jpeg': 'image', 'image/png': 'image' };

// ---- Settings (admin) ------------------------------------------------------------

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return decrypt(db.getSetting('anthropic_api_key', '')) || null;
  } catch {
    return null; // encryption key changed: re-enter it
  }
}

const model = () => db.getSetting('ai_model', '') || DEFAULT_MODEL;
const configured = () => Boolean(apiKey());

function saveConfig({ api_key, model: m }) {
  if (api_key) {
    const k = String(api_key).trim();
    if (!/^sk-ant-[\w-]{10,}$/.test(k)) throw new HttpError(400, 'That doesn\'t look like an Anthropic API key (it starts with sk-ant-)');
    db.setSetting('anthropic_api_key', encrypt(k));
  }
  if (api_key === '') db.setSetting('anthropic_api_key', '');
  if (m !== undefined) db.setSetting('ai_model', /^[a-z0-9.-]{3,60}$/.test(String(m || '')) ? String(m) : '');
}

// ---- What to extract ------------------------------------------------------------------

// "Not in the documents" is null, so every field is "value or null".
const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });
const str = nullable({ type: 'string' });
const num = nullable({ type: 'number' });
const date = nullable({ type: 'string' }, 'YYYY-MM-DD');
const oneOf = (values, description) => nullable({ type: 'string', enum: values }, description);
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['borrowers', 'lender_name', 'settlement_date', 'property_address', 'loans', 'direct_debit', 'lender_phone', 'uncertain', 'notes'],
  properties: {
    borrowers: { ...str, description: 'All borrowers\' full names, joined with " & "' },
    lender_name: str,
    settlement_date: date,
    property_address: { ...str, description: 'Security property address' },
    loans: {
      type: 'array',
      description: 'One entry per loan account / split. A single loan is one entry.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['account_number', 'product', 'loan_amount', 'interest_rate', 'rate_type', 'fixed_until', 'loan_term_years', 'repayment_type', 'io_until',
          'repayment_amount', 'repayment_frequency', 'first_repayment_date', 'offset_account'],
        properties: {
          account_number: str,
          product: { ...str, description: 'Product name, e.g. "Basic Variable Home Loan"' },
          loan_amount: { ...num, description: 'Amount of this loan/split in dollars' },
          interest_rate: { ...num, description: 'Annual interest rate as a percentage, e.g. 5.89' },
          rate_type: oneOf(['variable', 'fixed']),
          fixed_until: { ...date, description: 'Fixed rate expiry date, if fixed' },
          loan_term_years: num,
          repayment_type: oneOf(['pi', 'io'], 'pi = principal and interest, io = interest only'),
          io_until: { ...date, description: 'Interest-only period end date, if interest only' },
          repayment_amount: { ...num, description: 'Regular repayment amount in dollars' },
          repayment_frequency: oneOf(['weekly', 'fortnightly', 'monthly']),
          first_repayment_date: date,
          offset_account: { ...str, description: 'Linked offset account number, if any' },
        },
      },
    },
    direct_debit: {
      type: 'object',
      additionalProperties: false,
      required: ['bank', 'account_name', 'bsb', 'account_number'],
      properties: { bank: str, account_name: str, bsb: str, account_number: str },
      description: 'The account repayments are debited from (direct debit authority)',
    },
    lender_phone: { ...str, description: 'Lender customer service phone number' },
    uncertain: { type: 'array', items: { type: 'string' }, description: 'Field paths you were unsure about, e.g. "loans[0].first_repayment_date", "direct_debit.bsb"' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Short notes for the broker: conflicts between documents, missing pages, anything to double-check' },
  },
};

const SYSTEM = `You read Australian home loan documents for a mortgage broker: loan contracts and offers, settlement statements and letters, direct debit authorities and lender welcome letters. Extract the details the broker needs for a settlement letter to their client.

Rules:
- Only report what the documents state. If a detail isn't there, use null. Never estimate or calculate values that aren't written (for example, don't work out a repayment amount yourself).
- Dates as YYYY-MM-DD. Amounts as plain numbers in dollars. Interest rates as the annual percentage.
- Split loans: one entry per account/split, in the order the documents list them.
- Where documents disagree, prefer the most recent document (settlement documents over the original offer), and say so in notes.
- Add any field you're not confident about to "uncertain".`;

// `feature` labels the requests in the running-costs report (Reports → Running costs).
function clientFor(feature = 'other', { userId = null } = {}) {
  const key = apiKey();
  if (!key) throw new HttpError(400, 'AI document reading isn\'t set up yet. An admin needs to add an Anthropic API key in Settings → AI.');
  const client = new Anthropic({ apiKey: key, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2, timeout: 5 * 60 * 1000 });
  // Record each finished response's usage and cost.
  const stream = client.beta.messages.stream.bind(client.beta.messages);
  client.beta.messages.stream = (...args) => {
    const s = stream(...args);
    s.on('finalMessage', (message) => require('./costs').record(feature, message, { userId }));
    return s;
  };
  return client;
}

// files: [{ name, mime, data (base64) }]
async function extract(files) {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, 'Choose the loan documents to read');
  if (files.length > MAX_FILES) throw new HttpError(400, `Choose up to ${MAX_FILES} files`);
  let total = 0;
  const blocks = [];
  for (const f of files) {
    const kind = Object.hasOwn(TYPES, f?.mime) ? TYPES[f.mime] : null;
    if (!kind) throw new HttpError(400, `${f?.name || 'A file'} isn't a PDF, JPG or PNG`);
    const data = String(f.data || '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, `${f.name} couldn't be read`);
    total += Math.floor((data.length * 3) / 4);
    blocks.push(kind === 'document'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: String(f.name || 'Loan document').slice(0, 200) }
      : { type: 'image', source: { type: 'base64', media_type: f.mime, data } });
  }
  if (total > MAX_TOTAL_BYTES) throw new HttpError(400, 'Those files are too large together (24 MB at most). Leave out pages that aren\'t needed, like terms and conditions.');

  const client = clientFor('loan_documents');
  let message;
  try {
    const stream = client.beta.messages.stream({
      model: model(),
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: 'Extract the settlement letter details from these loan documents.' }] }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    // Never pass a 401 through: it would sign the broker out of the CRM.
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(400, 'The Anthropic API key was rejected. Check it in Settings → AI.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new HttpError(400, 'The Anthropic API key isn\'t allowed to use this model. Check it in Settings → AI.');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(502, 'The AI service is busy right now. Try again in a minute.');
    if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `The AI service couldn't read those files: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `The AI service had a problem (${err.status ?? 'no response'}). Try again shortly.`);
    throw new HttpError(502, `Couldn't reach the AI service: ${err.message}`);
  }
  if (message.stop_reason === 'refusal') throw new HttpError(502, 'The AI service declined to read these documents. Enter the details by hand.');
  if (message.stop_reason === 'max_tokens') throw new HttpError(502, 'The documents were too long to read in one go. Try fewer files.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'The AI service returned something unexpected. Try again, or enter the details by hand.');
  }
  return { ...out, model: message.model, usage: { input_tokens: message.usage?.input_tokens, output_tokens: message.usage?.output_tokens } };
}

module.exports = { extract, configured, saveConfig, model, clientFor, SCHEMA, DEFAULT_MODEL, MAX_FILES };
