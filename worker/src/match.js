// Match an email to a saved job using company aliases. Pure functions.

import { domainIn, ATS_DOMAINS, JOB_BOARD_DOMAINS } from './classify.js';

const SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'com', 'plc', 'gmbh', 'the',
  'services', 'technologies', 'technology', 'group', 'holdings', 'limited', 'usa', 'us',
]);

// Host labels that never identify a company.
const GENERIC_LABELS = new Set([
  'www', 'careers', 'career', 'jobs', 'job', 'apply', 'boards', 'board', 'hire', 'hiring',
  'join', 'work', 'recruiting', 'talent', 'team', 'en', 'us', 'app', 'portal', 'co', 'com',
]);

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "The Amazon.com Services LLC" -> "amazon". Suffix words are dropped from the ends only,
// so names like "US Bank" or "The Co-operative Bank" keep their meaningful words.
export function companyCore(name) {
  const words = normalize(name).split(' ').filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && SUFFIXES.has(words[start])) start++;
  while (end > start && SUFFIXES.has(words[end - 1])) end--;
  const core = words.slice(start, end).join(' ');
  return core || words.join(' ');
}

function firstSegment(u) {
  return u.pathname.split('/').filter(Boolean)[0] || null;
}

export function slugFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let slug = null;

  if (domainIn(host, ['greenhouse.io'])) {
    slug = u.searchParams.get('for') || firstSegment(u);
    if (slug === 'embed') slug = null;
  } else if (/^jobs\.(?:eu\.)?lever\.co$|^jobs\.ashbyhq\.com$|^jobs\.smartrecruiters\.com$|^apply\.workable\.com$/.test(host)) {
    slug = firstSegment(u);
  } else if (/^[^.]+\.wd\d+\.myworkdayjobs\.com$/.test(host)) {
    slug = host.split('.')[0];
  } else if (domainIn(host, ['icims.com'])) {
    slug = host.split('.')[0].replace(/^(?:[a-z]*careers?|jobs)-/, '');
  } else if (domainIn(host, JOB_BOARD_DOMAINS) || domainIn(host, ATS_DOMAINS)) {
    return null;
  } else {
    const labels = host.split('.');
    labels.pop(); // TLD
    // Two-part public suffixes like co.uk / com.au.
    if (labels.length > 1 && /^(?:co|com|org|net|ac|gov)$/.test(labels[labels.length - 1])) labels.pop();
    slug = [...labels].reverse().find((l) => !GENERIC_LABELS.has(l)) || null;
  }

  return slug ? decodeURIComponent(slug).toLowerCase() : null;
}

export function aliasesFor(company, url) {
  const slug = slugFromUrl(url);
  const list = [companyCore(company), slug ? slug.replace(/[-_]+/g, ' ').trim() : ''];
  return [...new Set(list.map((a) => a.trim()))].filter((a) => a.length >= 3);
}

export function jobAliases(job) {
  const stored = String(job.aliases || '')
    .split(',')
    .map((a) => normalize(a))
    .filter((a) => a.length >= 3);
  return stored.length ? stored : aliasesFor(job.company, job.url).map(normalize);
}

const ROLE_STOPWORDS = new Set(['and', 'the', 'for', 'of', 'in', 'at', 'to', 'a', 'an', 'with', 'i', 'ii', 'iii']);

function roleWords(role) {
  return [...new Set(normalize(role).split(' '))].filter((w) => w.length >= 2 && !ROLE_STOPWORDS.has(w));
}

// Returns the best-matching job or null.
export function matchJob(jobs, email) {
  const hay = ` ${normalize([email.from_name, email.subject, String(email.body || '').slice(0, 3000)].join(' '))} `;
  const subject = ` ${normalize(email.subject)} `;
  const domain = String(email.from_domain || '').toLowerCase().replace(/[^a-z0-9.]/g, '');

  let best = null;
  let bestScore = 0;
  for (const job of jobs || []) {
    const aliases = jobAliases(job);
    let score = 0;
    if (aliases.some((a) => hay.includes(` ${a} `))) score += 10;
    if (domain && aliases.some((a) => domain.includes(a.replace(/ /g, '')))) score += 20;
    if (!score) continue;

    score += roleWords(job.role).filter((w) => subject.includes(` ${w} `)).length;
    if (job.status !== 'rejected') score += 1;

    const newer = best && String(job.applied_at || '') > String(best.applied_at || '');
    if (score > bestScore || (score === bestScore && newer)) {
      best = job;
      bestScore = score;
    }
  }
  return best;
}
