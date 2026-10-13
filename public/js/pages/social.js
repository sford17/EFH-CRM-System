// Social: connect LinkedIn and Instagram, write a post (with a picture),
// preview it, then post now, schedule it or keep it as a draft.
import { api, h, pageHeader, attempt, confirmDialog, toast, modal, field, readForm, dateTime, badge, state } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const NET_ICON = { linkedin: 'in', instagram: 'IG' };
const STATUS = {
  draft: ['Draft', ''], scheduled: ['Scheduled', 'info'], publishing: ['Posting…', 'info'], posted: ['Posted', 'ok'], partly_posted: ['Partly posted', 'warn'], failed: ['Failed', 'danger'],
};
const IDEAS = [
  ['Settlement celebration', 'Congratulations to my latest clients on picking up the keys to their new home! 🏡🔑 It was a pleasure helping you through every step.\n\nThinking about your next move? Let\'s chat.\n\n#homeloans #mortgagebroker #settlementday'],
  ['Loan health check', 'When did you last review your home loan? Lenders often keep their sharpest rates for new customers, so a quick review could save you thousands over the life of your loan.\n\nBook a free loan health check. It takes 15 minutes.\n\n#refinance #homeloan #mortgagebroker'],
  ['First home buyer tip', 'Buying your first home? Government schemes and stamp duty concessions could mean you need a smaller deposit than you think. 🏠\n\nHappy to run the numbers with you, no obligation.\n\n#firsthomebuyer #firsthome #homeloans'],
  ['Fixed rate ending', 'Is your fixed rate ending in the next few months? Get in touch 2–3 months before it expires so we can compare your options before you roll onto a higher variable rate.\n\n#fixedrate #homeloan #mortgagebroker'],
  ['Thank you, referral partners', 'A big thank you to the real estate agents, accountants and financial planners who trust me with their clients. Referrals are the best compliment a broker can receive. 🙏\n\n#referrals #mortgagebroker #smallbusiness'],
];

const netName = (k) => (k === 'linkedin' ? 'LinkedIn' : 'Instagram');
const icon = (k) => h(`span.net-icon.${k}`, { 'aria-hidden': 'true' }, NET_ICON[k]);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hashtagCount = (t) => (t.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;

// Composer state survives page refreshes (e.g. after connecting an account).
let draft = { id: null, body: '', image: null, image_url: '', alt_text: '', networks: [], when: '', chosen: false };
const resetDraft = () => { draft = { id: null, body: '', image: null, image_url: '', alt_text: '', networks: [], when: '', chosen: false }; };

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Couldn\'t read that file'));
    r.readAsDataURL(file);
  });
}

// ---- Accounts -------------------------------------------------------------------------
function accountCard(n, status) {
  const a = n.account;
  const isAdmin = state.user.role === 'admin';
  const connect = async () => {
    const r = await attempt(() => api(`/social/connect/${n.key}`, { method: 'POST', body: {} }));
    if (r?.url) location.href = r.url;
  };
  const disconnect = async () => {
    if (!(await confirmDialog(`Disconnect ${netName(n.key)}? Scheduled posts for ${netName(n.key)} will fail until you connect again.`))) return;
    await attempt(() => api(`/social/disconnect/${n.key}`, { method: 'POST', body: {} }), 'Disconnected');
    refresh();
  };
  const igNoHttps = n.key === 'instagram' && !status.public_base;
  const buttons = !n.configured
    ? [h('span.muted.small', 'Not set up yet. '), isAdmin ? h('button.small', { type: 'button', onclick: () => setupDialog(status) }, 'Set up') : h('span.muted.small', 'Ask an admin to set it up.')]
    : [
      igNoHttps ? h('button.small', { type: 'button', onclick: () => tokenDialog() }, a ? 'Reconnect with a token' : 'Connect with a token')
        : h(`button.small${a ? '.secondary' : ''}`, { type: 'button', onclick: connect }, a ? 'Reconnect' : `Connect ${netName(n.key)}`),
      a ? h('button.link.small', { type: 'button', onclick: disconnect }, 'Disconnect') : null,
    ];
  return h(`article.card.net-card.${n.key}`,
    h('div.net-head', icon(n.key), h('div',
      h('strong', netName(n.key)),
      a ? h('div.small', a.username ? `@${a.username}` : a.name, a.username && a.name ? h('span.muted', ` · ${a.name}`) : null) : h('div.small.muted', 'Not connected')),
    a?.picture_url ? h('img.net-avatar', { src: a.picture_url, alt: '', referrerpolicy: 'no-referrer' }) : null),
    a?.expired ? h('p.small.text-danger', 'This connection has expired. Reconnect to keep posting.')
      : a?.expires_soon ? h('p.small.text-warn', `Connection expires ${dateTime(a.expires_at)}. ${n.key === 'linkedin' ? 'Reconnect before then.' : 'It renews automatically while the CRM is running.'}`)
        : a?.expires_at ? h('p.small.muted', `Connected · renews or expires ${new Date(a.expires_at).toLocaleDateString('en-AU')}`) : null,
    a?.last_error ? h('p.small.text-danger', a.last_error) : null,
    igNoHttps && n.configured ? h('p.small.muted', 'Instagram sign-in needs the CRM on an https web address, so connect with a token from the Meta App Dashboard instead.') : null,
    h('div.net-actions', buttons));
}

function tokenDialog() {
  const fields = [{ name: 'token', label: 'Instagram access token', type: 'textarea', rows: 3, required: true, full: true }];
  const form = h('form.grid-form',
    h('ol.small.full.setup-steps',
      h('li', 'Go to developers.facebook.com → My Apps → your app → Instagram → API setup with Instagram login.'),
      h('li', 'Under "Generate access tokens", add your Instagram professional account (if it isn\'t there) and click Generate token.'),
      h('li', 'Log in to Instagram if asked, then copy the token and paste it here.')),
    fields.map((f) => field(f)),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Connect')));
  const d = modal('Connect Instagram with a token', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('/social/instagram/token', { method: 'POST', body: readForm(form, fields) }));
    if (r) { toast(`@${r.username} connected`); d.close(); refresh(); }
  });
}

function setupDialog(status) {
  const app = status.app || {};
  const li = status.networks.find((n) => n.key === 'linkedin');
  const ig = status.networks.find((n) => n.key === 'instagram');
  const copy = (text) => h('span.copy-line', h('code', text), h('button.link.small', { type: 'button', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, 'Copy'));
  const fields = [
    { name: 'linkedin_client_id', label: 'LinkedIn Client ID' },
    { name: 'linkedin_client_secret', label: app.has_linkedin_secret ? 'LinkedIn Client Secret (saved, enter to change)' : 'LinkedIn Client Secret', type: 'password' },
    { name: 'instagram_app_id', label: 'Instagram App ID' },
    { name: 'instagram_app_secret', label: app.has_instagram_secret ? 'Instagram App Secret (saved, enter to change)' : 'Instagram App Secret', type: 'password' },
  ];
  const form = h('form.grid-form',
    h('section.full.setup-block', h('h3', 'LinkedIn'),
      h('ol.small.setup-steps',
        h('li', 'Go to linkedin.com/developers → Create app (it needs a LinkedIn company page; your business page is fine).'),
        h('li', 'On the Products tab, add "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect".'),
        h('li', 'On the Auth tab, add this Authorized redirect URL: ', copy(li.redirect_uri)),
        h('li', 'Copy the Client ID and Client Secret into the boxes below.'))),
    field(fields[0], app.linkedin_client_id), field(fields[1]),
    h('section.full.setup-block', h('h3', 'Instagram'),
      h('ol.small.setup-steps',
        h('li', 'Your Instagram account must be a professional (Business or Creator) account. Switch in the Instagram app: Settings → Account type and tools.'),
        h('li', 'Go to developers.facebook.com → Create app → choose the Instagram use case ("Manage messaging & content on Instagram").'),
        h('li', 'Under Instagram → API setup with Instagram login, copy the Instagram app ID and Instagram app secret into the boxes below.'),
        status.public_base
          ? h('li', 'Under "Set up Instagram business login", add this redirect URL: ', copy(ig.redirect_uri))
          : h('li', 'This CRM isn\'t on a public https address, so Instagram sign-in can\'t come back to it. Each person connects with a token instead (Generate token on the same page). Posts with uploaded pictures need a public address too; otherwise use a picture link.'),
        h('li', 'While the app is in development mode, add each broker\'s Instagram account as an Instagram tester under App roles.'))),
    field(fields[2], app.instagram_app_id), field(fields[3]),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Save')));
  const d = modal('Set up LinkedIn and Instagram', form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form, fields);
    for (const k of ['linkedin_client_secret', 'instagram_app_secret']) if (!v[k]) delete v[k];
    if (await attempt(() => api('/social/config', { method: 'PUT', body: v }), 'Saved')) { d.close(); refresh(); }
  });
}

// ---- Composer ------------------------------------------------------------------------------
function composer(status, settings) {
  const connected = status.networks.filter((n) => n.account && !n.account.expired);
  // Until the broker picks, a new post goes to every connected account.
  if (!draft.id && !draft.chosen) draft.networks = connected.map((n) => n.key);
  const limits = status.limits;
  const me = Object.fromEntries(status.networks.map((n) => [n.key, n.account]));

  const text = h('textarea.social-text', { rows: 8, placeholder: 'What would you like to share?', 'aria-label': 'Post text' }, draft.body);
  const counters = h('div.social-counters.small');
  const netChecks = h('div.social-nets', status.networks.map((n) => {
    const ok = n.account && !n.account.expired;
    const input = h('input', { type: 'checkbox', value: n.key, checked: ok && draft.networks.includes(n.key), disabled: !ok });
    input.addEventListener('change', () => {
      draft.networks = [...netChecks.querySelectorAll('input:checked')].map((i) => i.value);
      draft.chosen = true;
      update();
    });
    return h(`label.check-pill${ok ? '' : '.disabled'}`, { title: ok ? '' : `Connect ${netName(n.key)} above first` }, input, icon(n.key), netName(n.key));
  }));

  // Picture: upload, or a public link (needed for Instagram unless the CRM is public).
  const picBox = h('div.social-pic');
  const fileIn = h('input', { type: 'file', accept: 'image/jpeg,image/png', hidden: true });
  const linkIn = h('input', { type: 'url', placeholder: 'https://… link to a JPG or PNG', 'aria-label': 'Picture link' });
  const linkBox = h('div.social-link', { hidden: true }, linkIn, h('button.small', { type: 'button', onclick: () => addLink() }, 'Add'));
  const alt = h('input', { type: 'text', placeholder: 'Describe the picture for people using screen readers (optional)', value: draft.alt_text, 'aria-label': 'Alt text' });
  const busy = h('span.muted.small');
  async function addLink() {
    if (!linkIn.value.trim()) return;
    busy.textContent = 'Downloading…';
    const r = await attempt(() => api('/social/images', { method: 'POST', body: { url: linkIn.value.trim() } }));
    busy.textContent = '';
    if (r) { draft.image = r; draft.image_url = linkIn.value.trim(); linkBox.hidden = true; update(); }
  }
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) { toast('Please choose a JPG or PNG picture', 'error'); return; }
    if (f.size > 8 * 1024 * 1024) { toast('That picture is over 8 MB', 'error'); return; }
    busy.textContent = 'Uploading…';
    const r = await attempt(async () => api('/social/images', { method: 'POST', body: { image: await readFile(f) } }));
    busy.textContent = '';
    if (r) { draft.image = r; draft.image_url = ''; update(); }
  });
  linkIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });

  const ideas = h('select', { 'aria-label': 'Post ideas' }, h('option', { value: '' }, 'Post ideas…'), IDEAS.map(([l], i) => h('option', { value: i }, l)));
  ideas.addEventListener('change', () => {
    if (ideas.value === '') return;
    text.value = text.value.trim() ? `${text.value.trim()}\n\n${IDEAS[ideas.value][1]}` : IDEAS[ideas.value][1];
    ideas.value = '';
    update();
  });
  const disclaimer = () => {
    const who = [settings.business_name, settings.acl_number ? `ACL/Credit Representative ${settings.acl_number}` : null].filter(Boolean).join(', ');
    text.value = `${text.value.trim()}\n\nThis is general information only and doesn't take into account your objectives, financial situation or needs.${who ? ` ${who}.` : ''}`.trim();
    update();
  };

  const when = h('input', { type: 'datetime-local', 'aria-label': 'Post at', value: draft.when });
  const errors = h('div.social-errors');
  const previews = h('div.social-previews');

  function problems() {
    const out = [];
    const body = text.value;
    const nets = draft.networks;
    if (!body.trim() && !draft.image) out.push('Write something to post.');
    if (nets.includes('linkedin') && body.length > limits.linkedin) out.push(`LinkedIn allows ${limits.linkedin.toLocaleString()} characters.`);
    if (nets.includes('instagram')) {
      if (!draft.image) out.push('Instagram posts need a picture.');
      if (body.length > limits.instagram) out.push(`Instagram captions allow ${limits.instagram.toLocaleString()} characters.`);
      if (hashtagCount(body) > limits.instagram_hashtags) out.push(`Instagram allows ${limits.instagram_hashtags} hashtags.`);
      const r = draft.image ? draft.image.width / draft.image.height : 1;
      if (draft.image && (r < 0.795 || r > 1.915)) out.push('Instagram needs a picture between portrait 4:5 and landscape 1.91:1. Crop it, e.g. to a square.');
      if (draft.image && !draft.image_url && !status.public_base) out.push('For Instagram, add the picture as a public link ("Picture from a link"), because this CRM isn\'t on a public web address.');
    }
    return out;
  }

  function preview() {
    const body = text.value;
    const img = draft.image ? h('img', { src: draft.image.url, alt: draft.alt_text || '' }) : null;
    const li = me.linkedin;
    const ig = me.instagram;
    const short = body.length > 210 ? [body.slice(0, 210).trimEnd(), h('span.muted', '…see more')] : body;
    return [
      draft.networks.includes('linkedin') ? h('div.pv.pv-li',
        h('div.pv-head', li?.picture_url ? h('img.pv-avatar', { src: li.picture_url, alt: '', referrerpolicy: 'no-referrer' }) : h('span.pv-avatar.blank'),
          h('div', h('strong', li?.name || 'You'), h('div.muted.small', 'now · 🌐'))),
        body ? h('div.pv-text', short) : null, img ? h('div.pv-img', img) : null,
        h('div.pv-foot.muted.small', '👍 Like · 💬 Comment · ↻ Repost')) : null,
      draft.networks.includes('instagram') ? h('div.pv.pv-ig',
        h('div.pv-head', ig?.picture_url ? h('img.pv-avatar', { src: ig.picture_url, alt: '', referrerpolicy: 'no-referrer' }) : h('span.pv-avatar.blank'), h('strong', ig?.username || 'your.account')),
        h('div.pv-square', draft.image ? h('img', { src: draft.image.url, alt: '' }) : h('span.muted.small', 'Instagram needs a picture')),
        h('div.pv-text', h('strong', ig?.username || 'your.account'), ' ', body.length > 125 ? [body.slice(0, 125).trimEnd(), h('span.muted', '… more')] : body)) : null,
    ].filter(Boolean);
  }

  function update() {
    draft.body = text.value;
    draft.alt_text = alt.value;
    draft.when = when.value;
    const len = text.value.length;
    counters.replaceChildren(...draft.networks.map((k) => {
      const max = k === 'linkedin' ? limits.linkedin : limits.instagram;
      return h(`span${len > max ? '.text-danger' : len > max * 0.9 ? '.text-warn' : ''}`, `${netName(k)} ${len.toLocaleString()} / ${max.toLocaleString()}`);
    }), h('span.muted', plural(hashtagCount(text.value), 'hashtag')));
    picBox.replaceChildren(...(draft.image
      ? [h('img.social-thumb', { src: draft.image.url, alt: '' }),
        h('div.small', h('div', `${draft.image.width}×${draft.image.height}`), draft.image_url ? h('div.muted', 'From a link (Instagram uses this link)') : null,
          h('div', h('button.link.small', { type: 'button', onclick: () => { draft.image = null; draft.image_url = ''; update(); } }, 'Remove picture')))]
      : [h('button.secondary.small', { type: 'button', onclick: () => fileIn.click() }, '📷 Upload a picture'),
        h('button.link.small', { type: 'button', onclick: () => { linkBox.hidden = !linkBox.hidden; if (!linkBox.hidden) linkIn.focus(); } }, 'Picture from a link'), busy]));
    alt.hidden = !draft.image;
    const p = problems();
    errors.replaceChildren(...(p.length && draft.networks.length ? [h('ul.small.text-warn', p.map((x) => h('li', x)))] : []));
    previews.replaceChildren(...(draft.networks.length ? preview() : [h('p.muted.small', 'Choose LinkedIn and/or Instagram to see a preview.')]));
  }
  text.addEventListener('input', update);
  alt.addEventListener('input', update);
  when.addEventListener('input', update);

  async function save(action) {
    if (action !== 'draft' && !draft.networks.length) { toast('Choose where to post', 'error'); return; }
    if (action === 'schedule' && !when.value) { when.focus(); toast('Choose a date and time', 'error'); return; }
    const body = {
      body: text.value, alt_text: alt.value || null, image_asset_id: draft.image?.id || null, image_url: draft.image_url || null,
      networks: draft.networks, action, scheduled_at: when.value ? new Date(when.value).toISOString() : null,
    };
    const btns = form.querySelectorAll('.social-actions button');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api(draft.id ? `/social/posts/${draft.id}` : '/social/posts', { method: draft.id ? 'PUT' : 'POST', body });
      const failed = r.targets.filter((t) => t.status === 'failed');
      if (failed.length) toast(failed.map((t) => t.error).join(' '), 'error');
      else toast(action === 'now' ? (r.status === 'publishing' ? 'Posting… Instagram is still processing the picture' : 'Posted!') : action === 'schedule' ? `Scheduled for ${dateTime(r.scheduled_at)}` : 'Draft saved');
      resetDraft();
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  const form = h('section.card.social-compose',
    h('div.card-head', h('h2', draft.id ? 'Edit post' : 'New post'),
      h('div.actions', ideas, h('button.link.small', { type: 'button', onclick: disclaimer, title: 'Add a general advice disclaimer with your business name and credit licence number' }, '+ Disclaimer'),
        draft.id ? h('button.link.small', { type: 'button', onclick: () => { resetDraft(); refresh(); } }, 'Start a new post') : null)),
    h('div.social-grid',
      h('div',
        netChecks,
        text, counters,
        picBox, fileIn, linkBox, alt,
        errors,
        h('div.social-actions',
          h('button', { type: 'button', onclick: () => save('now') }, 'Post now'),
          h('span.social-when', when, h('button.secondary', { type: 'button', onclick: () => save('schedule') }, 'Schedule')),
          h('button.secondary', { type: 'button', onclick: () => save('draft') }, 'Save draft'))),
      h('div', h('div.muted.small.pv-label', 'Preview'), previews)));
  update();
  return form;
}

// ---- Posts --------------------------------------------------------------------------------
function postRow(p) {
  const [label, kind] = STATUS[p.status] || [p.status, ''];
  const canEdit = ['draft', 'scheduled', 'failed'].includes(p.status) && (p.user_id === state.user.id || state.user.role === 'admin');
  const edit = () => {
    const local = p.scheduled_at && p.status === 'scheduled' ? new Date(new Date(p.scheduled_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    draft = { chosen: true, id: p.id, body: p.body, image: p.image ? { ...p.image } : null, image_url: p.image_url || '', alt_text: p.alt_text || '', networks: p.targets.map((t) => t.network), when: local };
    refresh();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const remove = async () => {
    if (!(await confirmDialog(p.status === 'posted' ? 'Remove this post from the CRM? (It stays on LinkedIn/Instagram.)' : 'Delete this post?'))) return;
    await attempt(() => api(`/social/posts/${p.id}`, { method: 'DELETE' }), 'Deleted');
    refresh();
  };
  const retry = async () => {
    const r = await attempt(() => api(`/social/posts/${p.id}/retry`, { method: 'POST', body: {} }));
    if (r) { toast(r.status === 'posted' ? 'Posted!' : 'Still not posted. See the error below.', r.status === 'posted' ? 'ok' : 'error'); refresh(); }
  };
  return h('article.social-post',
    p.image ? h('img.social-thumb', { src: p.image.url, alt: '' }) : h('div.social-thumb.blank', 'Aa'),
    h('div.social-post-body',
      h('div.social-post-meta', badge(label, kind),
        h('span.muted.small', p.status === 'scheduled' ? `for ${dateTime(p.scheduled_at)}` : p.posted_at ? dateTime(p.posted_at) : `edited ${dateTime(p.updated_at)}`),
        p.author ? h('span.muted.small', `· ${p.author}`) : null),
      h('p.social-post-text', p.body.length > 280 ? `${p.body.slice(0, 280)}…` : p.body || h('span.muted', '(picture only)')),
      h('div.social-targets', p.targets.map((t) => h('span.social-target',
        icon(t.network),
        t.status === 'posted' ? (t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, `View on ${netName(t.network)} ↗`) : h('span', 'Posted'))
          : t.status === 'failed' ? h('span.text-danger.small', t.error || 'Failed') : h('span.muted.small', p.status === 'draft' ? netName(t.network) : 'Waiting')))),
      h('div.social-post-actions',
        canEdit && p.status !== 'failed' ? h('button.link.small', { type: 'button', onclick: edit }, 'Edit') : null,
        ['failed', 'partly_posted'].includes(p.status) ? h('button.link.small', { type: 'button', onclick: retry }, 'Retry') : null,
        p.status === 'failed' && canEdit ? h('button.link.small', { type: 'button', onclick: edit }, 'Edit') : null,
        p.status !== 'publishing' ? h('button.link.small', { type: 'button', onclick: remove }, 'Delete') : null)));
}

let filter = '';
export async function socialPage() {
  const [status, posts, settings] = await Promise.all([api('/social/status'), api(`/social/posts${filter ? `?status=${filter}` : ''}`), api('/settings')]);
  const filters = [['', 'All'], ['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['posted', 'Posted'], ['failed', 'Failed']];
  const anyConnected = status.networks.some((n) => n.account);
  return h('div',
    pageHeader('Social', state.user.role === 'admin' ? h('button.secondary', { type: 'button', onclick: () => setupDialog(status) }, 'Set up') : null),
    h('div.net-cards', status.networks.map((n) => accountCard(n, status))),
    anyConnected ? composer(status, settings) : h('section.card', h('p.empty', 'Connect LinkedIn or Instagram above to start posting from the CRM.')),
    h('section.card',
      h('div.card-head', h('h2', 'Posts'),
        h('nav.tabs.small.social-filter', filters.map(([v, l]) => h(`a${filter === v ? '.active' : ''}`, { href: '#/social', onclick: (e) => { e.preventDefault(); filter = v; refresh(); } }, l)))),
      posts.rows.length ? h('div.social-posts', posts.rows.map(postRow)) : h('p.empty', 'No posts yet.')));
}
