// Builds a job from an email when it doesn't match any saved job, so applications made
// without the extension still show up. Best-effort rules; pure functions.

import { domainIn, platformFor, JOB_BOARD_DOMAINS, FREE_MAIL } from './classify.js';
import { aliasesFor, normalize } from './match.js';

const STATUS_CATEGORIES = new Set(['application_received', 'oa', 'interview', 'offer', 'rejection']);
const APPLIED_CONTEXT = /\byour (?:recent )?application\b|\byou(?:'ve| have)? applied\b|\bapplying\b|\bthanks? (?:you )?for applying\b/i;

// Words recruiting senders put around the company name ("Stripe Recruiting", "Capital One Careers").
const SENDER_NOISE = /\b(?:recruiting|recruitment|recruiter|careers?|talent(?: acquisition)?|acquisition|hiring|team|jobs?|hr|human resources|people|university|campus|early|notifications?|no[- ]?reply|do[- ]?not[- ]?reply|applications?|candidate|experience|staffing)\b/gi;
const GENERIC_NAMES = new Set([
  'workday', 'greenhouse', 'lever', 'ashby', 'icims', 'smartrecruiters', 'jobvite', 'workable', 'taleo',
  'successfactors', 'oracle', 'bamboohr', 'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'handshake',
  'hackerrank', 'codesignal', 'codility', 'hirevue', 'calendly', 'goodtime', 'gem', 'paradox', 'karat',
  'jobright', 'notification', 'support', 'info', 'admin', 'mail', 'email', 'system', 'the', 'a', 'our', 'your',
]);
const BAD_COMPANY = /^(?:a|an|the|our|your|this|that|us|you|we|position|role|job|team|opportunity|software|engineer|intern)$/i;
const BAD_ROLE_START = /^(?:a|an|this|that|our|your|the|above|following|open|same|new|any|other|it)\b/i;

const clean = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
const compact = (s) => normalize(s).replace(/ /g, '');
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function validCompany(s) {
  const c = clean(s).replace(/[\s,.!:;'-]+$/, '').replace(/^[\s,.!:;'-]+/, '');
  if (c.length < 2 || c.length > 60 || c.split(' ').length > 6) return null;
  if (BAD_COMPANY.test(c) || GENERIC_NAMES.has(c.toLowerCase())) return null;
  if (!/[a-z]/i.test(c)) return null;
  return c;
}

function validRole(s, company) {
  const r = clean(s).replace(/^[\s,.!:;'-]+|[\s,.!:;'-]+$/g, '');
  if (r.length < 3 || r.length > 90 || r.split(' ').length > 12) return null;
  if (BAD_ROLE_START.test(r) || /https?:|@|application|applying|thank/i.test(r)) return null;
  if (company && compact(r) === compact(company)) return null;
  return r;
}

export function companyFromSender(name) {
  let n = clean(name);
  if (!n) return null;
  const at = n.match(/\s(?:at|@|from)\s+(.+)$/i); // "Jane at Stripe"
  if (at) n = at[1];
  n = n.split(/\s+(?:via|through)\s+/i)[0]; // "Stripe via Greenhouse"
  n = n.replace(/\s+[|–—-]\s+/g, ' ').replace(SENDER_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return validCompany(n);
}

// Company names written in the subject or body, in priority order.
const COMPANY_PATTERNS = [
  /\byour application (?:was|has been) (?:sent|submitted) to ([^\n]+?)\s*(?:$|\n|[.!])/im,
  /\b(?:position|role|opening|opportunity|job|internship) (?:at|with) ([A-Z0-9][\w&.' -]*?)(?=\s*(?:$|\n|[!.,:;()]| for | - | – | — | team\b| has\b| is\b| and\b))/m,
  /\b(?:applying|applied|application|apply) (?:to|at|with) ([A-Z0-9][\w&.' -]*?)(?=\s*(?:$|\n|[!.,:;()]| for | - | – | — | team\b| has\b| is\b| and\b))/m,
  /^([A-Z0-9][\w&.' -]{1,40}?) (?:has )?invited you\b/m,
  /\binterest in (?:joining |working (?:at|with) |a career (?:at|with) |careers at )?([A-Z0-9][\w&.' -]*?)(?=\s*(?:$|\n|[!.,:;()]| for | - | – | — | team\b| and\b))/m,
];

const ROLE_PATTERNS = [
  /\b(?:for|to) (?:the |our )?(?:position of )?([A-Za-z0-9][^\n.!?]{2,80}?) (?:position|role|opening|opportunity|internship)\b/i,
  /\b(?:application|applying|applied) (?:for|to) (?:the )?([A-Za-z0-9][^\n.!?]{2,80}?) (?:position |role )?(?:at|with) /i,
  /\b[Aa](?:pplication|pplying|pplied) for (?:the )?([A-Z][^\n.!?]{2,80}?)(?=[.!?\n]|$| at | with )/,
  /^indeed application:\s*(.+)$/im,
  /\bposition:\s*([^\n]{3,80})/i,
  /\b(?:job )?title:\s*([^\n]{3,80})/i,
];

function firstMatch(patterns, texts, validate) {
  for (const re of patterns) {
    for (const t of texts) {
      const m = t && t.match(re);
      const v = m && validate(m[1]);
      if (v) return v;
    }
  }
  return null;
}

// Job posting links that identify the job: LinkedIn job ids and the common ATS boards.
function postingUrl(body) {
  const text = String(body || '');
  const li = text.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i);
  if (li) return `https://www.linkedin.com/jobs/view/${li[1]}/`;
  for (const raw of text.match(/https?:\/\/[^\s<>"'()\[\]]+/gi) || []) {
    let u;
    try {
      u = new URL(raw.replace(/[.,;:!?]+$/, ''));
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    const isPosting =
      (/(^|\.)greenhouse\.io$/.test(host) && /\/jobs\/\d+/.test(u.pathname)) ||
      (/^jobs\.(?:eu\.)?lever\.co$|^jobs\.ashbyhq\.com$/.test(host) && u.pathname.split('/').filter(Boolean).length >= 2) ||
      (/\.myworkdayjobs\.com$/.test(host) && /\/job\//.test(u.pathname));
    if (!isPosting) continue;
    const jid = u.searchParams.get('gh_jid');
    u.search = jid ? `?gh_jid=${jid}` : '';
    u.hash = '';
    return u.toString();
  }
  return null;
}

// LinkedIn "application sent" emails list the role, company and location on separate lines.
function linkedInDetails(body, company) {
  const lines = String(body || '').split(/\r?\n/).map(clean).filter(Boolean).slice(0, 60);
  const key = compact(company);
  const LOCATION = /^(?:remote|hybrid|on-site|united states|[A-Z][\w .'-]+, [A-Z][\w .'-]+)(?:\s*\((?:remote|hybrid|on-site)\))?$/i;
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+[·•|]\s+/);
    if (compact(parts[0]) !== key) continue;
    let location = parts.length > 1 && LOCATION.test(parts[1]) ? parts[1] : null;
    if (!location && lines[i + 1] && LOCATION.test(lines[i + 1])) location = lines[i + 1];
    const before = lines[i - 1];
    const after = lines[i + 1];
    let role = before && !/your application|sent to/i.test(before) ? validRole(before, company) : null;
    if (!role && after && after !== location) role = validRole(after, company);
    return { role, location };
  }
  return { role: null, location: null };
}

/**
 * Returns {company, role, location, url, aliases} for an unmatched email that clearly belongs
 * to an application, or null when it shouldn't create a job.
 */
export function jobFromEmail(email, category) {
  if (!STATUS_CATEGORIES.has(category)) return null;
  const domain = String(email.from_domain || '').toLowerCase();
  if (!domain || domainIn(domain, FREE_MAIL)) return null;

  const platform = platformFor(domain);
  const board = domainIn(domain, JOB_BOARD_DOMAINS);
  const subject = clean(email.subject);
  const body = String(email.body || '').slice(0, 4000);
  const head = body.slice(0, 1500);

  // Unknown senders in Spam, and OA/interview/offer mail that never mentions an application,
  // are too likely to be junk or cold outreach.
  if (email.in_spam && !platform && !board) return null;
  if (['oa', 'interview', 'offer'].includes(category) && !platform && !APPLIED_CONTEXT.test(`${subject}\n${head}`)) return null;

  const fromText = firstMatch(COMPANY_PATTERNS, [subject, head], validCompany);
  const fromSender = companyFromSender(email.from_name);
  let company = null;

  if (board) {
    company = fromText;
  } else if (platform) {
    company = (platform === 'ats' ? fromSender || fromText : fromText || fromSender) || null;
    // Workday mails come from <tenant>@myworkday.com.
    if (!company && domainIn(domain, ['myworkday.com'])) {
      const local = String(email.from_addr || '').split('@')[0];
      if (local && !/^(?:no-?reply|donotreply|workday|notifications?)$/i.test(local)) company = titleCase(local);
    }
  } else {
    // The company's own domain: prefer a nicely written name that agrees with the domain.
    const label = domain.split('.').slice(-2, -1)[0] || '';
    company = [fromSender, fromText].find((c) => c && label.includes(compact(c).slice(0, 4)) && compact(c).length >= 2) || validCompany(titleCase(label));
  }
  if (!company) return null;

  let role = firstMatch(ROLE_PATTERNS, [subject, head], (r) => validRole(r, company));
  let location = null;
  if (domainIn(domain, ['linkedin.com'])) {
    const li = linkedInDetails(body, company);
    role = li.role || role;
    location = li.location;
  }

  const url = postingUrl(body);
  const aliases = aliasesFor(company, url);
  if (!platform && !board) {
    const label = domain.split('.').slice(-2, -1)[0];
    if (label && label.length >= 3 && !aliases.includes(label)) aliases.push(label);
  }

  return { company, role: role || null, location, url, aliases };
}

