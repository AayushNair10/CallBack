// Runs on jobright.ai. Callback is only updated when you actually apply: when jobright records
// an application (seen by jobright-hook.js), that job is saved to Callback as "applied".
// Undoing it on jobright moves an "applied" job back to "saved". Internships are skipped.
// Classic script: content scripts can't be ES modules, so extract.js is loaded with a dynamic import.

(() => {
  const INTERNSHIP = /\bintern(?:ship)?s?\b|\bco-?op\b/i;
  const recent = new Map(); // "kind:id" -> time, so a repeated request is handled once

  async function readJob(id) {
    const { extractJob } = await import(chrome.runtime.getURL('extract.js'));
    const url = `https://jobright.ai/jobs/info/${id}`;
    if (location.pathname.includes(`/jobs/info/${id}`)) {
      const job = extractJob(document, location.href);
      if (job.company && job.role) return job;
    }
    const html = await (await fetch(url, { credentials: 'include' })).text();
    const job = extractJob(new DOMParser().parseFromString(html, 'text/html'), url);
    return job.company && job.role ? job : null;
  }

  function toast(text, ok = true) {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.textContent = text;
    box.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647', 'max-width:360px',
      'padding:10px 14px', 'border-radius:8px', 'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'color:#fff', `background:${ok ? '#16a34a' : '#b45309'}`, 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
    ].join(';');
    root.append(box);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 4500);
  }

  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (e.source !== window || !data || data.__callbackJobright !== true || !/^[0-9a-f]{24}$/i.test(data.jobId)) return;
    const key = `${data.kind}:${data.jobId}`;
    if (Date.now() - (recent.get(key) || 0) < 10_000) return;
    recent.set(key, Date.now());

    if (data.kind === 'unapply') {
      const res = await chrome.runtime.sendMessage({ type: 'callback:unapply', url: `https://jobright.ai/jobs/info/${data.jobId}` });
      if (res?.ok && res.job) toast(`Callback: ${res.job.company} moved back to saved`);
      return;
    }

    const job = await readJob(data.jobId).catch(() => null);
    if (!job) {
      toast("Callback couldn't read the job you applied to. Use the Callback icon on its page.", false);
      return;
    }
    if (INTERNSHIP.test(job.role)) return; // internships aren't tracked

    const res = await chrome.runtime.sendMessage({ type: 'callback:save', job, status: 'applied' });
    const name = [res?.job?.company || job.company, res?.job?.role || job.role].filter(Boolean).join(' – ');
    if (!res?.ok) toast(`Callback: ${res?.error || 'save failed'}`, false);
    else toast(`✓ Applied: ${name}${res.job.status !== 'applied' ? ` (status stays ${res.job.status})` : ''}`);
  });
})();
