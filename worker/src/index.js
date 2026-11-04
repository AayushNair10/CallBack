// Callback Worker: jobs API, email ingest, status tracking and ntfy notifications.

import { classify, domainIn, FREE_MAIL, JOB_BOARD_DOMAINS, CATEGORIES } from './classify.js';
import { aliasesFor, companyCore, matchJob, normalize } from './match.js';
import { jobFromEmail } from './autojob.js';

const STATUSES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected'];
const ORDER = { saved: 0, applied: 1, oa: 2, interview: 3, offer: 4 };
const PAY_UNITS = ['HOUR', 'WEEK', 'MONTH', 'YEAR'];

const STATUS_FOR = {
  application_received: 'applied',
  oa: 'oa',
  interview: 'interview',
  offer: 'offer',
  rejection: 'rejected',
};

const NOISE = new Set(['job_alert', 'newsletter', 'scam', 'recruiter_outreach']);
const HIDDEN_BY_DEFAULT = ['job_alert', 'newsletter', 'other'];
const NOTIFY_CATEGORIES = new Set(['oa', 'interview', 'offer']);
const LABELS = { oa: 'Online assessment', interview: 'Interview', offer: 'Offer' };
const TAGS = { oa: 'computer', interview: 'calendar', offer: 'tada' };
const DAY_MS = 24 * 60 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const now = () => new Date().toISOString();

function authorized(request, env) {
  const expected = env.API_TOKEN;
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

// ---------- field cleaning ----------

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const payUnit = (v) => {
  const u = str(v)?.toUpperCase();
  return u && PAY_UNITS.includes(u) ? u : null;
};

const status = (v) => {
  const s = str(v)?.toLowerCase();
  if (s && !STATUSES.includes(s)) throw new HttpError(400, `Invalid status: ${s}`);
  return s;
};

const aliasList = (v) => {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const clean = [...new Set(list.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  return clean.length ? clean.join(',') : null;
};

const JOB_FIELDS = {
  company: str, role: str, location: str, pay_min: num, pay_max: num, pay_unit: payUnit,
  currency: (v) => str(v)?.toUpperCase() ?? null, url: str, aliases: aliasList, status, notes: str,
  applied_at: str,
};

// ---------- status history ----------

function nextStatus(current, target) {
  if (!target || current === target) return null;
  if (target === 'rejected') return 'rejected';
  if (current === 'rejected') return null; // only a manual edit reopens a rejected job
  return ORDER[target] > (ORDER[current] ?? -1) ? target : null;
}

// Moves the job forward if the category warrants it. Mutates `job` so later emails in the
// same batch see the new status. Returns the new status or null.
async function advance(env, job, category, emailId) {
  const target = nextStatus(job.status, STATUS_FOR[category]);
  if (!target) return null;
  const ts = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind(target, ts, job.id),
    env.DB.prepare('INSERT INTO events (job_id, status, email_id, created_at) VALUES (?, ?, ?, ?)').bind(job.id, target, emailId ?? null, ts),
  ]);
  job.status = target;
  job.updated_at = ts;
  return target;
}

// ---------- jobs ----------

async function listJobs(env, url) {
  const u = url.searchParams.get('url');
  const stmt = u
    ? env.DB.prepare('SELECT * FROM jobs WHERE url = ? ORDER BY updated_at DESC').bind(u)
    : env.DB.prepare('SELECT * FROM jobs ORDER BY updated_at DESC');
  return json((await stmt.all()).results);
}

async function upsertJob(env, request) {
  const body = await readJson(request);
  const job = {};
  for (const [k, clean] of Object.entries(JOB_FIELDS)) job[k] = clean(body[k]);
  if (!job.company) throw new HttpError(400, 'company is required');

  const ts = now();
  job.status ||= 'applied';
  job.applied_at ||= ts;
  job.aliases ||= aliasesFor(job.company, job.url).join(',') || null;

  const existing = job.url
    ? await env.DB.prepare('SELECT id FROM jobs WHERE url = ?').bind(job.url).first()
    : null;

  // The same job saved from jobright, LinkedIn or an email under another URL: update that row.
  if (!existing) {
    const similar = await findSimilarJob(env, job);
    if (similar) return json({ ...(await mergeInto(env, similar, job, ts)), created: false, merged: true });
  }

  const row = await env.DB.prepare(
    `INSERT INTO jobs (company, role, location, pay_min, pay_max, pay_unit, currency, url, aliases, status, notes, applied_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       company = excluded.company, role = excluded.role, location = excluded.location,
       pay_min = excluded.pay_min, pay_max = excluded.pay_max, pay_unit = excluded.pay_unit,
       currency = excluded.currency, notes = excluded.notes, updated_at = excluded.updated_at
     RETURNING *`,
  ).bind(
    job.company, job.role, job.location, job.pay_min, job.pay_max, job.pay_unit, job.currency,
    job.url, job.aliases, job.status, job.notes, job.applied_at, ts,
  ).first();

  if (!existing) {
    await env.DB.prepare('INSERT INTO events (job_id, status, email_id, created_at) VALUES (?, ?, NULL, ?)')
      .bind(row.id, row.status, ts).run();
  }
  return json({ ...row, created: !existing }, existing ? 200 : 201);
}

const isBoardUrl = (url) => {
  try {
    return domainIn(new URL(url).hostname, JOB_BOARD_DOMAINS);
  } catch {
    return false;
  }
};

// Same company and same role, where at least one side has no URL or only a job-board URL.
// Two different employer-site URLs are treated as two separate postings.
async function findSimilarJob(env, job) {
  const key = (name) => companyCore(name).replace(/ /g, ''); // "Capitalone" == "Capital One"
  const core = key(job.company);
  const role = normalize(job.role);
  const { results } = await env.DB.prepare('SELECT * FROM jobs').all();
  const candidates = results.filter((j) => {
    if (key(j.company) !== core) return false;
    if (j.url && job.url && !isBoardUrl(j.url) && !isBoardUrl(job.url)) return false;
    return true;
  });
  const sameRole = candidates.filter((j) => role && normalize(j.role) === role);
  if (sameRole.length) return sameRole[0];
  const loose = candidates.filter((j) => !role || !j.role);
  return loose.length === 1 ? loose[0] : null;
}

async function mergeInto(env, old, job, ts) {
  const url = job.url && isBoardUrl(job.url) && old.url && !isBoardUrl(old.url) ? old.url : job.url || old.url;
  const aliases = [...new Set([...String(old.aliases || '').split(','), ...aliasesFor(job.company, url)].map((a) => a.trim()).filter(Boolean))].join(',');
  return env.DB.prepare(
    `UPDATE jobs SET company = ?, role = COALESCE(?, role), location = COALESCE(?, location),
       pay_min = COALESCE(?, pay_min), pay_max = COALESCE(?, pay_max), pay_unit = COALESCE(?, pay_unit),
       currency = COALESCE(?, currency), url = ?, aliases = ?, notes = COALESCE(?, notes), updated_at = ?
     WHERE id = ? RETURNING *`,
  ).bind(
    job.company, job.role, job.location, job.pay_min, job.pay_max, job.pay_unit, job.currency,
    url, aliases || null, job.notes, ts, old.id,
  ).first();
}

async function patchJob(env, request, id) {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!current) throw new HttpError(404, 'Job not found');

  const sets = [];
  const values = [];
  for (const [k, clean] of Object.entries(JOB_FIELDS)) {
    if (!(k in body)) continue;
    const v = clean(body[k]);
    if ((k === 'company' || k === 'status' || k === 'applied_at') && !v) throw new HttpError(400, `${k} cannot be empty`);
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (!sets.length) return json(current);

  const ts = now();
  const row = await env.DB.prepare(`UPDATE jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ? RETURNING *`)
    .bind(...values, ts, id).first();

  if (row.status !== current.status) {
    await env.DB.prepare('INSERT INTO events (job_id, status, email_id, created_at) VALUES (?, ?, NULL, ?)')
      .bind(id, row.status, ts).run();
  }
  return json(row);
}

async function deleteJob(env, id) {
  const res = await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'Job not found');
  return json({ deleted: id });
}

// ---------- emails ----------

const EMAIL_SELECT = `SELECT e.*, j.company AS job_company, j.role AS job_role
  FROM emails e LEFT JOIN jobs j ON j.id = e.job_id`;

async function listEmails(env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
  const all = url.searchParams.get('all') === '1';
  const where = all ? '' : `WHERE e.category NOT IN (${HIDDEN_BY_DEFAULT.map(() => '?').join(', ')})`;
  const binds = all ? [limit] : [...HIDDEN_BY_DEFAULT, limit];
  const { results } = await env.DB.prepare(`${EMAIL_SELECT} ${where} ORDER BY e.received_at DESC LIMIT ?`)
    .bind(...binds).all();
  return json(results);
}

async function patchEmail(env, request, id) {
  const body = await readJson(request);
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first();
  if (!email) throw new HttpError(404, 'Email not found');

  const sets = [];
  const values = [];
  if ('category' in body) {
    if (!CATEGORIES.includes(body.category)) throw new HttpError(400, `Invalid category: ${body.category}`);
    sets.push('category = ?');
    values.push(body.category);
    email.category = body.category;
  }
  if ('job_id' in body) {
    const jobId = body.job_id === null || body.job_id === '' ? null : parseInt(body.job_id, 10);
    if (jobId !== null && !Number.isInteger(jobId)) throw new HttpError(400, 'Invalid job_id');
    sets.push('job_id = ?');
    values.push(jobId);
    email.job_id = jobId;
  }

  if (sets.length) {
    const job = email.job_id
      ? await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(email.job_id).first()
      : null;
    if (email.job_id && !job) throw new HttpError(404, 'Job not found');
    await env.DB.prepare(`UPDATE emails SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id).run();
    if (job) await advance(env, job, email.category, email.id);
  }

  return json(await env.DB.prepare(`${EMAIL_SELECT} WHERE e.id = ?`).bind(id).first());
}

// ---------- ingest ----------

function parseFrom(from) {
  const s = String(from || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const name = m ? m[1].trim() : '';
  const addr = (m ? m[2] : s).trim().toLowerCase();
  const domain = addr.includes('@') ? addr.split('@').pop() : '';
  return { from_name: name || null, from_addr: addr || null, from_domain: domain || null };
}

function toIso(date) {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? now() : d.toISOString();
}

// Decides whether and how to notify. Returns null for "don't".
function notificationPlan({ category, job, platform, domain, inSpam }) {
  if (!NOTIFY_CATEGORIES.has(category)) return null;
  if (job) return { priority: category === 'offer' ? 5 : 4, prefix: '' };
  if (platform) return { priority: 3, prefix: 'Unmatched · ' };
  if (domain && !domainIn(domain, FREE_MAIL) && !inSpam) return { priority: 2, prefix: 'Check · ' };
  return null;
}

async function sendNtfy(env, { plan, category, job, email, inSpam }) {
  if (!env.NTFY_TOPIC) return false;
  const who = job
    ? [job.company, job.role].filter(Boolean).join(' – ')
    : email.from_name || email.from_domain || email.from_addr || 'unknown sender';
  const payload = {
    topic: env.NTFY_TOPIC,
    title: `${plan.prefix}${LABELS[category]}: ${who}`,
    message: (email.subject || '(no subject)') + (inSpam ? '\n(Found in your Spam folder)' : ''),
    priority: plan.priority,
    tags: [TAGS[category]],
    click: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(email.thread_id || '')}`,
  };
  if (email.link) {
    payload.actions = [{ action: 'view', label: category === 'oa' ? 'Open assessment' : 'Open scheduler', url: email.link }];
  }
  try {
    const res = await fetch(env.NTFY_URL || 'https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error('ntfy failed', err);
    return false;
  }
}

// Lets the Apps Script skip downloading messages that are already stored.
async function knownIds(env, request) {
  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].slice(0, 500);
  if (!ids.length) return json({ known: [] });
  const stmts = [];
  for (let i = 0; i < ids.length; i += 90) { // D1 allows 100 bound parameters per query
    const chunk = ids.slice(i, i + 90);
    stmts.push(env.DB.prepare(`SELECT gmail_id FROM emails WHERE gmail_id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk));
  }
  const results = await env.DB.batch(stmts);
  return json({ known: results.flatMap((r) => r.results.map((row) => row.gmail_id)) });
}

async function ingest(env, request) {
  const body = await readJson(request);
  const notify = body.notify !== false;
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && m.gmail_id)
    .map((m) => ({ ...m, received_at: toIso(m.date) }))
    .sort((a, b) => a.received_at.localeCompare(b.received_at));
  if (!messages.length) return json({ results: [], skipped: 0 });

  // Query 1: which of these have we already seen?
  const ids = messages.map((m) => String(m.gmail_id));
  const seen = new Set(
    (await env.DB.prepare(`SELECT gmail_id FROM emails WHERE gmail_id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all())
      .results.map((r) => r.gmail_id),
  );
  const fresh = [];
  for (const m of messages) {
    const id = String(m.gmail_id);
    if (seen.has(id)) continue; // already stored, or repeated within this batch
    seen.add(id);
    fresh.push(m);
  }
  if (!fresh.length) return json({ results: [], skipped: messages.length });

  // Queries 2 and 3: all jobs, and threads that already produced a notification.
  const threads = [...new Set(fresh.map((m) => m.thread_id).filter(Boolean).map(String))];
  const stmts = [env.DB.prepare('SELECT * FROM jobs')];
  if (threads.length) {
    stmts.push(env.DB.prepare(`SELECT DISTINCT thread_id FROM emails WHERE notified = 1 AND thread_id IN (${threads.map(() => '?').join(', ')})`).bind(...threads));
  }
  const [jobsRes, notifiedRes] = await env.DB.batch(stmts);
  const jobs = jobsRes.results;
  const notifiedThreads = new Set((notifiedRes?.results || []).map((r) => r.thread_id));

  const results = [];
  for (const m of fresh) {
    const from = parseFrom(m.from);
    const inSpam = !!m.in_spam;
    const { category, platform, link } = classify({
      from_domain: from.from_domain,
      subject: m.subject,
      body: m.body,
      list_unsubscribe: m.list_unsubscribe,
    });
    let job = NOISE.has(category)
      ? null
      : matchJob(jobs, { from_name: from.from_name, from_domain: from.from_domain, subject: m.subject, body: m.body });

    // An application you never saved: create the job from the email.
    let created = false;
    if (!job && !NOISE.has(category)) {
      const draft = jobFromEmail({ ...from, subject: m.subject, body: m.body, in_spam: inSpam }, category);
      if (draft) {
        job = (draft.url && jobs.find((j) => j.url === draft.url)) || null;
        if (!job) {
          job = await env.DB.prepare(
            `INSERT INTO jobs (company, role, location, url, aliases, status, notes, applied_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(url) DO UPDATE SET updated_at = jobs.updated_at
             RETURNING *`,
          ).bind(
            draft.company, draft.role, draft.location, draft.url, draft.aliases.join(',') || null, STATUS_FOR[category],
            `Added automatically from an email: "${String(m.subject || '').slice(0, 150)}"`, m.received_at, now(),
          ).first();
          created = !jobs.some((j) => j.id === job.id);
          if (created) jobs.push(job);
        }
      }
    }

    const email = { ...from, gmail_id: String(m.gmail_id), thread_id: m.thread_id ? String(m.thread_id) : null, subject: m.subject || null, link };

    // Notify before inserting so the row is written once with the right flag.
    let notified = false;
    const plan = notificationPlan({ category, job, platform, domain: from.from_domain, inSpam });
    const fresh24h = Date.now() - new Date(m.received_at).getTime() < DAY_MS;
    if (plan && notify && fresh24h && !(email.thread_id && notifiedThreads.has(email.thread_id))) {
      notified = await sendNtfy(env, { plan, category, job, email, inSpam });
      if (notified && email.thread_id) notifiedThreads.add(email.thread_id);
    }

    const row = await env.DB.prepare(
      `INSERT INTO emails (gmail_id, thread_id, from_name, from_addr, from_domain, subject, received_at, category, job_id, link, in_spam, notified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(gmail_id) DO NOTHING RETURNING id`,
    ).bind(
      email.gmail_id, email.thread_id, email.from_name, email.from_addr, email.from_domain, email.subject,
      m.received_at, category, job?.id ?? null, link, inSpam ? 1 : 0, notified ? 1 : 0,
    ).first();
    if (!row) continue; // raced with another ingest

    if (created) {
      await env.DB.prepare('INSERT INTO events (job_id, status, email_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(job.id, job.status, row.id, now()).run();
    } else if (job) {
      await advance(env, job, category, row.id);
    }

    const rescue = inSpam && ((!!job && !!STATUS_FOR[category]) || (!!platform && NOTIFY_CATEGORIES.has(category)));
    results.push({ gmail_id: email.gmail_id, thread_id: email.thread_id, category, company: job?.company ?? null, created_job: created, notified, rescue });
  }

  return json({ results, skipped: messages.length - fresh.length });
}

// ---------- router ----------

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/jobs') {
    if (method === 'GET') return listJobs(env, url);
    if (method === 'POST') return upsertJob(env, request);
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)$/);
  if (jobMatch) {
    const id = Number(jobMatch[1]);
    if (method === 'PATCH') return patchJob(env, request, id);
    if (method === 'DELETE') return deleteJob(env, id);
  }
  if (pathname === '/api/emails' && method === 'GET') return listEmails(env, url);
  const emailMatch = pathname.match(/^\/api\/emails\/(\d+)$/);
  if (emailMatch && method === 'PATCH') return patchEmail(env, request, Number(emailMatch[1]));
  if (pathname === '/api/ingest' && method === 'POST') return ingest(env, request);
  if (pathname === '/api/known' && method === 'POST') return knownIds(env, request);

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },
};
