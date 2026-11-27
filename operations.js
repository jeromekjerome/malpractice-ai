// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// Knowing when things fail. Failures used to leave only console output, which the host keeps for an hour: nobody
// was told when the chat, the database or the contact form failed, and the nightly job stopped at its first failing
// step. Now each chat message is recorded with its outcome; a run of failures, a database that cannot be read and a
// contact request that fails email the operator at once; /health/deep answers an uptime monitor; and the nightly job
// runs every step, records the run and emails a summary of the day.

import { neon } from '@neondatabase/serverless';
import { notifyOperator } from './auction.js';
import { APP_URL } from './site.js';
import { withoutKeys, providerOfModel } from './providers.js';
import { chains, unmeasuredOverride } from './model-settings.js';
import { DEFAULTS } from './models.js';
import { SITE_NAME, CURRENT_LAW_FILE } from './gate-config.js';
import { readLawFile } from './law-file.js';
import { statuteWatchSummary } from './statute-watch.js';
import { libraryCounts } from './case-library.js';
import { usageToday, readAllowance } from './courtlistener-usage.js';
import { LIBRARY_TIMEOUT_MS, SCREEN_TIMEOUT_MS } from './courtlistener.js';
import { CASE_TOPICS } from './case-topics.js';

const sql = neon(process.env.DATABASE_URL);
const SITE = SITE_NAME;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeLimit(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${ms / 1000} seconds`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The same problem is emailed at most once per window on each server instance, so a failing database sends one
// email, not one per visitor. Never throws.
const lastAlerts = new Map();
export async function alertOperatorOnce(key, windowMs, subject, html) {
  const now = Date.now();
  if (now - (lastAlerts.get(key) || 0) < windowMs) return false;
  lastAlerts.set(key, now);
  await notifyOperator(subject, html).catch(err => console.error('Operator alert failed:', err.message));
  return true;
}

// One row per chat message, whatever happened: 'ok', 'slow' (no reply in time) or 'error'. A row used to be written
// only after a reply that worked, so failures left no trace. Never throws.
export async function recordInteraction({ sessionId, question, mode, caseType, outcome, latencyMs, gateStatus = null }) {
  try {
    await sql`
      INSERT INTO user_interactions (session_id, question, mode, case_type, outcome, latency_ms, gate_status)
      VALUES (${sessionId}, ${question}, ${mode}, ${caseType || 'other'}, ${outcome}, ${Math.round(latencyMs)}, ${gateStatus})`;
  } catch (err) {
    console.warn('DB log failed:', err.message);
    return;
  }
  if (outcome !== 'ok') await checkFailureBurst().catch(err => console.warn('The failure check failed:', err.message));
}

// Three of the last ten messages in 15 minutes failed or ran out of time: the operator is told at once.
async function checkFailureBurst() {
  const [recent] = await sql`
    SELECT count(*) FILTER (WHERE outcome IN ('error', 'slow'))::int AS failed, count(*)::int AS total
    FROM (SELECT outcome FROM user_interactions WHERE created_at > NOW() - INTERVAL '15 minutes' ORDER BY created_at DESC LIMIT 10) AS last_ten`;
  if ((recent?.failed || 0) < 3) return;
  await alertOperatorOnce('chat-failures', 30 * MINUTE, `${SITE}: the chat is failing (${recent.failed} of the last ${recent.total} messages)`,
    `<p>${recent.failed} of the last ${recent.total} chat messages on ${SITE} failed or ran out of time in the past 15 minutes. ` +
    `Each visitor was asked to send the message again.</p><p>Check the host's logs and ${escapeHtml(APP_URL)}/health/deep. ` +
    'You will not be emailed about this again for 30 minutes.</p>');
}

// An AI provider refused a request the app sent it (HTTP 400), which is almost always how the app shapes its
// requests for that provider, and no failure on the provider's side. providers.js gives this the provider's own
// message with any key taken out, and nothing of the request, so nothing a visitor wrote can be in the email. One
// email an hour for each provider.
const BAD_REQUEST_MESSAGE_CHARS = 300;
export async function tellOwnerOfBadRequest({ provider, model, job, status, code, message }) {
  const where = escapeHtml(provider);
  const row = (label, value) => `<tr><td style="color:#666;padding:4px 12px 4px 0">${label}</td><td>${escapeHtml(value)}</td></tr>`;
  return alertOperatorOnce(`ai-bad-request-${provider}`, HOUR, `${SITE}: ${provider} refused a request the app sent it`,
    `<p>${where} refused a request the app sent it, as malformed (HTTP ${escapeHtml(status ?? 400)}). If another model in the chain answered, the visitor was served by it; if every model refused, ` +
    'the visitor\'s message was not answered. The likely cause is how the app shapes its requests for this provider.</p>' +
    `<table>${row('Provider', provider)}${row('Model', model)}${row('Job', job)}${row('Status', status ?? 400)}${code ? row('Error code', code) : ''}` +
    `${row('Provider\'s message', withoutKeys(message).slice(0, BAD_REQUEST_MESSAGE_CHARS))}</table>` +
    `<p>You will not be emailed about ${where} again for an hour.</p>`);
}

// A provider marked down, or back up (provider-state.js). The state sends each once: only the server instance whose
// database update marked it down, or cleared it, tells the owner. The note carries the provider, the reason runJob
// gave the failure that marked it down (never what the provider said) and since when, so nothing a visitor wrote and
// no key can be in the email.
const DOWN_BECAUSE = {
  timeout: 'it did not answer in time',
  connection: 'the app could not connect to it',
  rate_limit: 'it turned requests away as too many (HTTP 408 or 429)',
  server: 'it answered with server errors (HTTP 5xx)',
  auth: "it refused the app's key (HTTP 401 or 403)",
  quota: "the account's quota is spent",
  bad_request: "it refused the app's requests as malformed (HTTP 400)",
};
const because = reason => escapeHtml(DOWN_BECAUSE[reason] ?? `it failed (${reason ?? 'no reason given'})`);

const NEW_YORK_TIME = { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' };
const newYorkTime = value => (Number.isNaN(Date.parse(value)) ? 'an unknown time' : `${new Date(value).toLocaleString('en-US', NEW_YORK_TIME)} New York time`);

function lasting(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` and ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

// What the app does while the provider is marked down: a provider marked down is asked after every other provider
// of a chain (providers.js), so a chain with no other provider keeps asking it. The chains are the ones in use
// (model-settings.js): the reply's, and the small jobs'.
async function meanwhile(provider) {
  const name = escapeHtml(provider);
  const { answer, small } = await chains();
  const inUse = [['reply', answer], ['small-job', small]];
  const alone = inUse.filter(([, chain]) => chain.every(model => providerOfModel(model) === provider)).map(([label]) => label);
  if (!alone.length) return `The app is answering from the next provider in each chain. It asks ${name} only after the others, and lets one request through to ${name} in its usual place five minutes after it was marked down, and every five minutes after that.`;
  if (alone.length === inUse.length) return `No chain has another provider, so the app keeps trying ${name}: replies may be slow, and visitors may be asked to send their message again, until it answers.`;
  return `The ${alone[0]} chain has no other provider, so the app keeps trying ${name} for it; the other chain is answering from its next provider.`;
}

async function tellOwnerProviderIsDown({ provider, reason, since }) {
  await notifyOperator(`${SITE}: ${provider} is marked down`,
    `<p>${escapeHtml(provider)} was marked down at ${newYorkTime(since)}, because ${because(reason)}.</p>` +
    `<p>${await meanwhile(provider)}</p>` +
    '<p>It stays marked down for at least five minutes; you will be emailed once it answers after that.</p>').catch(err => console.error('Operator alert failed:', err.message));
  return true;
}

async function tellOwnerProviderIsUp({ provider, reason, since }) {
  await notifyOperator(`${SITE}: ${provider} is answering again`,
    `<p>${escapeHtml(provider)} answered again, and is no longer marked down. It was marked down for ${lasting(Date.now() - Date.parse(since))}, ` +
    `since ${newYorkTime(since)}, because ${because(reason)}.</p>`).catch(err => console.error('Operator alert failed:', err.message));
  return true;
}

// What providers.js and provider-state.js tell the owner, which server.js sets up once for both: a request a
// provider refused (kind 'bad_request'), a provider marked down ('down') and one back up ('up').
const TELLINGS = { bad_request: tellOwnerOfBadRequest, down: tellOwnerProviderIsDown, up: tellOwnerProviderIsUp };
export async function tellOwnerOfProviders(note) {
  const telling = TELLINGS[note?.kind];
  return telling ? telling(note) : false;
}

// The model chains saved in the settings name a model the registry no longer has, so every job runs on the built-in
// chains (model-settings.js). The settings tell this at each read of the row, once a minute at most; the owner is
// emailed once a day for each server instance.
export async function tellOwnerOfModelChains({ models = [] } = {}) {
  const named = models.map(escapeHtml).join(', ') || 'a model';
  return alertOperatorOnce('model-chains-unknown', DAY, `${SITE}: the saved model chains name a model the app does not know`,
    `<p>The model chains saved in the settings name ${named}, which the app's registry of models does not have. ` +
    `Until they are saved again, every job runs on the built-in chains (models.js): replies ${DEFAULTS.answer.map(escapeHtml).join(', ')}; ` +
    `small jobs ${DEFAULTS.small.map(escapeHtml).join(', ')}.</p>` +
    '<p>Save the chains again from the admin page. You will not be emailed about this again for a day.</p>');
}

// The daily summary's line on the override (model-settings.js): the models it let in that have no measurement on
// record for the place they hold, who saved the chains so and when. Repeated each day until each has one.
const PLACES = { answer: 'a reply model', small: 'a small-job model' };
function overrideLine({ overriddenBy, overriddenOn, models }) {
  const named = models.map(({ model, role }) => `${escapeHtml(model)} as ${PLACES[role]}`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  return `<p>The model chains were saved under the override (by ${escapeHtml(overriddenBy)}, ${newYorkTime(overriddenOn)}) with ${list}, ` +
    `which ${models.length > 1 ? 'have' : 'has'} no measurement on record. This is repeated in each daily summary until ${models.length > 1 ? 'each has' : 'it has'} one.</p>`;
}

// The daily summary's line on the day's replies, by the model that wrote them (ai_usage: each reply job that came back
// through the caps), and a plain word when any was written by a model other than the first of the reply chain in
// force. No email tells of that: a provider is marked down only when it answers nothing in a reply, so while another
// of its jobs answers, its main reply model can fail every time and Claude write every reply. A query of its own, so
// that when it fails the summary goes out without this line alone.
async function repliesByModel() {
  try {
    const [rows, { answer }] = await Promise.all([
      sql`
        SELECT model, count(*)::int AS replies FROM ai_usage
        WHERE created_at > NOW() - INTERVAL '24 hours' AND operation = 'reply' AND status = 'ok'
        GROUP BY model ORDER BY replies DESC, model`,
      chains(),
    ]);
    return { rows: rows.map(row => ({ model: String(row.model), replies: Number(row.replies) || 0 })), first: answer[0] };
  } catch (err) {
    console.error('[digest] The replies by model could not be read, so the summary goes without them:', withoutKeys(err?.message ?? err));
    return null;
  }
}

// The daily summary's part on the statute watch (statute-watch.js): when it last ran, what differs, what could not be read, and
// the sources due for a review by hand. A null lastRun means the job log holds no run of it, and nothing else. Never fails: what
// cannot be read leaves the section out, and the rest of the summary goes as it was.
async function statuteWatchSection() {
  try {
    const [last] = await sql`SELECT ran_at, ok FROM job_runs WHERE job = 'statute-watch' ORDER BY ran_at DESC LIMIT 1`;
    const lastRun = last ? { ranAt: last.ran_at, ok: last.ok } : null;
    return await statuteWatchSummary({ sqlClient: sql, law: readLawFile(CURRENT_LAW_FILE), today: new Date(), lastRun });
  } catch (err) {
    console.error('[digest] The statute watch could not be read, so the summary goes without it:', withoutKeys(err?.message ?? err));
    return '';
  }
}

// The daily summary's part on the case library (case-library.js): per case type the clear, unscreened and held decisions, the
// types with too few clear ones to be offered to a reply, the previous New York day's CourtListener requests by job and the
// replies given from the library and live (counted under the jobs below; the day is the New York day of 24 hours before the
// summary is made), and what the token has left today. This app has no pinned decisions, so the section has no line for them.
// Never fails: what cannot be read says so, and the rest of the summary goes as it was.
const MIN_CLEAR_DECISIONS = 5;
const REPLIES_FROM_LIBRARY = 'replies-library';
const REPLIES_LIVE = 'replies-live';
const ALLOWANCE_READ_MS = 5000;

// The last run of the library refresh, for the daily summary: its time and the topics it searched, set aside with no answer and
// tried twice. The refresh runs in its own function hours before the summary, so the library route keeps it in app_settings
// under this key (setup-db.js), written over each night. Only a run that ended well writes it.
export const LIBRARY_LAST_RUN_KEY = 'library_last_run';
const LAST_NIGHT_MS = 20 * HOUR;

export async function recordLibraryRun(result, at = new Date()) {
  const ids = list => (Array.isArray(list) ? list.map(String) : []);
  const value = { at: new Date(at).toISOString(), searched: ids(result?.searched), noAnswer: ids(result?.noAnswer), retried: ids(result?.retried) };
  await sql`
    INSERT INTO app_settings (key, value, updated_at) VALUES (${LIBRARY_LAST_RUN_KEY}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
}

// The topics last night's refresh set aside with no answer: [] when there were none, and null when the row is missing,
// unreadable or older than last night, so that the summary leaves the line out.
async function setAsideLastNight() {
  try {
    const [row] = await sql`SELECT value FROM app_settings WHERE key = ${LIBRARY_LAST_RUN_KEY}`;
    const value = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value;
    const at = Date.parse(value?.at);
    if (!Number.isFinite(at) || Date.now() - at > LAST_NIGHT_MS || !Array.isArray(value.noAnswer)) return null;
    return value.noAnswer.map(String);
  } catch (err) {
    console.error('[digest] The last library run could not be read, so the summary goes without its topics set aside:', withoutKeys(err?.message ?? err));
    return null;
  }
}

async function caseLibrarySection() {
  try {
    const [counts, usage, setAside] = await Promise.all([libraryCounts(sql), usageToday(sql, new Date(Date.now() - 24 * 60 * 60 * 1000)), setAsideLastNight()]);
    const token = process.env.COURTLISTENER_TOKEN;
    const allowance = token ? await timeLimit(readAllowance({ token }), ALLOWANCE_READ_MS, 'The usage report').catch(() => null) : null;
    const types = Object.keys(CASE_TOPICS);
    const of = type => counts.byType[type] || { clear: 0, unscreened: 0, held: 0 };
    const hasAny = type => of(type).clear + of(type).unscreened + of(type).held > 0;
    const few = types.filter(type => of(type).clear < MIN_CLEAR_DECISIONS);
    const isReply = row => row.job.startsWith('replies-');
    const requests = usage.filter(row => !isReply(row));
    const repliesOf = job => usage.find(row => row.job === job)?.requests ?? 0;
    const none = types.filter(type => !hasAny(type));
    return `${types.some(hasAny) ? `<ul>${types.filter(hasAny).map(type => `<li>${escapeHtml(type)}: ${of(type).clear} clear, ${of(type).unscreened} unscreened, ${of(type).held} held</li>`).join('')}</ul>` : ''}` +
      `${none.length ? `<p>No decisions yet (or only banned ones): ${none.map(escapeHtml).join(', ')}.</p>` : ''}` +
      `<p>Held for your decision: ${counts.held}.${counts.held > 0 ? ` Clear or ban them on the <a href="${escapeHtml(APP_URL)}/admin.html">admin page</a>.` : ''}</p>` +
      `<p>Types with fewer than ${MIN_CLEAR_DECISIONS} clear decisions: ${few.length ? few.map(escapeHtml).join(', ') : 'none'}.</p>` +
      `<p>CourtListener requests yesterday (New York day): ${requests.length ? requests.map(row => `${escapeHtml(row.job)} ${row.requests}`).join(', ') : 'none'}.</p>` +
      `${setAside?.length ? `<p>Topics set aside last night with no answer from CourtListener: ${listed(setAside.map(escapeHtml))}. They keep their place in line, ahead of the topics searched since.</p>` : ''}` +
      `<p>Replies yesterday: ${repliesOf(REPLIES_FROM_LIBRARY)} from the library, ${repliesOf(REPLIES_LIVE)} live.</p>` +
      `<p>${allowance ? `CourtListener allowance left: ${allowance.day} today, ${allowance.hour} this hour.` : 'The CourtListener allowance left could not be read.'}</p>`;
  } catch (err) {
    console.error('[digest] The case library could not be read, so the summary says so:', withoutKeys(err?.message ?? err));
    return '<p>The case library could not be read for this summary.</p>';
  }
}

function repliesLine({ rows, first }) {
  const counted = list => list.map(row => `${escapeHtml(row.model)} ${row.replies}`).join(', ');
  if (!rows.length) return '<p>Replies by the model that wrote them: none.</p>';
  const others = rows.filter(row => row.model !== first);
  const total = rows.reduce((sum, row) => sum + row.replies, 0);
  const byOthers = others.reduce((sum, row) => sum + row.replies, 0);
  return `<p>Replies by the model that wrote them: ${counted(rows)}.</p>` +
    (others.length ? `<p><strong>${byOthers} of the ${total} replies were written by a model other than ${escapeHtml(first)}, the first of the reply chain</strong>: ${counted(others)}.</p>` : '');
}

// ─── /health/deep ─────────────────────────────────────────────────────────────
// The newest columns the code needs: a deploy whose database changes were not made fails the check. The provider state
// (provider-state.js) and the model settings (model-settings.js) work without their tables, on every provider up and
// the built-in chains, so only this check shows that npm run setup-db was not run.
const REQUIRED_COLUMNS = ['firms.card_declined_at', 'leads.decline_reason', 'user_interactions.outcome', 'job_runs.ran_at', 'ai_usage.created_at', 'auctions.reminder_sent_at',
  'ai_provider_state.failed_replies', 'app_settings.value', 'model_measurements.bar_ok', 'provider_model_lists.models',
  'statute_watch.unread_emailed_at', 'unconfirmed_charges.firm_id', 'courtlistener_usage.requests',
  'case_library.screen_tried_at', 'library_topics.last_found'];
let deepHealthCache = { at: 0, value: null };

// For an uptime monitor: is the database reachable, does it have the columns the code uses, and did the nightly job
// run and succeed in the last 26 hours? Computed at most every 30 seconds per instance. Details go to the log.
export async function deepHealth() {
  const cacheMs = Number(process.env.HEALTH_DEEP_CACHE_MS ?? 30_000);
  if (deepHealthCache.value && Date.now() - deepHealthCache.at < cacheMs) return deepHealthCache.value;
  const checks = { database: 'down', schema: 'unknown', nightlyJob: 'unknown', statuteWatch: 'unknown', statuteWatchLastOk: null, library: 'unknown', screen: 'unknown' };
  try {
    await timeLimit(sql`SELECT 1`, 3000, 'The database');
    checks.database = 'ok';
    const tables = [...new Set(REQUIRED_COLUMNS.map(column => column.split('.')[0]))];
    const rows = await timeLimit(sql`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY(${tables})`, 3000, 'The schema check');
    const present = new Set(rows.map(row => row.col));
    const missing = REQUIRED_COLUMNS.filter(column => !present.has(column));
    checks.schema = missing.length ? 'missing columns' : 'ok';
    if (missing.length) console.error('[health] the database is missing columns the code uses:', missing.join(', '));
    if (present.has('job_runs.ran_at')) {
      const [job] = await timeLimit(sql`
        SELECT (SELECT ok FROM job_runs WHERE job = 'nightly' ORDER BY ran_at DESC LIMIT 1) AS last_ok,
               (SELECT max(ran_at) FROM job_runs WHERE job = 'nightly') AS last_run`, 3000, 'The job check');
      checks.nightlyJob = !job?.last_run ? 'not run yet'
        : Date.now() - new Date(job.last_run).getTime() > 26 * HOUR ? 'late'
          : job.last_ok ? 'ok' : 'failed';
      // The nightly read of the watched statutes (statute-watch.js), judged the same way. Not run yet is healthy: the
      // demo has no scheduled job.
      const [watch] = await timeLimit(sql`
        SELECT (SELECT ok FROM job_runs WHERE job = 'statute-watch' ORDER BY ran_at DESC LIMIT 1) AS last_ok,
               (SELECT max(ran_at) FROM job_runs WHERE job = 'statute-watch') AS last_run,
               (SELECT max(ran_at) FROM job_runs WHERE job = 'statute-watch' AND ok) AS last_ok_at`, 3000, 'The statute watch check');
      checks.statuteWatch = !watch?.last_run ? 'not run yet'
        : Date.now() - new Date(watch.last_run).getTime() > 26 * HOUR ? 'late'
          : watch.last_ok ? 'ok' : 'failed';
      checks.statuteWatchLastOk = watch?.last_ok_at ? new Date(watch.last_ok_at).toISOString() : null;
      // The case library's nightly refresh and its screening, judged the same way.
      const judged = job => (!job?.last_run ? 'not run yet'
        : Date.now() - new Date(job.last_run).getTime() > 26 * HOUR ? 'late'
          : job.last_ok ? 'ok' : 'failed');
      const [library] = await timeLimit(sql`
        SELECT (SELECT ok FROM job_runs WHERE job = 'library' ORDER BY ran_at DESC LIMIT 1) AS last_ok,
               (SELECT max(ran_at) FROM job_runs WHERE job = 'library') AS last_run`, 3000, 'The case library check');
      checks.library = judged(library);
      const [screen] = await timeLimit(sql`
        SELECT (SELECT ok FROM job_runs WHERE job = 'screen' ORDER BY ran_at DESC LIMIT 1) AS last_ok,
               (SELECT max(ran_at) FROM job_runs WHERE job = 'screen') AS last_run`, 3000, 'The screening check');
      checks.screen = judged(screen);
    }
  } catch (err) {
    console.error('[health] deep check failed:', err.message);
  }
  const ok = checks.database === 'ok' && checks.schema === 'ok' && ['ok', 'not run yet'].includes(checks.nightlyJob)
    && ['ok', 'not run yet'].includes(checks.statuteWatch) && ['ok', 'not run yet'].includes(checks.library) && ['ok', 'not run yet'].includes(checks.screen);
  deepHealthCache = { at: Date.now(), value: { ok, ...checks } };
  return deepHealthCache.value;
}

// ─── The nightly job ──────────────────────────────────────────────────────────
// Each step runs whatever happened to the ones before it: the first failure used to stop every later step, the
// privacy deletions included. Returns each step's result and the steps that failed.
export async function runSteps(steps) {
  const results = {};
  const failed = [];
  for (const [name, work] of steps) {
    try {
      results[name] = await work();
    } catch (err) {
      console.error(`[nightly] ${name} failed:`, err);
      failed.push({ step: name, error: err?.message || String(err) });
    }
  }
  return { results, failed };
}

// The run is kept for 90 days; /health/deep reads the latest. The failed steps go to the operator.
export async function recordJobRun(job, failed) {
  await sql`INSERT INTO job_runs (job, ok, failed_steps) VALUES (${job}, ${failed.length === 0}, ${failed.length ? JSON.stringify(failed) : null})`;
  await sql`DELETE FROM job_runs WHERE ran_at < NOW() - INTERVAL '90 days'`;
}

// ─── The email about a failed job ─────────────────────────────────────────────
// Written for an owner who is not an engineer: what happened in plain words, whether visitors are affected, whether anything
// needs doing, and when the job runs again. The host keeps about an hour of logs, so the email points to /health/deep, and
// the error as the app gave it goes on the last line, keys withheld, for whoever debugs it.

// Each job's own lines. A nightly step says for itself what its failure means (NIGHTLY_STEPS), and a failure CourtListener
// caused says what it means for visitors (courtListenerVisitors).
const JOBS = {
  'case library': {
    opening: "The case library's nightly refresh failed.",
    visitors: 'Visitors are not affected. Replies keep using the decisions the library already holds, and a case type with fewer than 5 cleared decisions is searched on CourtListener live, as before.',
    again: 'The refresh runs again tomorrow night; the topics it did not search keep their place in line.',
  },
  screen: {
    opening: 'The nightly screen of the case library failed.',
    visitors: 'Visitors are not affected. A decision the screen has not cleared is never offered to replies from the library; replies keep using the decisions already cleared, or search CourtListener live.',
    again: 'The screen runs twice a night, an hour apart, and tries again at its next run.',
  },
  'statute watch': {
    opening: 'The nightly statute watch failed.',
    visitors: 'Visitors are not affected: nothing a visitor reads changes until you approve it. Until the watch runs again, though, a change to a watched statute goes unnoticed.',
    again: 'The watch runs again tomorrow night.',
  },
  nightly: { again: 'The nightly job runs again tomorrow night.' },
};

// What to do when the cause is not known: the error at the end of the email may say.
const FALLBACK_TODO = 'The error below says what went wrong; if it names something to do, do it. If not, and it fails again tomorrow night, it needs a look.';
const PRIVACY_TODO = 'The error below says what went wrong; if it names something to do, do it. If not, and it fails again tomorrow night, it needs a look: the privacy policy promises the deletion.';

// What the failure of each step of the nightly job (server.js) means, and what to do when it is not the usual.
const NIGHTLY_STEPS = {
  'delete old conversations': {
    means: 'Visitors are not affected, but conversations older than 90 days are kept until the step runs well, longer than the privacy policy says.',
    todo: PRIVACY_TODO,
  },
  'delete old lead records': {
    means: 'Visitors are not affected, but lead records older than 3 years are kept until the step runs well, longer than the privacy policy says.',
    todo: PRIVACY_TODO,
  },
  'back up business records offsite': {
    means: "Visitors are not affected. Tonight's encrypted copy of the firms, leads, auctions and bids was not made offsite; the last copy made stays.",
  },
  // An auction past its time is also closed by a visitor's chat message and by a firm opening its auction or its portal
  // (sweepExpiredAuctions in server.js).
  'close expired auctions': {
    means: 'An auction past its closing time stays open until a visitor next sends a chat message or a firm opens its auction or portal page, which closes it, or until tomorrow night, so its winning firm may wait for the lead.',
  },
  'report stuck auctions': {
    means: 'Visitors are not affected. You were not told tonight about any auction stuck while closing (a charge Stripe did not confirm, or a win not recorded).',
  },
  'decline overdue leads': {
    means: 'A lead a firm has not answered within 3 days stays with that firm until the step runs, instead of being offered to other firms, so its client waits longer to hear from a firm.',
  },
  // Refunds and suspensions count a firm's declines from its leads (recentDeclineCounts in firms.js), not the stored counts.
  'recount declines': {
    means: "Visitors and firms are not affected: refunds and suspensions count a firm's declines from its leads; this step only tidies the stored counts.",
  },
  'watch the model lists of the providers': {
    means: "Visitors are not affected. Tonight's look at the AI providers' lists of models did not finish; a retirement reminder due tonight, if any, was not sent.",
  },
};

const seconds = ms => `${Math.round(ms / 1000)} seconds`;
const listed = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const ALL_TOPICS = new Map(Object.values(CASE_TOPICS).flat().map(topic => [topic.id, topic.q]));
// A topic search as the owner reads it: its words and its id, or the id alone for a topic no longer listed.
const searchFor = id => (ALL_TOPICS.has(id) ? `the search for "${escapeHtml(ALL_TOPICS.get(id))}" (${escapeHtml(id)})` : `the search for ${escapeHtml(id)}`);
const decisions = ids => `decision${ids.length === 1 ? '' : 's'} ${listed(ids.map(escapeHtml))}`;

// What a failure CourtListener caused means for visitors, by its status, or null when it says nothing of CourtListener's
// state. The library and the screen share the token with the replies' own searches (getHeaders in courtlistener.js) and
// their citation check, which leaves a citation unchecked when CourtListener does not answer (citator.js). A reply for a
// case type with fewer than 5 cleared decisions searches live, and uses the decisions saved from earlier searches when the
// search finds nothing (ask.js).
const SAVED_ONLY = 'for a case type with fewer than 5 cleared decisions they use only the decisions saved from earlier searches, if any, and the citations in replies may be left unchecked.';
function courtListenerVisitors(status) {
  if (status === 401 || status === 403) return `Visitors are affected until the token is fixed: replies search CourtListener with the same token, so ${SAVED_ONLY}`;
  if (status === 429) return `Visitors may be affected until the hour's limit frees up: replies search CourtListener with the same token, so their searches may be refused too. Then, ${SAVED_ONLY}`;
  if (status === 0 || (status >= 500 && status <= 599)) return `If CourtListener is down, visitors are affected too: replies' live searches fail, so ${SAVED_ONLY}`;
  return null;
}
// Without the token the citation check in replies does not run (citator.js). Nothing else is claimed: CourtListener is not
// asked how it answers a search sent without one.
const NO_TOKEN_VISITORS = 'Visitors are affected: the citation check in replies runs only with the token set, so the citations in replies go unchecked until it is set.';

// A CourtListener answer by its status, as the rest of a sentence about where it came: "refused: too many requests ...".
function courtListenerSaid(status, where, stopped) {
  if (status === 0) return `CourtListener gave no answer within ${where.limit} to ${where.what}.`;
  if (status === 429) return `CourtListener refused: too many requests. It refused ${where.what}, and ${stopped} stopped there.`;
  if (status === 401 || status === 403) return `CourtListener refused the app's token ${where.at}, and ${stopped} stopped there.`;
  if (status >= 500 && status <= 599) return `CourtListener had an error of its own (status ${status}) ${where.at}, and ${stopped} stopped there.`;
  return `CourtListener answered ${where.what} with status ${status}, which the app cannot use, and ${stopped} stopped there.`;
}

// What a failed step's error says, in plain words, with what to do about it when that is more than the usual. The errors are
// those of library-refresh.js, case-screen.js, statute-watch.js and the job routes in server.js.
function plainFailure(error) {
  const text = String(error ?? '');
  let match = /CourtListener answered 0 to every topic search of the run \(([^)]*)\)/.exec(text);
  if (match) {
    return { said: `CourtListener gave no answer within ${seconds(LIBRARY_TIMEOUT_MS)} to any of the night's searches, even on a second try where there was time: ${listed(match[1].split(', ').map(searchFor))}.`, status: 0 };
  }
  match = /CourtListener answered (\d+) to the topic search (\S+); the run stopped/.exec(text);
  if (match) {
    const status = Number(match[1]);
    const where = { limit: seconds(LIBRARY_TIMEOUT_MS), what: searchFor(match[2]), at: `at ${searchFor(match[2])}` };
    return { said: courtListenerSaid(status, where, 'the refresh'), status };
  }
  match = /CourtListener answered 0 to every screen request of the run \(([^)]*)\)/.exec(text);
  if (match) return { said: `CourtListener gave no answer within ${seconds(SCREEN_TIMEOUT_MS)} to any of the screen's requests (${decisions(match[1].split(', '))}).`, status: 0 };
  match = /CourtListener answered (\d+) to the screen of (\d+); the run stopped/.exec(text);
  if (match) {
    const status = Number(match[1]);
    const where = { limit: seconds(SCREEN_TIMEOUT_MS), what: `the screen's question about decision ${match[2]}`, at: `while the screen asked about decision ${match[2]}` };
    return { said: courtListenerSaid(status, where, 'the screen'), status };
  }
  match = /^([A-Z][A-Z0-9_]+) is not set in this deployment/.exec(text);
  if (match) {
    return {
      said: `The setting ${match[1]} is missing from the deployment, so the job could not start.`,
      todo: `Set ${match[1]} in the deployment's settings on Vercel, then redeploy.`,
      ...(match[1] === 'COURTLISTENER_TOKEN' ? { visitors: NO_TOKEN_VISITORS } : {}),
    };
  }
  // backup.js names a setting that is set but not usable.
  match = /^(BACKUP_[A-Z0-9_]+) must be (.+?)\.?$/.exec(text);
  if (match) return { said: `The setting ${match[1]} is not valid: it must be ${escapeHtml(match[2])}.`, todo: `Correct ${match[1]} in the deployment's settings on Vercel, then redeploy.` };
  match = /no watched section or bill could be read \((.*)\)$/.exec(text);
  if (match) {
    return {
      said: `No watched section or bill could be read from the Senate's Open Legislation API (${escapeHtml(withoutKeys(match[1]))}).`,
      todo: "If the reason is a refusal (status 401 or 403), check NYSENATE_API_KEY in the deployment's settings on Vercel. Otherwise the Senate's service was likely down: if it fails again tomorrow night, it needs a look.",
    };
  }
  // Postgres names a table or column the code needs that the database lacks; the statute watch says so of its own table.
  if (/\bdoes not exist\b/.test(text)) return { said: 'The database is missing a table or column the job needs.', todo: 'Run npm run setup-db against the production database (or ask Claude to).' };
  if (/Run npm run setup-db/.test(text)) {
    return {
      said: 'The job could not read or write its table in the database.',
      todo: 'Run npm run setup-db against the production database (or ask Claude to), as the error below says. If the job fails the same way after that, the database itself could not be reached.',
    };
  }
  return { said: 'It stopped with an error, given at the end of this email.' };
}

// What to do after a CourtListener answer, by its status.
function courtListenerTodo(status) {
  if (status === 0) return 'Nothing needs doing: CourtListener was slow or down. If it fails the same way again tomorrow night, CourtListener may be down for longer.';
  if (status === 429) return "Nothing needs doing: the token's limits free up on their own. If it happens every night, the jobs ask more than the token allows.";
  if (status === 401 || status === 403) return "Check COURTLISTENER_TOKEN in the deployment's settings on Vercel, and do it today: replies use the same token. Until CourtListener takes it again, every refresh and screen fails too.";
  if (status >= 500 && status <= 599) return "Nothing needs doing: the error was on CourtListener's side.";
  return FALLBACK_TODO;
}

const sentence = text => `<p>${text}</p>`;
const capitalized = text => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Emails the owner about a job's failed steps. The subject names the job and says it failed; the body says, for each step, what
 * happened in plain words, whether visitors are affected and what to do, then when the job runs again and where to see each
 * job's last run, and last the errors as the app gave them, keys withheld.
 * @param {string} job  'nightly', 'statute watch', 'case library' or 'screen'
 * @param {{ step: string, error: string }[]} failed  runSteps' failed steps
 */
export async function reportFailedSteps(job, failed) {
  if (!failed.length) return;
  const own = JOBS[job] || {};
  const nightly = job === 'nightly' || !own.opening;
  const parts = [];
  if (nightly) parts.push(sentence(`${failed.length} of the ${escapeHtml(job)} job's steps failed; the others ran.`));
  for (const { step, error } of failed) {
    const plain = plainFailure(error);
    const todo = plain.todo ?? (plain.status !== undefined ? courtListenerTodo(plain.status) : null);
    const visitors = plain.visitors ?? (plain.status !== undefined ? courtListenerVisitors(plain.status) : null);
    if (nightly) {
      const meaning = NIGHTLY_STEPS[step];
      parts.push(`<h3>${escapeHtml(capitalized(String(step)))}</h3>`, sentence(plain.said),
        sentence(meaning?.means ?? 'It is one of the nightly steps; see the error at the end of this email.'), sentence(todo ?? meaning?.todo ?? FALLBACK_TODO));
    } else {
      parts.push(sentence(`${own.opening} ${plain.said}`), sentence(visitors ?? own.visitors), sentence(todo ?? FALLBACK_TODO));
    }
  }
  if (own.again) parts.push(sentence(own.again));
  // The states /health/deep gives a job (deepHealth above).
  const health = `${escapeHtml(APP_URL)}/health/deep`;
  parts.push(sentence(`To see how each job's last run went, open <a href="${health}">${health}</a>: each job reads "ok", "failed", "late" (no run in the last 26 hours) or "not run yet".`));
  const raw = failed.map(({ step, error }) => `${escapeHtml(step)}: ${escapeHtml(withoutKeys(error))}`).join('; ');
  parts.push(`<p style="color:#666;font-size:12px">For whoever debugs it, the error as the app gave it: ${raw}</p>`);
  const subject = `${SITE}: the ${job} job failed${job === 'nightly' ? ` (${failed.length} step${failed.length === 1 ? '' : 's'})` : ''}`;
  await notifyOperator(subject, `<div style="font-family:sans-serif;max-width:600px">${parts.join('')}</div>`);
}

// A summary of the last day for the operator, sent with the nightly job (DAILY_DIGEST=off stops it). It also shows
// that the job ran. The requests waiting for a firm are counted so they can be delivered by hand from the admin page.
export async function sendDailyDigest({ failed = [] } = {}) {
  if (process.env.DAILY_DIGEST === 'off') return false;
  const [day] = await sql`
    SELECT
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours')::int AS messages,
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours' AND outcome = 'error')::int AS errors,
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours' AND outcome = 'slow')::int AS slow,
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours' AND gate_status = 'BLOCKED')::int AS blocked,
      (SELECT count(*) FROM conversations WHERE contact_consent_at > NOW() - INTERVAL '24 hours')::int AS requests,
      (SELECT count(*) FROM leads WHERE created_at > NOW() - INTERVAL '24 hours')::int AS leads,
      (SELECT COALESCE(SUM(actual_cost_usd), 0) FROM ai_usage WHERE created_at > NOW() - INTERVAL '24 hours') AS ai_cost,
      (SELECT count(*) FROM conversations c WHERE c.contact_consent_at > NOW() - INTERVAL '7 days'
         AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.session_id = c.session_id)
         AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.session_id = c.session_id AND a.status IN ('open', 'closing')))::int AS unplaced`;
  // Never fails: a settings table that cannot be read names no override.
  const override = await unmeasuredOverride();
  // Never fails: a query that cannot be read leaves its line out.
  const replies = await repliesByModel();
  // Never fails: a watch that cannot be read leaves its section out.
  const watch = await statuteWatchSection();
  // Never fails: a library that cannot be read says so in its own section.
  const library = await caseLibrarySection();
  const row = (label, value) => `<tr><td style="color:#666;padding:4px 12px 4px 0">${label}</td><td><strong>${escapeHtml(value ?? 0)}</strong></td></tr>`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px">
      <h2 style="margin-bottom:0.5rem">${SITE}: the last 24 hours</h2>
      <table style="border-collapse:collapse">
        ${row('Chat messages', day?.messages)}
        ${row('Failed', day?.errors)}
        ${row('Ran out of time', day?.slow)}
        ${row('Replies the gate blocked', day?.blocked)}
        ${row('Contact requests', day?.requests)}
        ${row('Leads delivered', day?.leads)}
        ${row('Estimated AI spend (USD)', `$${Number(day?.ai_cost || 0).toFixed(2)}`)}
        ${row('Requests waiting for a firm (last 7 days)', day?.unplaced)}
      </table>
      ${day?.unplaced ? `<p>Deliver waiting requests by hand from the <a href="${escapeHtml(APP_URL)}/admin.html">admin page</a>.</p>` : ''}
      ${replies ? repliesLine(replies) : ''}
      ${override ? overrideLine(override) : ''}
      ${watch ? `<h3 style="margin-bottom:0.25rem">Statute watch</h3>${watch}` : ''}
      <h3 style="margin-bottom:0.25rem">Case library</h3>${library}
      <p>${failed.length ? `The nightly job had ${failed.length} failed step${failed.length === 1 ? '' : 's'}: ${failed.map(f => escapeHtml(f.step)).join(', ')}.` : 'The nightly job ran every step.'}</p>
    </div>`;
  await notifyOperator(`${SITE} daily summary: ${day?.messages || 0} messages, ${day?.requests || 0} contact requests, ${day?.leads || 0} leads`, html);
  return true;
}
