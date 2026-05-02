import type { InterceptRule } from "./shared/protocol";

/**
 * Request interception via CDP Fetch domain.
 *
 * CDP Fetch.enable takes an array of RequestPatterns. When a matching request
 * fires, Chrome pauses it and emits Fetch.requestPaused — we decide whether
 * to block, fulfill with synthetic response, or redirect, then call
 * Fetch.continueRequest / Fetch.fulfillRequest / Fetch.failRequest.
 *
 * One rule set per tab. Scope is tracked by tabId; an undefined tabId means
 * "apply to every debugger-attached tab".
 */

interface ActiveRule extends InterceptRule {
  id: string;
  match: (url: string) => boolean;
}

const tabRules = new Map<number, Map<string, ActiveRule>>();
const globalRules = new Map<string, ActiveRule>();
let installed = false;
let nextId = 1;

function compileRule(r: InterceptRule): ActiveRule {
  const id = r.id ?? `r${nextId++}`;
  let match: (url: string) => boolean;
  if (r.regex) {
    const re = new RegExp(r.urlPattern);
    match = (u) => re.test(u);
  } else {
    const needle = r.urlPattern;
    match = (u) => u.includes(needle);
  }
  return { ...r, id, match };
}

function rulesForTab(tabId: number): ActiveRule[] {
  const tab = tabRules.get(tabId);
  const list: ActiveRule[] = [];
  if (tab) list.push(...tab.values());
  list.push(...globalRules.values());
  return list;
}

async function enableFetch(tabId: number) {
  // Pattern wildcard; narrowing happens in our JS filter.
  await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
    patterns: [{ urlPattern: "*" }],
  });
}

async function disableFetch(tabId: number) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.disable");
  } catch {}
}

export function installInterceptHook() {
  if (installed) return;
  installed = true;
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (method !== "Fetch.requestPaused") return;
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const p = params as any;
    const rules = rulesForTab(tabId);
    const hit = rules.find((r) => r.match(p.request.url));
    if (!hit) {
      try {
        await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
          requestId: p.requestId,
        });
      } catch {}
      return;
    }
    try {
      switch (hit.action) {
        case "block":
          await chrome.debugger.sendCommand({ tabId }, "Fetch.failRequest", {
            requestId: p.requestId,
            errorReason: "BlockedByClient",
          });
          return;
        case "redirect":
          if (!hit.redirectTo) throw new Error("redirect rule missing redirectTo");
          await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
            requestId: p.requestId,
            url: hit.redirectTo,
          });
          return;
        case "fulfill":
          await chrome.debugger.sendCommand({ tabId }, "Fetch.fulfillRequest", {
            requestId: p.requestId,
            responseCode: hit.statusCode ?? 200,
            responseHeaders: Object.entries(hit.responseHeaders ?? {}).map(
              ([name, value]) => ({ name, value }),
            ),
            body: hit.responseBase64
              ? hit.responseBody ?? ""
              : btoa(unescape(encodeURIComponent(hit.responseBody ?? ""))),
          });
          return;
      }
    } catch (e) {
      console.warn("[reins] intercept apply failed", e);
      try {
        await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
          requestId: p.requestId,
        });
      } catch {}
    }
  });
}

export async function setRules(tabId: number | undefined, rules: InterceptRule[]): Promise<string[]> {
  const compiled = rules.map(compileRule);
  if (tabId === undefined) {
    for (const r of compiled) globalRules.set(r.id, r);
    // Enable fetch on every currently-attached tab (best effort).
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id !== undefined) await enableFetch(t.id).catch(() => {});
  } else {
    let bucket = tabRules.get(tabId);
    if (!bucket) {
      bucket = new Map();
      tabRules.set(tabId, bucket);
    }
    for (const r of compiled) bucket.set(r.id, r);
    await enableFetch(tabId);
  }
  return compiled.map((r) => r.id);
}

export async function clearRules(tabId: number | undefined, ruleIds?: string[]): Promise<void> {
  if (tabId === undefined) {
    if (!ruleIds) globalRules.clear();
    else ruleIds.forEach((id) => globalRules.delete(id));
    if (globalRules.size === 0) {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.id !== undefined) await disableFetch(t.id);
    }
  } else {
    const bucket = tabRules.get(tabId);
    if (!bucket) return;
    if (!ruleIds) bucket.clear();
    else ruleIds.forEach((id) => bucket.delete(id));
    if (bucket.size === 0) {
      tabRules.delete(tabId);
      if (globalRules.size === 0) await disableFetch(tabId);
    }
  }
}
