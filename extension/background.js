// Saves jobs on behalf of the jobright.ai content script.

import { api } from './api.js';

// Creates or updates the job. An existing job keeps its status, except that "applied"
// moves a "saved" job forward.
async function saveJob(job, status) {
  const body = {
    company: job.company,
    role: job.role,
    location: job.location,
    pay_min: job.pay_min,
    pay_max: job.pay_max,
    pay_unit: job.pay_unit,
    currency: job.currency,
    url: job.url,
    status,
  };
  const saved = await api('/api/jobs', { method: 'POST', body });
  if (!saved.created && status === 'applied' && saved.status === 'saved') {
    return { ...(await api(`/api/jobs/${saved.id}`, { method: 'PATCH', body: { status: 'applied' } })), created: false };
  }
  return saved;
}

// You un-marked a job as applied on jobright: an "applied" job goes back to "saved".
// Jobs that emails already moved further (OA, interview…) are left alone.
async function unapply(url) {
  const [job] = await api(`/api/jobs?url=${encodeURIComponent(url)}`);
  if (!job || job.status !== 'applied') return null;
  return api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { status: 'saved' } });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'callback:save') {
    saveJob(msg.job, msg.status === 'applied' ? 'applied' : 'saved')
      .then((job) => sendResponse({ ok: true, created: !!job.created, job }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // respond asynchronously
  }
  if (msg?.type === 'callback:unapply') {
    unapply(msg.url)
      .then((job) => sendResponse({ ok: true, job }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
