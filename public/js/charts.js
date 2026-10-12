// Minimal single-series charts built from HTML. Each mark has a hover/focus
// tooltip; values are also shown in tables on the pages that use them.
import { h, compact } from './core.js';

let tip;
function tooltip() {
  if (!tip) {
    tip = h('div.chart-tip', { role: 'tooltip', hidden: true });
    document.body.append(tip);
  }
  return tip;
}

function bindTip(el, text) {
  const show = () => {
    const t = tooltip();
    t.textContent = text;
    t.hidden = false;
    const r = el.getBoundingClientRect();
    t.style.left = `${Math.min(window.innerWidth - t.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - t.offsetWidth / 2))}px`;
    t.style.top = `${r.top + window.scrollY - t.offsetHeight - 8}px`;
  };
  const hide = () => { tooltip().hidden = true; };
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
  el.tabIndex = 0;
  el.setAttribute('aria-label', text);
}

// Horizontal bars: rows of { label, value, note }.
export function barList(rows, { format = String, empty = 'No data yet.' } = {}) {
  const max = Math.max(...rows.map((r) => r.value || 0), 0);
  if (!rows.length || max === 0) return h('p.empty', empty);
  return h('div.bar-list', rows.map((r) => {
    const hit = h('div.bar-row',
      h('div.bar-label', r.label),
      h('div.bar-track', h('div.bar-fill', { style: { width: `${Math.max(((r.value || 0) / max) * 100, r.value ? 1 : 0)}%` } })),
      h('div.bar-value', format(r.value || 0), r.note ? h('span.muted', ` ${r.note}`) : null));
    bindTip(hit, `${r.label}: ${format(r.value || 0)}${r.note ? ` (${r.note})` : ''}`);
    return hit;
  }));
}

// Vertical columns over time: rows of { label, value }.
export function columns(rows, { format = String, empty = 'No data yet.', height = 180 } = {}) {
  const max = Math.max(...rows.map((r) => r.value || 0), 0);
  if (!rows.length || max === 0) return h('p.empty', empty);
  const ticks = [max, max / 2, 0];
  return h('div.col-chart', { style: { height: `${height + 28}px` } },
    h('div.col-axis', ticks.map((t) => h('span', compact(t)))),
    h('div.col-plot', { style: { height: `${height}px` } },
      h('div.col-grid', ticks.map(() => h('span'))),
      rows.map((r) => {
        const col = h('div.col',
          h('div.col-bar', { style: { height: `${((r.value || 0) / max) * 100}%` } }),
          h('div.col-label', r.label));
        bindTip(col, `${r.label}: ${format(r.value || 0)}`);
        return col;
      })));
}
