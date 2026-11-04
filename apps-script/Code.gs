/**
 * Callback Gmail sync. Runs on Google's servers every 5 minutes, reads new mail
 * (including Spam) and posts it to the Callback Worker for classification.
 *
 * READ-ONLY: uses the Gmail API advanced service with the gmail.readonly scope
 * (pinned in appsscript.json). It can't send, delete, label or move mail.
 *
 * Script properties (Project Settings -> Script properties):
 *   WORKER_URL  e.g. https://callback.<you>.workers.dev
 *   API_TOKEN   the same token you set with `wrangler secret put API_TOKEN`
 *   LAST_TS     managed by the script (milliseconds since epoch)
 *
 * Run setup() once to install the trigger. Run backfill() once to import the last 45 days;
 * it keeps scheduling itself until it's done.
 */

var BATCH_SIZE = 10;            // keeps each Worker request well under D1's 50-query limit
var PAGE_SIZE = 100;
var POLL_MAX_MESSAGES = 2000;   // listing is cheap; only new messages are downloaded
var BACKFILL_MAX_MESSAGES = 5000;
var BACKFILL_DAYS = 45;
var OVERLAP_SECONDS = 600;      // re-read the last 10 minutes; already-stored messages are skipped
var BODY_CHARS = 6000;
var MAX_RUN_MS = 4.5 * 60 * 1000; // stop well before Apps Script's 6-minute limit
var GET_PAUSE_MS = 100;         // paces downloads far below Gmail's per-user rate limit

function setup() {
  deleteTriggers_('poll');
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(5).create();
  props_().setProperty('LAST_TS', String(Date.now() - 60 * 60 * 1000));
  poll();
}

function poll() {
  withLock_(function () {
    var started = Date.now();
    var since = Number(props_().getProperty('LAST_TS')) || started - 60 * 60 * 1000;
    var done = sync_(since, POLL_MAX_MESSAGES, true);
    // Only move the cursor once everything in the window is stored. If this run stopped
    // early, the next one lists the same window and skips what's already done.
    if (done) props_().setProperty('LAST_TS', String(started));
  });
}

/**
 * Imports the last 45 days without notifications, oldest first. Each run stops before the
 * 6-minute limit and schedules the next one, until everything is imported.
 */
function backfill() {
  deleteTriggers_('backfill');
  var done = false;
  var ran = withLock_(function () {
    done = sync_(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000, BACKFILL_MAX_MESSAGES, false);
  });
  if (ran && done) {
    console.log('Callback: backfill complete');
    return;
  }
  ScriptApp.newTrigger('backfill').timeBased().after(60 * 1000).create();
  console.log(ran ? 'Callback: backfill paused at the time limit; it continues by itself in about a minute'
    : 'Callback: busy with a sync; backfill retries in about a minute');
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

/**
 * Sends every message newer than `since` (ms) that the Worker doesn't have yet, oldest first.
 * Returns true if the whole window was processed, false if it stopped early.
 */
function sync_(since, maxMessages, notify) {
  var started = Date.now();
  var cfg = config_();
  var after = Math.floor(since / 1000) - OVERLAP_SECONDS;
  var query = 'in:anywhere -in:trash after:' + after + ' -from:me -in:chats';

  var ids = [];
  var pageToken = null;
  do {
    var page = withRetry_(function () {
      return Gmail.Users.Messages.list('me', {
        q: query,
        maxResults: Math.min(PAGE_SIZE, maxMessages - ids.length),
        includeSpamTrash: true,
        pageToken: pageToken
      });
    });
    (page.messages || []).forEach(function (m) { ids.push(m.id); });
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < maxMessages);
  var listedAll = !pageToken;
  if (!listedAll) console.log('Callback: more than %s messages in this window; processing the newest %s', maxMessages, ids.length);

  ids.reverse(); // Gmail lists newest first; process oldest first
  var known = knownIds_(cfg, ids);
  var todo = ids.filter(function (id) { return !known[id]; });

  var pending = [];
  var stats = { sent: 0, inSpam: [] };
  var finished = true;
  for (var i = 0; i < todo.length; i++) {
    if (Date.now() - started > MAX_RUN_MS) {
      finished = false;
      break;
    }
    var msg = fetchMessage_(todo[i]);
    if (msg) pending.push(msg);
    if (pending.length === BATCH_SIZE) {
      flush_(cfg, pending, notify, stats);
      pending = [];
    }
  }
  if (pending.length) flush_(cfg, pending, notify, stats);

  console.log('Callback: %s new of %s listed, sent %s%s', todo.length, ids.length, stats.sent,
    finished ? '' : ' (stopped early to stay under the time limit; the next run continues)');
  if (stats.inSpam.length) {
    // Read-only, so we can't move these; the dashboard and notification flag them instead.
    console.log('Callback: %s real recruiting email(s) are in Spam: %s', stats.inSpam.length, stats.inSpam.join(', '));
  }
  return finished && listedAll;
}

function fetchMessage_(id) {
  var msg = withRetry_(function () { return Gmail.Users.Messages.get('me', id, { format: 'full' }); });
  Utilities.sleep(GET_PAUSE_MS);
  var labels = msg.labelIds || [];
  if (labels.indexOf('DRAFT') !== -1 || labels.indexOf('SENT') !== -1) return null;

  var ts = Number(msg.internalDate);
  var headers = headerMap_(msg.payload);
  return {
    gmail_id: msg.id,
    thread_id: msg.threadId,
    from: headers['from'] || '',
    subject: headers['subject'] || '',
    date: new Date(ts).toISOString(),
    body: bodyText_(msg.payload).slice(0, BODY_CHARS),
    list_unsubscribe: !!headers['list-unsubscribe'],
    in_spam: labels.indexOf('SPAM') !== -1
  };
}

function flush_(cfg, messages, notify, stats) {
  messages.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var res = post_(cfg, '/api/ingest', { messages: messages, notify: notify });
  stats.sent += messages.length;
  (res.results || []).forEach(function (r) {
    if (r.rescue) stats.inSpam.push(r.company || r.category);
  });
}

/** Asks the Worker which of these Gmail ids it already stored. */
function knownIds_(cfg, ids) {
  var known = {};
  for (var i = 0; i < ids.length; i += 500) {
    var res = post_(cfg, '/api/known', { ids: ids.slice(i, i + 500) });
    (res.known || []).forEach(function (id) { known[id] = true; });
  }
  return known;
}

/** Retries Gmail calls that hit rate or quota limits, backing off up to ~1 minute in total. */
function withRetry_(fn) {
  var waits = [2000, 4000, 8000, 16000, 30000];
  for (var attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      var retryable = /quota|rate ?limit|too many|429|backend error|503|internal error/i.test(String(e && e.message));
      if (!retryable || attempt >= waits.length) throw e;
      console.log('Callback: Gmail limit hit, waiting %ss (%s)', waits[attempt] / 1000, String(e.message).slice(0, 120));
      Utilities.sleep(waits[attempt]);
    }
  }
}

function headerMap_(payload) {
  var map = {};
  ((payload && payload.headers) || []).forEach(function (h) {
    var key = String(h.name).toLowerCase();
    if (!(key in map)) map[key] = h.value;
  });
  return map;
}

/** Plain-text body: the text/plain part if there is one, otherwise the HTML with tags stripped. */
function bodyText_(payload) {
  var plain = findPart_(payload, 'text/plain');
  if (plain) return decodePart_(plain);
  var html = findPart_(payload, 'text/html');
  return html ? htmlToText_(decodePart_(html)) : '';
}

function findPart_(part, mimeType) {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body && part.body.data) return part;
  var parts = part.parts || [];
  for (var i = 0; i < parts.length; i++) {
    var found = findPart_(parts[i], mimeType);
    if (found) return found;
  }
  return null;
}

function decodePart_(part) {
  var bytes = partBytes_(part.body.data);
  if (!bytes) return '';
  var type = headerMap_(part)['content-type'] || '';
  var m = type.match(/charset="?([^";\s]+)/i);
  try {
    return Utilities.newBlob(bytes).getDataAsString(m ? m[1] : 'UTF-8');
  } catch (e) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
}

// The advanced service usually returns body data as an already-decoded byte array;
// the raw REST API returns unpadded base64url. Handle both, and skip what can't be read.
function partBytes_(data) {
  if (data && typeof data !== 'string') return data;
  try {
    var b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return Utilities.base64Decode(b64);
  } catch (e) {
    console.log('Callback: could not decode a message body (%s)', e.message);
    return null;
  }
}

function htmlToText_(html) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi, ' $1 ') // keep link URLs (OA/scheduling links)
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ');
}

function post_(cfg, path, payload) {
  var resp = UrlFetchApp.fetch(cfg.url + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('Worker returned ' + code + ': ' + resp.getContentText().slice(0, 500));
  }
  return JSON.parse(resp.getContentText());
}

function config_() {
  var p = props_();
  var url = (p.getProperty('WORKER_URL') || '').replace(/\/+$/, '');
  var token = p.getProperty('API_TOKEN') || '';
  if (!url || !token) throw new Error('Set WORKER_URL and API_TOKEN in Project Settings -> Script properties.');
  return { url: url, token: token };
}

/** Runs fn while holding the script lock. Returns false if another run holds it. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    console.log('Callback: another run is in progress, skipping');
    return false;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
  return true;
}

function props_() {
  return PropertiesService.getScriptProperties();
}
