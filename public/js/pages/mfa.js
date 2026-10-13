// Two-factor sign-in: the code step at sign-in, setting it up (QR code and
// recovery codes), and the Settings card (yours, plus admin controls).
import { api, h, attempt, toast, modal, confirmDialog, state, table, badge } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

function svgNode(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = doc.documentElement;
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code to scan with your authenticator app');
  svg.classList.add('mfa-qr');
  return document.importNode(svg, true);
}

// Recovery codes, shown once, with copy and download.
export function recoveryCodesView(codes, { onDone, doneLabel = 'I\'ve saved them' } = {}) {
  const text = `Recovery codes for ${state.brand?.business_name || 'the CRM'} (${state.user?.email || ''})\nEach code works once, if you can't use your authenticator app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'crm-recovery-codes.txt' });
    document.body.append(a);
    a.click();
    a.remove();
  };
  const done = h('button', { type: 'button', disabled: true }, doneLabel);
  const ack = h('input', { type: 'checkbox' });
  ack.addEventListener('change', () => { done.disabled = !ack.checked; });
  done.addEventListener('click', () => onDone?.());
  return h('div.mfa-recovery',
    h('p', 'If you lose your phone, you can sign in with one of these codes instead. Each one works once. ', h('strong', 'Save them somewhere safe now'), ' (a password manager, or printed and filed). You won\'t see them again.'),
    h('ol.mfa-codes', codes.map((c) => h('li', h('code', c)))),
    h('div.actions.mfa-left',
      h('button.secondary', { type: 'button', onclick: () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied')) }, 'Copy'),
      h('button.secondary', { type: 'button', onclick: download }, 'Download')),
    h('label.field.check', ack, h('span', 'I\'ve saved my recovery codes')),
    h('div.actions', done));
}

// The three set-up steps. `box` is filled in; onDone runs after the codes are saved.
export async function setupFlow(box, { onDone, onCancel = null } = {}) {
  const s = await api('/auth/2fa/start', { method: 'POST', body: {} });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, pattern: '[0-9 ]*', placeholder: '123456', 'aria-label': 'Six-digit code', required: true });
  const go = h('button', { type: 'submit' }, 'Turn on two-factor sign-in');
  const form = h('form.mfa-steps',
    h('ol',
      h('li', h('strong', 'Get an authenticator app'), ' on your phone, if you don\'t have one: ', h('em', 'Microsoft Authenticator'), ' or ', h('em', 'Google Authenticator'), ' (free from the App Store or Google Play).'),
      h('li', h('strong', 'Add this account:'), ' in the app, tap ', h('em', '+'), ' and scan this code.',
        svgNode(s.qr_svg),
        h('details.small', h('summary', 'Can\'t scan it?'), h('p', 'Choose "enter a key" (or "set up manually") in the app and type:'), h('p', h('code.mfa-key', s.key)),
          h('p', 'On this phone? ', h('a', { href: s.url }, 'Open in your authenticator app')))),
      h('li', h('strong', 'Enter the 6-digit code'), ' the app now shows for this account:', h('div.mfa-code', code))),
    h('div.actions', onCancel ? h('button.secondary', { type: 'button', onclick: onCancel }, 'Cancel') : null, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      const r = await api('/auth/2fa/confirm', { method: 'POST', body: { code: code.value } });
      toast('Two-factor sign-in is on');
      box.replaceChildren(h('h2', 'Save your recovery codes'), recoveryCodesView(r.recovery_codes, { onDone }));
    } catch (err) {
      toast(err.message, 'error');
      go.disabled = false;
      code.select();
    }
  });
  box.replaceChildren(form);
  code.focus();
}

// Full-screen set-up when the business requires it and this person hasn't yet.
export async function forcedSetupScreen(app, { brandMark, onDone, onLogout }) {
  const box = h('div');
  const card = h('div.auth-card.mfa-card',
    brandMark(true),
    h('h1', 'Set up two-factor sign-in'),
    h('p.muted', `${state.brand?.business_name || 'Your business'} protects client information with a second step at sign-in: a code from an app on your phone. It takes about two minutes.`),
    box,
    h('p.small', h('button.link', { type: 'button', onclick: onLogout }, 'Sign out')));
  app.replaceChildren(h('div.auth-wrap', card));
  await setupFlow(box, { onDone });
}

// The code step at sign-in.
export function codeScreen(app, { brandMark, challenge, onSignedIn, onBack }) {
  let recovery = false;
  const input = h('input', { id: 'mfa_code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 9, required: true });
  const remember = h('input', { type: 'checkbox' });
  const label = h('label', { for: 'mfa_code' }, 'Code from your authenticator app');
  const hint = h('p.muted.small', 'Open the app on your phone and enter the 6-digit code for this account.');
  const toggle = h('button.link.small', { type: 'button' }, 'Lost your phone? Use a recovery code');
  toggle.addEventListener('click', () => {
    recovery = !recovery;
    label.textContent = recovery ? 'Recovery code' : 'Code from your authenticator app';
    hint.textContent = recovery ? 'Enter one of the recovery codes you saved when you set up two-factor sign-in (e.g. abcd-efgh).' : 'Open the app on your phone and enter the 6-digit code for this account.';
    input.inputMode = recovery ? 'text' : 'numeric';
    toggle.textContent = recovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code';
    input.value = '';
    input.focus();
  });
  const submit = h('button', { type: 'submit' }, 'Sign in');
  const form = h('form.auth-card',
    brandMark(true),
    h('h1', 'Two-factor sign-in'),
    hint,
    h('div.field', label, input),
    h('label.field.check', remember, h('span', 'Remember this device for 30 days')),
    submit,
    h('p.small', toggle, ' · ', h('button.link.small', { type: 'button', onclick: onBack }, 'Back')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const r = await api('/auth/login/mfa', { method: 'POST', body: { challenge, code: input.value, remember: remember.checked } });
      if (r.used_recovery_code) toast(`Signed in with a recovery code. ${r.recovery_left} left – make new ones in Settings if you're running low.`);
      onSignedIn(r.user);
    } catch (err) {
      toast(err.message, 'error');
      submit.disabled = false;
      input.select();
      if (/timed out|password again/.test(err.message)) onBack();
    }
  });
  app.replaceChildren(h('div.auth-wrap', form));
  input.focus();
}

// ---- Settings card -----------------------------------------------------------------------------------

function passwordPrompt(title, text, onPassword) {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Your password' });
  const form = h('form', h('p', text), h('div.field', h('label', 'Your password'), pw),
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Continue')));
  const d = modal(title, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await onPassword(pw.value, d);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  pw.focus();
}

export async function mfaCard() {
  const s = await api('/auth/2fa');
  const isAdmin = state.user.role === 'admin';
  const users = isAdmin ? (await api('/users')).rows.filter((u) => u.active) : [];
  const setUp = () => {
    const box = h('div');
    const d = modal('Set up two-factor sign-in', box, { wide: true });
    setupFlow(box, { onDone: () => { d.close(); refresh(); }, onCancel: () => d.close() }).catch((err) => { toast(err.message, 'error'); d.close(); });
  };
  const newCodes = () => passwordPrompt('New recovery codes', 'Your old recovery codes will stop working.', async (password, d) => {
    const r = await api('/auth/2fa/recovery-codes', { method: 'POST', body: { password } });
    d.close();
    const box = h('div');
    const d2 = modal('Your new recovery codes', box, { wide: true });
    box.append(recoveryCodesView(r.recovery_codes, { onDone: () => { d2.close(); refresh(); } }));
  });
  const turnOff = () => passwordPrompt('Turn off two-factor sign-in', 'Signing in will only need your password. Not recommended once the CRM is online.', async (password, d) => {
    await api('/auth/2fa/disable', { method: 'POST', body: { password } });
    d.close();
    toast('Two-factor sign-in is off');
    refresh();
  });
  const forget = async () => {
    const r = await attempt(() => api('/auth/2fa/forget-devices', { method: 'POST', body: {} }));
    toast(`${r.forgotten} remembered device${r.forgotten === 1 ? '' : 's'} forgotten`);
    refresh();
  };
  const setRequired = async (on) => {
    if (on && !(await confirmDialog('Require two-factor sign-in for everyone? Anyone who hasn\'t set it up will be asked to the next time they use the CRM.'))) return;
    try {
      await attempt(() => api('/auth/2fa/required', { method: 'PUT', body: { required: on } }), on ? 'Two-factor sign-in is now required for everyone' : 'No longer required');
      refresh();
    } catch { /* toasted */ }
  };
  const reset = async (u) => {
    if (!(await confirmDialog(`Reset two-factor sign-in for ${u.name}? Use this if they've lost their phone. They'll be signed out, and set it up again next time they sign in.`))) return;
    try {
      await attempt(() => api(`/auth/2fa/reset/${u.id}`, { method: 'POST', body: {} }), `Reset for ${u.name}`);
      refresh();
    } catch { /* toasted */ }
  };
  return h('section.card',
    h('div.card-head', h('h2', 'Two-factor sign-in'), s.enabled ? badge('on', 'ok') : badge('off', 'danger')),
    h('p.small.muted', 'After your password, you enter a 6-digit code from an authenticator app on your phone, so a stolen or guessed password isn\'t enough to get in.'),
    s.enabled
      ? [h('p', `On since ${new Date(s.enabled_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}. ${s.recovery_left} recovery code${s.recovery_left === 1 ? '' : 's'} left${s.trusted_devices ? ` · ${s.trusted_devices} remembered device${s.trusted_devices === 1 ? '' : 's'}` : ''}.`),
        s.recovery_left <= 3 ? h('div.alert.warn-box.small', 'You\'re running low on recovery codes. Make new ones.') : null,
        h('div.actions.mfa-left',
          h('button.secondary.small', { type: 'button', onclick: newCodes }, 'New recovery codes'),
          s.trusted_devices ? h('button.secondary.small', { type: 'button', onclick: forget }, 'Forget remembered devices') : null,
          !s.required ? h('button.link.small.text-danger', { type: 'button', onclick: turnOff }, 'Turn off') : null)]
      : h('div.actions.mfa-left', h('button', { type: 'button', onclick: setUp }, 'Set up two-factor sign-in')),
    isAdmin ? [
      h('h3', 'For your team'),
      h('label.field.check', (() => {
        const box = h('input', { type: 'checkbox', checked: s.required });
        box.addEventListener('change', () => { setRequired(box.checked); box.checked = s.required; });
        return box;
      })(), h('span', 'Require two-factor sign-in for everyone (recommended before the CRM goes online)')),
      table([
        { label: 'Name', value: (u) => u.name },
        { label: 'Two-factor', value: (u) => (u.mfa_enabled ? badge('on', 'ok') : badge(s.required ? 'set up at next sign-in' : 'off', s.required ? 'warn' : 'danger')) },
        { label: '', value: (u) => (u.mfa_enabled && u.id !== state.user.id ? h('button.link.small', { type: 'button', onclick: () => reset(u) }, 'Reset (lost phone)') : '') },
      ], users)] : null);
}
