import { api, getConfig, setConfig, STATUSES, CATEGORIES } from './api.js';

// Email content is untrusted: every node is built with createElement/textContent.

const $ = (id) => document.getElementById(id);

const state = {
  jobs: [],
  emails: [],
  filter: 'all',
  search: '',
  sort: { key: 'updated_at', dir: -1 },
  showAll: false,
};

const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
const STATUS_LABEL = { saved: 'Saved', applied: 'Applied', oa: 'OA', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' };
const UNIT_SUFFIX = { HOUR: '/hr', WEEK: '/wk', MONTH: '/mo', YEAR: '/yr' };
const PER_YEAR = { HOUR: 2080, WEEK: 52, MONTH: 12, YEAR: 1 };
const CURRENCY = { USD: '$', EUR: '€', GBP: '£', INR: '₹', CAD: 'CA$', AUD: 'A$', JPY: '¥' };

// ---------- helpers ----------

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k === 'href') {
      const href = safeHref(v);
      if (href) {
        node.href = href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
      }
    } else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function select(options, value, props = {}) {
  const s = el('select', props);
  for (const [val, label] of options) s.append(new Option(label, val, false, String(val) === String(value ?? '')));
  return s;
}

function fmtPay(j) {
  const nums = [j.pay_min, j.pay_max].filter((v) => v !== null && v !== undefined);
  if (!nums.length) return '';
  const sym = CURRENCY[j.currency || 'USD'] ?? `${j.currency} `;
  const f = (n) => (n >= 1000 ? `${sym}${+(n / 1000).toFixed(1)}k` : `${sym}${Number.isInteger(n) ? n : n.toFixed(2)}`);
  const range = nums.length === 2 && nums[0] !== nums[1] ? `${f(nums[0])}–${f(nums[1])}` : f(nums[0]);
  return range + (UNIT_SUFFIX[j.pay_unit] || '');
}

function yearlyPay(j) {
  const n = j.pay_max ?? j.pay_min;
  return n === null || n === undefined ? -1 : n * (PER_YEAR[j.pay_unit] || 1);
}

function fmtDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString(undefined, opts);
}

function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}

function showError(err) {
  $('error').textContent = err ? err.message || String(err) : '';
  $('error').hidden = !err;
}

async function attempt(fn) {
  try {
    showError(null);
    await fn();
  } catch (err) {
    showError(err);
  }
}

// ---------- data ----------

async function load() {
  await attempt(async () => {
    const [jobs, emails] = await Promise.all([
      api('/api/jobs'),
      api(`/api/emails?limit=200${state.showAll ? '&all=1' : ''}`),
    ]);
    state.jobs = jobs;
    state.emails = emails;
    $('last-sync').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    render();
  });
}

async function patchJob(id, body) {
  await attempt(async () => {
    const updated = await api(`/api/jobs/${id}`, { method: 'PATCH', body });
    state.jobs = state.jobs.map((j) => (j.id === id ? updated : j));
    render();
  });
}

async function deleteJob(job) {
  if (!confirm(`Delete ${job.company}${job.role ? ` – ${job.role}` : ''}? Its status history is deleted too.`)) return;
  await attempt(async () => {
    await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    await load();
  });
}

async function patchEmail(id, body) {
  await attempt(async () => {
    await api(`/api/emails/${id}`, { method: 'PATCH', body });
    await load(); // linking an email can move a job's status
  });
}

// ---------- rendering ----------

function visibleJobs() {
  const q = state.search.trim().toLowerCase();
  const rows = state.jobs.filter((j) => {
    if (state.filter !== 'all' && j.status !== state.filter) return false;
    if (!q) return true;
    return [j.company, j.role, j.location, j.notes, j.aliases].some((v) => String(v || '').toLowerCase().includes(q));
  });
  const { key, dir } = state.sort;
  const value = (j) => {
    if (key === 'pay') return yearlyPay(j);
    if (key === 'status') return STATUS_RANK[j.status] ?? 99;
    return String(j[key] || '').toLowerCase();
  };
  return rows.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

function renderChips() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const j of state.jobs) counts[j.status] = (counts[j.status] || 0) + 1;
  const chip = (value, label, count) =>
    el('button', {
      type: 'button',
      class: `chip ${value !== 'all' ? `status-${value}` : ''} ${state.filter === value ? 'active' : ''}`,
      onclick: () => {
        state.filter = state.filter === value && value !== 'all' ? 'all' : value;
        render();
      },
    }, label, el('span', { class: 'count', text: String(count) }));
  $('chips').replaceChildren(chip('all', 'All', state.jobs.length), ...STATUSES.map((s) => chip(s, STATUS_LABEL[s], counts[s])));
}

function jobRow(j) {
  const aliases = el('input', {
    class: 'aliases',
    value: j.aliases || '',
    placeholder: 'aliases for email matching',
    title: 'Comma-separated names used to match emails to this job',
    onchange: (e) => patchJob(j.id, { aliases: e.target.value }),
    onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
  });
  const status = select(STATUSES.map((s) => [s, s]), j.status, {
    class: `status status-${j.status}`,
    onchange: (e) => patchJob(j.id, { status: e.target.value }),
  });
  const role = j.role || '(no role)';
  return el('tr', {},
    el('td', {}, el('div', { class: 'company', text: j.company }), aliases),
    el('td', {}, safeHref(j.url) ? el('a', { href: j.url, text: role }) : role),
    el('td', { text: j.location || '' }),
    el('td', { class: 'nowrap', text: fmtPay(j) }),
    el('td', {}, status),
    el('td', { class: 'nowrap', text: fmtDate(j.applied_at), title: j.applied_at }),
    el('td', { class: 'nowrap muted', text: relTime(j.updated_at), title: j.updated_at }),
    el('td', {}, el('button', { type: 'button', class: 'icon danger', title: 'Delete', text: '✕', onclick: () => deleteJob(j) })),
  );
}

function renderJobs() {
  const rows = visibleJobs();
  $('jobs').tBodies[0].replaceChildren(...rows.map(jobRow));
  $('jobs-empty').hidden = state.jobs.length > 0;
  for (const th of $('jobs').tHead.rows[0].cells) {
    const active = th.dataset.sort && th.dataset.sort === state.sort.key;
    th.classList.toggle('sorted', !!active);
    th.dataset.dir = active ? (state.sort.dir > 0 ? 'asc' : 'desc') : '';
  }
}

function emailRow(e) {
  const gmail = e.thread_id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(e.thread_id)}` : null;
  const subject = e.subject || '(no subject)';

  const pills = [];
  if (safeHref(e.link)) pills.push(el('a', { class: 'pill', href: e.link, text: e.category === 'oa' ? 'assessment ↗' : 'schedule ↗' }));
  if (e.in_spam) pills.push(el('span', { class: 'pill spam', text: 'was in spam' }));

  const jobOptions = [['', e.job_id ? '— unlink —' : 'Link to job…']];
  for (const j of [...state.jobs].sort((a, b) => a.company.localeCompare(b.company))) {
    jobOptions.push([j.id, j.role ? `${j.company} – ${j.role}` : j.company]);
  }
  if (e.job_id && !state.jobs.some((j) => j.id === e.job_id)) {
    jobOptions.push([e.job_id, [e.job_company, e.job_role].filter(Boolean).join(' – ') || `Job #${e.job_id}`]);
  }

  return el('tr', {},
    el('td', { class: 'nowrap', text: fmtDate(e.received_at, true), title: e.received_at }),
    el('td', {}, select(CATEGORIES.map((c) => [c, c.replace(/_/g, ' ')]), e.category, {
      class: `category cat-${e.category}`,
      onchange: (ev) => patchEmail(e.id, { category: ev.target.value }),
    })),
    el('td', { title: e.from_addr || '' },
      el('div', { text: e.from_name || e.from_addr || '' }),
      e.from_name ? el('div', { class: 'muted small', text: e.from_addr || '' }) : null),
    el('td', {}, gmail ? el('a', { href: gmail, text: subject }) : subject, pills.length ? el('span', { class: 'pills' }, pills) : null),
    el('td', {}, select(jobOptions, e.job_id, {
      class: `job-link ${e.job_id ? '' : 'unlinked'}`,
      onchange: (ev) => patchEmail(e.id, { job_id: ev.target.value ? Number(ev.target.value) : null }),
    })),
  );
}

function renderEmails() {
  $('emails').tBodies[0].replaceChildren(...state.emails.map(emailRow));
  $('emails-empty').hidden = state.emails.length > 0;
}

function render() {
  renderChips();
  renderJobs();
  renderEmails();
}

// ---------- CSV ----------

function exportCsv() {
  const cols = ['id', 'company', 'role', 'location', 'pay_min', 'pay_max', 'pay_unit', 'currency', 'status', 'url', 'aliases', 'notes', 'applied_at', 'updated_at'];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(','), ...state.jobs.map((j) => cols.map((c) => cell(j[c])).join(','))];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = el('a', { download: `callback-${new Date().toISOString().slice(0, 10)}.csv` });
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- settings ----------

async function initSettings() {
  const cfg = await getConfig();
  $('worker-url').value = cfg.workerUrl;
  $('api-token').value = cfg.apiToken;
  $('settings').hidden = !!(cfg.workerUrl && cfg.apiToken);
  $('toggle-settings').addEventListener('click', () => ($('settings').hidden = !$('settings').hidden));

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('settings-message');
    await setConfig({ workerUrl: $('worker-url').value, apiToken: $('api-token').value });
    msg.textContent = 'Testing…';
    msg.className = 'small muted';
    try {
      const jobs = await api('/api/jobs');
      msg.textContent = `Connected ✓ (${jobs.length} job${jobs.length === 1 ? '' : 's'})`;
      msg.className = 'small ok';
      await load();
    } catch (err) {
      msg.textContent = `Couldn't connect: ${err.message}`;
      msg.className = 'small error';
    }
  });
  return cfg.workerUrl && cfg.apiToken;
}

// ---------- wiring ----------

for (const th of $('jobs').tHead.rows[0].cells) {
  if (!th.dataset.sort) continue;
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key.endsWith('_at') || key === 'pay' ? -1 : 1 };
    renderJobs();
  });
}

$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderJobs();
});
$('show-all').addEventListener('change', (e) => {
  state.showAll = e.target.checked;
  load();
});
$('refresh').addEventListener('click', load);
$('export').addEventListener('click', exportCsv);

// Refresh every minute while the tab is visible, but not while you're editing a field.
const editing = () => !!document.activeElement?.closest?.('table, #settings');
setInterval(() => {
  if (document.visibilityState === 'visible' && !editing()) load();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !editing()) load();
});

if (await initSettings()) load();
