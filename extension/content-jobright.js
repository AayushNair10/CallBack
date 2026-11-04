// Runs on jobright.ai. When you click an Apply button, saves that job to Callback
// (status "applied") and shows a small confirmation. Classic script: content scripts
// can't be ES modules, so extract.js is loaded with a dynamic import.

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

    const res = await chrome.runtime.sendMessage({ type: 'callback:save-applied', job });
    const name = [res?.job?.company || job.company, res?.job?.role || job.role].filter(Boolean).join(' – ');
    if (!res?.ok) toast(`Callback: ${res?.error || 'save failed'}`, false);
    else if (res.created) toast(`✓ Saved to Callback: ${name}`);
    else toast(`✓ Already in Callback: ${name} (${res.job.status})`);
  }

  document.addEventListener('click', (e) => {
    const control = applyControl(e.target);
    if (control) onApplyClick(control);
  }, true);
})();
