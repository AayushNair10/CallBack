// Runs on jobright.ai.
// - Clicking an Apply button saves the job to Callback as "saved".
// - When jobright records that you applied (seen by jobright-hook.js), it becomes "applied";
//   undoing that on jobright moves it back to "saved".
// - Your Applied page syncs its 100 most recent jobs.
// Classic script: content scripts can't be ES modules, so extract.js is loaded with a dynamic import.

(() => {
  const APPLY_TEXT = /\bapply\b/i;
  const NOT_APPLY = /plugin|extension|filter|applied|applicants?|apply to \d|how to/i;
  const JOB_ID = /\/jobs\/info\/([0-9a-f]{24})/i;
  const recent = new Map(); // job id -> time, so double clicks save once

  // The Apply control the click landed on, if any: a short label containing "apply".
  function applyControl(target) {
    for (let n = target, depth = 0; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
      const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 40) break;
      if (APPLY_TEXT.test(text) && !NOT_APPLY.test(text)) return n;
    }
    return null;
  }

  // The jobright job id for the clicked button: from the page URL on a job page, otherwise
  // from a link to the job inside the card that holds the button.
  function jobIdFor(el) {
    const fromPath = location.pathname.match(JOB_ID);
    if (fromPath) return fromPath[1];
    for (let n = el, depth = 0; n && n !== document.body && depth < 10; n = n.parentElement, depth++) {
      const link = n.querySelector?.('a[href*="/jobs/info/"]');
      const m = link?.getAttribute('href')?.match(JOB_ID);
      if (m) return m[1];
    }
    const fromQuery = location.href.match(/[?&#][^=]*id=([0-9a-f]{24})/i);
    return fromQuery ? fromQuery[1] : null;
  }

  async function readJob(id) {
    const { extractJob } = await import(chrome.runtime.getURL('extract.js'));
    if (id && location.pathname.includes(`/jobs/info/${id}`)) {
      const job = extractJob(document, location.href);
      if (job.company && job.role) return job;
    }
    if (id) {
      const url = `https://jobright.ai/jobs/info/${id}`;
      const html = await (await fetch(url, { credentials: 'include' })).text();
      const job = extractJob(new DOMParser().parseFromString(html, 'text/html'), url);
      if (job.company && job.role) return job;
    }
    const job = extractJob(document, location.href);
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

  async function onApplyClick(control) {
    const id = jobIdFor(control);
    const key = id || location.href;
    if (Date.now() - (recent.get(key) || 0) < 30_000) return;
    recent.set(key, Date.now());

    let job;
    try {
      job = await readJob(id);
    } catch (err) {
      console.warn('Callback: could not read job', err);
    }
    if (!job) {
      toast("Callback couldn't read this job. Open it and use the Callback icon.", false);
      return;
    }

    const res = await chrome.runtime.sendMessage({ type: 'callback:save', job, status: 'saved' });
    const name = [res?.job?.company || job.company, res?.job?.role || job.role].filter(Boolean).join(' – ');
    if (!res?.ok) toast(`Callback: ${res?.error || 'save failed'}`, false);
    else if (res.created) toast(`☆ Saved to Callback: ${name}. It becomes "applied" when jobright records your application.`);
    else toast(`Already in Callback: ${name} (${res.job.status})`);
  }

  // jobright recorded (or undid) an application: mirror it in Callback.
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
    const res = await chrome.runtime.sendMessage({ type: 'callback:save', job, status: 'applied' });
    const name = [res?.job?.company || job.company, res?.job?.role || job.role].filter(Boolean).join(' – ');
    if (!res?.ok) toast(`Callback: ${res?.error || 'save failed'}`, false);
    else toast(`✓ Applied: ${name}${res.job.status !== 'applied' ? ` (status stays ${res.job.status})` : ''}`);
  });

  document.addEventListener('click', (e) => {
    const control = applyControl(e.target);
    if (control) onApplyClick(control);
  }, true);

  // On your jobright "Applied" page, copy the most recent listed jobs into Callback. This fills
  // in the role, location and pay on jobs that were created from emails. Each job is synced once.
  // The page lists newest first, so only the first APPLIED_LIMIT are used.
  const SYNCED_KEY = 'jobrightSynced';
  const APPLIED_LIMIT = 100;
  let syncing = false;
  let warned = false;

  async function syncApplied() {
    if (syncing || !location.pathname.startsWith('/jobs/applied')) return;
    const ids = [...new Set([...document.querySelectorAll('a[href*="/jobs/info/"]')]
      .map((a) => a.getAttribute('href').match(JOB_ID)?.[1])
      .filter(Boolean))].slice(0, APPLIED_LIMIT);
    const { [SYNCED_KEY]: synced = [] } = await chrome.storage.local.get(SYNCED_KEY);
    const todo = ids.filter((id) => !synced.includes(id));
    if (!todo.length) return;

    syncing = true;
    let saved = 0;
    try {
      for (const id of todo) {
        const job = await readJob(id).catch(() => null);
        if (!job) continue;
        const res = await chrome.runtime.sendMessage({ type: 'callback:save', job, status: 'applied' });
        if (!res?.ok) {
          toast(`Callback: ${res?.error || 'sync failed'}`, false);
          break;
        }
        saved++;
        synced.push(id);
      }
      await chrome.storage.local.set({ [SYNCED_KEY]: synced.slice(-3000) });
      if (saved) toast(`✓ Synced ${saved} applied job${saved === 1 ? '' : 's'} from jobright to Callback`);
    } finally {
      syncing = false;
    }
  }

  // jobright is a single-page app that loads the list (and more on scroll) after the page.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(syncApplied, 1500);
  }).observe(document.documentElement, { childList: true, subtree: true });
  syncApplied();
  setTimeout(() => {
    if (!warned && location.pathname.startsWith('/jobs/applied') && !document.querySelector('a[href*="/jobs/info/"]')) {
      warned = true;
      console.warn('Callback: no job links found on the jobright Applied page');
    }
  }, 10_000);
})();
