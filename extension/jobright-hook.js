// Runs in jobright.ai's own page context (manifest "world": "MAIN") so it can see the page's
// requests. When jobright records that you applied to a job (POST /swan/job/apply) or undoes it
// (/swan/job/unapply), it tells content-jobright.js via postMessage. It never sends requests itself.

(() => {
  const PATH = /\/swan\/job\/(apply|unapply)$/;
  const JOB_ID = /[0-9a-f]{24}/i;

  function report(kind, body, ok) {
    const id = String(body || '').match(JOB_ID);
    if (ok && id) window.postMessage({ __callbackJobright: true, kind, jobId: id[0] }, location.origin);
  }

  const matchPath = (url) => {
    try {
      return new URL(url, location.href).pathname.match(PATH);
    } catch {
      return null;
    }
  };
  const succeeded = (status, text) => status >= 200 && status < 300 && /"success"\s*:\s*true/.test(text || '');

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__callback = { method: String(method), url: String(url) };
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const m = this.__callback && /post/i.test(this.__callback.method) && matchPath(this.__callback.url);
    if (m) {
      this.addEventListener('load', () => {
        let text = '';
        try {
          text = this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response);
        } catch {
          // unreadable response
        }
        report(m[1], typeof body === 'string' ? body : '', succeeded(this.status, text));
      });
    }
    return send.call(this, body);
  };

  const fetchOrig = window.fetch;
  window.fetch = async function (input, init) {
    const res = await fetchOrig.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const m = matchPath(url);
      if (m) {
        const body = init?.body ?? (input instanceof Request ? await input.clone().text() : '');
        report(m[1], typeof body === 'string' ? body : '', succeeded(res.status, await res.clone().text()));
      }
    } catch {
      // never interfere with the page
    }
    return res;
  };
})();
