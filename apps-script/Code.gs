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
 * Run setup() once to install the trigger. Run backfill() to import the last 45 days.
 */

var BATCH_SIZE = 10;         // keeps each Worker request well under D1's 50-query limit
var PAGE_SIZE = 100;
var POLL_MAX_MESSAGES = 300;
var BACKFILL_MAX_MESSAGES = 500;
var BACKFILL_DAYS = 45;
var OVERLAP_SECONDS = 600;   // re-read the last 10 minutes; the Worker skips duplicates
var BODY_CHARS = 6000;

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(5).create();
  props_().setProperty('LAST_TS', String(Date.now() - 60 * 60 * 1000));
  poll();
}

function poll() {
  withLock_(function () {
    var since = Number(props_().getProperty('LAST_TS')) || Date.now() - 60 * 60 * 1000;
    var newest = sync_(since, POLL_MAX_MESSAGES, true);
    // Only reached if every batch succeeded; sync_ throws otherwise so the next run retries.
    if (newest > since) props_().setProperty('LAST_TS', String(newest));
  });
}

function backfill() {
  withLock_(function () {
    sync_(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000, BACKFILL_MAX_MESSAGES, false);
  });
}

/** Fetches messages newer than `since` (ms), posts them, and returns the newest timestamp seen. */
function sync_(since, maxMessages, notify) {
  var cfg = config_();
  var after = Math.floor(since / 1000) - OVERLAP_SECONDS;
  var query = 'in:anywhere -in:trash after:' + after + ' -from:me -in:chats';
  var cutoff = after * 1000;

  var ids = [];
  var pageToken = null;
  do {
    var page = Gmail.Users.Messages.list('me', {
      q: query,
      maxResults: Math.min(PAGE_SIZE, maxMessages - ids.length),
      includeSpamTrash: true,
      pageToken: pageToken
    });
    (page.messages || []).forEach(function (m) { ids.push(m.id); });
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < maxMessages);

  var messages = [];
  var newest = since;
  ids.forEach(function (id) {
    var msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
    var labels = msg.labelIds || [];
    if (labels.indexOf('DRAFT') !== -1 || labels.indexOf('SENT') !== -1) return;
    var ts = Number(msg.internalDate);
    if (ts < cutoff) return;
    if (ts > newest) newest = Math.min(ts, Date.now());

    var headers = headerMap_(msg.payload);
    messages.push({
      gmail_id: msg.id,
      thread_id: msg.threadId,
      from: headers['from'] || '',
      subject: headers['subject'] || '',
      date: new Date(ts).toISOString(),
      body: bodyText_(msg.payload).slice(0, BODY_CHARS),
      list_unsubscribe: !!headers['list-unsubscribe'],
      in_spam: labels.indexOf('SPAM') !== -1
    });
  });

  messages.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  var sent = 0;
  var inSpam = [];
  for (var i = 0; i < messages.length; i += BATCH_SIZE) {
    var batch = messages.slice(i, i + BATCH_SIZE);
    var res = post_(cfg, { messages: batch, notify: notify });
    sent += batch.length;
    (res.results || []).forEach(function (r) {
      if (r.rescue) inSpam.push(r.company || r.category);
    });
  }

  console.log('Callback: sent %s messages', sent);
  if (inSpam.length) {
    // Read-only, so we can't move these; the dashboard and notification flag them instead.
    console.log('Callback: %s real recruiting email(s) are in Spam: %s', inSpam.length, inSpam.join(', '));
  }
  return newest;
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
  var bytes = Utilities.base64DecodeWebSafe(part.body.data);
  var type = headerMap_(part)['content-type'] || '';
  var m = type.match(/charset="?([^";\s]+)/i);
  try {
    return Utilities.newBlob(bytes).getDataAsString(m ? m[1] : 'UTF-8');
  } catch (e) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
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

function post_(cfg, payload) {
  var resp = UrlFetchApp.fetch(cfg.url + '/api/ingest', {
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

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    console.log('Callback: another run is in progress, skipping');
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function props_() {
  return PropertiesService.getScriptProperties();
}
