import browser from "webextension-polyfill";
import type {
  PerformanceMetricsResult,
  ProbeAction,
  ProbeExpectation,
  ProbeExpectationResult,
  ProbeMutation,
  ProbeParams,
  ProbeResult,
  ProbeStep,
} from "../shared/protocol";
import { setRules as installRules, clearRules } from "../intercept";
import { read as readConsole, enableFor as enableConsoleFor } from "../console-log";
import { readNetwork as readNet } from "../net";
import { cookieUrl } from "./cookies";
import { sleep } from "./runtime";

/**
 * probe — counterfactual loop. The LLM declares a scenario as data:
 *
 *   before  → setup applied once, no auto-teardown
 *   mutate  → counterfactual; auto-restored after observation
 *   act     → user behavior (mutations may be interleaved inline)
 *   observe → settle + collect deltas (always runs)
 *   expect  → soft assertions evaluated against the deltas
 *   restore → undo of `mutate` (auto)
 *   after   → caller-owned cleanup; runs even on error (try/finally)
 *
 * Every mutation kind maps to existing primitives. We track per-mutation
 * "undoers" (idempotent close-over functions) so restore is symmetric and
 * doesn't accidentally clobber overrides set outside the probe.
 */

type Undo = () => Promise<void>;

interface MutationContext {
  tabId: number;
  undoers: Undo[];
  /** Tracks which CDP override categories we touched, so restore is precise. */
  touched: {
    viewport?: boolean;
    userAgent?: boolean;
    network?: boolean;
    timezone?: boolean;
    locale?: boolean;
    geolocation?: boolean;
    media?: boolean;
  };
  /** Snapshots taken before destructive identity mutations, used to restore. */
  storageSnapshot?: { local: Record<string, string | null>; session: Record<string, string | null> };
  cookiesSnapshot?: chrome.cookies.Cookie[];
}

export const probeHandlers: Record<string, (p: any) => Promise<unknown>> = {
  probe: async (p: ProbeParams): Promise<ProbeResult> => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const steps: ProbeStep[] = [];
    const ctx: MutationContext = { tabId: p.tabId, undoers: [], touched: {} };

    const recordStep = async <T>(phase: ProbeStep["phase"], tool: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T | undefined> => {
      const start = Date.now();
      try {
        const out = await fn();
        steps.push({ phase, tool, ok: true, ms: Date.now() - start, meta });
        return out;
      } catch (e: any) {
        steps.push({ phase, tool, ok: false, error: String(e?.message ?? e), ms: Date.now() - start, meta });
        return undefined;
      }
    };

    // Make sure we have a debugger attachment for any CDP-using mutations,
    // but only if any of them are present.
    const wantsCdp = needsDebugger([...(p.before ?? []), ...(p.mutate ?? []), ...(p.act ?? [])]);
    if (wantsCdp) {
      try { await chrome.debugger.attach({ tabId: p.tabId }, "1.3"); } catch { /* probably already attached */ }
    }

    // Baseline cursors. We use Date.now() so console_logs / read_network can
    // filter to "added since baseline".
    const baselineMs = Date.now();
    await enableConsoleFor(p.tabId).catch(() => {});

    const tabBefore = await browser.tabs.get(p.tabId);
    const urlBefore = tabBefore.url ?? "";

    let perfBefore: PerformanceMetricsResult | undefined;
    if (p.watch?.capturePerf) {
      perfBefore = await recordStep("observe", "performance_metrics:before", () => snapshotPerf(p.tabId));
    }

    let screenshotBefore: string | undefined;
    if (p.watch?.captureScreenshots && tabBefore.windowId) {
      screenshotBefore = await recordStep("observe", "screenshot:before", async () => {
        const dataUrl = await browser.tabs.captureVisibleTab(tabBefore.windowId!, { format: "png" });
        return dataUrl.replace(/^data:image\/png;base64,/, "");
      });
    }

    let result: ProbeResult;

    try {
      // 1. before — applied, NOT auto-restored
      for (const m of p.before ?? []) {
        await recordStep("before", `mutate:${m.kind}`, () => applyMutation(ctx, m, /*track*/ false));
      }

      // 2. mutate — applied, auto-restored
      for (const m of p.mutate ?? []) {
        await recordStep("mutate", `mutate:${m.kind}`, () => applyMutation(ctx, m, /*track*/ true));
      }

      // 3. act — heterogeneous (action or mutation inline)
      for (const step of p.act ?? []) {
        if (isMutation(step)) {
          await recordStep("act", `mutate:${step.kind}`, () => applyMutation(ctx, step, /*track*/ true));
        } else {
          await recordStep("act", `act:${step.kind}`, () => runAction(p.tabId, step));
        }
      }

      // 4. observe — settle, then collect deltas
      const settleMs = p.watch?.settleMs ?? 1500;
      await sleep(settleMs);

      const consoleLevels = p.watch?.consoleLevels ?? ["error", "warn"];
      const consoleAdded = await readConsole({
        tabId: p.tabId,
        levels: consoleLevels as any,
        sources: ["console", "exception"],
        sinceMs: baselineMs,
        limit: 1000,
      });

      const failedAdded = await readNet({
        tabId: p.tabId,
        urlPattern: p.watch?.networkPattern,
        sinceMs: baselineMs,
        failedOnly: true,
        limit: 1000,
      });

      const allAdded = await readNet({
        tabId: p.tabId,
        urlPattern: p.watch?.networkPattern,
        sinceMs: baselineMs,
        limit: 5000,
        includeBodies: false,
      });

      const tabAfter = await browser.tabs.get(p.tabId);
      const urlAfter = tabAfter.url ?? "";

      // In-page observation: error region + loading state + visible error text
      const observeIn = await observeInPage(p.tabId, p.watch?.domSelector);

      let perfAfter: PerformanceMetricsResult | undefined;
      if (p.watch?.capturePerf) {
        perfAfter = await recordStep("observe", "performance_metrics:after", () => snapshotPerf(p.tabId));
      }
      let screenshotAfter: string | undefined;
      if (p.watch?.captureScreenshots && tabAfter.windowId) {
        screenshotAfter = await recordStep("observe", "screenshot:after", async () => {
          const dataUrl = await browser.tabs.captureVisibleTab(tabAfter.windowId!, { format: "png" });
          return dataUrl.replace(/^data:image\/png;base64,/, "");
        });
      }

      // 5. expect — evaluate each assertion
      const expectations: ProbeExpectationResult[] = [];
      for (const exp of p.expect ?? []) {
        const r = await evalExpectation(p.tabId, exp, {
          baselineMs,
          urlBefore,
          urlAfter,
          observeIn,
          consoleAdded: consoleAdded.logs,
          failedAdded,
          allAdded,
        });
        expectations.push(r);
        steps.push({ phase: "expect", tool: `expect:${exp.kind}`, ok: r.status !== "fail", ms: 0, meta: { status: r.status, detail: r.detail } });
      }

      const evidence = {
        consoleErrorsAdded: consoleAdded.logs.length,
        failedRequestsAdded: failedAdded.length,
        domChanged: observeIn.domChanged,
        routeChanged: urlBefore !== urlAfter,
        a11yErrorMessageFound: observeIn.a11yError,
        visibleErrorText: observeIn.visibleErrorText,
        loadingStillVisible: observeIn.loadingVisible,
        perfBefore,
        perfAfter,
        screenshotsBase64: (screenshotBefore || screenshotAfter) ? { before: screenshotBefore, after: screenshotAfter } : undefined,
        urlBefore,
        urlAfter,
      };

      const verdict = computeVerdict(expectations, evidence);
      const summary = renderSummary(verdict, evidence, expectations);

      result = {
        label: p.label,
        verdict,
        summary,
        evidence,
        expectations,
        steps,
        startedAt,
        durationMs: 0, // filled below
      };
    } catch (e: any) {
      // Catastrophic — still try to restore, then surface the error.
      result = {
        label: p.label,
        verdict: "error",
        summary: `Probe threw: ${String(e?.message ?? e)}`,
        evidence: {
          consoleErrorsAdded: 0,
          failedRequestsAdded: 0,
          domChanged: false,
          routeChanged: false,
          a11yErrorMessageFound: false,
          loadingStillVisible: false,
          urlBefore,
          urlAfter: urlBefore,
        },
        expectations: [],
        steps,
        startedAt,
        durationMs: 0,
      };
    } finally {
      // 6. restore — undo `mutate` only (before stays applied per design)
      for (const undo of ctx.undoers.reverse()) {
        await recordStep("restore", "undo", () => undo());
      }
      // 7. after — caller-owned cleanup, ALWAYS runs
      for (const a of p.after ?? []) {
        await recordStep("after", `act:${a.kind}`, () => runAction(p.tabId, a));
      }
    }

    result.durationMs = Date.now() - t0;
    // Append the post-finally steps onto the result snapshot.
    result.steps = steps;
    return result;
  },
};

// ─── helpers ────────────────────────────────────────────────────────────

function isMutation(step: ProbeAction | ProbeMutation): step is ProbeMutation {
  // Mutations and actions share `kind`, so disambiguate by the known mutation set.
  const mutationKinds = new Set([
    "intercept", "block_urls", "throttle", "offline", "mock_response", "latency", "flaky",
    "clear_storage", "set_storage", "clear_cookies", "set_cookies",
    "viewport", "user_agent", "timezone", "locale", "geolocation", "permissions", "color_scheme", "reduced_motion",
    "inject_js", "delete_dom", "freeze_time", "freeze_random", "stub_global",
  ]);
  return mutationKinds.has((step as any).kind);
}

function needsDebugger(steps: Array<ProbeMutation | ProbeAction>): boolean {
  const cdpKinds = new Set([
    "intercept", "block_urls", "throttle", "offline", "mock_response", "latency", "flaky",
    "viewport", "user_agent", "timezone", "locale", "geolocation", "permissions", "color_scheme", "reduced_motion",
  ]);
  for (const s of steps) {
    if (cdpKinds.has((s as any).kind)) return true;
  }
  return false;
}

async function applyMutation(ctx: MutationContext, m: ProbeMutation, track: boolean): Promise<void> {
  const tabId = ctx.tabId;
  const pushUndo = (fn: Undo) => { if (track) ctx.undoers.push(fn); };

  switch (m.kind) {
    case "intercept": {
      const ids = await installRules(tabId, [{
        urlPattern: m.urlPattern ?? "",
        regex: !!m.urlRegex,
        action: m.action,
        statusCode: m.statusCode,
        responseBody: m.responseBody,
        responseHeaders: m.responseHeaders,
        redirectTo: m.redirectTo,
      }]);
      pushUndo(async () => { await clearRules(tabId, ids); });
      return;
    }
    case "block_urls": {
      const ids = await installRules(tabId, m.patterns.map((p) => ({
        urlPattern: p, regex: !!m.regex, action: "block" as const,
      })));
      pushUndo(async () => { await clearRules(tabId, ids); });
      return;
    }
    case "mock_response": {
      const body = typeof m.body === "string" ? m.body : JSON.stringify(m.body ?? "");
      const ids = await installRules(tabId, [{
        urlPattern: m.urlPattern,
        action: "fulfill",
        statusCode: m.status ?? 200,
        responseBody: body,
        responseHeaders: m.headers,
      }]);
      pushUndo(async () => { await clearRules(tabId, ids); });
      return;
    }
    case "latency":
    case "flaky": {
      // Implemented via in-page fetch/XHR shim because the intercept layer
      // doesn't natively support per-URL delay or every-Nth failure.
      const code = m.kind === "latency"
        ? `(()=>{const o=window.fetch;window.__bmcp_origFetch=o;window.fetch=async(...a)=>{const u=String(a[0]?.url||a[0]);if(u.includes(${JSON.stringify(m.urlPattern)}))await new Promise(r=>setTimeout(r,${m.ms}));return o(...a);};})();`
        : `(()=>{const o=window.fetch;window.__bmcp_origFetch=o;let n=0;const ev=${m.failEvery ?? 2};const st=${m.failStatus ?? 500};window.fetch=async(...a)=>{const u=String(a[0]?.url||a[0]);if(u.includes(${JSON.stringify(m.urlPattern)})){n++;if(n%ev===0)return new Response('{"error":"injected"}',{status:st,headers:{'content-type':'application/json'}});}return o(...a);};})();`;
      await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (c: string) => { (0, eval)(c); }, args: [code] });
      pushUndo(async () => {
        await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: () => { if ((window as any).__bmcp_origFetch) { window.fetch = (window as any).__bmcp_origFetch; delete (window as any).__bmcp_origFetch; } },
        });
      });
      return;
    }
    case "throttle": {
      const presets: Record<string, { offline: boolean; dl: number; ul: number; lat: number }> = {
        slow_3g: { offline: false, dl: 50 * 1024, ul: 50 * 1024, lat: 400 },
        fast_3g: { offline: false, dl: 180 * 1024, ul: 84 * 1024, lat: 150 },
        slow_4g: { offline: false, dl: 400 * 1024, ul: 400 * 1024, lat: 60 },
      };
      const pre = m.preset ? presets[m.preset] : null;
      await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
        offline: false,
        downloadThroughput: pre?.dl ?? m.downloadThroughput ?? 0,
        uploadThroughput: pre?.ul ?? m.uploadThroughput ?? 0,
        latency: pre?.lat ?? m.latencyMs ?? 0,
      });
      ctx.touched.network = true;
      pushUndo(async () => {
        await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
          offline: false, downloadThroughput: 0, uploadThroughput: 0, latency: 0,
        });
      });
      return;
    }
    case "offline": {
      await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
        offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0,
      });
      ctx.touched.network = true;
      pushUndo(async () => {
        await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
          offline: false, downloadThroughput: 0, uploadThroughput: 0, latency: 0,
        });
      });
      return;
    }
    case "clear_storage": {
      // Snapshot first so we can attempt restore.
      const snap = await snapshotStorage(tabId);
      const cookieSnap = await snapshotCookies(tabId);
      ctx.storageSnapshot ??= snap;
      ctx.cookiesSnapshot ??= cookieSnap;
      const kinds = m.kinds ?? ["localStorage", "sessionStorage", "indexedDB", "caches", "cookies"];
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: async (k: string[]) => {
          if (k.includes("localStorage")) try { localStorage.clear(); } catch {}
          if (k.includes("sessionStorage")) try { sessionStorage.clear(); } catch {}
          if (k.includes("indexedDB")) try {
            const dbs = (await (indexedDB as any).databases?.()) ?? [];
            await Promise.all(dbs.map((d: any) => new Promise<void>((res) => {
              const req = indexedDB.deleteDatabase(d.name);
              req.onsuccess = req.onerror = req.onblocked = () => res();
            })));
          } catch {}
          if (k.includes("caches")) try { const ks = await caches.keys(); await Promise.all(ks.map((x) => caches.delete(x))); } catch {}
        },
        args: [kinds],
      });
      if (kinds.includes("cookies")) {
        const tab = await browser.tabs.get(tabId);
        if (tab.url) {
          const list = await browser.cookies.getAll({ url: tab.url });
          for (const c of list) {
            try { await browser.cookies.remove({ url: cookieUrl(c), name: c.name }); } catch {}
          }
        }
      }
      pushUndo(async () => {
        // Best-effort restore of storage + cookies.
        if (ctx.storageSnapshot) await restoreStorage(tabId, ctx.storageSnapshot);
        if (ctx.cookiesSnapshot) await restoreCookies(ctx.cookiesSnapshot);
      });
      return;
    }
    case "set_storage": {
      const snap = await snapshotStorage(tabId);
      ctx.storageSnapshot ??= snap;
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (entries: any) => {
          for (const [kind, vals] of Object.entries(entries)) {
            if (!vals) continue;
            const s = kind === "local" ? localStorage : sessionStorage;
            for (const [k, v] of Object.entries(vals as Record<string, string>)) s.setItem(k, v);
          }
        },
        args: [m.entries],
      });
      pushUndo(async () => { if (ctx.storageSnapshot) await restoreStorage(tabId, ctx.storageSnapshot); });
      return;
    }
    case "clear_cookies": {
      const snap = await snapshotCookies(tabId);
      ctx.cookiesSnapshot ??= snap;
      const list = m.url ? await browser.cookies.getAll({ url: m.url }) : m.domain ? await browser.cookies.getAll({ domain: m.domain }) : [];
      for (const c of list) {
        try { await browser.cookies.remove({ url: cookieUrl(c), name: c.name }); } catch {}
      }
      pushUndo(async () => { if (ctx.cookiesSnapshot) await restoreCookies(ctx.cookiesSnapshot); });
      return;
    }
    case "set_cookies": {
      const snap = await snapshotCookies(tabId);
      ctx.cookiesSnapshot ??= snap;
      for (const c of m.cookies) {
        await browser.cookies.set({
          url: c.url, name: c.name, value: c.value,
          domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        });
      }
      pushUndo(async () => { if (ctx.cookiesSnapshot) await restoreCookies(ctx.cookiesSnapshot); });
      return;
    }
    case "viewport": {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        width: m.width, height: m.height,
        deviceScaleFactor: m.deviceScaleFactor ?? 1, mobile: !!m.mobile,
      });
      ctx.touched.viewport = true;
      pushUndo(async () => { try { await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride"); } catch {} });
      return;
    }
    case "user_agent": {
      await chrome.debugger.sendCommand({ tabId }, "Network.setUserAgentOverride", {
        userAgent: m.value, acceptLanguage: m.acceptLanguage, platform: m.platform,
      });
      ctx.touched.userAgent = true;
      pushUndo(async () => { try { await chrome.debugger.sendCommand({ tabId }, "Network.setUserAgentOverride", { userAgent: "" }); } catch {} });
      return;
    }
    case "timezone": {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setTimezoneOverride", { timezoneId: m.id });
      ctx.touched.timezone = true;
      pushUndo(async () => { try { await chrome.debugger.sendCommand({ tabId }, "Emulation.setTimezoneOverride", { timezoneId: "" }); } catch {} });
      return;
    }
    case "locale": {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setLocaleOverride", { locale: m.value });
      ctx.touched.locale = true;
      pushUndo(async () => { try { await chrome.debugger.sendCommand({ tabId }, "Emulation.setLocaleOverride", {}); } catch {} });
      return;
    }
    case "geolocation": {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setGeolocationOverride", {
        latitude: m.latitude, longitude: m.longitude, accuracy: m.accuracy ?? 50,
      });
      ctx.touched.geolocation = true;
      pushUndo(async () => { try { await chrome.debugger.sendCommand({ tabId }, "Emulation.clearGeolocationOverride"); } catch {} });
      return;
    }
    case "permissions": {
      const set: string[] = [];
      for (const [name, setting] of Object.entries(m.map)) {
        try {
          await chrome.debugger.sendCommand({ tabId }, "Browser.setPermission", { permission: { name }, setting });
          set.push(name);
        } catch {}
      }
      pushUndo(async () => {
        for (const name of set) {
          try { await chrome.debugger.sendCommand({ tabId }, "Browser.setPermission", { permission: { name }, setting: "prompt" }); } catch {}
        }
      });
      return;
    }
    case "color_scheme":
    case "reduced_motion": {
      const features: any[] = [];
      if (m.kind === "color_scheme") features.push({ name: "prefers-color-scheme", value: m.value });
      if (m.kind === "reduced_motion") features.push({ name: "prefers-reduced-motion", value: m.value });
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setEmulatedMedia", { features });
      ctx.touched.media = true;
      pushUndo(async () => { try { await chrome.debugger.sendCommand({ tabId }, "Emulation.setEmulatedMedia", { features: [] }); } catch {} });
      return;
    }
    case "inject_js": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (code: string) => { (0, eval)(code); },
        args: [m.code],
      });
      // No automatic undo — caller must ensure their inject is reversible
      // or clean up via `after`.
      return;
    }
    case "delete_dom": {
      const removed = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel: string) => {
          const els = [...document.querySelectorAll(sel)];
          const html = els.map((e) => e.outerHTML);
          for (const el of els) el.remove();
          return html;
        },
        args: [m.selector],
      });
      const htmls = (removed?.[0]?.result as string[]) ?? [];
      pushUndo(async () => {
        // Best-effort: re-append the removed HTML to body. Position is lost.
        if (!htmls.length) return;
        await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: (h: string[]) => {
            const tmp = document.createElement("div");
            tmp.innerHTML = h.join("");
            for (const c of [...tmp.children]) document.body.appendChild(c);
          },
          args: [htmls],
        });
      });
      return;
    }
    case "freeze_time": {
      const epoch = m.epochMs ?? Date.now();
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (e: number) => {
          const w: any = window;
          if (w.__bmcp_realDate) return;
          w.__bmcp_realDate = Date;
          const RealDate = Date;
          class FakeDate extends RealDate {
            constructor(...args: any[]) {
              if (args.length === 0) super(e); else super(...(args as []));
            }
            static now() { return e; }
          }
          w.Date = FakeDate;
        },
        args: [epoch],
      });
      pushUndo(async () => {
        await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: () => { const w: any = window; if (w.__bmcp_realDate) { w.Date = w.__bmcp_realDate; delete w.__bmcp_realDate; } },
        });
      });
      return;
    }
    case "freeze_random": {
      const seed = m.seed ?? 1;
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (s: number) => {
          const w: any = window;
          if (w.__bmcp_realRandom) return;
          w.__bmcp_realRandom = Math.random;
          let x = s || 1;
          Math.random = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
        },
        args: [seed],
      });
      pushUndo(async () => {
        await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: () => { const w: any = window; if (w.__bmcp_realRandom) { Math.random = w.__bmcp_realRandom; delete w.__bmcp_realRandom; } },
        });
      });
      return;
    }
    case "stub_global": {
      const path = m.path;
      const value = m.value;
      const r = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (p: string, v: unknown) => {
          const parts = p.split(".");
          const last = parts.pop()!;
          let host: any = window;
          for (const k of parts) host = host?.[k]; if (!host) return null;
          const prev = host[last];
          host[last] = v;
          (window as any).__bmcp_stubs ??= [];
          (window as any).__bmcp_stubs.push({ path: p, prev });
          return p;
        },
        args: [path, value],
      });
      const ok = !!r?.[0]?.result;
      if (ok) pushUndo(async () => {
        await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: (p: string) => {
            const stubs = (window as any).__bmcp_stubs as Array<{ path: string; prev: unknown }> | undefined;
            if (!stubs) return;
            // Restore the most recent stub for this path.
            for (let i = stubs.length - 1; i >= 0; i--) {
              if (stubs[i].path === p) {
                const parts = p.split(".");
                const last = parts.pop()!;
                let host: any = window;
                for (const k of parts) host = host?.[k];
                if (host) host[last] = stubs[i].prev;
                stubs.splice(i, 1);
                return;
              }
            }
          },
          args: [path],
        });
      });
      return;
    }
  }
}

async function runAction(tabId: number, a: ProbeAction): Promise<void> {
  switch (a.kind) {
    case "click": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (!el) throw new Error(`selector not found: ${sel}`); el.click(); },
        args: [a.selector],
      });
      return;
    }
    case "click_by_label": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (label: string, mode: string, flags: string, role: string | undefined) => {
          const matchFn = (s: string): boolean => {
            if (mode === "exact") return s === label;
            if (mode === "regex") return new RegExp(label, flags).test(s);
            return s.toLowerCase().includes(label.toLowerCase());
          };
          const candidates: HTMLElement[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("button, [role=button], a[href], [aria-label], summary")) {
            const aLabel = el.getAttribute("aria-label") || "";
            const txt = (el.textContent || "").trim();
            if (matchFn(aLabel) || matchFn(txt)) candidates.push(el);
          }
          for (const lab of document.querySelectorAll<HTMLLabelElement>("label")) {
            if (matchFn((lab.textContent || "").trim())) {
              const id = lab.getAttribute("for");
              const ctrl = id ? document.getElementById(id) : lab.querySelector("input,button");
              if (ctrl) candidates.push(ctrl as HTMLElement);
            }
          }
          const visible = candidates.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const target = visible || candidates[0];
          if (!target) return false;
          if (role) {
            const r = target.getAttribute("role") || target.tagName.toLowerCase();
            if (r !== role && !(role === "button" && (target.tagName === "BUTTON" || target.getAttribute("role") === "button"))) return false;
          }
          target.click();
          return true;
        },
        args: [a.label, a.mode ?? "contains", "i", a.role],
      });
      if (!result) throw new Error(`click_by_label: no match for ${a.label}`);
      return;
    }
    case "type": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel: string, text: string, clear: boolean) => {
          const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el) throw new Error(`selector not found: ${sel}`);
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(el, (clear ? "" : el.value) + text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        args: [a.selector, a.text, !!a.clear],
      });
      return;
    }
    case "fill_form": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel: string | undefined, data: any, submit: boolean) => {
          const form = (sel ? document.querySelector(sel) : document.querySelector("form")) as HTMLFormElement | null;
          if (!form) throw new Error("no form");
          for (const [k, v] of Object.entries(data)) {
            const f = form.querySelector<HTMLInputElement>(`[name="${k}"], #${CSS.escape(k)}, [aria-label="${k}"]`);
            if (!f) continue;
            const value = String(typeof v === "object" && v !== null ? (v as any).value : v);
            const setter = Object.getOwnPropertyDescriptor(
              f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
              "value",
            )?.set;
            setter?.call(f, value);
            f.dispatchEvent(new Event("input", { bubbles: true }));
            f.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (submit) {
            const btn = form.querySelector<HTMLButtonElement>('button[type="submit"], input[type="submit"]');
            if (btn) btn.click(); else form.submit();
          }
        },
        args: [a.selector, a.data, !!a.submit],
      });
      return;
    }
    case "press_key": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (key: string, sel: string | undefined, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean) => {
          const target = (sel ? document.querySelector(sel) : document.activeElement || document.body) as Element;
          const opts = { key, bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
          target.dispatchEvent(new KeyboardEvent("keydown", opts));
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
        },
        args: [a.key, a.selector, !!a.ctrl, !!a.shift, !!a.alt, !!a.meta],
      });
      return;
    }
    case "scroll": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel: string | undefined, intoView: string | undefined, dx: number, dy: number) => {
          if (intoView) { document.querySelector(intoView)?.scrollIntoView({ behavior: "auto", block: "center" }); return; }
          const target: any = sel ? document.querySelector(sel) : window;
          if ("scrollBy" in target) target.scrollBy({ left: dx || 0, top: dy || 0 });
          else if (target) { target.scrollLeft += (dx || 0); target.scrollTop += (dy || 0); }
        },
        args: [a.selector, a.intoView, a.dx ?? 0, a.dy ?? 0],
      });
      return;
    }
    case "hover": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) throw new Error(`selector not found: ${sel}`);
          for (const t of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
          }
        },
        args: [a.selector],
      });
      return;
    }
    case "navigate": { await browser.tabs.update(tabId, { url: a.url }); return; }
    case "reload": { await browser.tabs.reload(tabId, { bypassCache: !!a.bypassCache }); return; }
    case "back": { await chrome.scripting.executeScript({ target: { tabId }, func: () => history.back() }); return; }
    case "forward": { await chrome.scripting.executeScript({ target: { tabId }, func: () => history.forward() }); return; }
    case "wait": { await sleep(a.ms); return; }
    case "wait_for": {
      const deadline = Date.now() + (a.timeoutMs ?? 15_000);
      while (Date.now() < deadline) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: (sel: string | undefined, text: string | undefined, urlPat: string | undefined, networkIdle: boolean, domStable: boolean) => {
            if (sel) return !!document.querySelector(sel);
            if (text) return (document.body?.innerText || "").includes(text);
            if (urlPat) return new RegExp(urlPat).test(location.href);
            if (domStable) return true; // honored by outer loop
            if (networkIdle) return true;
            return true;
          },
          args: [a.selector, a.text, a.url, !!a.networkIdle, !!a.domStable],
        });
        if (result) return;
        await sleep(150);
      }
      return;
    }
    case "workflow_replay": {
      const { workflowHandlers } = await import("./workflow");
      await workflowHandlers.workflow({ tabId, action: "replay", name: a.name });
      return;
    }
    case "eval": {
      await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (c: string) => { (0, eval)(c); },
        args: [a.code],
      });
      return;
    }
  }
}

async function snapshotPerf(tabId: number): Promise<PerformanceMetricsResult> {
  const { diagnosticsHandlers } = await import("./diagnostics");
  return (await diagnosticsHandlers.performance_metrics({ tabId })) as PerformanceMetricsResult;
}

async function snapshotStorage(tabId: number) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: () => {
      const dump = (s: Storage) => {
        const o: Record<string, string | null> = {};
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) o[k] = s.getItem(k); }
        return o;
      };
      return { local: dump(localStorage), session: dump(sessionStorage) };
    },
  });
  return result as { local: Record<string, string | null>; session: Record<string, string | null> };
}

async function restoreStorage(tabId: number, snap: { local: Record<string, string | null>; session: Record<string, string | null> }) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: (snap: any) => {
      try { localStorage.clear(); for (const [k, v] of Object.entries(snap.local)) if (v !== null) localStorage.setItem(k, v as string); } catch {}
      try { sessionStorage.clear(); for (const [k, v] of Object.entries(snap.session)) if (v !== null) sessionStorage.setItem(k, v as string); } catch {}
    },
    args: [snap],
  });
}

async function snapshotCookies(tabId: number): Promise<chrome.cookies.Cookie[]> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url) return [];
  return browser.cookies.getAll({ url: tab.url }) as any;
}
async function restoreCookies(snap: chrome.cookies.Cookie[]) {
  for (const c of snap) {
    try {
      await browser.cookies.set({
        url: cookieUrl(c),
        name: c.name, value: c.value,
        domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite as any,
        expirationDate: (c as any).expirationDate,
      });
    } catch {}
  }
}
async function observeInPage(tabId: number, domSelector: string | undefined) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: (sel: string | undefined) => {
      const root = sel ? document.querySelector(sel) : document.body;
      const isVisible = (el: HTMLElement) => {
        if (!el.offsetParent && el !== document.body) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const a11yError = !!document.querySelector('[role=alert], [role=status][aria-live=assertive]');
      let visibleErrorText: string | undefined;
      const errEl = [...document.querySelectorAll<HTMLElement>('[role=alert], .error, [class*=error], [data-error]')]
        .find((el) => isVisible(el) && (el.textContent || "").trim().length > 0);
      if (errEl) visibleErrorText = (errEl.textContent || "").trim().slice(0, 240);
      const loadingVisible = [...document.querySelectorAll<HTMLElement>('[aria-busy=true], [class*=spinner], [class*=loading], [data-loading]')]
        .some((el) => isVisible(el));
      // domChanged is computed at the orchestrator level via baseline cursor;
      // here we report a lightweight signal — body innerText length.
      const textLen = (root as any)?.innerText?.length ?? 0;
      return { a11yError, visibleErrorText, loadingVisible, textLen, domChanged: true };
    },
    args: [domSelector],
  });
  return result as { a11yError: boolean; visibleErrorText?: string; loadingVisible: boolean; textLen: number; domChanged: boolean };
}

async function evalExpectation(
  tabId: number,
  exp: ProbeExpectation,
  ctx: {
    baselineMs: number;
    urlBefore: string;
    urlAfter: string;
    observeIn: { a11yError: boolean; visibleErrorText?: string; loadingVisible: boolean };
    consoleAdded: any[];
    failedAdded: any[];
    allAdded: any[];
  },
): Promise<ProbeExpectationResult> {
  const pass = (detail?: string): ProbeExpectationResult => ({ expectation: exp, status: "pass", detail });
  const fail = (detail?: string): ProbeExpectationResult => ({ expectation: exp, status: "fail", detail });

  switch (exp.kind) {
    case "request_fires": {
      const re = exp.urlRegex ? new RegExp(exp.urlRegex) : null;
      const matched = ctx.allAdded.filter((e) => {
        if (re && !re.test(e.url)) return false;
        if (exp.urlPattern && !e.url.includes(exp.urlPattern)) return false;
        if (exp.statusMin !== undefined && (e.status ?? 0) < exp.statusMin) return false;
        if (exp.statusMax !== undefined && (e.status ?? 999) > exp.statusMax) return false;
        return true;
      });
      return matched.length ? pass(`${matched.length} matching request(s)`) : fail("no matching request observed");
    }
    case "error_visible":
      return ctx.observeIn.a11yError || ctx.observeIn.visibleErrorText
        ? pass(ctx.observeIn.visibleErrorText) : fail("no a11y error region or visible error text");
    case "route_changes": {
      if (!exp.pattern) return ctx.urlBefore !== ctx.urlAfter ? pass(`${ctx.urlBefore} → ${ctx.urlAfter}`) : fail("URL unchanged");
      return new RegExp(exp.pattern).test(ctx.urlAfter) ? pass(ctx.urlAfter) : fail(`url ${ctx.urlAfter} did not match ${exp.pattern}`);
    }
    case "no_console_errors":
      return ctx.consoleAdded.length === 0 ? pass() : fail(`${ctx.consoleAdded.length} new error(s)`);
    case "dom_stable":
      return !ctx.observeIn.loadingVisible ? pass() : fail("loading indicator still visible");
    case "selector_appears": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (s: string) => !!document.querySelector(s), args: [exp.selector],
      });
      return result ? pass() : fail(`selector not found: ${exp.selector}`);
    }
    case "selector_gone": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (s: string) => !document.querySelector(s), args: [exp.selector],
      });
      return result ? pass() : fail(`selector still present: ${exp.selector}`);
    }
    case "text_appears": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (t: string) => (document.body?.innerText || "").includes(t), args: [exp.text],
      });
      return result ? pass() : fail(`text not found: ${exp.text}`);
    }
    case "no_broken_images": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: () => [...document.querySelectorAll("img")].filter((i) => i.complete && (i as HTMLImageElement).naturalWidth === 0).length,
      });
      const n = result as number;
      return n === 0 ? pass() : fail(`${n} broken image(s)`);
    }
    case "response_shape": {
      const matched = ctx.allAdded.find((e) => e.url.includes(exp.urlPattern));
      if (!matched) return fail(`no response for ${exp.urlPattern}`);
      try {
        // We need the body; re-fetch with includeBodies via readNet on requestId.
        const full = await readNet({ requestIds: [matched.requestId], includeBodies: true });
        const body = full[0]?.responseBody ?? "";
        const parsed = JSON.parse(body);
        return shapeMatches(parsed, exp.shape) ? pass() : fail("response shape mismatch");
      } catch (e: any) {
        return fail(`could not parse response: ${String(e?.message ?? e)}`);
      }
    }
  }
}

function shapeMatches(value: any, shape: any): boolean {
  if (shape === null) return value === null;
  if (typeof shape !== "object") return typeof value === typeof shape;
  if (Array.isArray(shape)) return Array.isArray(value) && (shape.length === 0 || value.every((v) => shapeMatches(v, shape[0])));
  if (typeof value !== "object" || value === null) return false;
  for (const k of Object.keys(shape)) {
    if (!(k in value)) return false;
    if (!shapeMatches(value[k], shape[k])) return false;
  }
  return true;
}

function computeVerdict(
  exps: ProbeExpectationResult[],
  ev: ProbeResult["evidence"],
): ProbeResult["verdict"] {
  if (exps.length) {
    const failures = exps.filter((e) => e.status === "fail").length;
    const passes = exps.filter((e) => e.status === "pass").length;
    if (failures === 0) return "recovered_gracefully";
    if (passes === 0) return "silent_failure";
    return "degraded_with_signal";
  }
  // Heuristic verdict.
  const broken = ev.failedRequestsAdded > 0;
  if (!broken) return "recovered_gracefully";
  const signal = ev.a11yErrorMessageFound || !!ev.visibleErrorText || ev.routeChanged;
  if (broken && !ev.domChanged && !signal) return "silent_failure";
  if (broken && signal) return "degraded_with_signal";
  return "degraded_with_signal";
}

function renderSummary(verdict: ProbeResult["verdict"], ev: ProbeResult["evidence"], exps: ProbeExpectationResult[]): string {
  const parts: string[] = [];
  if (ev.failedRequestsAdded) parts.push(`${ev.failedRequestsAdded} failed request(s)`);
  if (ev.consoleErrorsAdded) parts.push(`${ev.consoleErrorsAdded} new console error(s)`);
  if (ev.routeChanged) parts.push(`route ${ev.urlBefore} → ${ev.urlAfter}`);
  if (ev.a11yErrorMessageFound) parts.push("a11y error region found");
  if (ev.visibleErrorText) parts.push(`error text: "${ev.visibleErrorText.slice(0, 80)}"`);
  if (ev.loadingStillVisible) parts.push("loading indicator stuck");
  if (exps.length) {
    const f = exps.filter((e) => e.status === "fail").length;
    const p = exps.filter((e) => e.status === "pass").length;
    parts.push(`${p}/${exps.length} expectations passed`);
    if (f) parts.push(`${f} failed`);
  }
  return `${verdict}: ${parts.join("; ") || "no notable signals"}`;
}
