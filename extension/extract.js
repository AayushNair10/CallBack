// Runs inside the job-posting tab via chrome.scripting.executeScript({ func: extractJob }).
// Chrome serializes the function source, so it MUST be self-contained: no imports and
// no references to anything outside its own body.

export function extractJob() {
  const KEEP_PARAMS = ['gh_jid', 'jk', 'jobid', 'job_id', 'id', 'jobreqid', 'for', 'token'];
  const ATS_NAMES = /greenhouse|lever|workday|ashby|smartrecruiters|workable|icims|jobvite|linkedin|indeed|glassdoor|taleo|successfactors/i;

  const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const decode = (s) => {
    const t = clean(s);
    if (!/[&<]/.test(t)) return t;
    try {
      return clean(new DOMParser().parseFromString(t, 'text/html').documentElement.textContent);
    } catch {
      return t;
    }
  };
  const meta = (sel) => clean(document.querySelector(sel)?.getAttribute('content'));
  const firstText = (selectors) => {
    for (const sel of selectors) {
      const t = clean(document.querySelector(sel)?.textContent);
      if (t) return t;
    }
    return '';
  };
  const toNum = (v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const toUnit = (u) => {
    const s = String(u || '').toUpperCase();
    if (/HOUR/.test(s)) return 'HOUR';
    if (/WEEK/.test(s)) return 'WEEK';
    if (/MONTH/.test(s)) return 'MONTH';
    if (/YEAR|ANNUAL|ANNUM/.test(s)) return 'YEAR';
    return null;
  };
  const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

  // 1. Canonical URL.
  function canonicalUrl(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return href || null;
    }
    if (/(^|\.)linkedin\.com$/i.test(u.hostname)) {
      const id = u.searchParams.get('currentJobId');
      if (id && /^\d+$/.test(id)) return `https://www.linkedin.com/jobs/view/${id}/`;
      const m = u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d+)/);
      if (m) return `https://www.linkedin.com/jobs/view/${m[1]}/`;
    }
    u.hash = '';
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (KEEP_PARAMS.includes(k.toLowerCase())) kept.append(k, v);
    u.search = kept.toString();
    return u.toString();
  }

  function atsSlug(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean)[0] || null;
    if (/(^|\.)greenhouse\.io$/.test(host)) return u.searchParams.get('for') || (seg !== 'embed' ? seg : null);
    if (/^jobs\.(?:eu\.)?lever\.co$|^jobs\.ashbyhq\.com$|^jobs\.smartrecruiters\.com$|^apply\.workable\.com$/.test(host)) return seg;
    const wd = host.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
    if (wd) return wd[1];
    if (/\.icims\.com$/.test(host)) return host.split('.')[0].replace(/^(?:[a-z]*careers?|jobs)-/, '');
    return null;
  }

  // 2. JSON-LD JobPosting.
  function findPosting() {
    const found = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      const types = [].concat(node['@type'] || []);
      if (types.includes('JobPosting')) found.push(node);
      if (node['@graph']) visit(node['@graph']);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = s.textContent || '';
      try {
        visit(JSON.parse(raw));
      } catch {
        try {
          visit(JSON.parse(raw.replace(/[\u0000-\u001F]+/g, ' ')));
        } catch {
          // unparseable block; ignore
        }
      }
    }
    return found[0] || null;
  }

  function locationFrom(p) {
    const locs = [];
    for (const l of [].concat(p.jobLocation || [])) {
      const a = (l && l.address) || l;
      if (!a) continue;
      if (typeof a === 'string') {
        locs.push(clean(a));
        continue;
      }
      const country = typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry;
      const parts = [a.addressLocality, a.addressRegion, country].map(clean).filter(Boolean);
      if (parts.length) locs.push([...new Set(parts)].join(', '));
    }
    const unique = [...new Set(locs)];
    const remote = [].concat(p.jobLocationType || []).some((t) => /telecommute/i.test(t));
    if (remote) return unique.length ? `Remote (${unique.join('; ')})` : 'Remote';
    return unique.join('; ');
  }

  function salaryFrom(p) {
    for (const s of [].concat(p.baseSalary || [], p.estimatedSalary || [])) {
      if (!s) continue;
      let min = null;
      let max = null;
      let unit = s.unitText;
      const v = s.value ?? s;
      if (typeof v === 'number' || typeof v === 'string') {
        min = max = toNum(v);
      } else if (v && typeof v === 'object') {
        min = toNum(v.minValue ?? v.value);
        max = toNum(v.maxValue ?? v.value);
        unit = v.unitText || unit;
      }
      if (min || max) {
        return {
          pay_min: min ?? max,
          pay_max: max ?? min,
          pay_unit: toUnit(unit),
          currency: clean(s.currency || p.salaryCurrency).toUpperCase() || null,
        };
      }
    }
    return null;
  }

  // 5. Pay range in the visible text.
  function payFromText(text) {
    const N = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([kK])?';
    // Optional unit right after the first number, as in LinkedIn's "$150K/yr - $200K/yr".
    const U = '(?:\\s*(?:\\/|per\\s+|an?\\s+)\\s*(hour|hr|year|yr|month|mo|week|wk)\\b)?';
    const re = new RegExp(`\\$\\s*${N}${U}\\s*(?:-|–|—|to)\\s*(?:USD\\s*)?\\$?\\s*${N}`, 'g');
    const unitIn = (s) => {
      s = s.toLowerCase();
      if (/\bhour\b|\bhourly\b|\/\s*hr\b|\bhr\b/.test(s)) return 'HOUR';
      if (/\byear\b|\byearly\b|\bannual|\bannum\b|\/\s*yr\b|\byr\b/.test(s)) return 'YEAR';
      if (/\bmonth\b|\bmonthly\b|\/\s*mo\b/.test(s)) return 'MONTH';
      if (/\bweek\b|\bweekly\b|\/\s*wk\b/.test(s)) return 'WEEK';
      return null;
    };
    const RANGES = { HOUR: [10, 500], YEAR: [20000, 2000000], MONTH: [1000, 200000], WEEK: [200, 40000] };

    // A range that states its unit beats one whose unit we had to guess.
    let guessed = null;
    for (const m of text.matchAll(re)) {
      let min = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
      const max = Number(m[4].replace(/,/g, '')) * (m[5] ? 1000 : 1);
      if (m[5] && !m[2] && min < 1000) min *= 1000; // "$125 - $160K"
      const end = m.index + m[0].length;
      const stated = (m[3] && unitIn(`/${m[3]}`)) || unitIn(text.slice(end, end + 25));
      const unit = stated || (max < 500 ? 'HOUR' : 'YEAR');
      const [lo, hi] = RANGES[unit];
      if (!(min <= max && min >= lo && max <= hi)) continue;
      const pay = { pay_min: min, pay_max: max, pay_unit: unit, currency: 'USD' };
      if (stated) return pay;
      guessed ||= pay;
    }
    return guessed;
  }

  const url = canonicalUrl(location.href);
  const job = { company: '', role: '', location: '', pay_min: null, pay_max: null, pay_unit: null, currency: null, url, source: 'generic' };

  const posting = findPosting();
  if (posting) {
    job.source = 'jsonld';
    job.role = decode(posting.title);
    const org = [].concat(posting.hiringOrganization || [])[0];
    job.company = decode(typeof org === 'string' ? org : org?.name);
    job.location = locationFrom(posting);
    Object.assign(job, salaryFrom(posting) || {});
  }

  // 3. LinkedIn.
  if (/(^|\.)linkedin\.com$/i.test(location.hostname)) {
    job.role ||= firstText([
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      '.top-card-layout__title',
      'h1.t-24',
    ]);
    job.company ||= firstText([
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      '.topcard__org-name-link',
      '.top-card-layout__second-subline a',
    ]);
    job.location ||= firstText([
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      '.job-details-jobs-unified-top-card__bullet',
      '.jobs-unified-top-card__bullet',
      '.topcard__flavor--bullet',
    ]);
    if (job.role && job.source === 'generic') job.source = 'linkedin';
  }

  // 4. Generic fallbacks.
  job.role ||= firstText(['h1']) || meta('meta[property="og:title"]');
  if (!job.company) {
    const site = meta('meta[property="og:site_name"]');
    const slug = atsSlug(location.href);
    job.company = site && !ATS_NAMES.test(site) ? site : slug ? titleCase(decodeURIComponent(slug)) : site;
  }

  if (!job.pay_min && !job.pay_max) {
    const text = (document.body?.innerText || document.body?.textContent || '').slice(0, 200000);
    Object.assign(job, payFromText(text) || {});
  }
  job.currency ||= job.pay_min || job.pay_max ? 'USD' : null;

  return job;
}
