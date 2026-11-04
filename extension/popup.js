import { api, getConfig, STATUSES } from './api.js';
import { extractJob } from './extract.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['company', 'role', 'location', 'pay_min', 'pay_max', 'pay_unit', 'notes'];

let existing = null;
let page = {};

function show(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

function setMessage(text, kind = '') {
  $('message').textContent = text;
  $('message').className = `small ${kind}`;
}

function fill(data) {
  for (const f of FIELDS) {
    if (data[f] !== null && data[f] !== undefined && data[f] !== '') $(f).value = data[f];
  }
}

async function readPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJob });
    return res?.result || { url: tab.url };
  } catch {
    setMessage("Couldn't read this page. You can still fill in the form.", 'muted');
    return { url: tab?.url && /^https?:/.test(tab.url) ? tab.url : null };
  }
}

async function init() {
  for (const s of STATUSES) $('status').append(new Option(s, s, s === 'applied', s === 'applied'));
  $('open-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const cfg = await getConfig();
  const configured = cfg.workerUrl && cfg.apiToken;
  if (!configured) show('warning', 'No settings saved yet. Open the dashboard and add your Worker URL and token.');

  page = await readPage();
  fill(page);
  $('url').textContent = page.url || '';

  if (configured && page.url) {
    try {
      [existing] = await api(`/api/jobs?url=${encodeURIComponent(page.url)}`);
    } catch (err) {
      setMessage(err.message, 'error');
    }
  }
  if (existing) {
    fill(existing);
    $('status').value = existing.status;
    show('existing', `Already saved (status ${existing.status})`);
    $('save').textContent = 'Update';
  }
  $('company').focus();
}

async function save(e) {
  e.preventDefault();
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  const status = $('status').value;
  const body = {
    company: $('company').value.trim(),
    role: $('role').value.trim(),
    location: $('location').value.trim(),
    pay_min: num('pay_min'),
    pay_max: num('pay_max'),
    pay_unit: (num('pay_min') ?? num('pay_max')) !== null ? $('pay_unit').value : null,
    currency: existing?.currency || page.currency || 'USD',
    url: page.url || null,
    status,
    notes: $('notes').value.trim(),
  };
  if (!body.company) return setMessage('Company is required.', 'error');

  $('save').disabled = true;
  setMessage('Saving…', 'muted');
  try {
    let job = await api('/api/jobs', { method: 'POST', body });
    // The upsert never overwrites status, so apply a changed status explicitly.
    if (job.status !== status) job = await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { status } });
    existing = job;
    show('existing', `Saved (status ${job.status})`);
    $('save').textContent = 'Update';
    setMessage('Saved ✓', 'ok');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    $('save').disabled = false;
  }
}

$('job-form').addEventListener('submit', save);
init();
