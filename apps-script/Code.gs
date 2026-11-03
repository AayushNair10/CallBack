/**
 * Callback Gmail sync. Runs on Google's servers every 5 minutes, reads new mail
 * (including Spam) and posts it to the Callback Worker for classification.
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
var POLL_MAX_THREADS = 300;
var BACKFILL_MAX_THREADS = 500;
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
    var newest = sync_(since, POLL_MAX_THREADS, true);
    // Only reached if every batch succeeded; sync_ throws otherwise so the next run retries.
    if (newest > since) props_().setProperty('LAST_TS', String(newest));
  });
}

function backfill() {
  withLock_(function () {
    sync_(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000, BACKFILL_MAX_THREADS, false);
  });
}

/** Fetches messages newer than `since` (ms), posts them, and returns the newest timestamp seen. */
function sync_(since, maxThreads, notify) {
  var cfg = config_();
  var me = myAddresses_();
  var after = Math.floor(since / 1000) - OVERLAP_SECONDS;
  var query = 'in:anywhere -in:trash after:' + after + ' -from:me -in:chats';
  var cutoff = after * 1000;

  var threadsById = {};
  var messages = [];
  var newest = since;

  for (var start = 0; start < maxThreads; start += PAGE_SIZE) {
    var threads = GmailApp.search(query, start, Math.min(PAGE_SIZE, maxThreads - start));
    if (!threads.length) break;

    threads.forEach(function (thread) {
      var threadId = thread.getId();
      var inSpam = thread.isInSpam();
      threadsById[threadId] = thread;

      thread.getMessages().forEach(function (msg) {
        if (msg.isDraft()) return;
        var ts = msg.getDate().getTime();
        if (ts < cutoff) return;
        if (ts > newest) newest = Math.min(ts, Date.now()); // ignore future-dated headers
        var from = msg.getFrom();
        if (me[addressOf_(from)]) return;

        messages.push({
          gmail_id: msg.getId(),
          thread_id: threadId,
          from: from,
          subject: msg.getSubject() || '',
          date: msg.getDate().toISOString(),
          body: (msg.getPlainBody() || '').slice(0, BODY_CHARS),
          list_unsubscribe: !!msg.getHeader('List-Unsubscribe'),
          in_spam: inSpam
        });
      });
    });

    if (threads.length < PAGE_SIZE) break;
  }

  messages.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  var sent = 0;
  var rescued = 0;
  for (var i = 0; i < messages.length; i += BATCH_SIZE) {
    var batch = messages.slice(i, i + BATCH_SIZE);
    var res = post_(cfg, { messages: batch, notify: notify });
    sent += batch.length;
    (res.results || []).forEach(function (r) {
      if (!r.rescue) return;
      var thread = threadsById[r.thread_id] || GmailApp.getThreadById(r.thread_id);
      if (thread && thread.isInSpam()) {
        thread.moveToInbox();
        rescued++;
      }
    });
  }

  console.log('Callback: sent %s messages, rescued %s threads from spam', sent, rescued);
  return newest;
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

function myAddresses_() {
  var set = {};
  [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases()).forEach(function (a) {
    if (a) set[String(a).toLowerCase()] = true;
  });
  return set;
}

function addressOf_(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
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
