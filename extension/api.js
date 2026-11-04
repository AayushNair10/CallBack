// Settings storage and a small authenticated fetch wrapper for the Worker API.

export const STATUSES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected'];

export const CATEGORIES = [
  'application_received', 'oa', 'interview', 'offer', 'rejection',
  'recruiter_outreach', 'job_alert', 'newsletter', 'scam', 'other',
];

export async function getConfig() {
  const { workerUrl = '', apiToken = '' } = await chrome.storage.local.get(['workerUrl', 'apiToken']);
  return { workerUrl, apiToken };
}

export async function setConfig({ workerUrl, apiToken }) {
  await chrome.storage.local.set({
    workerUrl: String(workerUrl || '').trim().replace(/\/+$/, ''),
    apiToken: String(apiToken || '').trim(),
  });
}

export async function api(path, opts = {}) {
  const { workerUrl, apiToken } = await getConfig();
  if (!workerUrl || !apiToken) throw new Error('Add your Worker URL and token in the dashboard settings.');

  const headers = { Authorization: `Bearer ${apiToken}`, ...opts.headers };
  let body = opts.body;
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(workerUrl + path, { ...opts, headers, body });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}
