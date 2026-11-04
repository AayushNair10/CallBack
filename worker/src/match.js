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
  const core = companyCore(company);
  const list = [core.length >= 2 ? core : '', slug && slug.length >= 3 ? slug.replace(/[-_]+/g, ' ').trim() : ''];
  return [...new Set(list.map((a) => a.trim()))].filter(Boolean);
}

export function jobAliases(job) {
  const stored = String(job.aliases || '')
    .split(',')
    .map((a) => normalize(a))
    .filter((a) => a.length >= 2);
  return stored.length ? stored : aliasesFor(job.company, job.url).map(normalize);
}

const ROLE_STOPWORDS = new Set(['and', 'the', 'for', 'of', 'in', 'at', 'to', 'a', 'an', 'with', 'i', 'ii', 'iii']);

// First words too common to identify a company on their own ("Capital One", "General Motors").
const GENERIC_FIRST = new Set([
  'capital', 'general', 'united', 'american', 'national', 'first', 'global', 'digital', 'data', 'bank',
  'new', 'open', 'smart', 'north', 'south', 'east', 'west', 'pacific', 'central', 'international',
  'advanced', 'applied', 'modern', 'future', 'home', 'health', 'life', 'cloud', 'power', 'energy',
  'media', 'software', 'systems', 'tech', 'labs', 'solutions', 'consulting', 'partners', 'financial',
  'insurance', 'mutual', 'state', 'city', 'royal', 'scale', 'red', 'blue', 'green', 'black', 'white',
  'quantum', 'rocket', 'bright', 'true', 'great', 'golden', 'silver', 'summit', 'peak', 'alpha', 'delta',
]);

// "cerebras systems" -> "cerebras", for emails that only use the short name.
function shortName(alias) {
  const words = alias.split(' ');
  return words.length > 1 && words[0].length >= 5 && !GENERIC_FIRST.has(words[0]) ? words[0] : null;
}

// "Software Engineer, New Grad" and "Software Engineer - New Grad 2026" are the same role;
// "Backend Engineer" and "Data Scientist" are not.
export function rolesAgree(a, b) {
  const words = (r) => new Set(roleWords(r).filter((w) => !/^\d+$/.test(w)));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return true;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared === x.size || shared === y.size || shared / new Set([...x, ...y]).size > 0.5;
}

// Same company, allowing for spacing ("Capitalone" vs "Capital One") and short names
// ("Cerebras" vs "Cerebras Systems").
export function sameCompany(a, b) {
  const x = companyCore(a).replace(/ /g, '');
  const y = companyCore(b).replace(/ /g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.startsWith(short);
}

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
    const label = domain.split('.').slice(-2, -1)[0] || '';
    if (aliases.some((a) => hay.includes(` ${a} `))) score += 10;
    else if (aliases.some((a) => shortName(a) && hay.includes(` ${shortName(a)} `))) score += 5;
    // Two-letter names ("f5") must equal the domain name; longer ones may be part of it.
    const inDomain = (a) => (a.length <= 2 ? label === a : domain.includes(a));
    if (domain && aliases.some((a) => inDomain(a.replace(/ /g, '')))) score += 20;
    else if (domain && aliases.some((a) => shortName(a) && domain.includes(shortName(a)))) score += 15;
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
