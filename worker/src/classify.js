// Rule-based email classifier. Pure functions, no network, no AI.

export const OA_DOMAINS = [
  'hackerrank.com', 'codesignal.com', 'codility.com', 'hackerearth.com', 'testgorilla.com',
  'mettl.com', 'hirevue.com', 'coderbyte.com', 'qualified.io', 'byteboard.dev', 'imocha.io',
  'coderpad.io', 'glider.ai',
];

export const SCHEDULING_DOMAINS = [
  'calendly.com', 'goodtime.io', 'modernloop.io', 'gem.com', 'prelude.co', 'paradox.ai',
  'karat.io', 'karat.com', 'cal.com', 'yello.co',
];

export const ATS_DOMAINS = [
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'myworkday.com', 'myworkdayjobs.com',
  'ashbyhq.com', 'icims.com', 'smartrecruiters.com', 'jobvite.com', 'workable.com',
  'workablemail.com', 'successfactors.com', 'taleo.net', 'oraclecloud.com', 'cloud.oracle.com', 'bamboohr.com',
  'jazzhr.com', 'breezy.hr', 'eightfold.ai', 'phenompeople.com', 'avature.net', 'recruitee.com',
  'teamtailor.com', 'dover.com',
];

export const JOB_BOARD_DOMAINS = [
  'linkedin.com', 'indeed.com', 'indeedemail.com', 'glassdoor.com', 'ziprecruiter.com',
  'monster.com', 'dice.com', 'simplyhired.com', 'joinhandshake.com', 'wellfound.com',
  'builtin.com', 'jobright.ai', 'otta.com', 'hired.com', 'simplify.jobs', 'ripplematch.com', 'wayup.com',
  'welcometothejungle.com',
];

export const FREE_MAIL = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'aol.com', 'icloud.com',
  'proton.me', 'protonmail.com', 'yandex.com', 'mail.com', 'gmx.com', 'zoho.com',
];

// Interview-prep and learning sites: their mail talks about "coding challenges" and big-company
// interview questions, but it's always marketing.
export const PRACTICE_DOMAINS = [
  'leetcode.com', 'neetcode.io', 'algoexpert.io', 'educative.io', 'geeksforgeeks.org', 'interviewcake.com',
  'codecademy.com', 'datacamp.com', 'coursera.org', 'udemy.com', 'udacity.com', 'edx.org', 'brilliant.org',
  'designgurus.io', 'bytebytego.com', 'exponent.com', 'tryexponent.com', 'medium.com', 'substack.com',
];

export const CATEGORIES = [
  'application_received', 'oa', 'interview', 'offer', 'rejection',
  'recruiter_outreach', 'job_alert', 'newsletter', 'scam', 'other',
];

// True if `domain` is exactly one of `list` or a subdomain of one.
export function domainIn(domain, list) {
  if (!domain) return false;
  const d = String(domain).toLowerCase().trim().replace(/\.$/, '');
  return list.some((x) => d === x || d.endsWith('.' + x));
}

export function platformFor(domain) {
  if (domainIn(domain, OA_DOMAINS)) return 'oa';
  if (domainIn(domain, SCHEDULING_DOMAINS)) return 'scheduling';
  if (domainIn(domain, ATS_DOMAINS)) return 'ats';
  return null;
}

const anyOf = (patterns, text) => patterns.some((re) => re.test(text));

const SCAM = [
  /\btelegram\b/,
  /\bwhats ?app\b/,
  /\b(?:purchase|buy)\b.{0,30}\b(?:equipment|laptop|macbook|software license)/,
  /\b(?:deposit|cash)\b.{0,15}\b(?:check|cheque)\b/,
  /\bsend (?:you )?(?:a )?(?:check|cheque)\b/,
  /\bno interview (?:is |will be )?(?:required|needed|necessary)\b/,
  /\bwire transfer\b/,
  /\bgift ?cards?\b/,
];

const REJECTION = [
  /\bnot (?:be )?moving forward\b/,
  /\bmov(?:e|ing) forward with (?:other|another) (?:candidates?|applicants?)\b/,
  /\b(?:pursue|proceed with|continue with) other (?:candidates|applicants)\b/,
  /\bdecided not to (?:proceed|move forward|pursue|extend|continue)\b/,
  /\bwill not be (?:moving|proceeding|progressing|advancing)\b/,
  /\bnot to (?:proceed|move forward) with your (?:application|candidacy)\b/,
  /\bnot (?:been )?selected\b/,
  /\b(?:position|role|job|requisition) has (?:now )?been filled\b/,
  /\bregret to inform\b/,
  /\bunsuccessful\b/,
  /\bno longer (?:under consideration|being considered|considering)\b/,
  /\bunable to offer you\b/,
];

const RECEIVED = [
  /\bthanks? (?:you )?for applying\b/,
  /\bthank you for your application\b/,
  /\bapplication (?:has been |was )?received\b/,
  /\b(?:we(?: have|'ve)? )?received your application\b/,
  /\byour application (?:was|has been) (?:sent|submitted|received)\b/,
  /\bapplication (?:submitted|confirmation)\b/,
  /\bwe got your application\b/,
  /^indeed application:/,
];

const OUTREACH = [
  /\bcame across your (?:profile|resume|background|linkedin)\b/,
  /\bare you open to\b/,
  /\bi(?:'m| am) a (?:technical )?recruiter\b/,
  /\breaching out about\b/,
  /\bexciting opportunity\b/,
];

const APPLIED_CONTEXT = /\byour (?:recent )?application\b|\byou(?:'ve| have)? applied\b/;

const OFFER = [
  /\boffer letter\b/,
  /\bextend (?:you )?(?:an|a formal|a verbal|a written) offer\b/,
  /\b(?:verbal|written|formal) offer\b/,
  /\boffer of employment\b/,
  /\b(?:pleased|happy|delighted|excited|thrilled) to offer you\b/,
];

const OA = [
  /\bonline assessment\b/,
  /\bcoding (?:assessment|challenge|test|exercise)\b/,
  /\btechnical assessment\b/,
  /\btake[- ]home\b/,
  /\bcomplete (?:the|your|this|our) (?:online |technical |coding )?assessment\b/,
  /\bassessment invitation\b/,
  /\binvit(?:ed|ation) to (?:complete|take) (?:an?|the|our) (?:online |technical |coding )?(?:assessment|test|challenge)\b/,
  /\boa\b/,
];

// Wording a platform uses when it is inviting you to do something (vs. marketing).
const INVITE = [
  /\binvit(?:e|ed|es|ing|ation)\b/,
  /\byou(?:'ve| have) been (?:invited|selected|asked)\b/,
  /\b(?:please )?complete (?:the|your|this)\b/,
  /\b(?:assessment|test)\b/,
];

const INTERVIEW = [
  /\bschedul(?:e|ing) (?:an?|your|the|a time for (?:an?|your)) ?(?:\w+ )?(?:interview|phone screen|screen)\b/,
  /\binterview invitation\b/,
  /\binvit(?:e|ed|ation) (?:you )?to (?:an? |the )?(?:\w+ )?interview\b/,
  /\b(?:phone|technical|recruiter|hiring manager) (?:screen|interview)\b/,
  /\bvirtual onsite\b/,
  /\bonsite interview\b/,
  /\bshare (?:your|some) availability\b/,
  /\byour availability for (?:an? )?(?:interview|call|chat|conversation)\b/,
  /\bfinal round\b/,
  /\bsuperday\b/,
  /\binterview (?:confirmation|schedule|details)\b/,
];

// Scheduling platforms (Gem, Paradox, Yello…) also send confirmations and other mail, so their
// emails only count as interviews when they talk about scheduling something.
const SCHEDULING_WORDS = /\b(?:schedul\w*|reschedul\w*|book(?:ed|ing)? (?:a |your )?(?:time|slot|call|interview)|(?:pick|select|choose) a time|time slots?|availability|interview\w*|invit(?:e|ed|ation)|new event|event (?:scheduled|confirmed|updated|canceled|cancelled)|meeting|calendar|phone screen|video call)\b/;

function clean(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}]+/gi;

function findLink(body, list) {
  for (const raw of String(body || '').match(URL_RE) || []) {
    const url = raw.replace(/[.,;:!?]+$/, '');
    try {
      if (domainIn(new URL(url).hostname, list)) return url;
    } catch {
      // not a valid URL; keep looking
    }
  }
  return null;
}

function categorize({ domain, subject, text, listUnsub, platform }) {
  const offer = anyOf(OFFER, text);

  // 1. Scams.
  if (anyOf(SCAM, text)) return 'scam';
  if (offer && domainIn(domain, FREE_MAIL)) return 'scam';

  const rejection = anyOf(REJECTION, text);
  const receivedSubject = anyOf(RECEIVED, subject);

  // Practice and learning sites only send marketing.
  if (domainIn(domain, PRACTICE_DOMAINS)) return 'newsletter';

  // 2. Job boards only ever send confirmations, rejections or alerts.
  if (domainIn(domain, JOB_BOARD_DOMAINS)) {
    if (rejection) return 'rejection';
    if (receivedSubject) return 'application_received';
    return 'job_alert';
  }

  // 3. Bulk mail without a strong signal.
  if (listUnsub) {
    const platformSignal = platform && (anyOf(INVITE, text) || anyOf(INTERVIEW, text) || anyOf(OA, text) || /\binterview\b/.test(text));
    if (!(rejection || receivedSubject || platformSignal)) return 'newsletter';
  }

  // 4–10.
  if (rejection) return 'rejection';
  if (anyOf(OUTREACH, text) && !APPLIED_CONTEXT.test(text)) return 'recruiter_outreach';
  if (offer) return 'offer';
  if ((platform === 'oa' && anyOf(INVITE, text)) || anyOf(OA, text)) return 'oa';
  if (anyOf(INTERVIEW, text) || (platform === 'scheduling' && SCHEDULING_WORDS.test(text))) return 'interview';
  if (anyOf(RECEIVED, text)) return 'application_received';
  return 'other';
}

export function classify({ from_domain, subject, body, list_unsubscribe } = {}) {
  const domain = String(from_domain || '').toLowerCase();
  const subj = clean(subject);
  const text = clean(`${subject || ''}\n${String(body || '').slice(0, 5000)}`);
  const platform = platformFor(domain);

  const category = categorize({ domain, subject: subj, text, listUnsub: !!list_unsubscribe, platform });

  let link = null;
  if (category === 'oa') link = findLink(body, OA_DOMAINS);
  else if (category === 'interview') link = findLink(body, SCHEDULING_DOMAINS);

  return { category, platform, link };
}
