import browser from "webextension-polyfill";
import { readNetwork as readNet } from "./net";
import { read as readConsole, enableFor as enableConsoleFor } from "./console-log";

/**
 * page-commit — captures the *outgoing* page state on navigation and emits
 * a `page.commit` event over the WS so the DO can persist it to D1.
 *
 * Lifecycle:
 *   - on `webNavigation.onBeforeNavigate` for the top frame, look up the URL
 *     this tab is leaving (`previousUrl[tabId]`) and snapshot that still-live
 *     document before the browser commits the destination.
 *   - on `webNavigation.onCommitted`, stamp the new URL and reset
 *     `pageEnterMs[tabId]` so the next navigation's deltas start fresh.
 *
 * The first commit on a tab has no `previousUrl` so we just stamp the
 * baseline and skip the snapshot. Subsequent commits each capture the
 * page being left.
 */

let sessionId: string | null = null;
const previousUrl = new Map<number, string>();
const pageEnterMs = new Map<number, number>();

/** Send a JSON message over the live WS. Provided by background.ts. */
let send: (msg: unknown) => void = () => {};

export function setWsSender(fn: (msg: unknown) => void) {
  send = fn;
}

export function setSessionId(id: string | null) {
  sessionId = id;
}

export function getSessionId(): string | null {
  return sessionId;
}

/** Install the listener once. Safe to call repeatedly. */
let installed = false;
export function installPageCommitCapture() {
  if (installed) return;
  installed = true;
  browser.webNavigation.onBeforeNavigate.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const tabId = d.tabId;
    if (tabId < 0) return;

    const leavingUrl = previousUrl.get(tabId);
    const enteredAt = pageEnterMs.get(tabId) ?? Date.now();

    if (!leavingUrl) return;

    try {
      await sendPageCommit({
        tabId,
        leavingUrl,
        enteredAt,
      });
    } catch (e) {
      console.warn("[reins] page-commit capture failed", e);
    }
  });

  browser.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0 || d.tabId < 0) return;
    previousUrl.set(d.tabId, d.url);
    pageEnterMs.set(d.tabId, Date.now());
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    previousUrl.delete(tabId);
    pageEnterMs.delete(tabId);
  });
}

/** Capture an outgoing page state and push a page.commit event. The
 *  `leavingUrl` is what the snapshot describes (the page being left),
 *  not where the tab is now (which is the new url). */
export async function sendPageCommit(opts: {
  tabId: number;
  leavingUrl: string;
  enteredAt: number;
  transition?: string;
}): Promise<void> {
  const { tabId, leavingUrl, enteredAt, transition } = opts;

  // Best-effort console enable (no-op if already on).
  await enableConsoleFor(tabId).catch(() => {});

  // In-page collector — runs against whatever document the tab still has
  // before the new commit takes over.
  let pageInfo: any = null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const text = (document.body?.innerText || "").slice(0, 8 * 1024);
        const title = document.title;
        const historyLength = history.length;
        const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
          .slice(0, 200)
          .map((a) => ({ href: a.href, text: (a.innerText || "").trim() }));
        const forms = [...document.querySelectorAll<HTMLFormElement>("form")]
          .slice(0, 20)
          .map((f) => ({
            action: f.action,
            method: f.method,
            fields: [...f.querySelectorAll<HTMLInputElement>("input,select,textarea")].map((el) => ({
              name: el.name || el.id || "",
              type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
              required: (el as HTMLInputElement).required ?? false,
            })),
          }));
        const byType = (t: string) => { try { return performance.getEntriesByType(t); } catch { return []; } };
        const paint = byType("paint");
        const fcp = paint.find((e: any) => e.name === "first-contentful-paint")?.startTime;
        const lcpEntries = byType("largest-contentful-paint") as any[];
        const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].renderTime || lcpEntries[lcpEntries.length - 1].loadTime : undefined;
        let cls = 0; for (const e of byType("layout-shift") as any[]) if (!e.hadRecentInput) cls += e.value;
        const navE = byType("navigation") as any[];
        const ttfb = navE[0] ? navE[0].responseStart - navE[0].requestStart : undefined;
        return { title, text, historyLength, links, forms, perf: { lcpMs: lcp, cls, fcpMs: fcp, ttfbMs: ttfb } };
      },
    });
    pageInfo = result;
  } catch {
    // Tab may already be gone or on a chrome:// page; emit a thin commit anyway.
  }

  // Console + network deltas since the page was entered.
  const consoleSince = await readConsole({ tabId, sinceMs: enteredAt - 1, limit: 200 }).catch(() => ({ logs: [] }));
  const errs = consoleSince.logs.filter((l) => l.level === "error" || l.source === "exception");
  const warns = consoleSince.logs.filter((l) => l.level === "warn");
  const consoleBlock = {
    errors: errs.length,
    warns: warns.length,
    samples: [...errs.slice(0, 10), ...warns.slice(0, 5)].map((l) => ({ level: l.level, text: l.text.slice(0, 240) })),
  };
  const netSince = await readNet({ tabId, sinceMs: enteredAt - 1, limit: 500, includeBodies: false }).catch(() => []);
  const apiCalls = netSince.map((e) => ({ url: e.url, method: e.method, status: e.status }));

  const payload: any = {
    tabId,
    sessionId,
    url: leavingUrl,
    title: pageInfo?.title,
    capturedAt: Date.now(),
    historyLength: pageInfo?.historyLength,
    transition,
    textExcerpt: pageInfo?.text,
    forms: pageInfo?.forms,
    links: pageInfo?.links,
    apiCalls,
    console: consoleBlock,
    perf: pageInfo?.perf,
  };

  // Optionally pull selectors the LLM marked as "tried & confirmed" via
  // memory tab key `tried.selectors`. Not implemented yet — leave hook
  // open for the auto-pop pass.

  send({ event: "page.commit", data: payload });
}
