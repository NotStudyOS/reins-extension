/**
 * Wire protocol shared between the Reins server and the browser extension.
 *
 * All RPCs are JSON messages over the same WebSocket. Every request has an
 * `id` correlator; the extension echoes `id` in its response so the server
 * can resolve the right pending promise.
 *
 * The request side (server → extension) uses { id, method, params }.
 * The response side (extension → server) uses { id, result?, error? }.
 * Extension-initiated push events (tab close, network event) use
 * { event, data } with no id.
 */

export type RpcId = number;

export interface RpcRequest<P = unknown> {
  id: RpcId;
  method: RpcMethod;
  params: P;
}

export interface RpcResponse<R = unknown> {
  id: RpcId;
  result?: R;
  error?: string;
}

export interface RpcEvent<D = unknown> {
  event: string;
  data: D;
}

export type RpcMethod =
  | "tabs.list"
  | "tabs.create"
  | "tabs.close"
  | "tabs.activate"
  | "navigate"
  | "click"
  | "type_text"
  | "eval"
  | "eval_wait"
  | "eval_fetch"
  | "eval_chunk"
  | "read_page"
  | "screenshot"
  | "read_network"
  | "read_network_extract"
  | "clear_network"
  | "cookies.get"
  | "cookies.set"
  | "ping"
  // Tier 1
  | "wait_for_selector"
  | "wait_for_url"
  | "attach_debugger_all"
  | "download_file"
  // Tier 2
  | "open_devtools"
  | "window.create"
  | "window.list"
  | "storage.get"
  | "storage.set"
  | "cookies.clear"
  | "intercept.set"
  | "intercept.clear"
  // Tier 4
  | "network.stream_start"
  | "network.stream_stop"
  | "har_export"
  | "dom.xpath"
  | "dom.all_links"
  | "dom.form_schema"
  // Tier 5
  | "ws.capture_start"
  | "ws.capture_stop"
  | "ws.read"
  | "service_worker.eval"
  // Tier 6 — bulk crawl helpers
  | "dom.query"
  | "click_all_matching"
  | "navigate_sequence"
  // Tier 7 — interaction + waits
  | "scroll"
  | "hover"
  | "press_key"
  | "wait_for_network_idle"
  // Tier 8 — history, locators, frames, a11y, storage
  | "back"
  | "forward"
  | "reload"
  | "wait_for_text"
  | "find_elements"
  | "select_option"
  | "iframe.list"
  | "iframe.eval"
  | "console.logs"
  | "clear_storage"
  | "accessibility.tree"
  // Tier 9 — shortcuts + CDP emulation + file ops
  | "click_by_text"
  | "drag_drop"
  | "upload_file"
  | "set_viewport"
  | "set_user_agent"
  | "throttle_network"
  | "block_urls"
  | "pdf_export"
  // Tier 10 — meta + new mechanics (existing tools fattened in place)
  | "performance_metrics"
  | "wait_for_dom_stable"
  | "wait_for_response"
  | "health"
  | "capabilities"
  | "bug_report"
  | "session_export"
  // Tier 11 — fat composables (extract/audit/api_inspect/page_map/etc.)
  | "extract"
  | "audit"
  | "api_inspect"
  | "page_map"
  | "viewport_matrix"
  | "monitor_diff"
  | "workflow"
  | "emulate"
  | "detect_framework"
  // Tier 12 — single-purpose new tools
  | "infinite_scroll_extract"
  | "link_graph"
  | "selector_suggest"
  | "locator_heal"
  | "click_by_label"
  | "fill_form_from_json"
  | "broken_links_check"
  | "memory_sample"
  | "animation_inspect"
  | "route_change_wait"
  | "anti_bot_detect"
  | "lighthouse_quick"
  | "export_csv"
  | "dedupe_items"
  | "schema_infer"
  | "asset_capture"
  | "bundle_resources"
  | "forms_validate"
  // Tier 13 — counterfactual probe
  | "probe";

// ────────────────────────────────────────────────────────────────────────────
// Tier 13 — probe (counterfactual loop: before → mutate → act → expect → after)
// ────────────────────────────────────────────────────────────────────────────

export type ProbeMutation =
  // network
  | { kind: "intercept"; urlPattern?: string; urlRegex?: string; action: "block" | "fulfill" | "redirect"; statusCode?: number; responseBody?: string; responseHeaders?: Record<string, string>; redirectTo?: string }
  | { kind: "block_urls"; patterns: string[]; regex?: boolean }
  | { kind: "throttle"; preset?: "slow_3g" | "fast_3g" | "slow_4g"; downloadThroughput?: number; uploadThroughput?: number; latencyMs?: number }
  | { kind: "offline" }
  | { kind: "mock_response"; urlPattern: string; status?: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "latency"; urlPattern: string; ms: number }
  | { kind: "flaky"; urlPattern: string; failEvery?: number; failStatus?: number }
  // identity
  | { kind: "clear_storage"; kinds?: Array<"localStorage" | "sessionStorage" | "indexedDB" | "caches" | "cookies"> }
  | { kind: "set_storage"; entries: Partial<Record<"local" | "session", Record<string, string>>> }
  | { kind: "clear_cookies"; url?: string; domain?: string }
  | { kind: "set_cookies"; cookies: Array<{ url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean }> }
  // environment
  | { kind: "viewport"; width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
  | { kind: "user_agent"; value: string; acceptLanguage?: string; platform?: string }
  | { kind: "timezone"; id: string }
  | { kind: "locale"; value: string }
  | { kind: "geolocation"; latitude: number; longitude: number; accuracy?: number }
  | { kind: "permissions"; map: Record<string, "granted" | "denied" | "prompt"> }
  | { kind: "color_scheme"; value: "light" | "dark" }
  | { kind: "reduced_motion"; value: "reduce" | "no-preference" }
  // page
  | { kind: "inject_js"; code: string }
  | { kind: "delete_dom"; selector: string }
  | { kind: "freeze_time"; epochMs?: number }
  | { kind: "freeze_random"; seed?: number }
  | { kind: "stub_global"; path: string; value?: unknown };

export type ProbeAction =
  | { kind: "click"; selector: string }
  | { kind: "click_by_label"; label: string; mode?: "exact" | "contains" | "regex"; role?: string }
  | { kind: "type"; selector: string; text: string; clear?: boolean }
  | { kind: "fill_form"; data: Record<string, unknown>; selector?: string; submit?: boolean }
  | { kind: "press_key"; key: string; selector?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
  | { kind: "scroll"; selector?: string; intoView?: string; dy?: number; dx?: number }
  | { kind: "hover"; selector: string }
  | { kind: "navigate"; url: string }
  | { kind: "reload"; bypassCache?: boolean }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "wait"; ms: number }
  | { kind: "wait_for"; selector?: string; text?: string; url?: string; networkIdle?: boolean; domStable?: boolean; timeoutMs?: number }
  | { kind: "workflow_replay"; name: string }
  | { kind: "eval"; code: string };

export interface ProbeWatch {
  /** Quiet window after `act` finishes before evidence is collected. Default 1500ms. */
  settleMs?: number;
  /** Subtree to scope DOM diffs. Default: body. */
  domSelector?: string;
  /** Console levels included in the delta. Default ["error","warn"]. */
  consoleLevels?: Array<"log" | "info" | "warn" | "error" | "debug">;
  /** Restrict failed-network counting to URLs matching this substring. */
  networkPattern?: string;
  /** Snapshot performance metrics before/after. */
  capturePerf?: boolean;
  /** Include before+after viewport screenshots in evidence. */
  captureScreenshots?: boolean;
}

export type ProbeExpectation =
  | { kind: "request_fires"; urlPattern?: string; urlRegex?: string; statusMin?: number; statusMax?: number }
  | { kind: "error_visible" }
  | { kind: "route_changes"; pattern?: string }
  | { kind: "no_console_errors" }
  | { kind: "dom_stable"; idleMs?: number }
  | { kind: "selector_appears"; selector: string }
  | { kind: "selector_gone"; selector: string }
  | { kind: "text_appears"; text: string }
  | { kind: "no_broken_images" }
  | { kind: "response_shape"; urlPattern: string; shape: unknown };

export interface ProbeParams {
  tabId: number;
  /** Free-form name surfaced in steps + result. */
  label?: string;
  /** Setup applied once. NOT auto-restored — caller cleans up via `after` if needed. */
  before?: ProbeMutation[];
  /** The counterfactual. Auto-restored after observation. */
  mutate?: ProbeMutation[];
  /** User behavior. Mutations may be interleaved inline. */
  act?: Array<ProbeAction | ProbeMutation>;
  /** What to watch during the observe window. */
  watch?: ProbeWatch;
  /** Soft assertions. Drives the verdict; empty array → heuristic verdict. */
  expect?: ProbeExpectation[];
  /** Caller-owned cleanup. Runs even if earlier phases threw. */
  after?: ProbeAction[];
}

export interface ProbeStep {
  phase: "before" | "mutate" | "act" | "observe" | "expect" | "restore" | "after";
  tool: string;
  ok: boolean;
  error?: string;
  ms: number;
  /** Step-specific notes (e.g. ruleId for intercept, key for storage). */
  meta?: Record<string, unknown>;
}

export interface ProbeExpectationResult {
  expectation: ProbeExpectation;
  status: "pass" | "fail" | "n/a";
  detail?: string;
}

export interface ProbeResult {
  label?: string;
  verdict: "recovered_gracefully" | "degraded_with_signal" | "silent_failure" | "error";
  summary: string;
  evidence: {
    consoleErrorsAdded: number;
    failedRequestsAdded: number;
    domChanged: boolean;
    routeChanged: boolean;
    a11yErrorMessageFound: boolean;
    visibleErrorText?: string;
    loadingStillVisible: boolean;
    perfBefore?: PerformanceMetricsResult;
    perfAfter?: PerformanceMetricsResult;
    screenshotsBase64?: { before?: string; after?: string };
    urlBefore: string;
    urlAfter: string;
  };
  expectations: ProbeExpectationResult[];
  steps: ProbeStep[];
  startedAt: string;
  durationMs: number;
}

/** tabs.list */
export interface TabsListResult {
  tabs: Array<{
    id: number;
    url: string;
    title: string;
    active: boolean;
    windowId: number;
  }>;
}

/** navigate */
export interface NavigateParams {
  tabId?: number;
  url: string;
}
export interface NavigateResult {
  tabId: number;
  url: string;
}

/** click — by CSS selector in a tab */
export interface ClickParams {
  tabId: number;
  selector: string;
}

/** type_text — focus a selector, type a value */
export interface TypeTextParams {
  tabId: number;
  selector: string;
  text: string;
  clear?: boolean;
}

/** eval — run JS in page context, return the last expression */
export interface EvalParams {
  tabId: number;
  code: string;
}
export interface EvalResult {
  value: unknown;
}

/** read_page — DOM text + title, optionally with structured extracts. */
export interface ReadPageParams {
  tabId: number;
  /** Pull structured data alongside the page text. Each flag adds a key
   *  to the `extracted` field of the result. All default to false so
   *  cheap calls stay cheap. */
  extract?: {
    jsonLd?: boolean;
    openGraph?: boolean;
    twitter?: boolean;
    tables?: boolean;
    headings?: boolean;
    links?: boolean;
  };
}
export interface ReadPageResult {
  title: string;
  url: string;
  text: string;
  extracted?: {
    jsonLd?: unknown[];
    openGraph?: Record<string, string>;
    twitter?: Record<string, string>;
    tables?: Array<{ headers: string[]; rows: string[][] }>;
    headings?: Array<{ level: number; text: string }>;
    links?: Array<{ href: string; text: string; rel?: string }>;
  };
}

/** screenshot — returns base64 png. Three modes:
 *  - default: visible viewport.
 *  - selector: crop to an element's bounding rect.
 *  - clip: crop to absolute {x,y,w,h} in CSS pixels.
 *  fullPage stitches scroll positions (Chrome-only, requires debugger). */
export interface ScreenshotParams {
  tabId?: number;
  fullPage?: boolean;
  selector?: string;
  clip?: { x: number; y: number; w: number; h: number };
}
export interface ScreenshotResult {
  pngBase64: string;
  /** Present when `selector` or `clip` was passed. */
  width?: number;
  height?: number;
}

/** read_network — everything captured via chrome.debugger since last clear */
export interface ReadNetworkParams {
  tabId?: number;
  urlPattern?: string;
  limit?: number;
  includeBodies?: boolean;
}
export interface NetworkEntry {
  requestId: string;
  tabId: number;
  url: string;
  method: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBase64?: boolean;
  timing?: { startedMs: number; endedMs?: number };
}
export interface ReadNetworkResult {
  entries: NetworkEntry[];
}

/** cookies.get / cookies.set
 *  Either `url` or `domain` must be provided. `nameRegex` filters the
 *  returned set; `name` is exact match (kept for ergonomics). */
export interface CookiesGetParams {
  url?: string;
  domain?: string;
  name?: string;
  nameRegex?: string;
  nameFlags?: string;
}
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
}
export interface CookiesGetResult {
  cookies: CookieRecord[];
}
export interface CookiesSetParams extends CookieRecord {
  url: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 1 — workflow unlocks
// ────────────────────────────────────────────────────────────────────────────

/** wait_for_selector */
export interface WaitForSelectorParams {
  tabId: number;
  selector: string;
  timeoutMs?: number;   // default 15000
  visible?: boolean;    // require offsetParent !== null, default true
  pollMs?: number;      // default 100
}
export interface WaitForSelectorResult {
  found: boolean;
  elapsedMs: number;
}

/** wait_for_url */
export interface WaitForUrlParams {
  tabId: number;
  pattern: string;       // JS regex source
  flags?: string;        // default "i"
  timeoutMs?: number;    // default 15000
}
export interface WaitForUrlResult {
  matched: boolean;
  url: string;
  elapsedMs: number;
}

/** attach_debugger_all — arm capture on every current + future tab */
export interface AttachDebuggerAllResult {
  attached: number[];
  failed: Array<{ tabId: number; error: string }>;
}

/** download_file */
export interface DownloadFileParams {
  tabId?: number;                      // context tab (for cookies/headers)
  url: string;
  method?: string;                     // default GET
  headers?: Record<string, string>;
  body?: string;
  asBase64?: boolean;                  // default false (text)
}
export interface DownloadFileResult {
  status: number;
  contentType?: string;
  size: number;
  body: string;        // utf-8 text or base64 depending on asBase64
  base64: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 2 — multi-page / session
// ────────────────────────────────────────────────────────────────────────────

export interface OpenDevtoolsParams {
  tabId: number;
}

export interface WindowCreateParams {
  url?: string;
  incognito?: boolean;
  width?: number;
  height?: number;
  state?: "normal" | "maximized" | "minimized" | "fullscreen";
}
export interface WindowCreateResult {
  windowId: number;
  tabId: number | null;
}

export interface WindowListResult {
  windows: Array<{
    id: number;
    focused: boolean;
    incognito: boolean;
    state: string;
    tabIds: number[];
  }>;
}

/** storage.get — read across one or more web-storage areas in a tab.
 *  Pass `kinds: ["local","session"]` for both, or omit for both. */
export interface StorageGetParams {
  tabId: number;
  kinds?: Array<"local" | "session">;
  keys?: string[];   // omit → all keys, applied to every kind
}
export interface StorageGetResult {
  /** Map keyed by storage area → its key/value pairs. */
  values: Record<"local" | "session", Record<string, string | null>>;
}
/** storage.set — write to one or more areas. `entries` maps area →
 *  key/value object so a single call can populate both. */
export interface StorageSetParams {
  tabId: number;
  entries: Partial<Record<"local" | "session", Record<string, string>>>;
}

export interface CookiesClearParams {
  url?: string;       // if set, only cookies matching this URL
  domain?: string;    // if set, all cookies on/under this domain
}
export interface CookiesClearResult {
  removed: number;
}

export interface InterceptRule {
  id?: string;                            // client-chosen; else we assign
  urlPattern: string;                     // matches URL substring or regex
  regex?: boolean;                        // treat urlPattern as regex
  action: "block" | "fulfill" | "redirect";
  statusCode?: number;                    // for fulfill (default 200)
  responseHeaders?: Record<string, string>;
  responseBody?: string;                  // for fulfill (utf-8)
  responseBase64?: boolean;
  redirectTo?: string;                    // for redirect
}
export interface InterceptSetParams {
  tabId?: number;     // optional scope
  rules: InterceptRule[];
}
export interface InterceptSetResult {
  ruleIds: string[];
}
export interface InterceptClearParams {
  tabId?: number;
  ruleIds?: string[];  // omit → clear all
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 4 — quality of life
// ────────────────────────────────────────────────────────────────────────────

export interface ReadNetworkFilters {
  tabId?: number;
  urlPattern?: string;          // substring
  urlRegex?: string;            // regex source (takes precedence)
  hostRegex?: string;           // regex against URL host only
  mimeType?: string;            // exact match on Content-Type primary type
  /** Methods to include (case-insensitive). Default: any. */
  methods?: string[];
  statusMin?: number;
  statusMax?: number;
  /** Shortcut: status >= 400 OR transport-level failure. Equivalent to
   *  passing statusMin=400, but also catches blocked / aborted requests
   *  with no status. */
  failedOnly?: boolean;
  /** Return only entries with these requestIds. Useful as a follow-up
   *  to a summary call to fetch full headers/bodies for one row. */
  requestIds?: string[];
  sinceMs?: number;             // startedMs > sinceMs
  limit?: number;
  includeBodies?: boolean;
}

export interface ReadNetworkExtractParams extends ReadNetworkFilters {
  /** JS function body that receives (body, entry) and returns data to collect.
   *  `body` is the parsed JSON when content-type includes json, else a raw string.
   *  `entry` is {url, method, status}. Return any serializable value; returning
   *  undefined omits the entry. Example: "return body.markets?.map(m=>m.marketType?.name);" */
  extract: string;
  /** When true, merge arrays returned by extract into one flat output array.
   *  Useful for "collect all names across all responses". Default true. */
  flatten?: boolean;
  /** When true, deduplicate primitive values in the output array. Default false. */
  unique?: boolean;
  /** Hard cap on output array size (post-flatten). Default 5000. */
  maxItems?: number;
}
export interface ReadNetworkExtractResult {
  matchedEntries: number;
  items: unknown[];
  errors: Array<{ url: string; error: string }>;
}

export interface NetworkStreamStartParams {
  tabId?: number;
  urlPattern?: string;
}
export interface NetworkStreamStartResult {
  streamId: string;
}
export interface NetworkStreamStopParams {
  streamId: string;
}

/** HAR export — returns a HAR 1.2 JSON string. */
export interface HarExportParams {
  tabId?: number;
  urlPattern?: string;
  includeBodies?: boolean;
}
export interface HarExportResult {
  harJson: string;
}

export interface DomXpathParams {
  tabId: number;
  xpath: string;
  attr?: string;     // if set, read this attribute instead of textContent
}
export interface DomXpathResult {
  values: string[];
}

export interface DomAllLinksParams {
  tabId: number;
}
export interface DomAllLinksResult {
  links: Array<{ href: string; text: string; rel?: string }>;
}

export interface DomFormSchemaParams {
  tabId: number;
}
export interface DomFormSchemaResult {
  forms: Array<{
    action: string;
    method: string;
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      value: string;
      options?: string[];
    }>;
  }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 5 — bonus power
// ────────────────────────────────────────────────────────────────────────────

export interface WsCaptureStartParams {
  tabId: number;
  urlPattern?: string;       // filter by URL substring
}
export interface WsCaptureStartResult {
  captureId: string;
}
export interface WsCaptureStopParams {
  captureId: string;
}
export interface WsReadParams {
  captureId: string;
  sinceIndex?: number;        // return frames whose ordinal > sinceIndex
  limit?: number;
}
export interface WsFrame {
  index: number;
  ts: number;
  url: string;
  direction: "c2s" | "s2c";
  opcode?: number;
  payload: string;            // text, or base64 when binary
  binary: boolean;
}
export interface WsReadResult {
  frames: WsFrame[];
  nextIndex: number;
}

export interface ServiceWorkerEvalParams {
  scope: string;              // site origin or SW scope URL
  code: string;
}
export interface ServiceWorkerEvalResult {
  value: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 6 — bulk crawl helpers
// ────────────────────────────────────────────────────────────────────────────

/** dom.query — arbitrary CSS selector. The fat-tool that absorbs
 *  dom.outer_html, dom.inspect_styles, dom.highlight, and shadow-DOM
 *  piercing. Pass only the flags you need; default response is small. */
export interface DomQueryParams {
  tabId: number;
  selector: string;
  /** Attribute names to pull from each match. "href" is always included when
   *  the element has one; pass extras here. */
  attrs?: string[];
  /** Max matches to return. Default 500. */
  limit?: number;
  /** If true, only return matches that are visible (offsetParent set, w/h>0). */
  visibleOnly?: boolean;
  /** Pierce open shadow roots when querying. Default false. */
  pierceShadow?: boolean;
  /** Per-match getBoundingClientRect(). */
  boundingRect?: boolean;
  /** Per-match getComputedStyle() values for these property names. */
  computedStyles?: string[];
  /** Include element.outerHTML, capped at outerHtmlMaxBytes (default 50000). */
  outerHtml?: boolean;
  outerHtmlMaxBytes?: number;
  /** Briefly outline matches in the page (red 2px) for `highlightMs` ms,
   *  then auto-clear. 0 / undefined = no highlight. */
  highlightMs?: number;
}
export interface DomQueryMatch {
  text: string;
  href?: string;
  attrs?: Record<string, string>;
  rect?: { x: number; y: number; w: number; h: number };
  styles?: Record<string, string>;
  outerHtml?: string;
  outerHtmlTruncated?: boolean;
}
export interface DomQueryResult {
  matches: DomQueryMatch[];
  total: number;            // pre-limit count
}

/** click_all_matching — click every element matching selector, one at a
 *  time, with a settle delay between clicks. Use to drive list-style UIs
 *  (every game card, every tab in a strip). */
export interface ClickAllMatchingParams {
  tabId: number;
  selector: string;
  /** Delay between clicks in ms. Default 800. */
  delayMs?: number;
  /** Cap on clicks so a greedy selector doesn't run away. Default 40. */
  max?: number;
  /** If true, click only elements visible in viewport. Default false. */
  visibleOnly?: boolean;
  /** If set, re-query the selector before each click so dynamic lists
   *  (items loaded on scroll) work. Default true. */
  reQuery?: boolean;
}
export interface ClickAllMatchingResult {
  clicked: number;
  skipped: number;
}

/** navigate_sequence — navigate a tab through a list of URLs with a
 *  settle delay between each. Saves a round-trip per hop when crawling
 *  a sitemap. */
export interface NavigateSequenceParams {
  tabId: number;
  urls: string[];
  /** Milliseconds to pause after each navigation (let the page settle
   *  + XHRs fire). Default 3000. */
  settleMs?: number;
  /** Stop on first navigation error. Default false. */
  stopOnError?: boolean;
}
export interface NavigateSequenceResult {
  visited: Array<{ url: string; ok: boolean; error?: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 7 — interaction + waits
// ────────────────────────────────────────────────────────────────────────────

/** scroll — scroll a tab by a delta, to absolute coordinates, or bring
 *  a selector into view. Unblocks infinite-scroll / virtualized list
 *  patterns where the data only renders on demand. */
export interface ScrollParams {
  tabId: number;
  /** Scroll a specific element (CSS selector). Default: window. */
  selector?: string;
  /** Bring a target selector into view. Takes priority over x/y/dy. */
  intoView?: string;
  /** Absolute scrollTop/scrollLeft. Ignored when intoView is set. */
  x?: number;
  y?: number;
  /** Relative deltas from current position. Ignored when x/y/intoView set. */
  dx?: number;
  dy?: number;
  /** Scroll behavior. Default "auto". */
  behavior?: "auto" | "smooth";
}
export interface ScrollResult {
  /** Final scroll position after the call. */
  x: number;
  y: number;
  /** Max scrollable in each axis (scrollSize - clientSize). */
  maxX: number;
  maxY: number;
}

/** hover — dispatch mouseover / mouseenter so hover-gated menus reveal.
 *  Clicks alone do not trigger hover reveal; this fills that gap. */
export interface HoverParams {
  tabId: number;
  selector: string;
}

/** press_key — dispatch keydown+keyup (and keypress for printable keys)
 *  on a focused element. type_text bypasses native key listeners by
 *  setting .value; this routes through real KeyboardEvents so
 *  single-page-app forms that listen for Enter / Escape / Tab actually
 *  react. */
export interface PressKeyParams {
  tabId: number;
  /** Key value, e.g. "Enter", "Escape", "Tab", "ArrowDown", "a". */
  key: string;
  /** Target selector. Default: document.activeElement or document.body. */
  selector?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** wait_for_network_idle — block until the extension sees no new
 *  network requests for `idleMs` ms (or timeout). Much more reliable
 *  than a fixed sleep when deciding "page done loading". Relies on the
 *  same capture buffer as read_network. */
export interface WaitForNetworkIdleParams {
  tabId?: number;
  /** Only count requests matching this URL substring. Default: any. */
  urlPattern?: string;
  /** Ms of quiet before declaring idle. Default 800. */
  idleMs?: number;
  /** Overall timeout. Default 15000. */
  timeoutMs?: number;
}
export interface WaitForNetworkIdleResult {
  idle: boolean;
  elapsedMs: number;
  observedRequests: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 8 — history, locators, frames, a11y, storage
// ────────────────────────────────────────────────────────────────────────────

/** back / forward / reload — tab history navigation. */
export interface HistoryParams {
  tabId: number;
  /** reload: if true, bypass cache. */
  bypassCache?: boolean;
}

/** wait_for_text — block until a substring (or regex) appears in the
 *  rendered text of a tab. Covers the very common case where
 *  wait_for_selector is overkill (don't know the selector) and eval
 *  polling is verbose. */
export interface WaitForTextParams {
  tabId: number;
  /** Substring to look for; or pass regex+flags for regex match. */
  text?: string;
  regex?: string;
  flags?: string;
  /** Scope to a subtree. Default: document.body. */
  selector?: string;
  timeoutMs?: number;     // default 15000
  pollMs?: number;        // default 250
}
export interface WaitForTextResult {
  found: boolean;
  elapsedMs: number;
  /** The matched snippet (or empty if not found). */
  match: string;
}

/** find_elements — Playwright-style locator by role + accessible name +
 *  visible text. Returns a CSS-selector-ish path per match so the
 *  caller can follow up with click / screenshot_element. */
export interface FindElementsParams {
  tabId: number;
  /** ARIA role filter (e.g. "button", "link", "tab"). Uses element tag
   *  fallback when no explicit role attribute. Optional. */
  role?: string;
  /** Exact accessible-name / innerText match (or regex via nameRegex). */
  name?: string;
  nameRegex?: string;
  nameFlags?: string;
  /** Substring match — faster than regex, use for "contains X". */
  nameContains?: string;
  /** Only visible (offsetParent !== null) elements. Default true. */
  visibleOnly?: boolean;
  limit?: number;   // default 25
}
export interface FindElementsMatch {
  /** A selector you can pass back to click / screenshot_element. */
  selector: string;
  role: string;
  name: string;
  tag: string;
  rect: { x: number; y: number; w: number; h: number };
  visible: boolean;
}
export interface FindElementsResult {
  matches: FindElementsMatch[];
  total: number;
}

/** select_option — pick an option on a native <select>. Clicking a
 *  <select> only opens the dropdown; this sets value + fires change. */
export interface SelectOptionParams {
  tabId: number;
  selector: string;
  /** Either value= or label=. value wins if both provided. */
  value?: string;
  label?: string;
  /** Pass true to allow multiple on a multi-select. Default false. */
  multiple?: boolean;
}
export interface SelectOptionResult {
  selected: string[];
}

/** iframe.list — enumerate frames on a tab (id, url, name, parent). */
export interface IframeListParams {
  tabId: number;
}
export interface IframeListResult {
  frames: Array<{
    frameId: string;       // Chrome frameId, unique within tab
    url: string;
    name: string;
    parentFrameId: string | null;
  }>;
}

/** iframe.eval — run code inside one or many frames. Either pass a
 *  specific `frameId` (from iframe.list), or set `allFrames: true` to
 *  fan out across every frame and return one result per frame. Use
 *  `frameUrlPattern` (substring) or `frameUrlRegex` to scope the fan-out. */
export interface IframeEvalParams {
  tabId: number;
  code: string;
  frameId?: string;
  allFrames?: boolean;
  frameUrlPattern?: string;
  frameUrlRegex?: string;
}
export interface IframeEvalFrameResult {
  frameId: string;
  url: string;
  value?: unknown;
  error?: string;
}
export interface IframeEvalResult {
  /** When fanning out (allFrames or pattern), one entry per frame. When a
   *  single frameId is passed, exactly one entry. */
  frames: IframeEvalFrameResult[];
}

/** console.logs — return buffered console.* output AND uncaught exceptions
 *  from the page. Requires debugger attached (same channel as read_network).
 *  Single tool covers everything: pass `levels` and/or `sources` to scope
 *  to errors-only, exceptions-only, etc. */
export interface ConsoleLogsParams {
  tabId?: number;
  /** Substring filter against the rendered text. */
  contains?: string;
  /** Regex filter against the rendered text (alternative to `contains`). */
  containsRegex?: string;
  containsFlags?: string;
  /** Levels to include. Default: all. Examples:
   *   ["error"]              — page errors only
   *   ["error","warn"]       — errors + warnings
   *   ["log","info","debug"] — chatter only
   */
  levels?: Array<"log" | "info" | "warn" | "error" | "debug">;
  /** Origin of the entry. "console" = console.* call, "exception" =
   *  uncaught exception or unhandled rejection. Default: both. */
  sources?: Array<"console" | "exception">;
  limit?: number;     // default 200
  sinceMs?: number;   // ts > sinceMs
}
export interface ConsoleLogEntry {
  tabId: number;
  ts: number;
  level: string;
  text: string;
  source?: string;
  url?: string;
  lineNumber?: number;
}
export interface ConsoleLogsResult {
  logs: ConsoleLogEntry[];
}

/** clear_storage — nuke local/session/indexedDB/cacheStorage for the
 *  origin of a tab. Use before scripted login flows. */
export interface ClearStorageParams {
  tabId: number;
  /** Which stores to clear; default everything. */
  kinds?: Array<"localStorage" | "sessionStorage" | "indexedDB" | "caches" | "cookies">;
}
export interface ClearStorageResult {
  cleared: string[];
}

/** accessibility.tree — structured AX snapshot (richer than read_page).
 *  Labels + roles + names; strips offscreen / ignored nodes by default. */
export interface AccessibilityTreeParams {
  tabId: number;
  /** Include nodes the platform marked ignored. Default false. */
  includeIgnored?: boolean;
  /** Max nodes to return. Default 2000. */
  limit?: number;
}
export interface AxNode {
  nodeId: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  children: AxNode[];
}
export interface AccessibilityTreeResult {
  root: AxNode | null;
  nodeCount: number;
  truncated: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 9 — shortcuts + CDP emulation + file ops
// ────────────────────────────────────────────────────────────────────────────

/** click_by_text — locate an element by role+name (same matcher as
 *  find_elements) then click the first visible match. One round-trip. */
export interface ClickByTextParams {
  tabId: number;
  role?: string;
  name?: string;
  nameRegex?: string;
  nameFlags?: string;
  nameContains?: string;
  /** If >1 match, pick by 0-based index (default 0). */
  index?: number;
}
export interface ClickByTextResult {
  clicked: boolean;
  selector: string;
  matchName: string;
  total: number;
}

/** drag_drop — synthetic HTML5 drag + drop between two elements. */
export interface DragDropParams {
  tabId: number;
  source: string;
  target: string;
  /** Delay ms between dragstart/move/end. Default 50. */
  delayMs?: number;
}

/** upload_file — inject a file (bytes or URL-fetched) into an
 *  <input type=file>. Standard click-to-open dialog can't be scripted;
 *  we build a File + assign it via DataTransfer. */
export interface UploadFileParams {
  tabId: number;
  selector: string;
  filename: string;
  mimeType?: string;
  /** Either bytes (base64) or sourceUrl. */
  base64?: string;
  sourceUrl?: string;
}
export interface UploadFileResult {
  filename: string;
  size: number;
}

/** set_viewport — override device metrics. Pass all zeros / omit
 *  to clear. deviceScaleFactor default 1, mobile default false. */
export interface SetViewportParams {
  tabId: number;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  /** Pass true to clear any prior override and restore real metrics. */
  clear?: boolean;
}

/** set_user_agent — override UA string (and optional Accept-Language). */
export interface SetUserAgentParams {
  tabId: number;
  userAgent: string;
  acceptLanguage?: string;
  platform?: string;
  /** Pass true to clear the override. userAgent required but ignored. */
  clear?: boolean;
}

/** throttle_network — CDP emulateNetworkConditions. Presets (slow_3g,
 *  fast_3g, slow_4g, offline) or raw values. */
export interface ThrottleNetworkParams {
  tabId: number;
  preset?: "offline" | "slow_3g" | "fast_3g" | "slow_4g" | "reset";
  offline?: boolean;
  /** Download throughput bytes/s. */
  downloadThroughput?: number;
  uploadThroughput?: number;
  /** Round-trip latency ms. */
  latencyMs?: number;
}

/** block_urls — install a simple block list. Uses the same intercept
 *  infra as intercept.set but with a one-line API for the common case. */
export interface BlockUrlsParams {
  tabId?: number;
  patterns: string[];    // substring match; wildcard via * if regex=true
  regex?: boolean;
}
export interface BlockUrlsResult {
  ruleIds: string[];
}

/** pdf_export — CDP Page.printToPDF. Returns base64 PDF. */
export interface PdfExportParams {
  tabId: number;
  landscape?: boolean;
  printBackground?: boolean;
  /** Paper size in inches. Default 8.5x11. */
  paperWidth?: number;
  paperHeight?: number;
  /** Scale (0.1–2). Default 1. */
  scale?: number;
}
export interface PdfExportResult {
  pdfBase64: string;
  bytes: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 10 — meta + new mechanics
// ────────────────────────────────────────────────────────────────────────────

/** performance_metrics — Web Vitals + navigation/resource timing. Pulled
 *  from PerformanceObserver and the Performance API in-page. No CDP. */
export interface PerformanceMetricsParams {
  tabId: number;
  /** Include the full PerformanceResourceTiming list. Default false. */
  includeResources?: boolean;
}
export interface PerformanceMetricsResult {
  /** Largest Contentful Paint, ms since navigation start. */
  lcpMs?: number;
  /** Cumulative Layout Shift score. */
  cls?: number;
  /** First Contentful Paint, ms. */
  fcpMs?: number;
  /** Time to first byte (responseStart - requestStart), ms. */
  ttfbMs?: number;
  /** First Input Delay if observed, ms. */
  fidMs?: number;
  /** Worst observed long-task duration, ms. */
  longestTaskMs?: number;
  /** PerformanceNavigationTiming top-level fields, ms relative to nav start. */
  nav?: {
    domContentLoadedEventEnd?: number;
    loadEventEnd?: number;
    domInteractive?: number;
    type?: string;
  };
  resourceCount: number;
  resources?: Array<{
    name: string;
    initiatorType: string;
    durationMs: number;
    transferSize?: number;
  }>;
}

/** wait_for_dom_stable — block until no DOM mutations have been observed
 *  for `idleMs` ms (or timeout). Useful after triggering an async UI
 *  update where you don't have a precise selector to wait on. */
export interface WaitForDomStableParams {
  tabId: number;
  /** Subtree root. Default: document.body. */
  selector?: string;
  /** Quiet window in ms. Default 500. */
  idleMs?: number;
  /** Overall timeout in ms. Default 15000. */
  timeoutMs?: number;
}
export interface WaitForDomStableResult {
  stable: boolean;
  elapsedMs: number;
  mutationsObserved: number;
}

/** wait_for_response — block until the network capture sees a request
 *  matching the given filters AND meeting the optional status range.
 *  Resolves with the matched entry's id so the caller can fetch full
 *  bodies via read_network({ requestIds: [...] }). */
export interface WaitForResponseParams {
  tabId?: number;
  urlPattern?: string;
  urlRegex?: string;
  hostRegex?: string;
  methods?: string[];
  statusMin?: number;
  statusMax?: number;
  /** Body substring/regex filters (only applied when bodies are buffered). */
  bodyContains?: string;
  bodyRegex?: string;
  timeoutMs?: number;       // default 15000
  pollMs?: number;          // default 200
}
export interface WaitForResponseResult {
  matched: boolean;
  elapsedMs: number;
  requestId?: string;
  url?: string;
  status?: number;
}

/** health — extension+worker liveness + attached-tab summary. */
export interface HealthResult {
  ok: true;
  worker: { version: string };
  extension: {
    connected: boolean;
    version?: string;
    attachedTabs: number[];
  };
  /** ISO timestamp at the worker. */
  ts: string;
}

/** capabilities — machine-readable list of supported tools and the
 *  browser-side permissions required for each. Lets clients render a
 *  feature matrix without hard-coding it. */
export interface CapabilitiesResult {
  version: string;
  tools: Array<{
    name: string;
    /** Free-text describing the tool's effect. */
    description: string;
    /** Permissions the extension must hold for this tool to work
     *  (e.g. "debugger", "cookies", "downloads"). */
    permissions: string[];
    /** Whether the tool requires chrome.debugger to be attached. */
    requiresDebugger: boolean;
  }>;
}

/** bug_report — composite. Captures console errors, failed network,
 *  perf snapshot, current URL, and a viewport screenshot in one call.
 *  Suitable for "the page is broken, gather everything." */
export interface BugReportParams {
  tabId: number;
  /** Include a viewport screenshot (base64 png). Default true. */
  includeScreenshot?: boolean;
  /** Include the most-recent N console entries (errors+warns+exceptions).
   *  Default 50. */
  consoleLimit?: number;
  /** Include the most-recent N failed network entries. Default 25. */
  networkLimit?: number;
}
export interface BugReportResult {
  url: string;
  title: string;
  capturedAt: string;
  console: ConsoleLogEntry[];
  failedNetwork: NetworkEntry[];
  performance: PerformanceMetricsResult;
  screenshotPngBase64?: string;
}

/** session_export — bundle of (HAR + console log + DOM snapshot +
 *  screenshot) suitable for offline analysis or attaching to a ticket. */
export interface SessionExportParams {
  tabId: number;
  /** Include response bodies in the HAR. Default false (smaller). */
  includeBodies?: boolean;
  /** Include outerHTML of the document at capture time. Default true. */
  includeDom?: boolean;
  /** Include a viewport screenshot. Default true. */
  includeScreenshot?: boolean;
}
export interface SessionExportResult {
  url: string;
  capturedAt: string;
  harJson: string;
  console: ConsoleLogEntry[];
  domHtml?: string;
  screenshotPngBase64?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 11 — fat composable tools
// ────────────────────────────────────────────────────────────────────────────

/** extract — one tool, many extraction shapes. `type` selects the
 *  extractor; `selector` (when set) scopes the extractor to a subtree;
 *  some types accept extra options. Returns `{type, items}` for list-shaped
 *  extractors and `{type, data}` for single-shaped ones. */
export type ExtractType =
  | "page"        // title/url/text/headings/links/meta as one blob
  | "article"     // readability-like: title, byline, date, body, hero
  | "products"    // product cards: name, price, currency, url, image, availability
  | "prices"      // free-floating prices on the page (currency + amount + nearby text)
  | "contacts"    // emails, phones, addresses, social links
  | "jobs"        // job postings
  | "events"      // event listings
  | "tables"      // every <table> normalized
  | "jsonld"      // schema.org JSON-LD blocks
  | "meta"        // OpenGraph + Twitter + canonical + description
  | "copy"        // visible text grouped by section
  | "tokens";     // design tokens (colors, fonts, radii, spacing) inferred from page styles
export interface ExtractParams {
  tabId: number;
  type: ExtractType;
  /** Subtree to scope the extractor to. Default: document. */
  selector?: string;
  /** Cap on items returned for list shapes. Default 200. */
  limit?: number;
}
export interface ExtractResult {
  type: ExtractType;
  items?: any[];
  data?: any;
  /** Free-form notes (e.g. "no <article> found, falling back to body"). */
  notes?: string[];
}

/** audit — one tool, many checks. Each check produces a list of findings.
 *  All findings share a common shape so a single consumer can render them. */
export type AuditCheck =
  | "a11y"         // labels, missing alt, role/name, focus traps, landmark coverage
  | "aria"         // invalid roles/attrs/refs
  | "contrast"     // computed text/background contrast vs WCAG AA
  | "seo"          // title, meta description, canonical, headings hierarchy, robots
  | "analytics"    // GA4 / GTM / Meta Pixel / Segment / Plausible / Fathom / Hotjar
  | "cookies"      // SameSite, Secure, HttpOnly, Domain leaks
  | "headers"      // cache-control, content-type, security (CSP/HSTS/XCTO/XFO)
  | "images"       // missing alt, broken, oversized natural-vs-display, lazy-loading
  | "fonts"        // loaded fonts, font-display, fallback usage
  | "responsive"   // overflow, horizontal scroll, clipped text
  | "html"         // duplicate ids, unclosed tags (heuristic), nesting issues
  | "i18n"         // <html lang>, dir, mixed-direction text
  | "hydration"    // React/Next hydration warnings in console + mismatched DOM
  | "overflow"     // text-overflow, scrollWidth>clientWidth
  | "auth";        // logged-in detection (auth cookies, account links visible)
export interface AuditParams {
  tabId: number;
  checks: AuditCheck[];
  /** Per-check options bag. Keys are check names. */
  options?: Record<string, unknown>;
}
export interface AuditFinding {
  check: AuditCheck;
  severity: "info" | "warn" | "error";
  message: string;
  selector?: string;
  details?: Record<string, unknown>;
}
export interface AuditResult {
  findings: AuditFinding[];
  summary: Record<AuditCheck, { ran: boolean; total: number; errors: number; warns: number }>;
}

/** api_inspect — five modes. Discover/inspect XHR + GraphQL + WS + SSE +
 *  auth signals from already-captured network entries. Requires the
 *  debugger to have been attached for traffic to appear. */
export type ApiInspectMode = "discover" | "schema" | "graphql" | "websocket" | "sse" | "auth";
export interface ApiInspectParams {
  tabId?: number;
  mode: ApiInspectMode;
  /** Filter the source set. Same shape as read_network filters. */
  urlPattern?: string;
  urlRegex?: string;
  hostRegex?: string;
  /** For mode="schema": URL substring of the entry to schema-infer. */
  fromUrl?: string;
  /** For mode="schema": cap on sample size. Default 5. */
  sampleSize?: number;
  /** For mode="graphql": optional operation name filter. */
  operationName?: string;
}
export interface ApiInspectResult {
  mode: ApiInspectMode;
  data: unknown;
  notes?: string[];
}

/** page_map — landmarks + headings + forms + buttons + links + frames
 *  in one structured snapshot. Pass `selector` to map a subtree, or
 *  `describe` to get rich info about a single element instead. */
export interface PageMapParams {
  tabId: number;
  selector?: string;
  /** When set, skip the broad map and return rich info on this selector
   *  only (role, name, rect, computed styles, listeners, ancestors). */
  describe?: string;
  /** Max items per category. Default 50. */
  perSection?: number;
}
export interface PageMapElement {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  selector: string;
  rect?: { x: number; y: number; w: number; h: number };
  attrs?: Record<string, string>;
}
export interface PageMapResult {
  url: string;
  title: string;
  /** Structured map (when no `describe`). */
  landmarks?: PageMapElement[];
  headings?: PageMapElement[];
  forms?: PageMapElement[];
  buttons?: PageMapElement[];
  links?: PageMapElement[];
  frames?: Array<{ frameId: string; url: string }>;
  /** Single-element rich info (when `describe` is set). */
  element?: PageMapElement & {
    styles?: Record<string, string>;
    visible?: boolean;
    eventListenerKinds?: string[];
    ancestors?: Array<{ tag: string; selector: string }>;
  };
}

/** viewport_matrix — run a small action across multiple viewport sizes
 *  (and optionally color schemes) and return one screenshot+findings per
 *  cell. Powers responsive screenshots, ad-size captures, dark-mode tests. */
export interface ViewportMatrixCell {
  label: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  prefersColorScheme?: "light" | "dark";
}
export interface ViewportMatrixParams {
  tabId: number;
  cells: ViewportMatrixCell[];
  /** Per-cell delay before screenshot (lets media queries settle). Default 400ms. */
  settleMs?: number;
  /** Run an `audit` per cell with these checks. Optional. */
  auditChecks?: AuditCheck[];
  /** Capture screenshot per cell. Default true. */
  screenshot?: boolean;
}
export interface ViewportMatrixCellResult {
  label: string;
  pngBase64?: string;
  audit?: AuditResult;
  errors?: string[];
}
export interface ViewportMatrixResult {
  results: ViewportMatrixCellResult[];
}

/** monitor_diff — two-phase snapshot/compare. Call with phase=snapshot
 *  to record current state under a key; call with phase=diff to compare
 *  the live state against the prior snapshot. Covers state/storage/dom
 *  diffs, visual diffs (perceptual hash), and "watch this listing" use-cases. */
export interface MonitorDiffParams {
  tabId: number;
  phase: "snapshot" | "diff" | "list" | "drop";
  /** Required for snapshot/diff/drop. */
  key?: string;
  /** What to capture. Default: ["dom","localStorage","sessionStorage","cookies","url"]. */
  fields?: Array<"dom" | "text" | "localStorage" | "sessionStorage" | "cookies" | "url" | "screenshotHash" | "network">;
  /** Subtree selector (for dom/text). Default body. */
  selector?: string;
}
export interface MonitorDiffSnapshotResult {
  phase: "snapshot";
  key: string;
  capturedAt: string;
  fields: string[];
}
export interface MonitorDiffDiffResult {
  phase: "diff";
  key: string;
  changed: boolean;
  diffs: Array<{ field: string; before?: unknown; after?: unknown; summary?: string }>;
}
export type MonitorDiffResult =
  | MonitorDiffSnapshotResult
  | MonitorDiffDiffResult
  | { phase: "list"; keys: string[] }
  | { phase: "drop"; key: string; ok: true };

/** workflow — record/replay/list user-action workflows. Recorded events
 *  are normalized {kind, selector, value, ts} so they can be replayed
 *  via the existing click/type_text/scroll/press_key tools. */
export interface WorkflowParams {
  tabId: number;
  action: "record_start" | "record_stop" | "replay" | "list" | "delete";
  /** Required for record_stop, replay, delete. */
  name?: string;
  /** For replay: ms between steps (default = recorded timing). */
  stepDelayMs?: number;
}
export interface WorkflowStep {
  kind: "click" | "type" | "press" | "scroll" | "navigate";
  selector?: string;
  value?: string;
  url?: string;
  ts: number;
}
export interface WorkflowResult {
  action: WorkflowParams["action"];
  name?: string;
  steps?: WorkflowStep[];
  names?: string[];
  ok?: true;
}

/** emulate — bundle of CDP overrides applied in one call. Each field is
 *  optional; pass `clear: true` to remove all overrides. Combines the
 *  set_viewport / set_user_agent / throttle_network surface with new
 *  timezone / geolocation / permissions / locale / prefersColorScheme. */
export interface EmulateParams {
  tabId: number;
  clear?: boolean;
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
  userAgent?: { value: string; acceptLanguage?: string; platform?: string };
  network?: { preset?: "offline" | "slow_3g" | "fast_3g" | "slow_4g"; offline?: boolean; latencyMs?: number; downloadThroughput?: number; uploadThroughput?: number };
  timezone?: string;        // IANA, e.g. "America/Los_Angeles"
  locale?: string;          // BCP 47, e.g. "fr-FR"
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  permissions?: Record<string, "granted" | "denied" | "prompt">;
  prefersColorScheme?: "light" | "dark" | "no-preference";
  prefersReducedMotion?: "reduce" | "no-preference";
}
export interface EmulateResult { ok: true; applied: string[] }

/** detect_framework — heuristic detection of front-end framework + dev
 *  hooks + commonly-used libraries. Single non-destructive read. */
export interface DetectFrameworkParams { tabId: number }
export interface DetectFrameworkResult {
  frameworks: Array<{ name: string; version?: string; signals: string[] }>;
  buildTools?: string[];
  routers?: string[];
  state?: string[];
  cms?: string[];
  hasReactDevHook: boolean;
  hasVueDevHook: boolean;
  hydrationErrors?: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 12 — single-purpose new tools
// ────────────────────────────────────────────────────────────────────────────

export interface InfiniteScrollExtractParams {
  tabId: number;
  /** Selector for repeated items (cards, rows, etc.). */
  itemSelector: string;
  /** Per-item field map: { fieldName: { selector, attr? } } relative to each item. */
  fields?: Record<string, { selector?: string; attr?: string }>;
  /** Container to scroll. Default: window. */
  scrollContainer?: string;
  /** Max scroll passes. Default 30. */
  maxPasses?: number;
  /** Quiet ms after a scroll before checking new items. Default 800. */
  settleMs?: number;
  /** Stop when no new items in N consecutive passes. Default 2. */
  stableFor?: number;
  /** Cap on items returned. Default 1000. */
  maxItems?: number;
}
export interface InfiniteScrollExtractResult {
  items: Array<Record<string, string>>;
  passes: number;
  stableHit: boolean;
}

export interface LinkGraphParams {
  /** Starting tab. Crawler reuses this tab — destructive of current page. */
  tabId: number;
  /** Max link depth from start. Default 1. */
  depth?: number;
  /** Same-origin only. Default true. */
  sameOriginOnly?: boolean;
  /** Per-page settle ms. Default 1500. */
  settleMs?: number;
  /** Cap on URLs visited. Default 25. */
  maxPages?: number;
  /** URL include/exclude regex (applied to the candidate before fetching). */
  includeRegex?: string;
  excludeRegex?: string;
}
export interface LinkGraphResult {
  nodes: Array<{ url: string; title?: string; depth: number; status?: number }>;
  edges: Array<{ from: string; to: string }>;
}

export interface SelectorSuggestParams {
  tabId: number;
  /** Either an existing selector to base suggestions on, or text to find. */
  fromSelector?: string;
  fromText?: string;
  /** How many alternates to generate. Default 5. */
  limit?: number;
}
export interface SelectorSuggestResult {
  suggestions: Array<{ selector: string; rationale: string; uniqueness: number }>;
}

export interface LocatorHealParams {
  tabId: number;
  brokenSelector: string;
  /** Hints to nudge the heal: prior text/role/attrs. */
  hints?: { text?: string; role?: string; attrs?: Record<string, string> };
}
export interface LocatorHealResult {
  candidates: Array<{ selector: string; score: number; rationale: string }>;
}

export interface ClickByLabelParams {
  tabId: number;
  label: string;
  /** Match mode. Default "contains" (case-insensitive). */
  mode?: "exact" | "contains" | "regex";
  flags?: string;
  /** Optional role narrowing (button, link, checkbox, ...). */
  role?: string;
}
export interface ClickByLabelResult {
  clicked: boolean;
  selector: string;
  matchedLabel: string;
}

export interface FillFormFromJsonParams {
  tabId: number;
  /** Form scope. Default: first <form> on page. */
  selector?: string;
  /** field-name → value (or {value, mode}) where field-name matches the
   *  input's name, id, label text, or aria-label. */
  data: Record<string, string | number | boolean | { value: string | number | boolean; mode?: "set" | "type" }>;
  /** Submit after fill. Default false. */
  submit?: boolean;
}
export interface FillFormFromJsonResult {
  filled: string[];
  missing: string[];
  submitted: boolean;
}

export interface BrokenLinksCheckParams {
  tabId: number;
  /** Restrict to same-origin links. Default true. */
  sameOriginOnly?: boolean;
  /** HEAD first, fall back to GET on 405. Default true. */
  headFirst?: boolean;
  /** Cap on links to probe. Default 200. */
  limit?: number;
  /** Concurrency. Default 8. */
  concurrency?: number;
}
export interface BrokenLinksCheckResult {
  results: Array<{ href: string; status: number | null; ok: boolean; error?: string }>;
}

export interface MemorySampleParams { tabId: number }
export interface MemorySampleResult {
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
  jsHeapLimitBytes?: number;
  domNodes: number;
  documents: number;
  detachedDomCandidates: number;
  listeners?: number;
}

export interface AnimationInspectParams {
  tabId: number;
  selector: string;
}
export interface AnimationInspectResult {
  animations: Array<{
    id: string;
    type: "css-animation" | "css-transition" | "web-animation";
    playState: string;
    name?: string;
    durationMs?: number;
    delayMs?: number;
    iterationCount?: number | "infinite";
  }>;
}

export interface RouteChangeWaitParams {
  tabId: number;
  /** Wait until URL matches this regex. */
  pattern?: string;
  flags?: string;
  /** Wait until any route change happens. Default true if no pattern. */
  any?: boolean;
  timeoutMs?: number;
}
export interface RouteChangeWaitResult {
  changed: boolean;
  url: string;
  elapsedMs: number;
}

export interface AntiBotDetectParams { tabId: number }
export interface AntiBotDetectResult {
  signals: Array<{ kind: "cloudflare" | "captcha" | "login_wall" | "paywall" | "bot_block" | "turnstile" | "hcaptcha" | "recaptcha"; selector?: string; details?: string }>;
}

export interface LighthouseQuickParams { tabId: number }
export interface LighthouseQuickResult {
  vitals: PerformanceMetricsResult;
  audits: AuditFinding[];
  score: { performance: number; accessibility: number; seo: number };
}

export interface ExportCsvParams {
  rows: Array<Record<string, unknown>>;
  /** Column order. Default = keys of first row. */
  columns?: string[];
  /** Separator. Default ",". */
  delimiter?: string;
}
export interface ExportCsvResult { csv: string; rows: number; columns: string[] }

export interface DedupeItemsParams {
  rows: Array<Record<string, unknown>>;
  /** Key fields to consider for identity. Default: all keys. */
  keys?: string[];
  /** Lowercase + trim string keys before hashing. Default true. */
  normalize?: boolean;
}
export interface DedupeItemsResult { rows: Array<Record<string, unknown>>; removed: number }

export interface SchemaInferParams {
  tabId: number;
  /** Selector for repeated items to study. */
  itemSelector: string;
  /** Cap on items sampled. Default 20. */
  sample?: number;
}
export interface SchemaInferResult {
  fields: Array<{ name: string; selector: string; coverage: number; sampleValues: string[] }>;
}

export interface AssetCaptureParams {
  tabId: number;
  /** Include inline base64 of small (<200KB) assets. Default false. */
  inlineSmall?: boolean;
}
export interface AssetCaptureResult {
  url: string;
  capturedAt: string;
  domHtml: string;
  assets: Array<{ url: string; type: string; sizeBytes?: number; cached?: boolean; base64?: string }>;
}

export interface BundleResourcesParams {
  tabId: number;
  /** Group by. Default "type". */
  groupBy?: "type" | "origin" | "cache";
}
export interface BundleResourcesResult {
  groups: Array<{ key: string; count: number; bytes: number; items: Array<{ url: string; bytes: number; type: string; cached: boolean }> }>;
  totalBytes: number;
}

export interface FormsValidateParams {
  tabId: number;
  /** Form selector. Default: every form. */
  selector?: string;
  /** Max forms to return. Default 20. */
  limit?: number;
  /** Max invalid fields per form. Default 50. */
  maxFields?: number;
}
export interface FormsValidateResult {
  forms: Array<{
    selector: string;
    valid: boolean;
    invalidFields: Array<{ name: string; selector: string; validity: string[]; message: string }>;
    truncatedFields?: boolean;
  }>;
  truncated?: boolean;
}
