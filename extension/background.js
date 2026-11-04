// Saves jobs on behalf of content scripts (the jobright.ai Apply-click capture).

import { api } from './api.js';

async function saveApplied(job) {
  const body = {
    company: job.company,
    role: job.role,
    location: job.location,
    pay_min: job.pay_min,
    pay_max: job.pay_max,
    pay_unit: job.pay_unit,
    currency: job.currency,
    url: job.url,
    status: 'applied',
  };
  let saved = await api('/api/jobs', { method: 'POST', body });
  // An existing row keeps its status, except that clicking Apply moves "saved" to "applied".
  if (!saved.created && saved.status === 'saved') {
    saved = { ...(await api(`/api/jobs/${saved.id}`, { method: 'PATCH', body: { status: 'applied' } })), created: false };
  }
  return saved;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'callback:save-applied') return false;
  saveApplied(msg.job)
    .then((job) => sendResponse({ ok: true, created: !!job.created, job }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // respond asynchronously
});
