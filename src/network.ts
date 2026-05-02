import browser from "webextension-polyfill";
import type {
  NetworkEntry,
  ReadNetworkFilters,
  AttachDebuggerAllResult,
} from "../../src/shared/protocol";
import { buf, clearTab, markDirty, snapshot } from "./persistent-net";

/**
 * Chrome CDP-based network capture.
 * Hot path: CDP events append to per-tab buffer, flagged dirty so the
 * persistent layer can flush. Retrieval filters by URL / regex / host /
 * mime / status / time, and optionally fetches response bodies on demand.
 *
 * Also hosts the stream hub: callers register a listener that receives
 * network entries as they're finalized (used by the MCP network.stream_start
 * tool).
 */

const MAX_BUFFER_PER_TAB = 5000;
const attached = new Set<number>();

type StreamListener = (e: NetworkEntry) => void;
const streams = new Map<string, { filter?: ReadNetworkFilters; listener: StreamListener }>();

export function addStream(id: string, filter: ReadNetworkFilters | undefined, listener: StreamListener) {
  streams.set(id, { filter, listener });
}
export function removeStream(id: string) {
  streams.delete(id);
}
export function listStreams() {
  return [...streams.keys()];
}

function fanout(entry: NetworkEntry) {
  for (const { filter, listener } of streams.values()) {
    if (filter && !matchFilter(entry, filter)) continue;
    try {
      listener(entry);
    } catch (e) {
      console.warn("[reins] stream listener threw", e);
    }
  }
}

function trimIfOverflow(b: Map<string, NetworkEntry>) {
  if (b.size <= MAX_BUFFER_PER_TAB) return;
  const drop = Math.floor(MAX_BUFFER_PER_TAB * 0.1);
  let i = 0;
  for (const k of b.keys()) {
    if (i++ >= drop) break;
    b.delete(k);
  }
}

// URL prefixes CDP cannot (or refuses to) target. Attaching to one of these
// reliably throws "Cannot access contents of url ...", which used to bubble
// out of the onCreated listener as an unhandled promise rejection and kill
// the message port that tools like `eval` rely on. Centralize the check.
const CDP_DENY_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "chrome-untrusted://",
  "devtools://",
  "edge://",
  "about:",
  "view-source:",
];

function isCdpIneligibleUrl(url: string | undefined): boolean {
  if (!url) return false;
  return CDP_DENY_PREFIXES.some((p) => url.startsWith(p));
}

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    const t = await browser.tabs.get(tabId);
    return t.url;
  } catch {
    return undefined;
  }
}

export async function attachDebugger(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  // Pre-check: skip ineligible URLs up front so we don't spam warnings
  // and don't surface a rejection to callers. attachAll already does this,
  // but onCreated/onCommitted listeners funnel through here and need the
  // same guard.
  const url = await tabUrl(tabId);
  if (isCdpIneligibleUrl(url)) {
    console.debug("[reins] skip attach (ineligible url)", tabId, url);
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    attached.add(tabId);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // Silently ignore the two benign, expected failures:
    //   • "Cannot access a chrome:// URL" / "Cannot access contents of url ..."
    //   • "Another debugger is already attached"
    // These happen when devtools/inspect pages open, or the user has the
    // DevTools panel open on a tab. Throwing them out of the auto-attach
    // listeners leaks unhandled promise rejections that can desync the
    // extension's message port.
    if (/Cannot access|Another debugger is already attached|Extension manifest/.test(msg)) {
      console.debug("[reins] attach skipped (benign)", tabId, url, msg);
      return;
    }
    console.warn("[reins] debugger attach failed", tabId, url, e);
    throw e;
  }
}

export async function detachDebugger(tabId: number) {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  attached.delete(tabId);
}

/**
 * Eagerly attach CDP to every existing tab + auto-attach any new ones.
 * Called once at extension boot and on-demand via attach_debugger_all RPC.
 */
export async function attachAll(): Promise<AttachDebuggerAllResult> {
  const tabs = await browser.tabs.query({});
  const ok: number[] = [];
  const bad: AttachDebuggerAllResult["failed"] = [];
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    // Skip chrome:// and devtools:// tabs — CDP refuses.
    if (t.url?.startsWith("chrome://") || t.url?.startsWith("chrome-extension://") || t.url?.startsWith("devtools://")) continue;
    try {
      await attachDebugger(t.id);
      ok.push(t.id);
    } catch (e) {
      bad.push({ tabId: t.id, error: (e as Error).message });
    }
  }
  return { attached: ok, failed: bad };
}

export function installNetworkCapture() {
  browser.webNavigation.onCommitted.addListener((d) => {
    // Swallow per-tab attach failures (chrome://, devtools://, a second
    // debugger already attached) so one problem tab can't surface an
    // unhandled promise rejection and poison the extension's message
    // port. Without .catch here, `eval` RPCs on unrelated tabs start
    // failing with "extension disconnected".
    if (d.frameId === 0 && d.tabId >= 0) {
      void attachDebugger(d.tabId).catch((e) => {
        console.debug("[reins] onCommitted attach swallowed", d.tabId, (e as Error).message);
      });
    }
  });
  browser.tabs.onCreated.addListener((t) => {
    if (typeof t.id === "number") {
      void attachDebugger(t.id).catch((e) => {
        console.debug("[reins] onCreated attach swallowed", t.id, (e as Error).message);
      });
    }
  });
  browser.tabs.onRemoved.addListener(async (tabId) => {
    attached.delete(tabId);
    await clearTab(tabId);
  });
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId !== undefined) attached.delete(src.tabId);
  });

  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const b = await buf(tabId);
    const p = params as any;

    switch (method) {
      case "Network.requestWillBeSent": {
        b.set(p.requestId, {
          requestId: p.requestId,
          tabId,
          url: p.request.url,
          method: p.request.method,
          requestHeaders: p.request.headers,
          requestBody: p.request.postData,
          timing: { startedMs: Date.now() },
        });
        trimIfOverflow(b);
        markDirty();
        break;
      }
      case "Network.responseReceived": {
        const e = b.get(p.requestId);
        if (!e) return;
        e.status = p.response.status;
        e.responseHeaders = p.response.headers;
        markDirty();
        break;
      }
      case "Network.loadingFinished": {
        const e = b.get(p.requestId) as any;
        if (!e) return;
        e.timing = { ...(e.timing ?? { startedMs: Date.now() }), endedMs: Date.now() };
        e.loaded = true;
        markDirty();
        fanout(e);
        break;
      }
      case "Network.loadingFailed": {
        const e = b.get(p.requestId) as any;
        if (!e) return;
        e.loaded = true;
        markDirty();
        fanout(e);
        break;
      }
      case "Network.webSocketCreated":
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived":
        // Handled by ws-capture.ts
        break;
    }
  });
}

async function fillBody(tabId: number, entry: NetworkEntry) {
  if (entry.responseBody !== undefined) return;
  try {
    const body = (await chrome.debugger.sendCommand(
      { tabId },
      "Network.getResponseBody",
      { requestId: entry.requestId },
    )) as { body: string; base64Encoded: boolean };
    entry.responseBody = body.body;
    entry.responseBase64 = body.base64Encoded;
  } catch {
    // Bodies get evicted by Chrome after a while. Safe to skip.
  }
}

function matchFilter(entry: NetworkEntry, f: ReadNetworkFilters): boolean {
  if (f.requestIds && f.requestIds.length && !f.requestIds.includes(entry.requestId)) return false;
  if (f.urlRegex) {
    if (!new RegExp(f.urlRegex).test(entry.url)) return false;
  } else if (f.urlPattern) {
    if (!entry.url.includes(f.urlPattern)) return false;
  }
  if (f.hostRegex) {
    try {
      const host = new URL(entry.url).host;
      if (!new RegExp(f.hostRegex).test(host)) return false;
    } catch {
      return false;
    }
  }
  if (f.methods && f.methods.length) {
    const want = f.methods.map((m) => m.toUpperCase());
    if (!want.includes((entry.method || "").toUpperCase())) return false;
  }
  if (f.mimeType && entry.responseHeaders) {
    const ct = entry.responseHeaders["content-type"] ?? entry.responseHeaders["Content-Type"] ?? "";
    const primary = ct.split(";")[0].trim().toLowerCase();
    if (primary !== f.mimeType.toLowerCase()) return false;
  }
  if (f.failedOnly) {
    // Treat any 4xx/5xx as failed. No-status entries (blocked/aborted) also
    // count — those have status=undefined and a 4xx-like absence.
    const s = entry.status;
    if (s !== undefined && s < 400) return false;
  }
  if (f.statusMin !== undefined && (entry.status ?? 0) < f.statusMin) return false;
  if (f.statusMax !== undefined && (entry.status ?? 999) > f.statusMax) return false;
  if (f.sinceMs !== undefined && (entry.timing?.startedMs ?? 0) <= f.sinceMs) return false;
  return true;
}

export async function readNetwork(opts: ReadNetworkFilters): Promise<NetworkEntry[]> {
  const mem = await snapshot();
  const tabsToScan =
    opts.tabId !== undefined ? [opts.tabId] : [...mem.keys()];
  const out: NetworkEntry[] = [];
  for (const t of tabsToScan) {
    const b = mem.get(t);
    if (!b) continue;
    for (const entry of b.values()) {
      if (!matchFilter(entry, opts)) continue;
      if (opts.includeBodies && (entry as any).loaded) {
        await fillBody(t, entry);
      }
      const { loaded: _, ...clean } = entry as any;
      out.push(clean);
      if (opts.limit && out.length >= opts.limit) return out;
    }
  }
  return out;
}

export async function clearNetwork(tabId?: number) {
  await clearTab(tabId);
}
