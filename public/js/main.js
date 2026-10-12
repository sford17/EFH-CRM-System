import { api, h, clear, state, loadLookups, toast, attempt, dateTime, modal } from './core.js';
import { dashboardPage } from './pages/dashboard.js';
import { contactsPage, contactPage } from './pages/contacts.js';
import { pipelinePage, dealsPage, dealPage } from './pages/deals.js';
import { tasksPage } from './pages/tasks.js';
import { automationsPage, automationPage } from './pages/automations.js';
import { templatesPage, outboxPage } from './pages/comms.js';
import { commissionsPage } from './pages/commissions.js';
import { partnersPage, lendersPage, settingsPage } from './pages/admin.js';
import { reportsPage } from './pages/reports.js';
import { calculatorsPage } from './pages/calculators.js';
import { inboxPage } from './pages/email.js';
import { calendarPage } from './pages/calendar.js';
import { importPage } from './pages/import.js';
import { reviewPage } from './pages/review.js';

const NAV = [
  ['#/', 'Dashboard', '◧'],
  ['#/pipeline', 'Pipeline', '▤'],
  ['#/contacts', 'Contacts', '☺'],
  ['#/deals', 'Deals', '$'],
  ['#/calendar', 'Calendar', '▦'],
  ['#/tasks', 'Tasks', '✓'],
  ['#/inbox', 'Client emails', '✉'],
  ['#/automations', 'Automations', '⚡'],
  ['#/templates', 'Email templates', '✎'],
  ['#/outbox', 'Outbox', '⇪'],
  ['#/commissions', 'Commissions', '¢'],
  ['#/partners', 'Referral partners', '⇄'],
  ['#/lenders', 'Lenders', '⌂'],
  ['#/reports', 'Reports', '▥'],
  ['#/calculators', 'Calculators', '±'],
  ['#/settings', 'Settings', '⚙'],
];

const ROUTES = [
  [/^\/$/, dashboardPage],
  [/^\/pipeline$/, pipelinePage],
  [/^\/contacts$/, contactsPage],
  [/^\/import$/, importPage],
  [/^\/reviews\/(\d+)$/, reviewPage],
  [/^\/contacts\/(\d+)$/, contactPage],
  [/^\/deals$/, dealsPage],
  [/^\/deals\/(\d+)$/, dealPage],
  [/^\/tasks$/, tasksPage],
  [/^\/inbox$/, inboxPage],
  [/^\/calendar$/, calendarPage],
  [/^\/automations$/, automationsPage],
  [/^\/automations\/(\d+|new)$/, automationPage],
  [/^\/templates$/, templatesPage],
  [/^\/outbox$/, outboxPage],
  [/^\/commissions$/, commissionsPage],
  [/^\/partners$/, partnersPage],
  [/^\/lenders$/, lendersPage],
  [/^\/reports$/, reportsPage],
  [/^\/calculators$/, calculatorsPage],
  [/^\/settings$/, settingsPage],
];

const app = document.getElementById('app');

// Logo (or text mark) for the sidebar and sign-in page.
function brandMark(large = false) {
  const b = state.brand || {};
  if (b.logo) return h(`div.${large ? 'brand-lg' : 'brand'}`, h(`img.${large ? 'brand-logo-lg' : 'brand-logo'}`, { src: `${b.logo}?v=${b.version}`, alt: b.business_name || 'Logo' }));
  return h(`div.${large ? 'brand-lg' : 'brand'}`, h('span.logo', 'EFH'), h('span', 'CRM'));
}

// Reloads /brand.css and the logo after branding changes.
export function reloadBranding(brand) {
  const link = document.getElementById('brand-css');
  if (link) link.href = `/brand.css?v=${Date.now()}`;
  state.brand = { ...state.brand, logo: brand.logo?.url || null, version: brand.version, business_name: brand.business_name };
  const old = document.querySelector('.sidebar .brand');
  if (old) old.replaceWith(brandMark());
}
window.addEventListener('crm:branding', (e) => reloadBranding(e.detail));

function authScreen(needsSetup) {
  const fields = needsSetup
    ? [['business_name', 'Business name', 'text'], ['name', 'Your name', 'text'], ['email', 'Email', 'email'], ['password', 'Password (8+ characters)', 'password']]
    : [['email', 'Email', 'email'], ['password', 'Password', 'password']];
  const form = h('form.auth-card',
    brandMark(true),
    h('h1', needsSetup ? 'Set up your CRM' : `Sign in${state.brand?.business_name && !needsSetup ? ` to ${state.brand.business_name}` : ''}`),
    needsSetup ? h('p.muted', 'Create the first administrator account.') : null,
    fields.map(([name, text, type]) => h('div.field', h('label', { for: `a_${name}` }, text),
      h('input', { id: `a_${name}`, name, type, required: name !== 'business_name', autocomplete: type === 'password' ? (needsSetup ? 'new-password' : 'current-password') : name }))),
    h('button', { type: 'submit' }, needsSetup ? 'Create account' : 'Sign in'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    await attempt(async () => {
      const { user } = await api(needsSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body });
      state.user = user;
      location.hash = '#/';
      await boot();
    });
  });
  clear(app).append(h('div.auth-wrap', form));
}

function shell() {
  const search = h('input.search', { type: 'search', placeholder: 'Search contacts & deals…', 'aria-label': 'Search' });
  const results = h('div.search-results', { hidden: true });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      const r = await api(`/search?q=${encodeURIComponent(q)}`);
      clear(results).append(
        ...r.contacts.map((c) => h('a', { href: `#/contacts/${c.id}` }, h('strong', `${c.first_name} ${c.last_name || ''}`), h('span.muted', ` ${c.email || c.mobile || ''}`))),
        ...r.deals.map((d) => h('a', { href: `#/deals/${d.id}` }, h('strong', d.title), h('span.muted', ' deal'))),
      );
      if (!r.contacts.length && !r.deals.length) results.append(h('p.muted', 'No matches'));
      results.hidden = false;
    }, 200);
  });
  search.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 200));
  window.addEventListener('hashchange', () => { results.hidden = true; search.value = ''; });

  const bell = h('button.icon.bell', { type: 'button', 'aria-label': 'Notifications', onclick: () => openNotifications() }, '🔔', h('span.count', { hidden: true }));
  const menuBtn = h('button.icon.menu-toggle', { type: 'button', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, '☰');

  clear(app).append(
    h('nav.sidebar',
      brandMark(),
      h('ul', NAV.map(([href, text, icon]) => h('li', h('a', { href, dataset: { nav: href } }, h('span.nav-icon', { 'aria-hidden': 'true' }, icon), text)))),
      h('div.user-box', h('div', h('strong', state.user.name), h('div.muted', state.user.role)),
        h('button.link', { type: 'button', onclick: logout }, 'Sign out'))),
    h('div.main',
      h('header.topbar', menuBtn, h('div.search-box', search, results), bell),
      h('main#view')),
  );
  refreshNotifications();
}

async function refreshNotifications() {
  try {
    const { unread } = await api('/notifications');
    const count = document.querySelector('.bell .count');
    if (count) { count.textContent = unread; count.hidden = !unread; }
  } catch { /* ignore */ }
}

async function openNotifications() {
  const { rows } = await api('/notifications');
  modal('Notifications', rows.length
    ? h('ul.notif-list', rows.map((n) => h(`li${n.read ? '' : '.unread'}`, n.link ? h('a', { href: n.link }, n.message) : n.message, h('div.muted', dateTime(n.created_at)))))
    : h('p.empty', 'No notifications.'));
  await api('/notifications/read', { method: 'POST', body: {} });
  refreshNotifications();
}

async function logout() {
  await api('/auth/logout', { method: 'POST', body: {} });
  state.user = null;
  state.meta = null;
  location.hash = '#/login';
  boot();
}

async function route() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  window.routeQuery = new URLSearchParams(query);
  if (path === '/login') return;
  document.body.classList.remove('nav-open');
  const view = document.getElementById('view');
  if (!view) return;
  for (const a of document.querySelectorAll('[data-nav]')) {
    const href = a.dataset.nav.slice(1);
    a.classList.toggle('active', href === '/' ? path === '/' : path.startsWith(href));
  }
  const match = ROUTES.find(([re]) => re.test(path));
  clear(view).append(h('div.loading', 'Loading…'));
  try {
    if (!match) throw new Error('Page not found');
    const params = path.match(match[0]).slice(1);
    const content = await match[1](...params);
    clear(view).append(content);
    view.focus?.();
    window.scrollTo(0, 0);
  } catch (err) {
    clear(view).append(h('div.error-box', h('h2', 'Something went wrong'), h('p', err.message)));
  }
  refreshNotifications();
}

async function boot() {
  const status = await api('/auth/status');
  state.brand = status.brand;
  if (!status.user) {
    authScreen(status.needs_setup);
    return;
  }
  state.user = status.user;
  await loadLookups(true);
  shell();
  if (location.hash === '#/login' || !location.hash) location.hash = '#/';
  else route();
}

window.addEventListener('hashchange', () => { if (state.user) route(); });
// Lets pages re-render the current route after a change.
window.addEventListener('crm:refresh', () => route());
boot().catch((err) => toast(err.message, 'error'));
