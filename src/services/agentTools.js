'use strict';
// Tools for the CRM's AI assistant. "Read" tools look things up and run
// straight away. "Action" tools change data or contact someone, so the
// broker approves each one before it runs.
const db = require('../db');
const { STAGES, STAGE_KEYS, OPEN_STAGES } = require('../constants');
const { today, addDays, nowIso, formatDate, HttpError } = require('../util');

const STATUSES = ['lead', 'prospect', 'client', 'past_client', 'lost'];
const stageLabel = (k) => STAGES.find((s) => s.key === k)?.label || k;
const fullName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ');
const money = (n) => (n === null || n === undefined ? null : `$${Math.round(n).toLocaleString('en-AU')}`);
const like = (q) => `%${String(q).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
const clip = (s, n = 300) => (s && String(s).length > n ? `${String(s).slice(0, n)}…` : s || null);
const int = { type: 'integer' };
const str = { type: 'string' };
const date = { type: 'string', description: 'YYYY-MM-DD' };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const opt = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- Read tools -------------------------------------------------------------------------

const READ = {
  search_contacts: {
    description: 'Find contacts (clients, leads, prospects) by name, email, phone or tag. Returns ids and links.',
    input_schema: obj({ query: opt(str), status: opt({ type: 'string', enum: STATUSES }), limit: opt(int) }, ['query', 'status', 'limit']),
    run(i) {
      const where = [];
      const args = [];
      if (i.query) {
        where.push("(c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.mobile LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')");
        args.push(like(i.query), like(i.query), like(i.query), like(i.query));
      }
      if (i.status) { where.push('c.status = ?'); args.push(i.status); }
      const rows = db.all(
        `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.status, c.next_review_date, u.name AS owner FROM contacts c LEFT JOIN users u ON u.id = c.owner_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.updated_at DESC LIMIT ?`,
        ...args, Math.min(50, i.limit || 15),
      );
      return { count: rows.length, contacts: rows.map((c) => ({ id: c.id, name: fullName(c), email: c.email, mobile: c.mobile, status: c.status, broker: c.owner, next_review: c.next_review_date, link: `#/contacts/${c.id}` })) };
    },
  },

  get_contact: {
    description: 'Everything about one contact: details, household, deals, mortgage tracker (properties, loans, rates, LVR), open tasks and recent activity.',
    input_schema: obj({ contact_id: int }, ['contact_id']),
    run(i) {
      const c = db.one('SELECT c.*, u.name AS owner FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', i.contact_id);
      if (!c) return { error: 'No contact with that id' };
      const household = require('./household');
      const t = require('./tracker').summary(c.id);
      const ids = household.householdIds(c.id);
      const inIds = ids.map(() => '?').join(',');
      return {
        id: c.id, name: fullName(c), link: `#/contacts/${c.id}`, status: c.status, email: c.email, mobile: c.mobile, dob: c.dob,
        address: [c.address, c.suburb, c.state, c.postcode].filter(Boolean).join(', '), employment: c.employment_type, employer: c.employer,
        annual_income: c.annual_income, dependants: c.dependants, broker: c.owner, lead_source: c.lead_source, tags: c.tags,
        marketing_opt_in: Boolean(c.marketing_opt_in), next_review_date: c.next_review_date, background: clip(c.background, 600),
        household: household.household(c.id).filter((m) => m.id !== c.id).map((m) => ({ id: m.id, name: fullName(m) })),
        deals: db.all(`SELECT d.id, d.title, d.stage, d.loan_amount, d.settlement_date, l.name AS lender FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id WHERE d.contact_id IN (${inIds}) OR d.co_borrower_id IN (${inIds}) ORDER BY d.id DESC LIMIT 15`, ...ids, ...ids)
          .map((d) => ({ id: d.id, title: d.title, stage: stageLabel(d.stage), loan_amount: d.loan_amount, lender: d.lender, settlement_date: d.settlement_date, link: `#/deals/${d.id}` })),
        position: { property_value: t.totals.property_value, total_lending: t.totals.total_debt, lvr: t.totals.lvr, usable_equity: t.totals.usable_equity, net_position: t.totals.net_position },
        properties: t.properties.filter((p) => p.status !== 'sold').map((p) => ({ address: p.address, use: p.usage, value: p.current_value, valued: p.current_valuation?.method_label })),
        loans: t.loans.filter((n) => n.status === 'active').map((n) => ({
          lender: n.lender_display, type: n.loan_type, balance: n.balance ?? n.limit_amount, rate: n.interest_rate, rate_type: n.rate_type,
          fixed_until: n.fixed_expiry_date, repayment_type: n.repayment_type, io_until: n.io_expiry_date, arranged_by_us: Boolean(n.arranged_by_us),
        })),
        open_tasks: db.all("SELECT id, title, due_date FROM tasks WHERE contact_id = ? AND status = 'open' ORDER BY due_date LIMIT 10", c.id),
        recent_activity: db.all('SELECT type, body, created_at FROM activities WHERE contact_id = ? ORDER BY id DESC LIMIT 10', c.id)
          .map((a) => ({ type: a.type, when: a.created_at.slice(0, 10), text: clip(a.body, 200) })),
      };
    },
  },

  search_deals: {
    description: 'Find deals by client/title, stage, broker or settlement dates. Stages: ' + STAGES.map((s) => `${s.key} (${s.label})`).join(', '),
    input_schema: obj({
      query: opt(str), stage: opt({ type: 'string', enum: STAGE_KEYS }), open_only: opt({ type: 'boolean' }), settlement_from: opt(date), settlement_to: opt(date),
      owner_user_id: opt(int), limit: opt(int),
    }, ['query', 'stage', 'open_only', 'settlement_from', 'settlement_to', 'owner_user_id', 'limit']),
    run(i) {
      const where = [];
      const args = [];
      if (i.query) { where.push("(d.title LIKE ? ESCAPE '\\' OR c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? ESCAPE '\\')"); args.push(like(i.query), like(i.query)); }
      if (i.stage) { where.push('d.stage = ?'); args.push(i.stage); }
      if (i.open_only) { where.push(`d.stage IN (${OPEN_STAGES.map(() => '?').join(',')})`); args.push(...OPEN_STAGES); }
      if (i.settlement_from) { where.push('d.settlement_date >= ?'); args.push(i.settlement_from); }
      if (i.settlement_to) { where.push('d.settlement_date <= ?'); args.push(i.settlement_to); }
      if (i.owner_user_id) { where.push('d.owner_id = ?'); args.push(i.owner_user_id); }
      const rows = db.all(
        `SELECT d.id, d.title, d.stage, d.loan_amount, d.loan_purpose, d.settlement_date, d.finance_due_date, l.name AS lender, u.name AS broker,
                c.first_name, c.last_name, d.contact_id
         FROM deals d JOIN contacts c ON c.id = d.contact_id LEFT JOIN lenders l ON l.id = d.lender_id LEFT JOIN users u ON u.id = d.owner_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(d.settlement_date, '9999') , d.id DESC LIMIT ?`,
        ...args, Math.min(50, i.limit || 20),
      );
      return {
        count: rows.length,
        total_volume: rows.reduce((s, d) => s + (d.loan_amount || 0), 0),
        deals: rows.map((d) => ({ id: d.id, title: d.title, client: fullName(d), stage: stageLabel(d.stage), purpose: d.loan_purpose, loan_amount: d.loan_amount, lender: d.lender, broker: d.broker, finance_due: d.finance_due_date, settlement_date: d.settlement_date, link: `#/deals/${d.id}` })),
      };
    },
  },

  get_deal: {
    description: 'Everything about one deal: loan details, stage history, key dates, agent/solicitor, documents outstanding, tasks, commission and settlement letter status.',
    input_schema: obj({ deal_id: int }, ['deal_id']),
    run(i) {
      const d = db.one(
        `SELECT d.*, l.name AS lender, u.name AS broker, c.first_name, c.last_name, cb.first_name AS co_first, cb.last_name AS co_last
         FROM deals d JOIN contacts c ON c.id = d.contact_id LEFT JOIN contacts cb ON cb.id = d.co_borrower_id
         LEFT JOIN lenders l ON l.id = d.lender_id LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?`,
        i.deal_id,
      );
      if (!d) return { error: 'No deal with that id' };
      const letter = db.one('SELECT status, sent_at FROM settlement_letters WHERE deal_id = ?', d.id);
      return {
        id: d.id, title: d.title, link: `#/deals/${d.id}`, stage: stageLabel(d.stage), borrowers: [fullName(d), d.co_first ? fullName({ first_name: d.co_first, last_name: d.co_last }) : null].filter(Boolean),
        contact_id: d.contact_id, purpose: d.loan_purpose, lender: d.lender, product: d.product_name, loan_amount: d.loan_amount, property_value: d.property_value,
        lvr: d.loan_amount && d.property_value ? Math.round((d.loan_amount / d.property_value) * 1000) / 10 : null, rate: d.interest_rate, rate_type: d.rate_type,
        property: d.property_address, broker: d.broker, pre_approval_expiry: d.pre_approval_expiry, finance_due: d.finance_due_date, settlement_date: d.settlement_date,
        lost_reason: d.lost_reason,
        parties: db.all('SELECT dp.role, p.name, p.company, p.email, p.phone FROM deal_parties dp JOIN referral_partners p ON p.id = dp.partner_id WHERE dp.deal_id = ?', d.id),
        documents_outstanding: db.all("SELECT name, status FROM documents WHERE deal_id = ? AND status IN ('required','requested')", d.id).map((x) => x.name),
        open_tasks: db.all("SELECT id, title, due_date FROM tasks WHERE deal_id = ? AND status = 'open' ORDER BY due_date", d.id),
        stage_history: db.all('SELECT from_stage, to_stage, changed_at FROM deal_stage_history WHERE deal_id = ? ORDER BY id', d.id).map((h) => `${h.changed_at.slice(0, 10)}: ${stageLabel(h.to_stage)}`),
        commissions: db.all("SELECT type, amount, status, period FROM commissions WHERE deal_id = ? AND status != 'cancelled' ORDER BY period LIMIT 6", d.id),
        settlement_letter: letter ? `${letter.status}${letter.sent_at ? ` ${letter.sent_at.slice(0, 10)}` : ''}` : 'not started',
      };
    },
  },

  find_loans: {
    description: 'Search loans in the mortgage tracker across all clients, e.g. fixed rates ending soon, interest-only periods ending, rates above a level, or by lender. Good for finding clients to contact.',
    input_schema: obj({
      fixed_expiring_within_days: opt(int), io_expiring_within_days: opt(int), rate_above: opt({ type: 'number' }), lender: opt(str), limit: opt(int),
    }, ['fixed_expiring_within_days', 'io_expiring_within_days', 'rate_above', 'lender', 'limit']),
    run(i) {
      const where = ["n.status = 'active'"];
      const args = [];
      const t = today();
      if (i.fixed_expiring_within_days) { where.push("n.rate_type IN ('fixed','split') AND n.fixed_expiry_date BETWEEN ? AND ?"); args.push(t, addDays(t, i.fixed_expiring_within_days)); }
      if (i.io_expiring_within_days) { where.push("n.repayment_type = 'io' AND n.io_expiry_date BETWEEN ? AND ?"); args.push(t, addDays(t, i.io_expiring_within_days)); }
      if (i.rate_above) { where.push('n.interest_rate > ?'); args.push(i.rate_above); }
      if (i.lender) { where.push("COALESCE(l.name, n.lender_name) LIKE ? ESCAPE '\\'"); args.push(like(i.lender)); }
      const rows = db.all(
        `SELECT n.*, COALESCE(l.name, n.lender_name) AS lender, c.first_name, c.last_name FROM loans n JOIN contacts c ON c.id = n.contact_id LEFT JOIN lenders l ON l.id = n.lender_id
         WHERE ${where.join(' AND ')} ORDER BY COALESCE(n.fixed_expiry_date, n.io_expiry_date, '9999'), n.interest_rate DESC LIMIT ?`,
        ...args, Math.min(100, i.limit || 30),
      );
      return {
        count: rows.length,
        loans: rows.map((n) => ({
          client: fullName(n), contact_id: n.contact_id, link: `#/contacts/${n.contact_id}?tab=tracker`, lender: n.lender, type: n.loan_type,
          balance: n.balance ?? n.limit_amount, rate: n.interest_rate, rate_type: n.rate_type, fixed_until: n.fixed_expiry_date, io_until: n.io_expiry_date,
        })),
      };
    },
  },

  list_tasks: {
    description: 'List tasks: the current user\'s or everyone\'s, open or done, optionally only overdue or due within N days.',
    input_schema: obj({ everyone: opt({ type: 'boolean' }), status: opt({ type: 'string', enum: ['open', 'done'] }), overdue_only: opt({ type: 'boolean' }), due_within_days: opt(int) }, ['everyone', 'status', 'overdue_only', 'due_within_days']),
    run(i, ctx) {
      const where = ['t.status = ?'];
      const args = [i.status || 'open'];
      if (!i.everyone) { where.push('t.assigned_to = ?'); args.push(ctx.user.id); }
      if (i.overdue_only) { where.push('t.due_date < ?'); args.push(today()); }
      if (i.due_within_days) { where.push('t.due_date <= ?'); args.push(addDays(today(), i.due_within_days)); }
      const rows = db.all(
        `SELECT t.id, t.title, t.due_date, t.priority, t.contact_id, t.deal_id, u.name AS assignee, c.first_name, c.last_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN contacts c ON c.id = t.contact_id
         WHERE ${where.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date LIMIT 60`,
        ...args,
      );
      return { count: rows.length, tasks: rows.map((t) => ({ id: t.id, title: t.title, due: t.due_date, priority: t.priority, assignee: t.assignee, client: t.first_name ? fullName(t) : null, link: t.deal_id ? `#/deals/${t.deal_id}` : t.contact_id ? `#/contacts/${t.contact_id}` : '#/tasks' })) };
    },
  },

  pipeline_summary: {
    description: 'The open pipeline by stage (count and volume), deals due to settle in the next 30 days, and settlements so far this month.',
    input_schema: obj({}),
    run() {
      const t = today();
      return {
        by_stage: STAGES.filter((s) => OPEN_STAGES.includes(s.key)).map((s) => ({ stage: s.label, ...db.one('SELECT COUNT(*) AS count, COALESCE(SUM(loan_amount),0) AS volume FROM deals WHERE stage = ?', s.key) })),
        settling_next_30_days: db.all(`SELECT d.id, d.title, d.settlement_date, d.loan_amount FROM deals d WHERE d.stage IN (${OPEN_STAGES.map(() => '?').join(',')}) AND d.settlement_date BETWEEN ? AND ? ORDER BY d.settlement_date`, ...OPEN_STAGES, t, addDays(t, 30))
          .map((d) => ({ ...d, link: `#/deals/${d.id}` })),
        settled_this_month: db.one("SELECT COUNT(*) AS count, COALESCE(SUM(loan_amount),0) AS volume FROM deals WHERE stage = 'settled' AND settlement_date >= ?", `${t.slice(0, 7)}-01`),
      };
    },
  },

  settlements_report: {
    description: 'Settlement totals and commission for a period: financial year (fy, e.g. 2027 = Jul 2026–Jun 2027), calendar year (cy) or custom dates. Month-by-month totals.',
    input_schema: obj({ period: { type: 'string', enum: ['fy', 'cy', 'custom'] }, fy: opt(int), year: opt(int), from: opt(date), to: opt(date) }, ['period', 'fy', 'year', 'from', 'to']),
    run(i) {
      const period = require('./periods').resolve({ period: i.period, fy: i.fy ? String(i.fy) : undefined, year: i.year ? String(i.year) : undefined, from: i.from || undefined, to: i.to || undefined });
      const r = require('./settlementReport').report({ period });
      return { period: r.period.label, totals: r.totals, months: r.months.map((m) => ({ month: m.month, ...m.totals })) };
    },
  },

  run_calculator: {
    description: 'Run one of the CRM calculators. calculator: repayment {loan_amount, interest_rate, loan_term_years, frequency, repayment_type, io_years}; borrowing-power {applicant1_income, applicant2_income, dependants, living_expenses, existing_repayments, credit_card_limits, interest_rate, buffer}; lvr {property_value, loan_amount}; refinance {loan_balance, remaining_years, current_rate, new_rate, switching_costs, cashback}; stamp-duty-residential {state, property_value, property_type, buyer, first_home, foreign}; stamp-duty-commercial {state, property_value}; purchase {purchase_price, lvr or loan_amount, state, property_type, buyer, first_home, legal_costs}.',
    input_schema: { type: 'object', properties: { calculator: { type: 'string' }, inputs: { type: 'object' } }, required: ['calculator', 'inputs'] },
    strict: false,
    run(i) {
      const { CALCULATORS } = require('./calculators');
      if (!Object.hasOwn(CALCULATORS, i.calculator)) return { error: `Unknown calculator. Use one of: ${Object.keys(CALCULATORS).join(', ')}` };
      try {
        const r = CALCULATORS[i.calculator](i.inputs || {});
        if (r && r.comparison) delete r.comparison;
        return r;
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  reference_data: {
    description: 'Team members (user ids), lenders (ids) and deal stages, for filling in other tools.',
    input_schema: obj({}),
    run() {
      return {
        users: db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name'),
        lenders: db.all('SELECT id, name FROM lenders WHERE active = 1 ORDER BY name'),
        stages: STAGES.map((s) => ({ key: s.key, label: s.label })),
      };
    },
  },
};

// ---- Action tools (approved by the broker first) -------------------------------------------------

const contactName = (id) => fullName(db.one('SELECT first_name, last_name FROM contacts WHERE id = ?', id)) || `contact ${id}`;
const mustContact = (id) => {
  if (!db.one('SELECT 1 FROM contacts WHERE id = ?', id)) throw new HttpError(400, 'That contact no longer exists');
};
const mustDeal = (id) => {
  if (id && !db.one('SELECT 1 FROM deals WHERE id = ?', id)) throw new HttpError(400, 'That deal no longer exists');
};
const when = (d) => (d ? formatDate(d) : null);

const ACTIONS = {
  create_task: {
    description: 'Create a task (a to-do) for the current user or a team member, optionally about a contact and/or deal.',
    input_schema: obj({
      title: str, description: opt(str), due_date: opt(date), priority: opt({ type: 'string', enum: ['low', 'normal', 'high'] }),
      contact_id: opt(int), deal_id: opt(int), assign_to_user_id: opt(int),
    }, ['title', 'description', 'due_date', 'priority', 'contact_id', 'deal_id', 'assign_to_user_id']),
    summary: (i) => `Create a task: "${i.title}"${i.due_date ? `, due ${when(i.due_date)}` : ''}${i.contact_id ? `, about ${contactName(i.contact_id)}` : ''}${i.assign_to_user_id ? `, for ${db.one('SELECT name FROM users WHERE id = ?', i.assign_to_user_id)?.name || 'a team member'}` : ''}`,
    run(i, ctx) {
      if (i.contact_id) mustContact(i.contact_id);
      mustDeal(i.deal_id);
      if (i.due_date && !DATE.test(i.due_date)) throw new HttpError(400, 'Invalid due date');
      const id = db.insert('tasks', {
        title: String(i.title).slice(0, 200), description: i.description ? String(i.description).slice(0, 2000) : null, due_date: i.due_date || null,
        priority: i.priority || 'normal', contact_id: i.contact_id || null, deal_id: i.deal_id || null,
        assigned_to: i.assign_to_user_id && db.one('SELECT 1 FROM users WHERE id = ? AND active = 1', i.assign_to_user_id) ? i.assign_to_user_id : ctx.user.id,
        created_by: ctx.user.id,
      });
      return { done: true, task_id: id, link: '#/tasks' };
    },
  },

  add_note: {
    description: 'Add a note (or a logged call/meeting) to a contact\'s timeline, optionally on a deal.',
    input_schema: obj({ contact_id: int, deal_id: opt(int), type: opt({ type: 'string', enum: ['note', 'call', 'meeting'] }), note: str }, ['contact_id', 'deal_id', 'type', 'note']),
    summary: (i) => `Add a ${i.type || 'note'} to ${contactName(i.contact_id)}'s timeline: "${clip(i.note, 160)}"`,
    run(i, ctx) {
      mustContact(i.contact_id);
      mustDeal(i.deal_id);
      const id = db.insert('activities', { contact_id: i.contact_id, deal_id: i.deal_id || null, user_id: ctx.user.id, type: i.type || 'note', body: String(i.note).slice(0, 5000) });
      return { done: true, activity_id: id, link: `#/contacts/${i.contact_id}` };
    },
  },

  create_contact: {
    description: 'Create a new contact (usually a lead).',
    input_schema: obj({
      first_name: str, last_name: opt(str), email: opt(str), mobile: opt(str), status: opt({ type: 'string', enum: STATUSES }), lead_source: opt(str), background: opt(str),
    }, ['first_name', 'last_name', 'email', 'mobile', 'status', 'lead_source', 'background']),
    summary: (i) => `Create a ${i.status || 'lead'}: ${[i.first_name, i.last_name].filter(Boolean).join(' ')}${i.email ? `, ${i.email}` : ''}${i.mobile ? `, ${i.mobile}` : ''}`,
    run(i, ctx) {
      if (i.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) throw new HttpError(400, 'That email address doesn\'t look right');
      const id = db.insert('contacts', {
        first_name: String(i.first_name).slice(0, 80), last_name: i.last_name || null, email: i.email || null, mobile: i.mobile || null,
        status: i.status || 'lead', lead_source: i.lead_source || null, background: i.background || null, owner_id: ctx.user.id,
      });
      return { done: true, contact_id: id, link: `#/contacts/${id}` };
    },
  },

  update_deal: {
    description: 'Change a deal: move it to another stage (which runs that stage\'s automations, e.g. client emails), or update its dates, amount, rate or lender.',
    input_schema: obj({
      deal_id: int, stage: opt({ type: 'string', enum: STAGE_KEYS }), lost_reason: opt(str), settlement_date: opt(date), finance_due_date: opt(date),
      pre_approval_expiry: opt(date), loan_amount: opt({ type: 'number' }), interest_rate: opt({ type: 'number' }), lender_id: opt(int),
    }, ['deal_id', 'stage', 'lost_reason', 'settlement_date', 'finance_due_date', 'pre_approval_expiry', 'loan_amount', 'interest_rate', 'lender_id']),
    summary(i) {
      const d = db.one('SELECT title, stage FROM deals WHERE id = ?', i.deal_id);
      const parts = [];
      if (i.stage) parts.push(`move to ${stageLabel(i.stage)}${d && i.stage !== d.stage ? ' (stage automations will run)' : ''}`);
      if (i.settlement_date) parts.push(`settlement date ${when(i.settlement_date)}`);
      if (i.finance_due_date) parts.push(`finance due ${when(i.finance_due_date)}`);
      if (i.pre_approval_expiry) parts.push(`pre-approval expiry ${when(i.pre_approval_expiry)}`);
      if (i.loan_amount) parts.push(`loan amount ${money(i.loan_amount)}`);
      if (i.interest_rate) parts.push(`rate ${i.interest_rate}%`);
      if (i.lender_id) parts.push(`lender ${db.one('SELECT name FROM lenders WHERE id = ?', i.lender_id)?.name || i.lender_id}`);
      return `Update deal "${d?.title || i.deal_id}": ${parts.join(', ') || 'no changes'}`;
    },
    run(i, ctx) {
      const d = db.one('SELECT * FROM deals WHERE id = ?', i.deal_id);
      if (!d) throw new HttpError(400, 'That deal no longer exists');
      const patch = {};
      for (const k of ['settlement_date', 'finance_due_date', 'pre_approval_expiry']) {
        if (i[k]) {
          if (!DATE.test(i[k])) throw new HttpError(400, `Invalid ${k.replace(/_/g, ' ')}`);
          patch[k] = i[k];
        }
      }
      if (i.loan_amount) patch.loan_amount = i.loan_amount;
      if (i.interest_rate) patch.interest_rate = i.interest_rate;
      if (i.lender_id && db.one('SELECT 1 FROM lenders WHERE id = ?', i.lender_id)) patch.lender_id = i.lender_id;
      if (Object.keys(patch).length) db.update('deals', d.id, { ...patch, updated_at: nowIso() });
      if (i.stage && i.stage !== d.stage) {
        if (i.stage === 'lost' && !i.lost_reason) throw new HttpError(400, 'A reason is needed to mark a deal lost');
        require('./automation').changeDealStage(d.id, i.stage, ctx.user.id, i.stage === 'lost' ? { lost_reason: i.lost_reason } : {});
      }
      return { done: true, link: `#/deals/${d.id}` };
    },
  },

  send_email: {
    description: 'Email a contact from the current user\'s mailbox (branded, with their signature). Write the full email body; it is sent as written once approved.',
    input_schema: obj({ contact_id: int, deal_id: opt(int), subject: str, body: str }, ['contact_id', 'deal_id', 'subject', 'body']),
    summary: (i) => {
      const c = db.one('SELECT first_name, last_name, email FROM contacts WHERE id = ?', i.contact_id);
      return `Email ${fullName(c) || 'contact'}${c?.email ? ` <${c.email}>` : ' (no email address!)'}: "${i.subject}"`;
    },
    preview: (i) => i.body,
    async run(i, ctx) {
      const c = db.one('SELECT id, email FROM contacts WHERE id = ?', i.contact_id);
      if (!c) throw new HttpError(400, 'That contact no longer exists');
      if (!c.email) throw new HttpError(400, 'That contact has no email address');
      mustDeal(i.deal_id);
      const mailer = require('./mailer');
      const id = mailer.queueEmail({ to: c.email, subject: String(i.subject).slice(0, 300), body: String(i.body).slice(0, 20000), contactId: c.id, dealId: i.deal_id || null, senderUserId: ctx.user.id });
      await mailer.processOutbox();
      const out = db.one('SELECT status, error FROM outbox WHERE id = ?', id);
      if (out.status === 'failed') throw new HttpError(502, `The email couldn't be sent: ${out.error}`);
      return { done: true, status: out.status === 'logged' ? 'logged (no mailbox connected, so not actually sent)' : 'sent' };
    },
  },

  send_sms: {
    description: 'Send a text message to a contact\'s mobile (from the current user\'s SMS number). Keep it short; it is sent as written once approved.',
    input_schema: obj({ contact_id: int, deal_id: opt(int), message: str }, ['contact_id', 'deal_id', 'message']),
    summary: (i) => {
      const c = db.one('SELECT first_name, last_name, mobile FROM contacts WHERE id = ?', i.contact_id);
      return `Text ${fullName(c) || 'contact'}${c?.mobile ? ` (${c.mobile})` : ' (no mobile!)'}`;
    },
    preview: (i) => i.message,
    async run(i, ctx) {
      mustContact(i.contact_id);
      const sms = require('./sms');
      const r = sms.queueForContact({ contactId: i.contact_id, dealId: i.deal_id || null, body: String(i.message).slice(0, 640), senderUserId: ctx.user.id });
      if (!r.id) throw new HttpError(400, r.reason);
      await sms.processSms();
      const out = db.one('SELECT status, error FROM sms_messages WHERE id = ?', r.id);
      if (out?.status === 'failed') throw new HttpError(502, `The text couldn't be sent: ${out.error}`);
      return { done: true, status: out?.status || 'queued' };
    },
  },
};

// Minimal check of a tool's input against its schema (the model's input is
// streamed without server validation, so it's checked here before running).
function check(schema, value, path = 'input') {
  if (schema.anyOf) {
    const errs = schema.anyOf.map((s) => check(s, value, path)).filter(Boolean);
    return errs.length === schema.anyOf.length ? errs[0] : null;
  }
  const t = schema.type;
  if (t === 'null') return value === null ? null : `${path} should be null`;
  if (t === 'string') {
    if (typeof value !== 'string') return `${path} should be text`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} should be one of ${schema.enum.join(', ')}`;
    return null;
  }
  if (t === 'integer') return Number.isInteger(value) ? null : `${path} should be a whole number`;
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${path} should be a number`;
  if (t === 'boolean') return typeof value === 'boolean' ? null : `${path} should be true or false`;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} should be an object`;
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) return `${path}.${k} is missing`;
    for (const [k, v] of Object.entries(value)) {
      if (!schema.properties) continue;
      if (!Object.hasOwn(schema.properties, k)) {
        if (schema.additionalProperties === false) return `${path}.${k} isn't expected`;
        continue;
      }
      const e = check(schema.properties[k], v, `${path}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

// Tool definitions for the API.
function definitions() {
  const def = (name, t) => ({ name, description: t.description, input_schema: t.input_schema, ...(t.strict === false ? {} : { strict: true }), eager_input_streaming: true });
  return [...Object.entries(READ).map(([n, t]) => def(n, t)), ...Object.entries(ACTIONS).map(([n, t]) => def(n, t))];
}

const isAction = (name) => Object.hasOwn(ACTIONS, name);
const isRead = (name) => Object.hasOwn(READ, name);
const tool = (name) => (isRead(name) ? READ[name] : isAction(name) ? ACTIONS[name] : null);

const LABELS = {
  search_contacts: (i) => `Searching contacts${i.query ? ` for "${i.query}"` : ''}`,
  get_contact: (i) => `Looking at ${contactName(i.contact_id)}`,
  search_deals: (i) => `Searching deals${i.query ? ` for "${i.query}"` : ''}`,
  get_deal: (i) => `Looking at deal ${db.one('SELECT title FROM deals WHERE id = ?', i.deal_id)?.title || i.deal_id}`,
  find_loans: () => 'Searching the mortgage tracker',
  list_tasks: () => 'Checking tasks',
  pipeline_summary: () => 'Checking the pipeline',
  settlements_report: () => 'Running the settlements report',
  run_calculator: (i) => `Running the ${String(i.calculator || '').replace(/-/g, ' ')} calculator`,
  reference_data: () => 'Looking up team members and lenders',
};
const label = (name, input) => {
  try {
    return LABELS[name] ? LABELS[name](input || {}) : name.replace(/_/g, ' ');
  } catch {
    return name.replace(/_/g, ' ');
  }
};

module.exports = { READ, ACTIONS, definitions, check, isAction, isRead, tool, label };
