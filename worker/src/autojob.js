// Builds a job from an email when it doesn't match any saved job, so applications made
// without the extension still show up. Best-effort rules; pure functions.
// When unsure, it leaves a field empty rather than guessing.

import { domainIn, platformFor, JOB_BOARD_DOMAINS, FREE_MAIL } from './classify.js';
import { aliasesFor, normalize } from './match.js';

const STATUS_CATEGORIES = new Set(['application_received', 'oa', 'interview', 'offer', 'rejection']);
const APPLIED_CONTEXT = /\byour (?:recent )?application\b|\byou(?:'ve| have)? applied\b|\bapplying\b|\bthanks? (?:you )?for applying\b/i;

const ATS_NAMES = 'workday|greenhouse|lever|ashby|icims|smartrecruiters|jobvite|workable|taleo|successfactors|bamboohr|jazzhr|breezy|recruitee|teamtailor|eightfold|phenom|avature|dover';
// Words recruiting senders put around the company name ("Stripe Recruiting", "Workday. PayPal").
const SENDER_NOISE = new RegExp(`\\b(?:${ATS_NAMES}|recruiting|recruitment|recruiters?|careers?|talent|acquisition|hiring|team|jobs?|hr|human resources|people|university|campus|early careers?|notifications?|no[- ]?reply|do[- ]?not[- ]?reply|noreply|donotreply|system|applications?|candidates?|experience|staffing|mailer|alerts?)\\b`, 'gi');
const GENERIC_NAMES = new Set([
  ...ATS_NAMES.split('|'), 'oracle', 'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'handshake',
  'hackerrank', 'codesignal', 'codility', 'hirevue', 'calendly', 'goodtime', 'gem', 'paradox', 'karat',
  'jobright', 'ripplematch', 'notification', 'support', 'info', 'admin', 'mail', 'email', 'system', 'the', 'a', 'our', 'your',
]);
const BAD_COMPANY = /^(?:a|an|the|our|your|this|that|us|you|we|it|position|role|job|team|opportunity|software|engineer|intern|company|organization|hiring|recruiting|careers?)$/i;

// A role must contain a job-title word ("Data" or "AI" alone isn't enough)...
const TITLE_WORD = /\b(?:engineer(?:ing)?|developer|scientist|analyst|intern(?:ship)?|co-?op|designer|manager|programmer|architect|specialist|associate|consultant|researcher|sde|swe|sre|devops|qa|tester|fellow(?:ship)?|technician|administrator|lead|director|coordinator|representative|officer|accountant|strategist|writer|recruiter|advisor|graduate|new grad|trainee|apprentice|technologist|quant|trader)\b/i;
// ...and not like a sentence.
const NOT_TITLE = /\b(?:you|your|we|our|us|let|know|information|visit|proceed|determine|alignment|candidacy|thank|thanks|time|effort|submitted|successfully|received|reviewing|review|please|regret|unfortunately|decided|selected|interest|considering|consideration|following|current|this|that|these|which|will|would|could|should)\b/i;

const clean = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
const compact = (s) => normalize(s).replace(/ /g, '');
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validCompany(s) {
  let c = clean(s)
    .replace(/'s\b.*$/i, '') // "Notion's engineering team" -> "Notion"
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)&.]+$/g, '')
    .replace(/\.$/, '');
  if (/@/.test(c)) return null;
  const domainLike = c.match(/^(?:[\w-]+\.)*([\w-]+)\.(?:com|net|org|io|ai|co|us|tech|dev|app)$/i);
  if (domainLike) c = titleCase(domainLike[1]);
  if (c.length < 2 || c.length > 60 || c.split(' ').length > 6) return null;
  if (BAD_COMPANY.test(c) || GENERIC_NAMES.has(c.toLowerCase())) return null;
  if (!/[a-z]/i.test(c)) return null;
  return c;
}

// Trims a captured phrase down to the job title in it, or returns null.
export function cleanRole(s, company) {
  let r = clean(s);
  // Keep only what follows the last "apply for the", "to the", "for our"...
  const lead = [...r.matchAll(/\b(?:apply(?:ing)?|applied|application|candidacy|interest|for|to|in)\s+(?:for |to |in )?(?:the|our|a|an|this)\s+/gi)].pop();
  if (lead) r = r.slice(lead.index + lead[0].length);
  r = r
    .replace(/^[^A-Za-z0-9]+/, '') // "* Backend Developer"
    .replace(/^(?:R|JR|REQ)-?\d{4,}\s*[-–—:]?\s*/i, '') // "JR2020271 Senior Systems Software Engineer"
    .replace(/\s+(?:job|position|role|opening|opportunity|posting)?\s*(?:was|has been|have been|is|at|with|here|and we|we|that|which|on|via)\b.*$/i, '')
    .replace(/\s+(?:job|position|role|opening|opportunity|posting)$/i, '')
    .replace(/\s*(?:[-–—#:]\s*|\(\s*)(?:req(?:uisition)?\.?\s*(?:id)?:?\s*)?(?:R|JR|REQ)?-?\d{5,}\)?\s*$|\s+\(?(?:R|JR|REQ)-?\d{4,}\)?\s*$/i, '') // trailing req ids, not years
    .replace(/[\s,.!:;'(-]+$/, '');
  if (r.length < 3 || r.length > 90 || r.split(' ').length > 12) return null;
  if (!TITLE_WORD.test(r) || NOT_TITLE.test(r) || /https?:|@/.test(r)) return null;
  if (company && compact(r).startsWith(compact(company)) && !TITLE_WORD.test(r.slice(company.length))) return null;
  return r;
}

// "Stripe Recruiting" -> "Stripe", "Workday. PayPal" -> "PayPal". Returns {name, org} where org says
// the name came with a recruiting word, which a person's name never does.
export function companyFromSender(name) {
  let n = clean(name);
  if (!n) return null;
  if (!/\s/.test(n) && /[a-z][A-Z]/.test(n)) {
    const split = n.replace(/([a-z])([A-Z])/g, '$1 $2'); // "WorkdaySystemDoNotReply"
    if (SENDER_NOISE.test(split)) n = split;
    SENDER_NOISE.lastIndex = 0;
  }
  if (/^[^\s@]+@[^\s@]+$/.test(n)) n = n.split('@')[1]; // "noreply@questdiagnostics.com"
  const at = n.match(/\s(?:at|@|from)\s+(.+)$/i); // "Jane at Stripe"
  if (at) n = at[1];
  n = n.split(/\s+(?:via|through)\s+/i)[0]; // "Stripe via Greenhouse"
  const domainLike = n.replace(/^[^A-Za-z0-9]+/, '').match(/^(?:[\w-]+\.)*([\w-]+)\.(?:com|net|org|io|ai|co|us|tech|dev|app)$/i);
  if (domainLike) n = domainLike[1]; // "Careers @ .questdiagnostics.com"
  const stripped = n.replace(/\s*[|–—:.-]+\s*/g, ' ').replace(SENDER_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const org = !!at || compact(stripped) !== compact(n);
  const valid = validCompany(stripped);
  return valid ? { name: valid, org } : null;
}

// Company names written in the subject or body, in priority order.
const COMPANY_PATTERNS = [
  /\byour application (?:was|has been) (?:sent|submitted) to ([^\n]+?)\s*(?:$|\n|[.!])/im,
  /\b(?:position|role|opening|opportunity|job|internship) (?:at|with) ([A-Z0-9][\w&.' -]*?)(?=\s*(?:$|\n|[!.,:;()]| for | - | – | — | team\b| has\b| is\b| and\b| was\b))/m,
  /\b(?:applying|applied|application|apply) (?:to|at|with) ([A-Z0-9][\w&.' -]*?)(?=\s*(?:$|\n|[!.,:;()]| for | - | – | — | team\b| has\b| is\b| and\b| was\b))/m,
  /^([A-Z0-9][\w&.' -]{1,40}?) (?:has )?invited you\b/m,
  /\binterest in (?:joining |working (?:at|with) |a career (?:at|with) |careers at )?([A-Z0-9][\w&.' -]*?)(?=\s*(?:$|\n|[!.,:;()]| for | - | – | — | team\b| and\b|'s\b))/m,
  /\bjoin(?:ing)? (?:the )?([A-Z0-9][\w&.' -]{1,40}?) team\b/m,
];

const ROLE_PATTERNS = [
  /^indeed application:\s*(.+)$/im,
  /\b(?:job )?title:\s*([^\n]{3,80})/i,
  /\bposition:\s*([^\n]{3,80})/i,
  /\b(?:for|to) (?:the |our )?(?:position of )?([A-Za-z0-9][^\n.!?]{2,80}?) (?:position|role|opening|opportunity|internship)\b/i,
  /\b(?:application|applying|applied) (?:for|to) (?:the )?([A-Za-z0-9][^\n.!?]{2,80}?) (?:position |role )?(?:at|with) /i,
  /\b[Aa](?:pplication|pplying|pplied) (?:for|to) (?:the )?([A-Z][^\n.!?]{2,80}?)(?=[.!?\n]|$| at | with | job\b| has\b| was\b| is\b)/,
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

// Use the capitalization written in the email ("paypal" -> "PayPal") when it's there.
function withCasing(company, texts) {
  const re = new RegExp(`\\b${escapeRe(company)}\\b`, 'i');
  for (const t of texts) {
    const m = t && t.match(re);
    if (m && m[0] !== m[0].toLowerCase()) return m[0];
  }
  return /^[a-z0-9 &.-]+$/.test(company) ? titleCase(company) : company;
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
    let role = before && !/your application|sent to/i.test(before) ? cleanRole(before, company) : null;
    if (!role && after && after !== location) role = cleanRole(after, company);
    return { role, location };
  }
  return { role: null, location: null };
}

function pickCompany({ domain, platform, board, subject, head, fromName, fromAddr }) {
  const texts = [subject, head];
  const fromText = firstMatch(COMPANY_PATTERNS, texts, validCompany);
  const sender = companyFromSender(fromName);
  // A bare two-word sender name with no recruiting words is usually a person ("Erica Saunders").
  const senderOk = sender && (sender.org || !/\s/.test(sender.name) || new RegExp(`\\b${escapeRe(sender.name)}\\b`, 'i').test(subject));
  const fromSender = senderOk ? sender.name : null;

  if (board) return fromText;

  if (platform) {
    if (domainIn(domain, ['myworkday.com'])) {
      // <tenant>@myworkday.com, unless it's a generic system address.
      const local = String(fromAddr || '').split('@')[0];
      const tenant = local && !/reply|system|notification|workday|mail|alert|recruit|career|talent/i.test(local) ? local : null;
      return fromSender || fromText || (tenant && validCompany(tenant));
    }
    return platform === 'ats' ? (sender?.org && fromSender) || fromText || fromSender : fromText || fromSender;
  }

  // The company's own domain: prefer a nicely written name that agrees with the domain.
  const label = domain.split('.').slice(-2, -1)[0] || '';
  const agrees = (c) => c && compact(c).length >= 2 && label.includes(compact(c).slice(0, 4));
  return [fromSender, fromText].find(agrees) || validCompany(label);
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

  let company = pickCompany({ domain, platform, board, subject, head, fromName: email.from_name, fromAddr: email.from_addr });
  if (!company) return null;
  company = withCasing(company, [subject, head]);

  let role = firstMatch(ROLE_PATTERNS, [subject, head], (r) => cleanRole(r, company));
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
