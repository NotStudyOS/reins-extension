import browser from "webextension-polyfill";
import type {
  BugReportParams,
  BugReportResult,
  HealthResult,
  PerformanceMetricsParams,
  PerformanceMetricsResult,
  SessionExportParams,
  SessionExportResult,
  WaitForDomStableParams,
  WaitForDomStableResult,
  WaitForResponseParams,
  WaitForResponseResult,
} from "../shared/protocol";
import { readNetwork as readNet } from "../net";
import { read as readConsole, enableFor as enableConsoleFor } from "../console-log";
import { sleep } from "./runtime";
import { toHar } from "./har";

const VERSION = "0.1.0";

export const diagnosticsHandlers: Record<string, (params: any) => Promise<unknown>> = {
  performance_metrics: async (p: PerformanceMetricsParams): Promise<PerformanceMetricsResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (includeResources: boolean) => {
        // Web Vitals via PerformanceObserver buffered entries.
        const byType = (t: string) => {
          try { return performance.getEntriesByType(t); } catch { return []; }
        };
        const paint = byType("paint");
        const fcp = paint.find((e: any) => e.name === "first-contentful-paint")?.startTime;
        const lcpEntries = byType("largest-contentful-paint") as any[];
        const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].renderTime || lcpEntries[lcpEntries.length - 1].loadTime : undefined;

        let cls = 0;
        for (const e of byType("layout-shift") as any[]) {
          if (!e.hadRecentInput) cls += e.value;
        }

        let fid: number | undefined;
        const fids = byType("first-input") as any[];
        if (fids.length) fid = fids[0].processingStart - fids[0].startTime;

        let longestTask = 0;
        for (const e of byType("longtask") as any[]) {
          if (e.duration > longestTask) longestTask = e.duration;
        }

        const navEntries = byType("navigation") as any[];
        const n = navEntries[0];
        const ttfb = n ? n.responseStart - n.requestStart : undefined;
        const nav = n
          ? {
              domContentLoadedEventEnd: n.domContentLoadedEventEnd,
              loadEventEnd: n.loadEventEnd,
              domInteractive: n.domInteractive,
              type: n.type,
            }
          : undefined;

        const resourceEntries = byType("resource") as any[];
        const out: any = {
          lcpMs: lcp,
          cls,
          fcpMs: fcp,
          ttfbMs: ttfb,
          fidMs: fid,
          longestTaskMs: longestTask || undefined,
          nav,
          resourceCount: resourceEntries.length,
        };
        if (includeResources) {
          out.resources = resourceEntries.map((r: any) => ({
            name: r.name,
            initiatorType: r.initiatorType,
            durationMs: r.duration,
            transferSize: r.transferSize,
          }));
        }
        return out;
      },
      args: [!!p.includeResources],
    });
    return result as PerformanceMetricsResult;
  },

  wait_for_dom_stable: async (p: WaitForDomStableParams): Promise<WaitForDomStableResult> => {
    const idleMs = p.idleMs ?? 500;
    const timeoutMs = p.timeoutMs ?? 15_000;
    const start = Date.now();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: async (selector: string | null, idleMs: number, timeoutMs: number) => {
        const root: Element = (selector ? document.querySelector(selector) : document.body) ?? document.body;
        if (!root) return { stable: false, mutationsObserved: 0 };
        let lastMutation = Date.now();
        let count = 0;
        const obs = new MutationObserver((m) => {
          count += m.length;
          lastMutation = Date.now();
        });
        obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        const start = Date.now();
        try {
          while (Date.now() - start < timeoutMs) {
            if (Date.now() - lastMutation >= idleMs) {
              return { stable: true, mutationsObserved: count };
            }
            await new Promise((r) => setTimeout(r, Math.min(100, idleMs / 4)));
          }
          return { stable: false, mutationsObserved: count };
        } finally {
          obs.disconnect();
        }
      },
      args: [p.selector ?? null, idleMs, timeoutMs],
    });
    const r = result as { stable: boolean; mutationsObserved: number };
    return { stable: r.stable, mutationsObserved: r.mutationsObserved, elapsedMs: Date.now() - start };
  },

  wait_for_response: async (p: WaitForResponseParams): Promise<WaitForResponseResult> => {
    const start = Date.now();
    const deadline = start + (p.timeoutMs ?? 15_000);
    const pollMs = p.pollMs ?? 200;
    const bodyRe = p.bodyRegex ? new RegExp(p.bodyRegex) : null;
    while (Date.now() < deadline) {
      const entries = await readNet({
        tabId: p.tabId,
        urlPattern: p.urlPattern,
        urlRegex: p.urlRegex,
        hostRegex: p.hostRegex,
        methods: p.methods,
        statusMin: p.statusMin,
        statusMax: p.statusMax,
        sinceMs: start - 1,
        includeBodies: !!(p.bodyContains || p.bodyRegex),
        limit: 200,
      });
      for (const e of entries) {
        if (p.bodyContains && !(e.responseBody ?? "").includes(p.bodyContains)) continue;
        if (bodyRe && !bodyRe.test(e.responseBody ?? "")) continue;
        return {
          matched: true,
          elapsedMs: Date.now() - start,
          requestId: e.requestId,
          url: e.url,
          status: e.status,
        };
      }
      await sleep(pollMs);
    }
    return { matched: false, elapsedMs: Date.now() - start };
  },

  health: async (): Promise<HealthResult> => {
    const targets = await new Promise<chrome.debugger.TargetInfo[]>((res) =>
      chrome.debugger.getTargets((t) => res(t)),
    );
    const attached = targets.filter((t) => t.attached && t.tabId !== undefined).map((t) => t.tabId!);
    return {
      ok: true,
      worker: { version: VERSION },
      extension: {
        connected: true,
        version: chrome.runtime.getManifest?.().version,
        attachedTabs: attached,
      },
      ts: new Date().toISOString(),
    };
  },

  bug_report: async (p: BugReportParams): Promise<BugReportResult> => {
    const tab = await browser.tabs.get(p.tabId);
    await enableConsoleFor(p.tabId);
    const consoleLimit = p.consoleLimit ?? 50;
    const networkLimit = p.networkLimit ?? 25;

    const [consoleLogs, failed, perf] = await Promise.all([
      readConsole({ tabId: p.tabId, levels: ["error", "warn"], sources: ["console", "exception"], limit: consoleLimit }),
      readNet({ tabId: p.tabId, failedOnly: true, limit: networkLimit, includeBodies: false }),
      diagnosticsHandlers.performance_metrics({ tabId: p.tabId }) as Promise<PerformanceMetricsResult>,
    ]);

    let screenshotPngBase64: string | undefined;
    if (p.includeScreenshot !== false && tab.windowId) {
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        screenshotPngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      } catch {
        // ignore — capture can fail on chrome:// pages
      }
    }

    return {
      url: tab.url ?? "",
      title: tab.title ?? "",
      capturedAt: new Date().toISOString(),
      console: consoleLogs.logs,
      failedNetwork: failed,
      performance: perf,
      screenshotPngBase64,
    };
  },

  session_export: async (p: SessionExportParams): Promise<SessionExportResult> => {
    const tab = await browser.tabs.get(p.tabId);
    await enableConsoleFor(p.tabId);
    const [entries, consoleLogs] = await Promise.all([
      readNet({ tabId: p.tabId, includeBodies: !!p.includeBodies, limit: 5000 }),
      readConsole({ tabId: p.tabId, limit: 1000 }),
    ]);
    const harJson = JSON.stringify(toHar(entries));

    let domHtml: string | undefined;
    if (p.includeDom !== false) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: p.tabId },
          func: () => document.documentElement.outerHTML,
        });
        domHtml = result as string;
      } catch {}
    }

    let screenshotPngBase64: string | undefined;
    if (p.includeScreenshot !== false && tab.windowId) {
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        screenshotPngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      } catch {}
    }

    return {
      url: tab.url ?? "",
      capturedAt: new Date().toISOString(),
      harJson,
      console: consoleLogs.logs,
      domHtml,
      screenshotPngBase64,
    };
  },
};
