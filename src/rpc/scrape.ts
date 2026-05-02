import browser from "webextension-polyfill";
import type {
  AnimationInspectParams,
  AnimationInspectResult,
  AntiBotDetectParams,
  AntiBotDetectResult,
  AssetCaptureParams,
  AssetCaptureResult,
  AuditFinding,
  BrokenLinksCheckParams,
  BrokenLinksCheckResult,
  BundleResourcesParams,
  BundleResourcesResult,
  DedupeItemsParams,
  DedupeItemsResult,
  ExportCsvParams,
  ExportCsvResult,
  FormsValidateParams,
  FormsValidateResult,
  InfiniteScrollExtractParams,
  InfiniteScrollExtractResult,
  LighthouseQuickParams,
  LighthouseQuickResult,
  LinkGraphParams,
  LinkGraphResult,
  MemorySampleParams,
  MemorySampleResult,
  PerformanceMetricsResult,
  RouteChangeWaitParams,
  RouteChangeWaitResult,
  SchemaInferParams,
  SchemaInferResult,
  ViewportMatrixCellResult,
  ViewportMatrixParams,
  ViewportMatrixResult,
} from "../shared/protocol";
import { readNetwork as readNet } from "../net";
import { sleep, waitForTabComplete } from "./runtime";

export const scrapeHandlers: Record<string, (p: any) => Promise<unknown>> = {
  infinite_scroll_extract: async (p: InfiniteScrollExtractParams): Promise<InfiniteScrollExtractResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: runInfiniteScroll as any,
      args: [p.itemSelector, p.fields ?? null, p.scrollContainer ?? null, p.maxPasses ?? 30, p.settleMs ?? 800, p.stableFor ?? 2, p.maxItems ?? 1000],
    });
    return result as InfiniteScrollExtractResult;
  },

  link_graph: async (p: LinkGraphParams): Promise<LinkGraphResult> => {
    const depth = p.depth ?? 1;
    const sameOrigin = p.sameOriginOnly !== false;
    const settle = p.settleMs ?? 1500;
    const maxPages = p.maxPages ?? 25;
    const includeRe = p.includeRegex ? new RegExp(p.includeRegex) : null;
    const excludeRe = p.excludeRegex ? new RegExp(p.excludeRegex) : null;
    const tab = await browser.tabs.get(p.tabId);
    const startUrl = tab.url ?? "";
    let origin = "";
    try { origin = new URL(startUrl).origin; } catch {}
    const visited = new Map<string, { title?: string; depth: number; status?: number }>();
    const edges: Array<{ from: string; to: string }> = [];
    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
    visited.set(startUrl, { depth: 0 });

    while (queue.length && visited.size <= maxPages) {
      const { url, depth: d } = queue.shift()!;
      try {
        await browser.tabs.update(p.tabId, { url });
        await waitForTabComplete(p.tabId, 20_000);
        await sleep(settle);
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: p.tabId },
          func: () => ({
            title: document.title,
            links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.href),
          }),
        });
        const r = result as { title: string; links: string[] };
        visited.set(url, { ...visited.get(url)!, title: r.title, status: 200 });
        if (d >= depth) continue;
        for (const raw of r.links) {
          let target: string;
          try { target = new URL(raw, url).toString().split("#")[0]; } catch { continue; }
          if (sameOrigin && origin && !target.startsWith(origin)) continue;
          if (includeRe && !includeRe.test(target)) continue;
          if (excludeRe && excludeRe.test(target)) continue;
          edges.push({ from: url, to: target });
          if (!visited.has(target)) {
            visited.set(target, { depth: d + 1 });
            queue.push({ url: target, depth: d + 1 });
          }
        }
      } catch (e: any) {
        visited.set(url, { ...visited.get(url)!, status: 0 });
      }
    }
    return {
      nodes: [...visited.entries()].map(([url, m]) => ({ url, title: m.title, depth: m.depth, status: m.status })),
      edges,
    };
  },

  broken_links_check: async (p: BrokenLinksCheckParams): Promise<BrokenLinksCheckResult> => {
    const tab = await browser.tabs.get(p.tabId);
    let origin = "";
    try { if (tab.url) origin = new URL(tab.url).origin; } catch {}
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: () => [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.href),
    });
    const all: string[] = result as string[];
    let candidates = Array.from(new Set(all)).filter((h) => /^https?:/.test(h));
    if (p.sameOriginOnly !== false && origin) candidates = candidates.filter((h) => h.startsWith(origin));
    const limit = p.limit ?? 200;
    candidates = candidates.slice(0, limit);

    const concurrency = Math.max(1, Math.min(32, p.concurrency ?? 8));
    const headFirst = p.headFirst !== false;
    const out: BrokenLinksCheckResult["results"] = [];
    let i = 0;
    async function worker() {
      while (i < candidates.length) {
        const url = candidates[i++];
        try {
          const method = headFirst ? "HEAD" : "GET";
          let resp = await fetch(url, { method, redirect: "follow" });
          if (resp.status === 405 && headFirst) resp = await fetch(url, { method: "GET", redirect: "follow" });
          out.push({ href: url, status: resp.status, ok: resp.ok });
        } catch (e: any) {
          out.push({ href: url, status: null, ok: false, error: String(e?.message ?? e) });
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { results: out };
  },

  memory_sample: async (p: MemorySampleParams): Promise<MemorySampleResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: () => {
        const m = (performance as any).memory;
        const allEls = document.querySelectorAll("*").length;
        // Detached DOM nodes are ones not connected to document. We can't
        // enumerate the heap, but can flag refs hanging off window globals.
        let detached = 0;
        const w: any = window;
        for (const k of Object.keys(w)) {
          const v = (w as any)[k];
          if (v instanceof Element && !v.isConnected) detached++;
        }
        return {
          jsHeapUsedBytes: m?.usedJSHeapSize,
          jsHeapTotalBytes: m?.totalJSHeapSize,
          jsHeapLimitBytes: m?.jsHeapSizeLimit,
          domNodes: allEls,
          documents: document.querySelectorAll("iframe").length + 1,
          detachedDomCandidates: detached,
        };
      },
    });
    return result as MemorySampleResult;
  },

  animation_inspect: async (p: AnimationInspectParams): Promise<AnimationInspectResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return { animations: [] };
        const anims: any[] = [];
        // Web Animations API.
        const wa = (el as any).getAnimations?.({ subtree: true }) || [];
        for (const a of wa) {
          const t = a.effect?.getTiming?.();
          anims.push({
            id: a.id || `wa-${anims.length}`,
            type: "web-animation",
            playState: a.playState,
            name: (a.effect as any)?.target?.tagName?.toLowerCase(),
            durationMs: t?.duration,
            delayMs: t?.delay,
            iterationCount: t?.iterations,
          });
        }
        // CSS animations/transitions via computed style on the target.
        const cs = getComputedStyle(el as Element);
        if (cs.animationName && cs.animationName !== "none") {
          anims.push({
            id: `css-anim-${anims.length}`,
            type: "css-animation",
            playState: cs.animationPlayState,
            name: cs.animationName,
            durationMs: parseFloat(cs.animationDuration) * 1000,
            delayMs: parseFloat(cs.animationDelay) * 1000,
            iterationCount: cs.animationIterationCount === "infinite" ? "infinite" : parseFloat(cs.animationIterationCount),
          });
        }
        if (cs.transitionProperty && cs.transitionProperty !== "none" && cs.transitionProperty !== "all 0s ease 0s") {
          anims.push({
            id: `css-trans-${anims.length}`,
            type: "css-transition",
            playState: "running",
            name: cs.transitionProperty,
            durationMs: parseFloat(cs.transitionDuration) * 1000,
            delayMs: parseFloat(cs.transitionDelay) * 1000,
          });
        }
        return { animations: anims };
      },
      args: [p.selector],
    });
    return result as AnimationInspectResult;
  },

  route_change_wait: async (p: RouteChangeWaitParams): Promise<RouteChangeWaitResult> => {
    const start = Date.now();
    const tabId = p.tabId;
    const re = p.pattern ? new RegExp(p.pattern, p.flags ?? "i") : null;
    const tab0 = await browser.tabs.get(tabId);
    const url0 = tab0.url ?? "";
    const deadline = start + (p.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      const tab = await browser.tabs.get(tabId);
      const url = tab.url ?? "";
      const hit = re ? re.test(url) : url !== url0;
      if (hit) return { changed: true, url, elapsedMs: Date.now() - start };
      await sleep(150);
    }
    const tabF = await browser.tabs.get(tabId);
    return { changed: false, url: tabF.url ?? "", elapsedMs: Date.now() - start };
  },

  anti_bot_detect: async (p: AntiBotDetectParams): Promise<AntiBotDetectResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: () => {
        const signals: AntiBotDetectResult["signals"] = [];
        const html = document.documentElement.outerHTML;
        if (/Cloudflare|cf-chl-bypass|__cf_chl/.test(html)) signals.push({ kind: "cloudflare", details: "Cloudflare challenge markers in DOM" });
        if (document.querySelector('iframe[src*="recaptcha"]')) signals.push({ kind: "recaptcha", selector: 'iframe[src*="recaptcha"]' });
        if (document.querySelector('iframe[src*="hcaptcha"]')) signals.push({ kind: "hcaptcha", selector: 'iframe[src*="hcaptcha"]' });
        if (document.querySelector('iframe[src*="turnstile"]') || /challenges\.cloudflare\.com/.test(html)) signals.push({ kind: "turnstile" });
        if (/\bcaptcha\b/i.test(document.title)) signals.push({ kind: "captcha", details: "captcha in <title>" });
        // Login wall: prominent login form + no main content.
        if (document.querySelector('input[type="password"]') && (document.body.innerText.length < 800)) {
          signals.push({ kind: "login_wall", selector: 'input[type="password"]' });
        }
        // Paywall: common class names.
        if (document.querySelector('[class*=paywall], [id*=paywall], [class*=premium-only]')) {
          signals.push({ kind: "paywall" });
        }
        // 403/429 visible on page text.
        if (/access denied|rate limit|too many requests|blocked/i.test(document.body.innerText.slice(0, 2000))) {
          signals.push({ kind: "bot_block", details: "denial text in body" });
        }
        return { signals };
      },
    });
    return result as AntiBotDetectResult;
  },

  lighthouse_quick: async (p: LighthouseQuickParams): Promise<LighthouseQuickResult> => {
    // Reuses performance_metrics + audit({checks:["a11y","seo"]}) — call them
    // out-of-band so we don't depend on diagnostics/audit imports order.
    const [{ result: vitals }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: () => {
        const byType = (t: string) => { try { return performance.getEntriesByType(t); } catch { return []; } };
        const paint = byType("paint");
        const fcp = paint.find((e: any) => e.name === "first-contentful-paint")?.startTime;
        const lcpEntries = byType("largest-contentful-paint") as any[];
        const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].renderTime || lcpEntries[lcpEntries.length - 1].loadTime : undefined;
        let cls = 0; for (const e of byType("layout-shift") as any[]) if (!e.hadRecentInput) cls += e.value;
        const navE = byType("navigation") as any[];
        const ttfb = navE[0] ? navE[0].responseStart - navE[0].requestStart : undefined;
        return { lcpMs: lcp, cls, fcpMs: fcp, ttfbMs: ttfb, resourceCount: byType("resource").length } as PerformanceMetricsResult;
      },
    });
    // No real Lighthouse without the lib; produce a heuristic 0–100 score
    // from LCP/CLS thresholds. SEO/A11y come from audit findings.
    const v = vitals as PerformanceMetricsResult;
    const perf = scoreVitals(v);
    // We can't import audit handlers cleanly here without circular deps;
    // run a tiny inline audit subset for the score.
    const [{ result: audits }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: () => {
        const findings: AuditFinding[] = [];
        if (!document.title) findings.push({ check: "seo", severity: "error", message: "Missing <title>" });
        if (!document.querySelector('meta[name="description"]')) findings.push({ check: "seo", severity: "warn", message: "Missing meta description" });
        if (!document.documentElement.lang) findings.push({ check: "i18n", severity: "warn", message: "<html> has no lang" });
        for (const img of document.querySelectorAll<HTMLImageElement>("img")) {
          if (!img.alt && img.getAttribute("alt") === null) findings.push({ check: "a11y", severity: "warn", message: "Image missing alt" });
        }
        return findings;
      },
    });
    const a = (audits as AuditFinding[]) ?? [];
    const score = {
      performance: perf,
      accessibility: 100 - Math.min(100, a.filter((x) => x.check === "a11y").length * 5),
      seo: 100 - Math.min(100, a.filter((x) => x.check === "seo").length * 10),
    };
    return { vitals: v, audits: a, score };
  },

  schema_infer: async (p: SchemaInferParams): Promise<SchemaInferResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (itemSel: string, sample: number) => {
        const items = [...document.querySelectorAll<HTMLElement>(itemSel)].slice(0, sample);
        if (!items.length) return { fields: [] };
        // Find descendants present in most items.
        const counts = new Map<string, { count: number; values: string[] }>();
        for (const item of items) {
          const seen = new Set<string>();
          for (const child of item.querySelectorAll<HTMLElement>("*")) {
            const tag = child.tagName.toLowerCase();
            const cls = (child.className && typeof (child as any).className === "string")
              ? (child as HTMLElement).className.trim().split(/\s+/).slice(0, 1).map((c) => "." + c).join("")
              : "";
            const k = tag + cls;
            if (seen.has(k)) continue;
            seen.add(k);
            const cur = counts.get(k) ?? { count: 0, values: [] };
            cur.count++;
            const v = (child.textContent || "").replace(/\s+/g, " ").trim();
            if (v && cur.values.length < 3) cur.values.push(v.slice(0, 80));
            counts.set(k, cur);
          }
        }
        const total = items.length;
        const fields = [...counts.entries()]
          .filter(([, v]) => v.count >= total * 0.6)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 25)
          .map(([selector, v]) => ({
            name: selector.replace(/[^a-zA-Z0-9]/g, "_"),
            selector,
            coverage: +(v.count / total).toFixed(2),
            sampleValues: v.values,
          }));
        return { fields };
      },
      args: [p.itemSelector, p.sample ?? 20],
    });
    return result as SchemaInferResult;
  },

  asset_capture: async (p: AssetCaptureParams): Promise<AssetCaptureResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: () => ({
        url: location.href,
        domHtml: document.documentElement.outerHTML,
        resources: performance.getEntriesByType("resource").map((r: any) => ({
          url: r.name,
          type: r.initiatorType,
          sizeBytes: r.transferSize,
          cached: r.transferSize === 0 && r.encodedBodySize > 0,
        })),
      }),
    });
    const r = result as { url: string; domHtml: string; resources: Array<{ url: string; type: string; sizeBytes?: number; cached?: boolean }> };
    const assets = r.resources.slice(0, 1000) as Array<{ url: string; type: string; sizeBytes?: number; cached?: boolean; base64?: string }>;
    if (p.inlineSmall) {
      // Inline small assets via fetch in tab context, capped to avoid huge results.
      let inlined = 0;
      for (const a of assets) {
        if (inlined >= 30) break;
        if (a.sizeBytes && a.sizeBytes > 200_000) continue;
        try {
          const [{ result: b64 }] = await chrome.scripting.executeScript({
            target: { tabId: p.tabId },
            world: "MAIN",
            func: async (url: string) => {
              const r = await fetch(url);
              const buf = new Uint8Array(await r.arrayBuffer());
              let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
              return btoa(s);
            },
            args: [a.url],
          });
          a.base64 = b64 as string;
          inlined++;
        } catch {}
      }
    }
    return { url: r.url, capturedAt: new Date().toISOString(), domHtml: r.domHtml, assets };
  },

  bundle_resources: async (p: BundleResourcesParams): Promise<BundleResourcesResult> => {
    const groupBy = p.groupBy ?? "type";
    const entries = await readNet({ tabId: p.tabId, includeBodies: false, limit: 5000 });
    const groups = new Map<string, { count: number; bytes: number; items: Array<{ url: string; bytes: number; type: string; cached: boolean }> }>();
    let total = 0;
    for (const e of entries) {
      const ct = (e.responseHeaders?.["content-type"] || e.responseHeaders?.["Content-Type"] || "").split(";")[0];
      const type = ct.split("/")[1] || ct || "other";
      let host = "";
      try { host = new URL(e.url).host; } catch {}
      const cl = +(e.responseHeaders?.["content-length"] || e.responseHeaders?.["Content-Length"] || 0);
      const bytes = isFinite(cl) ? cl : 0;
      total += bytes;
      const key = groupBy === "origin" ? host : groupBy === "cache" ? (e.responseHeaders?.["cache-control"] ? "cached" : "uncached") : type;
      const g = groups.get(key) ?? { count: 0, bytes: 0, items: [] };
      g.count++;
      g.bytes += bytes;
      g.items.push({ url: e.url, bytes, type, cached: !!e.responseHeaders?.["cache-control"] });
      groups.set(key, g);
    }
    return {
      groups: [...groups.entries()].map(([key, g]) => ({ key, count: g.count, bytes: g.bytes, items: g.items.slice(0, 50) })).sort((a, b) => b.bytes - a.bytes),
      totalBytes: total,
    };
  },

  forms_validate: async (p: FormsValidateParams): Promise<FormsValidateResult> => {
    const limit = p.limit ?? 20;
    const maxFields = p.maxFields ?? 50;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (sel: string | null, limit: number, maxFields: number) => {
        const allForms = sel ? [document.querySelector(sel) as HTMLFormElement | null].filter(Boolean) : [...document.querySelectorAll<HTMLFormElement>("form")];
        const total = allForms.length;
        const forms = allForms.slice(0, limit);
        const out: any[] = [];
        for (const form of forms) {
          if (!form) continue;
          const fields = [...form.querySelectorAll<HTMLInputElement>("input,select,textarea")];
          const invalidFields: any[] = [];
          let allValid = true;
          let truncatedFields = false;
          for (const f of fields) {
            if ((f as any).willValidate === false) continue;
            const v = (f as any).validity as ValidityState;
            if (!v.valid) {
              allValid = false;
              if (invalidFields.length >= maxFields) { truncatedFields = true; continue; }
              const flags = Object.keys(v).filter((k) => (v as any)[k] === true && k !== "valid");
              const msg = (f.validationMessage ?? "");
              invalidFields.push({
                name: f.name || f.id || "",
                selector: (f.id ? `#${f.id}` : f.tagName.toLowerCase() + (f.name ? `[name="${f.name}"]` : "")),
                validity: flags,
                message: msg.length > 240 ? msg.slice(0, 240) : msg,
              });
            }
          }
          const entry: any = { selector: (form as any).id ? `#${(form as any).id}` : "form", valid: allValid, invalidFields };
          if (truncatedFields) entry.truncatedFields = true;
          out.push(entry);
        }
        return { forms: out, truncated: total > forms.length };
      },
      args: [p.selector ?? null, limit, maxFields],
    });
    const r = result as { forms: FormsValidateResult["forms"]; truncated: boolean };
    return r.truncated ? { forms: r.forms, truncated: true } : { forms: r.forms };
  },

  viewport_matrix: async (p: ViewportMatrixParams): Promise<ViewportMatrixResult> => {
    const tab = await browser.tabs.get(p.tabId);
    if (!tab.windowId) throw new Error("no windowId");
    const settle = p.settleMs ?? 400;
    const wantShot = p.screenshot !== false;
    const results: ViewportMatrixCellResult[] = [];
    for (const cell of p.cells) {
      const cellRes: ViewportMatrixCellResult = { label: cell.label };
      try {
        await chrome.debugger.sendCommand({ tabId: p.tabId }, "Emulation.setDeviceMetricsOverride", {
          width: cell.width,
          height: cell.height,
          deviceScaleFactor: cell.deviceScaleFactor ?? 1,
          mobile: !!cell.mobile,
        });
        if (cell.prefersColorScheme) {
          await chrome.debugger.sendCommand({ tabId: p.tabId }, "Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: cell.prefersColorScheme }],
          });
        }
        await sleep(settle);
        if (wantShot) {
          const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          cellRes.pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        }
        // audit per cell is delegated by the caller — we don't import the
        // audit module here to keep modules independent. Caller can call
        // `audit` between cells if richer findings are needed.
      } catch (e: any) {
        cellRes.errors = [String(e?.message ?? e)];
      }
      results.push(cellRes);
    }
    // Reset overrides at the end.
    try {
      await chrome.debugger.sendCommand({ tabId: p.tabId }, "Emulation.clearDeviceMetricsOverride");
      await chrome.debugger.sendCommand({ tabId: p.tabId }, "Emulation.setEmulatedMedia", { features: [] });
    } catch {}
    return { results };
  },

  export_csv: async (p: ExportCsvParams): Promise<ExportCsvResult> => {
    const rows = p.rows ?? [];
    const cols = p.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
    const delim = p.delimiter ?? ",";
    const esc = (v: unknown) => {
      const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = cols.map(esc).join(delim);
    const body = rows.map((r) => cols.map((c) => esc((r as any)[c])).join(delim)).join("\n");
    const csv = header + (body ? "\n" + body : "");
    return { csv, rows: rows.length, columns: cols };
  },

  dedupe_items: async (p: DedupeItemsParams): Promise<DedupeItemsResult> => {
    const rows = p.rows ?? [];
    const norm = p.normalize !== false;
    const keys = p.keys && p.keys.length ? p.keys : (rows[0] ? Object.keys(rows[0]) : []);
    const seen = new Set<string>();
    const out: typeof rows = [];
    let removed = 0;
    for (const r of rows) {
      const k = keys.map((k) => {
        const v = (r as any)[k];
        if (typeof v === "string" && norm) return v.trim().toLowerCase();
        return JSON.stringify(v ?? null);
      }).join("|");
      if (seen.has(k)) { removed++; continue; }
      seen.add(k);
      out.push(r);
    }
    return { rows: out, removed };
  },
};

// ─── in-page helpers ───

function runInfiniteScroll(itemSelector: string, fields: any, scrollContainer: string | null, maxPasses: number, settleMs: number, stableFor: number, maxItems: number) {
  return new Promise<InfiniteScrollExtractResult>(async (resolve) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const root: Element | Window = scrollContainer ? (document.querySelector(scrollContainer) as Element) : window;
    const collected = new Map<string, Record<string, string>>();
    let passes = 0;
    let stable = 0;
    let lastSize = 0;
    while (passes < maxPasses && collected.size < maxItems) {
      const items = [...document.querySelectorAll<HTMLElement>(itemSelector)];
      for (const it of items) {
        const key = it.outerHTML.slice(0, 200);
        if (collected.has(key)) continue;
        const row: Record<string, string> = {};
        if (fields) {
          for (const [name, spec] of Object.entries(fields as Record<string, { selector?: string; attr?: string }>)) {
            const targetEl = spec.selector ? it.querySelector(spec.selector) : it;
            if (!targetEl) { row[name] = ""; continue; }
            row[name] = spec.attr ? (targetEl.getAttribute(spec.attr) || "") : (targetEl.textContent || "").replace(/\s+/g, " ").trim();
          }
        } else {
          row.text = (it.textContent || "").replace(/\s+/g, " ").trim();
          const link = it.querySelector("a[href]") as HTMLAnchorElement | null;
          if (link) row.href = link.href;
        }
        collected.set(key, row);
        if (collected.size >= maxItems) break;
      }
      // Scroll.
      if ("scrollTo" in root) (root as Window).scrollTo({ top: (root as Window).scrollY + window.innerHeight * 0.95 });
      else (root as Element).scrollTop += (root as Element).clientHeight * 0.95;
      await sleep(settleMs);
      passes++;
      if (collected.size === lastSize) stable++;
      else { stable = 0; lastSize = collected.size; }
      if (stable >= stableFor) break;
    }
    resolve({ items: [...collected.values()], passes, stableHit: stable >= stableFor });
  });
}

function scoreVitals(v: PerformanceMetricsResult): number {
  let score = 100;
  if (v.lcpMs && v.lcpMs > 2500) score -= Math.min(40, (v.lcpMs - 2500) / 100);
  if (v.cls && v.cls > 0.1) score -= Math.min(30, (v.cls - 0.1) * 100);
  if (v.ttfbMs && v.ttfbMs > 800) score -= Math.min(20, (v.ttfbMs - 800) / 50);
  return Math.max(0, Math.round(score));
}
