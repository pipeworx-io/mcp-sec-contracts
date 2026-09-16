interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}
/**
 * SEC Contracts MCP — material-contract exhibits (EX-10 / EX-4 / EX-2) found by
 * CLAUSE LANGUAGE over SEC EDGAR full-text search (free, no auth).
 *
 * Tools:
 * - sec_contracts_search: find exhibits whose text contains a phrase ("change of control")
 * - sec_contract_text: read one exhibit's text, paged
 * - sec_contracts_by_company: one filer's material contracts in date order
 *
 * How it works (verified against efts.sec.gov 2026-08-28):
 * - EDGAR full-text search (efts) indexes every DOCUMENT in a filing, not just
 *   the primary form, and each hit carries `file_type` ("EX-10.1", "EX-4.2",
 *   "10-K"...) and `file_description` ("EX-10.1 CREDIT AGREEMENT"). efts has NO
 *   exhibit-type parameter (`forms=EX-10` returns zero — `forms` filters the
 *   ROOT form), so exhibit filtering is client-side: over-fetch 100 docs a page
 *   and keep the ones whose file_type is in the requested family.
 * - efts returns no highlight/snippet. Snippets come from a bounded read of
 *   each matched exhibit (first 1.5 MB of HTML), stripped to text, with the
 *   first occurrence of the phrase windowed. Definitions ("Change of Control"
 *   means...) sit near the top of an agreement, so the bound is rarely hit.
 * - A `dateRange=custom` with only `startdt` is IGNORED by efts (the filter
 *   array comes back empty and 2008 hits appear). Always send both ends.
 * - Unquoted words are ANDed as separate match_phrase clauses; `OR` between
 *   terms is honored; a double-quoted phrase is an exact phrase. `q=*` matches
 *   nothing, which is why the by-company tool uses a broad OR of contract words.
 * - Archive URLs need the REGISTRANT's CIK (`ciks[0]` on the hit). The filing
 *   agent CIK that prefixes many accession numbers (0001193125 = Donnelley)
 *   returns 503 on the Archives path, so the search rows carry the resolved
 *   `document_url` and `cik` for sec_contract_text to reuse.
 * - efts full-text coverage starts 2001; earlier `since` values are clamped and
 *   the response says so.
 * - efts sits behind an API Gateway response cache whose key covers q, the
 *   date window, forms and from/page but NOT sics / ciks / entityName. Measured
 *   2026-08-28: a `sics=7372` request served the unfiltered 10,000-hit result
 *   cached seconds earlier for the same q and dates — and the reverse leak
 *   too. The echoed `query` in the body shows which filters actually ran. Fix:
 *   when any of those filters is set, `q` gets a negated nonsense token
 *   (`-zqf…`) derived from the filter set; efts compiles it to a must_not that
 *   matches nothing (totals verified identical with and without it), and the
 *   key becomes unique per filter set. A client-side guard re-checks sic/cik
 *   on every row as well, and reports if it ever drops anything.
 *
 * Note: SEC requires a descriptive User-Agent header per their fair-access rules.
 */


const EFTS_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const SEC_HEADERS: Record<string, string> = {
  'User-Agent': 'Pipeworx/1.0 (support@pipeworx.io)',
  Accept: 'application/json',
};
const DOC_HEADERS: Record<string, string> = {
  'User-Agent': 'Pipeworx/1.0 (support@pipeworx.io)',
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
};

const FTS_FLOOR = '2001-01-01';
const EFTS_PAGE = 100; // efts fixed page size
const MAX_PAGES_SEARCH = 5; // 500 documents scanned per call at most
const MAX_PAGES_COMPANY = 5;
const SNIPPET_MAX_BYTES = 1_500_000;
const TEXT_MAX_BYTES = 4_000_000;
const SNIPPET_RADIUS = 220;
const SNIPPET_CONCURRENCY = 5;
const TEXT_DEFAULT_MAX = 50000;
const TEXT_CAP = 100000;

// Words that appear in essentially every material contract; used as the efts
// `q` when the caller wants a filer's exhibits rather than a clause match.
const BROAD_CONTRACT_QUERY =
  'agreement OR indenture OR amendment OR lease OR plan OR note OR warrant OR contract OR letter OR supplement';

const EXHIBIT_TYPE_ENUM = ['any', 'EX-10', 'EX-4', 'EX-2', 'EX-99', 'all_exhibits'] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'sec_contracts_search',
    description:
      'Find SEC material-contract exhibits by CLAUSE LANGUAGE — credit agreements, merger agreements, indentures, employment and severance agreements, change-of-control agreements, license and supply agreements, warrants — searching the full text of every Exhibit 10 / Exhibit 4 / Exhibit 2 attached to 8-K, 10-K, 10-Q, S-1 and S-4 filings in SEC EDGAR full-text search (2001 to today). The inverted question: "credit agreements filed since 2025 with a change of control clause", "employment agreements with a 2x severance multiple", "indentures with a make-whole redemption", "merger agreements with a reverse termination fee". Returns one row per exhibit document: company, CIK, ticker, root form, filing date, exhibit type (EX-10.1, EX-4.2...), the filer\'s exhibit description ("EX-10.1 CREDIT AGREEMENT"), a text snippet around the matched phrase, the exhibit document URL, accession number and the filing index page — plus the same hits grouped by filing with each filing\'s exhibit list. Narrow by exhibit family (EX-10 material contracts, EX-4 debt instruments/indentures/warrants, EX-2 merger and acquisition agreements), root form, filing-date window, one company (name, ticker or CIK) or SIC industry code (7372 software, 2834 pharma, 6022 banks). Feed `document_url` (or adsh + filename + cik) to sec_contract_text to read the agreement.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'The clause or phrase to find in exhibit text, e.g. "change of control", "make-whole", "reverse termination fee", "most favored nation". Multi-word input is matched as an exact phrase by default (see `match`). Double quotes inside the value are passed through, so "\\"change of control\\" severance" searches the phrase AND the word.',
        },
        match: {
          type: 'string',
          enum: ['phrase', 'all', 'any'],
          description:
            'phrase (default): the words must appear together in order. all: every word must appear somewhere in the document. any: at least one word. Use `all` for concept searches like "severance multiple change control".',
        },
        exhibit_type: {
          type: 'string',
          enum: [...EXHIBIT_TYPE_ENUM],
          description:
            'Exhibit family to keep. EX-10 = material contracts (credit, employment, license, supply, leases). EX-4 = instruments defining security-holder rights (indentures, notes, warrants, registration rights). EX-2 = plans of acquisition, reorganization, merger. EX-99 = additional exhibits (press releases, investor decks). any (default) = EX-10 + EX-4 + EX-2, the material-contract set. all_exhibits = every EX-* document. "10", "ex10" and "EX-10.1" are all read as EX-10.',
        },
        form: {
          type: 'string',
          description: 'Root form the exhibit was attached to, e.g. "8-K", "10-K", "10-Q", "S-1", "S-4", "DEF 14A". Comma-separate several: "8-K,10-K". Omit for all forms.',
        },
        since: {
          type: 'string',
          description: 'Earliest filing date, YYYY-MM-DD. Full-text coverage starts 2001-01-01; earlier values are clamped. Default: 2 years before today.',
        },
        until: {
          type: 'string',
          description: 'Latest filing date, YYYY-MM-DD. Default: today.',
        },
        company: {
          type: 'string',
          description: 'Restrict to one filer: ticker ("ADBE"), company name ("Adobe") or CIK ("796343"). Names are resolved against the SEC ticker list first; unlisted names fall back to EDGAR\'s entity-name filter.',
        },
        sic: {
          type: 'string',
          description: 'Restrict to an SIC industry code, e.g. "7372" (prepackaged software), "2834" (pharmaceutical preparations), "6022" (state commercial banks), "1311" (crude petroleum and natural gas). Comma-separate several.',
        },
        limit: {
          type: 'number',
          description: 'Max exhibit documents to return (1-50, default 10). Each returned exhibit costs one bounded document read for its snippet when include_snippets is on.',
        },
        include_snippets: {
          type: 'boolean',
          description: 'Fetch each matched exhibit and return a ~440-character window around the first occurrence of the phrase. Default true. Set false for a faster list-only answer.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'sec_contract_text',
    description:
      'Read the text of ONE SEC exhibit document — a credit agreement, merger agreement, indenture, employment agreement or any other EX-10 / EX-4 / EX-2 attachment — as clean plaintext, paged. Pass the `document_url` from sec_contracts_search or sec_contracts_by_company (or adsh + filename + the registrant\'s cik). Returns up to `max_chars` (default 50,000) from `offset` with `truncated` + `next_offset` for the next window; a very large exhibit (a syndicated credit agreement can run 2-4 MB of HTML) is read up to 4 MB and flagged `raw_truncated`. Use to quote the actual clause — the definition of "Change of Control", the severance multiple, the termination-fee amount, the interest-rate grid, the covenants — after sec_contracts_search located the agreement.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The exhibit\'s document URL on www.sec.gov/Archives, exactly as returned in `document_url` by sec_contracts_search. Preferred over adsh + filename.',
        },
        adsh: {
          type: 'string',
          description: 'Accession number, dashed or not (e.g. "0000712537-25-000088"). Use with `filename` and `cik`.',
        },
        filename: {
          type: 'string',
          description: 'The exhibit file name inside the filing, e.g. "fcf-ex103_20250331xchangeo.htm" (the part after the colon in a search hit\'s `_id`, also returned as `filename`).',
        },
        cik: {
          type: 'string',
          description: 'The REGISTRANT\'s CIK (returned as `cik` on every search row). Needed with adsh + filename because the Archives path is keyed by the registrant, and the filing-agent CIK that prefixes many accession numbers does not resolve. Omit only when the accession prefix is the registrant itself.',
        },
        max_chars: {
          type: 'number',
          description: 'Max characters in this page (1000-100000, default 50000).',
        },
        offset: {
          type: 'number',
          description: 'Character offset to start from (default 0). Pass the prior result\'s next_offset to page forward.',
        },
        find: {
          type: 'string',
          description: 'Optional phrase to jump to: the page starts ~300 characters before its first occurrence instead of at `offset`. Use to land directly on the "Change of Control" definition or the "Termination Fee" section.',
        },
      },
      required: [],
    },
  },
  {
    name: 'sec_contracts_by_company',
    description:
      'List ONE company\'s material contracts as filed with the SEC — every Exhibit 10 (credit agreements, employment and severance agreements, leases, license and supply agreements, equity plans), Exhibit 4 (indentures, notes, warrants, registration rights) and Exhibit 2 (merger and acquisition agreements) attached to its 8-K, 10-K, 10-Q, S-1 and S-4 filings — newest first, from SEC EDGAR full-text search. Pass a ticker ("ADBE"), company name ("Adobe") or CIK. Returns exhibit type, the filer\'s own exhibit description ("EX-10.1 CREDIT AGREEMENT DATED..."), root form, filing date, document URL and accession, grouped by filing. Answers "what credit facility does $TICKER have on file", "show me $COMPANY\'s executive employment agreements", "which indentures has $TICKER filed since 2023". Read any row with sec_contract_text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: {
          type: 'string',
          description: 'Ticker ("ADBE"), company name ("Adobe Inc") or CIK ("796343"). Names are resolved against the SEC ticker list first; unlisted names fall back to EDGAR\'s entity-name filter.',
        },
        exhibit_type: {
          type: 'string',
          enum: [...EXHIBIT_TYPE_ENUM],
          description: 'Exhibit family: EX-10 material contracts, EX-4 debt/warrant instruments, EX-2 M&A agreements, EX-99 other, any (default) = EX-10 + EX-4 + EX-2, all_exhibits = every EX-* document.',
        },
        form: {
          type: 'string',
          description: 'Root form filter, e.g. "8-K" or "10-K,10-Q". Omit for all forms.',
        },
        since: {
          type: 'string',
          description: 'Earliest filing date, YYYY-MM-DD (default: 5 years before today; coverage floor 2001-01-01).',
        },
        until: {
          type: 'string',
          description: 'Latest filing date, YYYY-MM-DD (default: today).',
        },
        limit: {
          type: 'number',
          description: 'Max exhibit documents to return (1-100, default 25), newest filing first.',
        },
      },
      required: ['company'],
    },
  },
];

// ── efts types ────────────────────────────────────────────────────────

interface EftsSource {
  ciks?: string[];
  display_names?: string[];
  form?: string;
  root_forms?: string[];
  file_type?: string;
  file_description?: string;
  file_date?: string;
  period_ending?: string;
  biz_locations?: string[];
  biz_states?: string[];
  sics?: string[];
  adsh?: string;
  sequence?: string;
  items?: string[];
}
interface EftsHit {
  _id: string;
  _score?: number;
  _source: EftsSource;
}
interface EftsResponse {
  hits?: { hits?: EftsHit[]; total?: { value: number; relation?: string } };
}

// ── Helpers ─────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function validDate(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be YYYY-MM-DD (got "${s}").`);
  }
  return s;
}

// Resolve a date window; efts silently drops a one-sided custom range, so both
// ends are always sent. Returns the coverage note when `since` predates the index.
function dateWindow(since: string | undefined, until: string | undefined, defaultSince: string) {
  let start = since ?? defaultSince;
  const end = until ?? todayIso();
  let note: string | undefined;
  if (start < FTS_FLOOR) {
    note = `EDGAR full-text search covers filings from ${FTS_FLOOR} onward; since=${start} was clamped to ${FTS_FLOOR}. Earlier exhibits exist in EDGAR but are not text-searchable here.`;
    start = FTS_FLOOR;
  }
  if (start > end) throw new Error(`since (${start}) is after until (${end}).`);
  return { start, end, note };
}

// "EX-10", "ex10", "10", "EX-10.1", "Exhibit 10" → family key; also the enum words.
function normalizeExhibitType(raw: unknown): (typeof EXHIBIT_TYPE_ENUM)[number] {
  if (raw === undefined || raw === null || raw === '') return 'any';
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'any' || s === 'all' || s === 'contracts') return 'any';
  if (s === 'all_exhibits' || s === 'allexhibits' || s === 'ex' || s === 'ex-*' || s === '*') return 'all_exhibits';
  const m = s.match(/^(?:exhibit|ex)?-?(\d+)/);
  if (m) {
    const n = m[1];
    if (n === '10') return 'EX-10';
    if (n === '4') return 'EX-4';
    if (n === '2') return 'EX-2';
    if (n === '99') return 'EX-99';
    throw new Error(`exhibit_type "${String(raw)}" is not a supported family. Use one of: ${EXHIBIT_TYPE_ENUM.join(', ')}.`);
  }
  throw new Error(`exhibit_type "${String(raw)}" is not recognised. Use one of: ${EXHIBIT_TYPE_ENUM.join(', ')}.`);
}

// Family regexes. `(?!\d)` keeps EX-10 from swallowing EX-103 (a filer typo
// that does occur) and EX-4 from matching EX-41.
const FAMILY_RE: Record<string, RegExp> = {
  'EX-10': /^EX-10(?!\d)/i,
  'EX-4': /^EX-4(?!\d)/i,
  'EX-2': /^EX-2(?!\d)/i,
  'EX-99': /^EX-99(?!\d)/i,
};

function exhibitMatcher(family: (typeof EXHIBIT_TYPE_ENUM)[number]): (fileType: string) => boolean {
  if (family === 'all_exhibits') return (ft) => /^EX-/i.test(ft);
  if (family === 'any') return (ft) => FAMILY_RE['EX-10'].test(ft) || FAMILY_RE['EX-4'].test(ft) || FAMILY_RE['EX-2'].test(ft);
  const re = FAMILY_RE[family];
  return (ft) => re.test(ft);
}

function familyLabel(family: (typeof EXHIBIT_TYPE_ENUM)[number]): string {
  if (family === 'any') return 'EX-10 + EX-4 + EX-2';
  if (family === 'all_exhibits') return 'every EX-* exhibit';
  return family;
}

// efts query builder. Quoted input passes through untouched (the caller knows
// what they want); otherwise phrase → one quoted phrase, all → bare words
// (efts ANDs them), any → words joined with OR.
function buildQuery(query: string, match: string): { q: string; terms: string[] } {
  const raw = query.trim();
  if (!raw) throw new Error('query is required — the clause or phrase to find, e.g. "change of control".');
  const words = raw.replace(/"/g, ' ').split(/\s+/).filter(Boolean);
  if (raw.includes('"')) {
    const phrases = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
    const loose = raw.replace(/"[^"]*"/g, ' ').split(/\s+/).filter(Boolean);
    return { q: raw, terms: [...phrases, ...loose] };
  }
  if (match === 'any') return { q: words.join(' OR '), terms: words };
  if (match === 'all') return { q: words.join(' '), terms: words };
  // phrase
  return { q: words.length > 1 ? `"${words.join(' ')}"` : raw, terms: [words.join(' ')] };
}

function padCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0');
}

// Cache-key token for filters efts does not key its response cache on (see the
// header). Alphanumeric only, so efts reads it as one nonsense term; negated
// with `-` it becomes a must_not clause that matches no document.
function cacheKeyToken(params: URLSearchParams): string | null {
  const parts: string[] = [];
  const sics = params.get('sics');
  const ciks = params.get('ciks');
  const entity = params.get('entityName');
  if (sics) parts.push('s' + sics.replace(/[^0-9a-z]/gi, 'x'));
  if (ciks) parts.push('c' + ciks.replace(/\D/g, ''));
  if (entity) {
    let h = 0;
    for (const ch of entity.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    parts.push('n' + h.toString(36));
  }
  return parts.length ? 'zqf' + parts.join('') : null;
}

function applyCacheKeyToken(params: URLSearchParams): void {
  const token = cacheKeyToken(params);
  if (token) params.set('q', `${params.get('q') ?? ''} -${token}`);
}

// Ticker OR name OR CIK → { ciks } or { entityName } for the efts params.
async function companyFilter(company: string | undefined, cikArg?: string) {
  if (cikArg && String(cikArg).trim()) {
    return { ciks: padCik(String(cikArg)), resolved: { cik: String(Number(String(cikArg).replace(/\D/g, ''))), matched_by: 'cik' as const } };
  }
  if (!company || !String(company).trim()) return {};
  const c = String(company).trim();
  if (/^\d{1,10}$/.test(c)) {
    return { ciks: padCik(c), resolved: { cik: String(Number(c)), matched_by: 'cik' as const } };
  }
  try {
    const ent = await resolveSecEntity(c, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
    return {
      ciks: ent.cik_padded,
      resolved: {
        cik: ent.cik,
        ticker: ent.ticker,
        company_name: ent.company_name,
        matched_by: ent.matched_by,
        ...(ent.alternatives?.length ? { alternatives: ent.alternatives.slice(0, 5) } : {}),
      },
    };
  } catch {
    // Not in the ticker list (private filer, fund, delisted) — let efts match the name.
    return { entityName: c, resolved: { entity_name_filter: c, matched_by: 'entity_name' as const } };
  }
}

// display_names[0] is "NAME  (TICKER, TICKER2)  (CIK 0000796343)"; the ticker
// group is absent for non-tickered filers.
function parseDisplayName(display: string): { name: string; ticker: string | null } {
  const name = display.split(/\s{2,}\(/)[0].trim() || display;
  const groups = [...display.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());
  const tick = groups.find((g) => !/^CIK\s/i.test(g));
  return { name, ticker: tick ? tick.split(',')[0].trim() : null };
}

function accessionParts(adsh: string): { dashed: string; nodash: string } | null {
  const digits = String(adsh ?? '').replace(/\D/g, '');
  if (digits.length !== 18) return null;
  return { dashed: `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`, nodash: digits };
}

function archiveFolder(cikNoZeros: string, adshNodash: string): string {
  return `${ARCHIVES_BASE}/${cikNoZeros}/${adshNodash}`;
}

interface ExhibitRow {
  company: string;
  cik: string;
  ticker: string | null;
  form: string | null;
  filing_date: string | null;
  period_ending: string | null;
  exhibit_type: string;
  exhibit_description: string | null;
  sic: string | null;
  location: string | null;
  adsh: string;
  filename: string;
  document_url: string;
  filing_index_url: string;
  snippet?: string | null;
  snippet_note?: string;
  matched_term?: string | null;
}

function hitToRow(hit: EftsHit): ExhibitRow | null {
  const s = hit._source;
  const adsh = s.adsh ?? hit._id.split(':')[0];
  const acc = accessionParts(adsh);
  const filename = hit._id.includes(':') ? hit._id.slice(hit._id.indexOf(':') + 1) : '';
  const cikRaw = s.ciks?.[0];
  if (!acc || !filename || !cikRaw) return null;
  const cik = String(parseInt(cikRaw, 10));
  const { name, ticker } = parseDisplayName(s.display_names?.[0] ?? '');
  const folder = archiveFolder(cik, acc.nodash);
  const desc = (s.file_description ?? '').trim();
  return {
    company: name,
    cik,
    ticker,
    form: s.form ?? s.root_forms?.[0] ?? null,
    filing_date: s.file_date ?? null,
    period_ending: s.period_ending ?? null,
    exhibit_type: s.file_type ?? '',
    // Filers usually repeat the type in the description ("EX-10.1 CREDIT AGREEMENT"); a bare
    // repeat of the type carries no information, so return null then.
    exhibit_description: desc && desc.toUpperCase() !== (s.file_type ?? '').toUpperCase() ? desc : null,
    sic: s.sics?.[0] ?? null,
    location: s.biz_locations?.[0] ?? s.biz_states?.[0] ?? null,
    adsh: acc.dashed,
    filename,
    document_url: `${folder}/${filename}`,
    filing_index_url: `${folder}/${acc.dashed}-index.html`,
  };
}

async function eftsPage(params: URLSearchParams, from: number): Promise<EftsResponse> {
  params.set('from', String(from));
  const res = await fetch(`${EFTS_SEARCH}?${params}`, { headers: SEC_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await httpError(res, 'SEC EDGAR full-text search error');
  return (await res.json()) as EftsResponse;
}

// Walk efts pages, keeping documents whose file_type passes `keep`, until
// `want` rows are collected or the pages run out.
// `guard` re-applies the sics/ciks filters client-side: efts was observed once
// (2026-08-28) returning the UNFILTERED result set for a sics-filtered query —
// a clean 200 with 10,000+ hits from every industry — so a requested filter is
// verified on every row rather than trusted.
async function scanExhibits(
  params: URLSearchParams,
  keep: (ft: string) => boolean,
  want: number,
  maxPages: number,
  guard: { sics?: Set<string>; ciks?: Set<string> } = {},
) {
  const rows: ExhibitRow[] = [];
  let guardDropped = 0;
  let total = 0;
  let totalRelation = 'eq';
  let docsScanned = 0;
  let pages = 0;
  let exhausted = false;
  for (let p = 0; p < maxPages; p++) {
    const data = await eftsPage(params, p * EFTS_PAGE);
    pages++;
    const hits = data.hits?.hits ?? [];
    if (p === 0) {
      total = data.hits?.total?.value ?? 0;
      totalRelation = data.hits?.total?.relation ?? 'eq';
    }
    docsScanned += hits.length;
    for (const h of hits) {
      const ft = h._source.file_type ?? '';
      if (!keep(ft)) continue;
      if (guard.sics && !(h._source.sics ?? []).some((c) => guard.sics!.has(c))) { guardDropped++; continue; }
      if (guard.ciks && !(h._source.ciks ?? []).some((c) => guard.ciks!.has(String(parseInt(c, 10))))) { guardDropped++; continue; }
      const row = hitToRow(h);
      if (row) rows.push(row);
      if (rows.length >= want) break;
    }
    if (rows.length >= want) break;
    if (hits.length < EFTS_PAGE) { exhausted = true; break; }
  }
  if (pages >= maxPages && rows.length < want && !exhausted) exhausted = false;
  return { rows, total, totalRelation, docsScanned, pages, exhausted: exhausted || docsScanned >= total, guardDropped };
}

function guardFor(sic: string, ciks?: string): { sics?: Set<string>; ciks?: Set<string> } {
  const g: { sics?: Set<string>; ciks?: Set<string> } = {};
  if (sic) g.sics = new Set(sic.split(',').filter(Boolean));
  if (ciks) g.ciks = new Set([String(parseInt(ciks, 10))]);
  return g;
}

// ── Document reading ─────────────────────────────────────────────────

// Read at most maxBytes of a document and cancel the rest. SEC's archive does
// not honor Range requests, and a multi-MB credit agreement stripped in one
// go is what trips the Worker CPU ceiling — so the cap lives on our side.
async function fetchTextBounded(url: string, maxBytes: number, timeoutMs: number): Promise<{ status: number; text: string; truncated: boolean }> {
  const res = await fetch(url, { headers: DOC_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { status: res.status, text: '', truncated: false };
  if (!res.body) {
    const whole = await res.text();
    return { status: res.status, text: whole.length > maxBytes ? whole.slice(0, maxBytes) : whole, truncated: whole.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) { truncated = true; await reader.cancel().catch(() => undefined); break; }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { status: res.status, text: new TextDecoder().decode(buf), truncated };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&ldquo;|&#8221;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-').replace(/&#8212;|&mdash;/g, '--')
    .replace(/&#(\d+);/g, (_, n: string) => { const c = Number(n); return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' '; });
}

// Workers have no DOMParser; strip tags, decode entities, collapse whitespace.
function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Archive documents arrive inside their SGML envelope (<DOCUMENT><TYPE>EX-10.3
      // <SEQUENCE>4 <FILENAME>… <DESCRIPTION>… <TEXT>); drop it so the text starts
      // at the agreement, not at the file name.
      .replace(/^\s*<DOCUMENT>\s*(?:<(?:TYPE|SEQUENCE|FILENAME|DESCRIPTION)>[^\n]*\n)+\s*<TEXT>\s*/i, '')
      .replace(/<(script|style|title)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|tr|li|h[1-6]|br)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeHtml(filename: string, body: string): boolean {
  return /\.x?html?$/i.test(filename) || /^\s*<(!doctype|html|\?xml|div|p|body)/i.test(body.slice(0, 400));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive, whitespace-tolerant search for the first of `terms`.
function findTerm(text: string, terms: string[]): { index: number; term: string; length: number } | null {
  let best: { index: number; term: string; length: number } | null = null;
  for (const t of terms) {
    const words = t.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const re = new RegExp(words.map(escapeRe).join('\\s+'), 'i');
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, term: t, length: m[0].length };
  }
  return best;
}

function windowAround(text: string, index: number, length: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${s}${end < text.length ? '…' : ''}`;
}

async function snippetFor(row: ExhibitRow, terms: string[]): Promise<void> {
  try {
    const { status, text: raw, truncated } = await fetchTextBounded(row.document_url, SNIPPET_MAX_BYTES, 12000);
    if (status !== 200) {
      row.snippet = null;
      row.snippet_note = `exhibit fetch returned HTTP ${status}`;
      return;
    }
    if (/\.pdf$/i.test(row.filename)) {
      row.snippet = null;
      row.snippet_note = 'exhibit is a PDF; text extraction is not available here — open document_url';
      return;
    }
    const text = looksLikeHtml(row.filename, raw) ? htmlToText(raw) : raw;
    const hit = findTerm(text, terms);
    if (!hit) {
      row.snippet = null;
      row.snippet_note = truncated
        ? `phrase not found in the first ${(SNIPPET_MAX_BYTES / 1_000_000).toFixed(1)} MB of this exhibit; it matched further in — use sec_contract_text with find`
        : 'phrase indexed by EDGAR but not found verbatim in the stripped text (hyphenation or a table split it) — open document_url';
      return;
    }
    row.snippet = windowAround(text, hit.index, hit.length, SNIPPET_RADIUS);
    row.matched_term = hit.term;
  } catch (e) {
    row.snippet = null;
    row.snippet_note = `snippet unavailable: ${(e as Error)?.message ?? String(e)}`;
  }
}

async function addSnippets(rows: ExhibitRow[], terms: string[]): Promise<void> {
  for (let i = 0; i < rows.length; i += SNIPPET_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + SNIPPET_CONCURRENCY).map((r) => snippetFor(r, terms)));
  }
}

function groupByFiling(rows: ExhibitRow[]) {
  const map = new Map<string, { adsh: string; company: string; cik: string; ticker: string | null; form: string | null; filing_date: string | null; filing_index_url: string; exhibits: { exhibit_type: string; description: string | null; document_url: string }[] }>();
  for (const r of rows) {
    let g = map.get(r.adsh);
    if (!g) {
      g = { adsh: r.adsh, company: r.company, cik: r.cik, ticker: r.ticker, form: r.form, filing_date: r.filing_date, filing_index_url: r.filing_index_url, exhibits: [] };
      map.set(r.adsh, g);
    }
    g.exhibits.push({ exhibit_type: r.exhibit_type, description: r.exhibit_description, document_url: r.document_url });
  }
  return [...map.values()];
}

// ── Tool implementations ────────────────────────────────────────────

async function contractsSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? '');
  const match = String(args.match ?? 'phrase').toLowerCase();
  if (!['phrase', 'all', 'any'].includes(match)) throw new Error('match must be one of phrase, all, any.');
  const family = normalizeExhibitType(args.exhibit_type);
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 10)));
  const includeSnippets = args.include_snippets === undefined ? true : Boolean(args.include_snippets);
  const { start, end, note } = dateWindow(validDate(args.since, 'since'), validDate(args.until, 'until'), yearsAgoIso(2));
  const { q, terms } = buildQuery(query, match);

  const params = new URLSearchParams({ q, dateRange: 'custom', startdt: start, enddt: end });
  const form = args.form ? String(args.form).trim() : '';
  if (form) params.set('forms', form.split(',').map((f) => f.trim().toUpperCase()).filter(Boolean).join(','));
  const sic = args.sic ? String(args.sic).replace(/\s/g, '') : '';
  if (sic) params.set('sics', sic);
  const cf = await companyFilter(args.company ? String(args.company) : undefined);
  if ('ciks' in cf && cf.ciks) params.set('ciks', cf.ciks);
  if ('entityName' in cf && cf.entityName) params.set('entityName', cf.entityName);

  applyCacheKeyToken(params);
  const scan = await scanExhibits(params, exhibitMatcher(family), limit, MAX_PAGES_SEARCH, guardFor(sic, 'ciks' in cf ? cf.ciks : undefined));
  if (includeSnippets && scan.rows.length) await addSnippets(scan.rows, terms);

  const notes: string[] = [];
  if (note) notes.push(note);
  if (scan.guardDropped) notes.push(`${scan.guardDropped} document(s) EDGAR returned did not match the requested ${sic ? 'sic' : 'company'} filter and were dropped (upstream response-cache leak; see pack README).`);
  if (scan.totalRelation === 'gte') notes.push(`EDGAR reports the phrase in 10,000+ documents of all types in this window; only the first ${scan.docsScanned} (by relevance) were scanned for ${familyLabel(family)} exhibits. Narrow with since/until, form, sic or company to reach the rest.`);
  else if (!scan.exhausted && scan.rows.length < limit) notes.push(`Scanned ${scan.docsScanned} of ${scan.total} matching documents; more ${familyLabel(family)} exhibits may exist past the scan window — narrow with since/until, form, sic or company.`);
  if (scan.rows.length === 0) notes.push(`No ${familyLabel(family)} exhibit in ${start}..${end} contains ${match === 'phrase' ? 'the phrase' : 'the terms'} ${JSON.stringify(query)}${scan.total ? ` (the text matched ${scan.total} non-exhibit documents such as 10-K bodies — set exhibit_type:"all_exhibits" or drop the family filter to see more)` : ''}. Try match:"all" for a looser search, or a shorter phrase.`);

  return {
    query,
    efts_query: q,
    match,
    exhibit_type: family,
    exhibit_family: familyLabel(family),
    date_range: { since: start, until: end },
    ...(form ? { form } : {}),
    ...(sic ? { sic } : {}),
    ...('resolved' in cf && cf.resolved ? { company_filter: cf.resolved } : {}),
    total_matching_documents: scan.total,
    total_relation: scan.totalRelation,
    documents_scanned: scan.docsScanned,
    exhibits_returned: scan.rows.length,
    filings_returned: new Set(scan.rows.map((r) => r.adsh)).size,
    ...(notes.length ? { note: notes.join(' ') } : {}),
    results: scan.rows,
    by_filing: groupByFiling(scan.rows),
    source: 'SEC EDGAR full-text search (efts.sec.gov) — exhibit documents attached to filings since 2001',
  };
}

const ARCHIVE_URL_RE = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})\/([^/?#]+)$/i;

async function contractText(args: Record<string, unknown>) {
  let url = args.url ? String(args.url).trim() : '';
  let cik: string | null = null;
  let adshDashed: string | null = null;
  let filename = '';
  let cikGuessed = false;

  if (url) {
    // Accept the dashed-index folder form too; normalise to the document URL.
    const m = ARCHIVE_URL_RE.exec(url);
    if (!m) {
      throw new Error(`url must be an exhibit document on https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/<file> — pass the document_url from sec_contracts_search. Got: ${url}`);
    }
    cik = String(Number(m[1]));
    const acc = accessionParts(m[2]);
    adshDashed = acc?.dashed ?? m[2];
    filename = m[3];
    url = `${archiveFolder(cik, m[2])}/${filename}`;
  } else {
    const adsh = args.adsh ? String(args.adsh) : '';
    filename = args.filename ? String(args.filename).trim() : '';
    const acc = accessionParts(adsh);
    if (!acc || !filename) {
      throw new Error('Pass either url (the document_url from sec_contracts_search) or adsh + filename (+ the registrant cik). An accession is 18 digits shaped 10-2-6, e.g. "0000712537-25-000088".');
    }
    if (/[/?#]/.test(filename)) throw new Error('filename must be a bare file name inside the filing, e.g. "fcf-ex103_20250331xchangeo.htm".');
    adshDashed = acc.dashed;
    if (args.cik && String(args.cik).trim()) {
      cik = String(Number(String(args.cik).replace(/\D/g, '')));
    } else {
      // Self-filers' accessions are prefixed by their own CIK; filing agents' are not.
      cik = String(Number(acc.nodash.slice(0, 10)));
      cikGuessed = true;
    }
    url = `${archiveFolder(cik, acc.nodash)}/${filename}`;
  }

  if (/\.pdf$/i.test(filename)) {
    return {
      found: false,
      reason: 'pdf_exhibit',
      hint: `This exhibit is a PDF (${filename}); plaintext extraction is not available here. Open ${url} directly, or look for an .htm sibling of the same exhibit in the filing index.`,
      document_url: url,
    };
  }

  const { status, text: raw, truncated: rawTruncated } = await fetchTextBounded(url, TEXT_MAX_BYTES, 20000);
  if (status === 404 || status === 503) {
    return {
      found: false,
      reason: cikGuessed ? 'cik_required' : 'document_not_found',
      hint: cikGuessed
        ? `No document at ${url}. The accession prefix (${cik}) is a filing agent, not the registrant — pass the registrant's cik (the \`cik\` field on the sec_contracts_search row) or pass the row's document_url instead.`
        : `No document at ${url} (HTTP ${status}). Check the accession and file name against the filing index: ${archiveFolder(cik, adshDashed.replace(/-/g, ''))}/${adshDashed}-index.html`,
      document_url: url,
    };
  }
  if (status !== 200) throw new Error(`SEC archive returned HTTP ${status} for ${url}.`);

  let fullText = looksLikeHtml(filename, raw) ? htmlToText(raw) : raw;
  const total = fullText.length;

  let off = Math.max(0, Math.floor(Number(args.offset) || 0));
  let findApplied: string | null = null;
  let findFound: boolean | null = null;
  const find = args.find ? String(args.find).trim() : '';
  if (find) {
    const hit = findTerm(fullText, [find]);
    findApplied = find;
    if (hit) { off = Math.max(0, hit.index - 300); findFound = true; } else { findFound = false; }
  }
  const cap = Math.min(TEXT_CAP, Math.max(1000, Math.floor(Number(args.max_chars) || TEXT_DEFAULT_MAX)));
  const slice = fullText.slice(off, off + cap);
  const end = off + slice.length;
  const truncated = end < total;

  return {
    document_url: url,
    adsh: adshDashed,
    cik,
    filename,
    filing_index_url: `${archiveFolder(cik, adshDashed.replace(/-/g, ''))}/${adshDashed}-index.html`,
    total_chars: total,
    offset: off,
    returned_chars: slice.length,
    truncated,
    next_offset: truncated ? end : null,
    ...(findApplied !== null ? { find: findApplied, find_found: findFound } : {}),
    ...(rawTruncated
      ? {
          raw_truncated: true,
          raw_truncated_note: `This exhibit's raw HTML exceeds the ${(TEXT_MAX_BYTES / 1_000_000).toFixed(0)} MB read in one call, so total_chars and the text reflect only the portion read. Sections late in a long agreement (schedules, signature pages) may fall beyond it.`,
        }
      : {}),
    text: slice,
    source: 'SEC EDGAR archive (www.sec.gov/Archives)',
  };
}

async function contractsByCompany(args: Record<string, unknown>) {
  const company = args.company ? String(args.company).trim() : '';
  if (!company) throw new Error('company is required — a ticker ("ADBE"), company name ("Adobe") or CIK ("796343").');
  const family = normalizeExhibitType(args.exhibit_type);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 25)));
  const { start, end, note } = dateWindow(validDate(args.since, 'since'), validDate(args.until, 'until'), yearsAgoIso(5));

  const cf = await companyFilter(company);
  const params = new URLSearchParams({ q: BROAD_CONTRACT_QUERY, dateRange: 'custom', startdt: start, enddt: end });
  if ('ciks' in cf && cf.ciks) params.set('ciks', cf.ciks);
  if ('entityName' in cf && cf.entityName) params.set('entityName', cf.entityName);
  const form = args.form ? String(args.form).trim() : '';
  if (form) params.set('forms', form.split(',').map((f) => f.trim().toUpperCase()).filter(Boolean).join(','));

  applyCacheKeyToken(params);
  // efts orders by relevance; collect the window, then sort newest first.
  const scan = await scanExhibits(params, exhibitMatcher(family), MAX_PAGES_COMPANY * EFTS_PAGE, MAX_PAGES_COMPANY, guardFor('', 'ciks' in cf ? cf.ciks : undefined));
  const rows = scan.rows.sort((a, b) => (b.filing_date ?? '').localeCompare(a.filing_date ?? '') || a.exhibit_type.localeCompare(b.exhibit_type)).slice(0, limit);

  const notes: string[] = [];
  if (note) notes.push(note);
  if (!scan.exhausted) notes.push(`Scanned ${scan.docsScanned} of ${scan.total} documents in the window; a filer with more exhibits than that may have older ones beyond the scan — narrow with since/until or form.`);
  if (rows.length === 0) notes.push(`No ${familyLabel(family)} exhibits found for ${company} between ${start} and ${end}. ${'resolved' in cf && cf.resolved && 'entity_name_filter' in cf.resolved ? 'The name was not in the SEC ticker list, so EDGAR\'s entity-name filter was used — try the CIK.' : 'Widen since, or set exhibit_type:"all_exhibits".'}`);

  return {
    company: company,
    ...('resolved' in cf && cf.resolved ? { company_filter: cf.resolved } : {}),
    exhibit_type: family,
    exhibit_family: familyLabel(family),
    date_range: { since: start, until: end },
    ...(form ? { form } : {}),
    documents_scanned: scan.docsScanned,
    exhibits_returned: rows.length,
    filings_returned: new Set(rows.map((r) => r.adsh)).size,
    ...(notes.length ? { note: notes.join(' ') } : {}),
    results: rows,
    by_filing: groupByFiling(rows),
    source: 'SEC EDGAR full-text search (efts.sec.gov) — exhibit documents attached to filings since 2001',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'sec_contracts_search':
      return contractsSearch(args);
    case 'sec_contract_text':
      return contractText(args);
    case 'sec_contracts_by_company':
      return contractsByCompany(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 10 } } satisfies McpToolExport;
