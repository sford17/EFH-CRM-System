import { codeScreen, forcedSetupScreen } from './pages/mfa.js';
import { api, h, clear, state, loadLookups, toast, attempt, dateTime, modal } from './core.js';
import { dashboardPage } from './pages/dashboard.js';
import { contactsPage, contactPage } from './pages/contacts.js';
import { pipelinePage, dealsPage, dealPage } from './pages/deals.js';
import { tasksPage } from './pages/tasks.js';
import { automationsPage, automationPage } from './pages/automations.js';
import { templatesPage, outboxPage } from './pages/comms.js';
import { commissionsPage } from './pages/commissions.js';
import { partnersPage, settingsPage } from './pages/admin.js';
import { lendersPage, lenderPage } from './pages/lenders.js';
import { reportsPage } from './pages/reports.js';
import { calculatorsPage } from './pages/calculators.js';
import { inboxPage } from './pages/email.js';
import { calendarPage } from './pages/calendar.js';
import { importPage } from './pages/import.js';
import { reviewPage } from './pages/review.js';
import { socialPage } from './pages/social.js';
import { newslettersPage, newsletterPage } from './pages/newsletters.js';
import { assistantPage } from './pages/assistant.js';
import { leadsPage, leadSearchPage } from './pages/leads.js';
import { propertyReportPage } from './pages/propertyReports.js';
import { factFindsPage, factFindPage } from './pages/factFinds.js';
import { partnerNewslettersPage, partnerNewsletterPage } from './pages/partnerNewsletters.js';

const NAV = [
  ['#/', 'Dashboard', '◧'],
  ['#/assistant', 'Assistant', '✧'],
  ['#/pipeline', 'Pipeline', '▤'],
  ['#/contacts', 'Contacts', '☺'],
  ['#/leads', 'Lead Generator', '⌕'],
  ['#/fact-finds', 'Fact finds', '☑'],
  ['#/deals', 'Deals', '$'],
  ['#/calendar', 'Calendar', '▦'],
  ['#/tasks', 'Tasks', '✓'],
  ['#/inbox', 'Client emails', '✉'],
  ['#/automations', 'Automations', '⚡'],
  ['#/templates', 'Email templates', '✎'],
  ['#/outbox', 'Outbox', '⇪'],
  ['#/commissions', 'Commissions', '¢'],
  ['#/partners', 'Partners & agents', '⇄'],
  ['#/lenders', 'Lenders', '⌂'],
  ['#/newsletters', 'Newsletter', '✦'],
  ['#/social', 'Social', '◎'],
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
  [/^\/lenders\/(\d+)$/, lenderPage],
  [/^\/reports$/, reportsPage],
  [/^\/calculators$/, calculatorsPage],
  [/^\/social$/, socialPage],
  [/^\/leads$/, leadsPage],
  [/^\/leads\/(\d+)$/, leadSearchPage],
  [/^\/property-reports\/(\d+)$/, propertyReportPage],
  [/^\/fact-finds$/, factFindsPage],
  [/^\/partner-newsletters$/, partnerNewslettersPage],
  [/^\/partner-newsletters\/(\d+)$/, partnerNewsletterPage],
  [/^\/fact-finds\/(\d+)$/, factFindPage],
  [/^\/assistant$/, assistantPage],
  [/^\/assistant\/(\d+)$/, assistantPage],
  [/^\/newsletters$/, newslettersPage],
  [/^\/newsletters\/(\d+)$/, newsletterPage],
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
      const r = await api(needsSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body });
      if (r.mfa_required) {
        // Second step: a code from the authenticator app.
        codeScreen(app, {
          brandMark, challenge: r.challenge,
          onSignedIn: async (user) => { state.user = user; location.hash = '#/'; await boot(); },
          onBack: () => authScreen(false),
        });
        return;
      }
      state.user = r.user;
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
      h('header.topbar', menuBtn, h('div.search-box', search, results), h('a.button.secondary.small.ask-ai', { href: '#/assistant', title: 'Ask the AI assistant' }, '✧ Ask AI'), bell),
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
    const section = path.startsWith('/partner-newsletters') ? '/newsletters' : path;
    a.classList.toggle('active', href === '/' ? path === '/' : section.startsWith(href));
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

// The page a welcome email (or new-password email) links to: choose a password, then sign in.
async function welcomeScreen(token) {
  const done = async (user) => { state.user = user; location.hash = '#/'; await boot(); };
  let info;
  try {
    info = await api(`/auth/welcome/${encodeURIComponent(token)}`);
  } catch (err) {
    const back = h('button', { type: 'button', onclick: () => { location.hash = '#/login'; boot(); } }, 'Go to sign in');
    clear(app).append(h('div.auth-wrap', h('div.auth-card', brandMark(true), h('h1', 'This link has expired'), h('p', err.message), back)));
    return;
  }
  const pw = h('input', { id: 'w_pw', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const pw2 = h('input', { id: 'w_pw2', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const reset = info.kind === 'reset';
  const form = h('form.auth-card',
    brandMark(true),
    h('h1', reset ? 'Choose a new password' : `Welcome, ${info.name.split(/\s+/)[0]}`),
    h('p.muted', reset ? `For ${info.email}.` : `Choose a password for your account (${info.email}). You'll sign in with your email and this password from now on.`),
    h('input', { type: 'email', value: info.email, autocomplete: 'username', hidden: true, readonly: true }),
    h('div.field', h('label', { for: 'w_pw' }, 'Password (8+ characters)'), pw),
    h('div.field', h('label', { for: 'w_pw2' }, 'Type it again'), pw2),
    !reset && info.mfa_required ? h('p.small.muted', 'Next, you\'ll set up two-factor sign-in with an authenticator app on your phone.') : null,
    h('button', { type: 'submit' }, reset ? 'Save and sign in' : 'Save and continue'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pw.value !== pw2.value) { toast('The two passwords don\'t match', 'error'); return; }
    try {
      const r = await attempt(() => api(`/auth/welcome/${encodeURIComponent(token)}`, { method: 'POST', body: { password: pw.value } }));
      history.replaceState(null, '', '#/'); // the link is used up
      if (r.mfa_required) {
        codeScreen(app, { brandMark, challenge: r.challenge, onSignedIn: done, onBack: () => authScreen(false) });
        return;
      }
      await done(r.user);
    } catch { /* toasted */ }
  });
  clear(app).append(h('div.auth-wrap', form));
  pw.focus();
}

async function boot() {
  const status = await api('/auth/status');
  state.brand = status.brand;
  const welcome = location.hash.match(/^#\/welcome\/([\w-]+)$/);
  if (welcome) {
    await welcomeScreen(welcome[1]);
    return;
  }
  if (!status.user) {
    authScreen(status.needs_setup);
    return;
  }
  state.user = status.user;
  if (status.mfa_setup_required) {
    await forcedSetupScreen(app, { brandMark, onDone: () => boot(), onLogout: logout });
    return;
  }
  await loadLookups(true);
  shell();
  if (location.hash === '#/login' || !location.hash) location.hash = '#/';
  else route();
}

window.addEventListener('hashchange', () => {
  // Pop-ups belong to the page they were opened on.
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  if (location.hash.startsWith('#/welcome/')) boot();
  else if (state.user) route();
});
// Lets pages re-render the current route after a change.
window.addEventListener('crm:refresh', () => route());
// The business now requires two-factor sign-in and this person hasn't set it up.
window.addEventListener('crm:mfa-setup', () => boot());
boot().catch((err) => toast(err.message, 'error'));
