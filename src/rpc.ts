import browser from "webextension-polyfill";
import type {
  ClickAllMatchingParams,
  ClickAllMatchingResult,
  ClickParams,
  DownloadFileParams,
  DownloadFileResult,
  HoverParams,
  PressKeyParams,
  ScrollParams,
  ScrollResult,
  NavigateSequenceParams,
  NavigateSequenceResult,
  NetworkEntry,
  OpenDevtoolsParams,
  ScreenshotParams,
  TypeTextParams,
  WaitForSelectorParams,
  WaitForSelectorResult,
  WaitForUrlParams,
  WaitForUrlResult,
  WindowCreateParams,
  WindowCreateResult,
  WindowListResult,
  WaitForTextParams,
  WaitForTextResult,
  FindElementsParams,
  FindElementsResult,
  SelectOptionParams,
  SelectOptionResult,
  IframeListParams,
  IframeListResult,
  IframeEvalParams,
  IframeEvalResult,
  ConsoleLogsParams,
  ConsoleLogsResult,
  AccessibilityTreeParams,
  AccessibilityTreeResult,
  AxNode,
  ClickByTextParams,
  ClickByTextResult,
  DragDropParams,
  UploadFileParams,
  UploadFileResult,
  SetUserAgentParams,
  SetViewportParams,
  PdfExportParams,
  PdfExportResult,
} from "../../src/shared/protocol";
import { createNetworkHandlers } from "./rpc/network";
import { domHandlers } from "./rpc/dom";
import { evalHandlers } from "./rpc/eval";
import { diagnosticsHandlers } from "./rpc/diagnostics";
import { extractHandlers } from "./rpc/extract";
import { auditHandlers } from "./rpc/audit";
import { apiInspectHandlers } from "./rpc/api-inspect";
import { locatorHandlers } from "./rpc/locators";
import { monitorHandlers } from "./rpc/monitor";
import { workflowHandlers } from "./rpc/workflow";
import { emulateHandlers } from "./rpc/emulate";
import { frameworkHandlers } from "./rpc/framework";
import { scrapeHandlers } from "./rpc/scrape";
import { probeHandlers } from "./rpc/probe";
import { activeTabId, runInMainWorld, runInPage, sleep, waitForTabComplete } from "./rpc/runtime";
import { storageHandlers } from "./rpc/storage";
import { tabHandlers } from "./rpc/tabs";

/**
 * Handler map — each entry mirrors a RpcMethod.
 * Keep handlers small; delegate heavy lifting to network.ts / intercept.ts
 * / ws-capture.ts and focused modules under ./rpc.
 */
export const handlers: Record<string, (params: any) => Promise<unknown>> = {
  ping: async () => ({ ok: true, ts: Date.now() }),
  ...tabHandlers,
  ...storageHandlers,
  ...createNetworkHandlers(emitStream),
  ...evalHandlers,
  ...domHandlers,
  ...diagnosticsHandlers,
  ...extractHandlers,
  ...auditHandlers,
  ...apiInspectHandlers,
  ...locatorHandlers,
  ...monitorHandlers,
  ...workflowHandlers,
  ...emulateHandlers,
  ...frameworkHandlers,
  ...scrapeHandlers,
  ...probeHandlers,

  click: async (p: ClickParams) => {
    await runInPage(
      p.tabId,
      (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`selector not found: ${sel}`);
        el.click();
      },
      [p.selector],
    );
    return { ok: true };
  },

  type_text: async (p: TypeTextParams) => {
    await runInPage(
      p.tabId,
      (sel: string, text: string, clear: boolean) => {
        const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
        if (!el) throw new Error(`selector not found: ${sel}`);
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value",
        )?.set;
        const next = (clear ? "" : el.value) + text;
        setter?.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      [p.selector, p.text, p.clear ?? false],
    );
    return { ok: true };
  },

  screenshot: async (p: ScreenshotParams) => {
    const tab = p.tabId
      ? await browser.tabs.get(p.tabId)
      : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.windowId || !tab?.id) throw new Error("no target tab");

    // Resolve the crop rect, if any. selector wins; else clip; else full
    // viewport.
    let rect: { x: number; y: number; w: number; h: number; dpr: number } | null = null;
    if (p.selector) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 };
        },
        args: [p.selector],
      });
      if (!result) throw new Error(`selector not found: ${p.selector}`);
      rect = result as any;
    } else if (p.clip) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.devicePixelRatio || 1,
      });
      rect = { ...p.clip, dpr: (result as number) || 1 };
    }

    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });

    if (!rect) {
      return { pngBase64: dataUrl.replace(/^data:image\/png;base64,/, "") };
    }

    // Crop in a content-script <canvas>.
    const [{ result: cropped }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (dataUrl: string, rect: { x: number; y: number; w: number; h: number; dpr: number }) => {
        const img = new Image();
        img.src = dataUrl;
        await new Promise((r) => (img.onload = r));
        const c = document.createElement("canvas");
        const dpr = rect.dpr;
        c.width = Math.max(1, Math.round(rect.w * dpr));
        c.height = Math.max(1, Math.round(rect.h * dpr));
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, rect.x * dpr, rect.y * dpr, rect.w * dpr, rect.h * dpr, 0, 0, c.width, c.height);
        return c.toDataURL("image/png");
      },
      args: [dataUrl, rect],
    });
    const base64 = (cropped as string).replace(/^data:image\/png;base64,/, "");
    return {
      pngBase64: base64,
      width: Math.round(rect.w * rect.dpr),
      height: Math.round(rect.h * rect.dpr),
    };
  },

  // ──────────────────────────────────────────────────────────────────────
  // Tier 1
  // ──────────────────────────────────────────────────────────────────────

  wait_for_selector: async (p: WaitForSelectorParams): Promise<WaitForSelectorResult> => {
    const start = Date.now();
    const deadline = start + (p.timeoutMs ?? 15_000);
    const visible = p.visible ?? true;
    const poll = p.pollMs ?? 100;
    while (Date.now() < deadline) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: p.tabId },
        func: (sel: string, mustBeVisible: boolean) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) return false;
          if (!mustBeVisible) return true;
          return (el.offsetParent !== null) || el === document.body;
        },
        args: [p.selector, visible],
      });
      if (result) return { found: true, elapsedMs: Date.now() - start };
      await sleep(poll);
    }
    return { found: false, elapsedMs: Date.now() - start };
  },

  wait_for_url: async (p: WaitForUrlParams): Promise<WaitForUrlResult> => {
    const start = Date.now();
    const deadline = start + (p.timeoutMs ?? 15_000);
    const re = new RegExp(p.pattern, p.flags ?? "i");
    while (Date.now() < deadline) {
      const tab = await browser.tabs.get(p.tabId);
      const url = tab.url ?? "";
      if (re.test(url)) return { matched: true, url, elapsedMs: Date.now() - start };
      await sleep(200);
    }
    const tab = await browser.tabs.get(p.tabId);
    return { matched: false, url: tab.url ?? "", elapsedMs: Date.now() - start };
  },

  download_file: async (p: DownloadFileParams): Promise<DownloadFileResult> => {
    // Fetch from within a tab's context so credentials + cookies apply.
    const tabId = p.tabId ?? (await activeTabId());
    return runInMainWorld(
      tabId,
      async (url: string, method: string, headers: Record<string, string>, body: string | undefined, asBase64: boolean) => {
        const resp = await fetch(url, { method, headers, body, credentials: "include" });
        const buf = new Uint8Array(await resp.arrayBuffer());
        let out = "";
        if (asBase64) {
          let binary = "";
          for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
          out = btoa(binary);
        } else {
          out = new TextDecoder().decode(buf);
        }
        return {
          status: resp.status,
          contentType: resp.headers.get("content-type") ?? undefined,
          size: buf.length,
          body: out,
          base64: asBase64,
        };
      },
      [p.url, p.method ?? "GET", p.headers ?? {}, p.body, p.asBase64 ?? false],
    ) as Promise<DownloadFileResult>;
  },

  // ──────────────────────────────────────────────────────────────────────
  // Tier 2
  // ──────────────────────────────────────────────────────────────────────

  open_devtools: async (_p: OpenDevtoolsParams) => {
    // chrome.devtools.* is devtools-scoped and can't be called from the SW.
    // Best we can do: focus the tab so user can cmd-opt-i themselves.
    // Keeping the RPC for API completeness; returning a helpful error.
    throw new Error("open_devtools not supported from extension SW; user must press Cmd/Ctrl+Opt+I");
  },

  "window.create": async (p: WindowCreateParams): Promise<WindowCreateResult> => {
    const w = await browser.windows.create({
      url: p.url,
      incognito: p.incognito,
      width: p.width, height: p.height,
      state: p.state,
    });
    const tid = w.tabs?.[0]?.id ?? null;
    return { windowId: w.id!, tabId: tid };
  },

  "window.list": async (): Promise<WindowListResult> => {
    const ws = await browser.windows.getAll({ populate: true });
    return {
      windows: ws.map((w) => ({
        id: w.id!,
        focused: !!w.focused,
        incognito: !!w.incognito,
        state: w.state ?? "normal",
        tabIds: (w.tabs ?? []).map((t) => t.id!).filter((x) => typeof x === "number"),
      })),
    };
  },

  click_all_matching: async (p: ClickAllMatchingParams): Promise<ClickAllMatchingResult> => {
    // Click loop runs in page context so each iteration sees DOM changes
    // triggered by the previous click. Sleep between clicks to let XHRs
    // fire — mitm sees the resulting traffic the same as a human clicker.
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: async (
        selector: string,
        delayMs: number,
        max: number,
        visibleOnly: boolean,
        reQuery: boolean,
      ) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const isVisible = (el: HTMLElement) => {
          if (!el.offsetParent) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        let clicked = 0;
        let skipped = 0;
        if (reQuery) {
          const visited = new WeakSet<HTMLElement>();
          while (clicked + skipped < max) {
            const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
            const next = nodes.find((n) => !visited.has(n) && (!visibleOnly || isVisible(n)));
            if (!next) break;
            visited.add(next);
            try {
              next.click();
              clicked++;
            } catch {
              skipped++;
            }
            await sleep(delayMs);
          }
        } else {
          const nodes = [...document.querySelectorAll<HTMLElement>(selector)].slice(0, max);
          for (const n of nodes) {
            if (visibleOnly && !isVisible(n)) {
              skipped++;
              continue;
            }
            try {
              n.click();
              clicked++;
            } catch {
              skipped++;
            }
            await sleep(delayMs);
          }
        }
        return { clicked, skipped };
      },
      args: [p.selector, p.delayMs ?? 800, p.max ?? 40, !!p.visibleOnly, p.reQuery !== false],
    });
    return result as ClickAllMatchingResult;
  },

  navigate_sequence: async (p: NavigateSequenceParams): Promise<NavigateSequenceResult> => {
    // Background-side loop — each navigation awaits tab status="complete"
    // then a settle sleep so XHRs fired after DOMContentLoaded (typical
    // for SPA shells) still land.
    const settleMs = p.settleMs ?? 3000;
    const visited: NavigateSequenceResult["visited"] = [];
    for (const url of p.urls) {
      try {
        const complete = waitForTabComplete(p.tabId, 20000);
        await browser.tabs.update(p.tabId, { url });
        await complete;
        await sleep(settleMs);
        visited.push({ url, ok: true });
      } catch (e: any) {
        const error = String(e?.message ?? e);
        visited.push({ url, ok: false, error });
        if (p.stopOnError) break;
      }
    }
    return { visited };
  },

  // ──────────────────────────────────────────────────────────────────────
  // Tier 7 — interaction + waits
  // ──────────────────────────────────────────────────────────────────────

  scroll: async (p: ScrollParams): Promise<ScrollResult> => {
    return runInMainWorld(
      p.tabId,
      (p: ScrollParams) => {
        const behavior: ScrollBehavior = p.behavior ?? "auto";
        const target: Element | Window = p.selector
          ? (document.querySelector(p.selector) as Element | null) ?? window
          : window;
        if (p.intoView) {
          const el = document.querySelector(p.intoView);
          if (!el) throw new Error(`intoView selector not found: ${p.intoView}`);
          el.scrollIntoView({ behavior, block: "center", inline: "center" });
        } else if (p.x !== undefined || p.y !== undefined) {
          if (target === window) {
            window.scrollTo({ left: p.x ?? window.scrollX, top: p.y ?? window.scrollY, behavior });
          } else {
            const el = target as Element;
            if (p.x !== undefined) el.scrollLeft = p.x;
            if (p.y !== undefined) el.scrollTop = p.y;
          }
        } else {
          const dx = p.dx ?? 0, dy = p.dy ?? 0;
          if (target === window) window.scrollBy({ left: dx, top: dy, behavior });
          else {
            const el = target as Element;
            el.scrollLeft += dx;
            el.scrollTop += dy;
          }
        }
        const pos = target === window
          ? { x: window.scrollX, y: window.scrollY,
              maxX: document.documentElement.scrollWidth - window.innerWidth,
              maxY: document.documentElement.scrollHeight - window.innerHeight }
          : (() => {
              const el = target as Element;
              return {
                x: el.scrollLeft, y: el.scrollTop,
                maxX: el.scrollWidth - el.clientWidth,
                maxY: el.scrollHeight - el.clientHeight,
              };
            })();
        return pos;
      },
      [p],
    ) as Promise<ScrollResult>;
  },

  hover: async (p: HoverParams) => {
    await runInMainWorld(
      p.tabId,
      (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`selector not found: ${sel}`);
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const common: MouseEventInit = {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y,
        };
        el.dispatchEvent(new MouseEvent("mouseover", common));
        el.dispatchEvent(new MouseEvent("mouseenter", common));
        el.dispatchEvent(new MouseEvent("mousemove", common));
      },
      [p.selector],
    );
    return { ok: true };
  },

  press_key: async (p: PressKeyParams) => {
    await runInMainWorld(
      p.tabId,
      (p: PressKeyParams) => {
        const el = (p.selector
          ? document.querySelector<HTMLElement>(p.selector)
          : (document.activeElement as HTMLElement | null) ?? document.body) as HTMLElement;
        if (!el) throw new Error(`selector not found: ${p.selector}`);
        el.focus?.();
        const init: KeyboardEventInit = {
          key: p.key,
          code: p.key.length === 1 ? `Key${p.key.toUpperCase()}` : p.key,
          bubbles: true, cancelable: true,
          ctrlKey: !!p.ctrl, shiftKey: !!p.shift, altKey: !!p.alt, metaKey: !!p.meta,
        };
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        if (p.key.length === 1) {
          el.dispatchEvent(new KeyboardEvent("keypress", init));
          // For inputs, also advance the .value so form handlers see the char.
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
              "value",
            )?.set;
            setter?.call(el, (el.value ?? "") + p.key);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        el.dispatchEvent(new KeyboardEvent("keyup", init));
      },
      [p],
    );
    return { ok: true };
  },

  // ──────────────────────────────────────────────────────────────────────
  // Tier 8 — history, locators, frames, a11y, storage
  // ──────────────────────────────────────────────────────────────────────

  wait_for_text: async (p: WaitForTextParams): Promise<WaitForTextResult> => {
    const start = Date.now();
    const deadline = start + (p.timeoutMs ?? 15_000);
    const poll = p.pollMs ?? 250;
    while (Date.now() < deadline) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: p.tabId },
        func: (p: WaitForTextParams) => {
          const root = (p.selector
            ? document.querySelector<HTMLElement>(p.selector)
            : document.body) as HTMLElement | null;
          if (!root) return { match: "" };
          const text = root.innerText ?? "";
          if (p.regex) {
            const m = text.match(new RegExp(p.regex, p.flags ?? "i"));
            return { match: m ? m[0] : "" };
          }
          if (p.text && text.includes(p.text)) {
            const idx = text.indexOf(p.text);
            const snip = text.slice(Math.max(0, idx - 40), idx + p.text.length + 40);
            return { match: snip };
          }
          return { match: "" };
        },
        args: [p],
      });
      const r = result as { match: string };
      if (r.match) return { found: true, elapsedMs: Date.now() - start, match: r.match };
      await sleep(poll);
    }
    return { found: false, elapsedMs: Date.now() - start, match: "" };
  },

  find_elements: async (p: FindElementsParams): Promise<FindElementsResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (p: FindElementsParams) => {
        function pathFor(el: Element): string {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const dt = el.getAttribute("data-testid");
          if (dt) return `${el.tagName.toLowerCase()}[data-testid="${CSS.escape(dt)}"]`;
          const parts: string[] = [];
          let cur: Element | null = el;
          while (cur && cur !== document.body && parts.length < 6) {
            const here: Element = cur;
            const tag = here.tagName.toLowerCase();
            const parent: Element | null = here.parentElement;
            if (!parent) { parts.unshift(tag); break; }
            const sibs = [...parent.children].filter((c) => c.tagName === here.tagName);
            const idx = sibs.indexOf(here);
            parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${idx + 1})` : tag);
            cur = parent;
          }
          return parts.join(" > ");
        }

        const tag = (el: Element) => el.tagName.toLowerCase();
        const roleOf = (el: Element): string => {
          const r = el.getAttribute("role");
          if (r) return r;
          const t = tag(el);
          if (t === "a") return "link";
          if (t === "button") return "button";
          if (t === "input") {
            const tp = (el as HTMLInputElement).type;
            if (tp === "checkbox") return "checkbox";
            if (tp === "radio") return "radio";
            if (tp === "submit" || tp === "button") return "button";
            return "textbox";
          }
          if (t === "select") return "combobox";
          if (t === "textarea") return "textbox";
          if (t === "nav") return "navigation";
          if (/^h[1-6]$/.test(t)) return "heading";
          return t;
        };
        const nameOf = (el: Element): string => {
          const aria = el.getAttribute("aria-label");
          if (aria) return aria.trim();
          const labelled = el.getAttribute("aria-labelledby");
          if (labelled) {
            const parts = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
            if (parts.trim()) return parts.trim();
          }
          const title = el.getAttribute("title");
          if (title) return title.trim();
          const t = (el as HTMLElement).innerText || el.textContent || "";
          return t.trim();
        };

        const role = p.role?.toLowerCase();
        const contains = p.nameContains?.toLowerCase();
        const nameRe = p.nameRegex ? new RegExp(p.nameRegex, p.nameFlags ?? "i") : null;
        const exact = p.name;
        const visibleOnly = p.visibleOnly !== false;
        const limit = p.limit ?? 25;

        const matches: any[] = [];
        let total = 0;
        const selector = role === "link" ? "a[href]"
          : role === "button" ? "button, [role='button'], input[type='button'], input[type='submit']"
          : role === "textbox" ? "input, textarea, [role='textbox']"
          : role === "checkbox" ? "input[type='checkbox'], [role='checkbox']"
          : role === "combobox" ? "select, [role='combobox']"
          : role === "heading" ? "h1,h2,h3,h4,h5,h6,[role='heading']"
          : "*[role], a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, nav, [tabindex]";
        for (const el of document.querySelectorAll<HTMLElement>(selector)) {
          if (visibleOnly && el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
          const r = roleOf(el);
          if (role && r !== role) continue;
          const n = nameOf(el).slice(0, 500);
          if (exact && n !== exact) continue;
          if (contains && !n.toLowerCase().includes(contains)) continue;
          if (nameRe && !nameRe.test(n)) continue;
          total++;
          if (matches.length >= limit) continue;
          const rect = el.getBoundingClientRect();
          matches.push({
            selector: pathFor(el),
            role: r, name: n, tag: tag(el),
            rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
            visible: el.offsetParent !== null || getComputedStyle(el).position === "fixed",
          });
        }
        return { matches, total };
      },
      args: [p],
    });
    return result as FindElementsResult;
  },

  select_option: async (p: SelectOptionParams): Promise<SelectOptionResult> => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (p: SelectOptionParams) => {
        const sel = document.querySelector<HTMLSelectElement>(p.selector);
        if (!sel) throw new Error(`selector not found: ${p.selector}`);
        const wanted = p.value ?? p.label;
        if (!wanted) throw new Error("value or label required");
        const matchBy = p.value !== undefined ? "value" : "label";
        const picks: string[] = [];
        if (p.multiple) {
          for (const o of Array.from(sel.options)) {
            const hit = matchBy === "value" ? o.value === wanted : (o.label === wanted || o.text === wanted);
            o.selected = o.selected || hit;
            if (hit) picks.push(o.value);
          }
        } else {
          for (const o of Array.from(sel.options)) {
            const hit = matchBy === "value" ? o.value === wanted : (o.label === wanted || o.text === wanted);
            if (hit) { sel.value = o.value; picks.push(o.value); break; }
          }
        }
        if (picks.length === 0) throw new Error(`option not found: ${wanted}`);
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { selected: picks };
      },
      args: [p],
    });
    return result as SelectOptionResult;
  },

  "iframe.list": async (p: IframeListParams): Promise<IframeListResult> => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: p.tabId });
    return {
      frames: (frames ?? []).map((f) => ({
        frameId: String(f.frameId),
        url: f.url,
        name: "",
        parentFrameId: f.parentFrameId >= 0 ? String(f.parentFrameId) : null,
      })),
    };
  },

  "iframe.eval": async (p: IframeEvalParams): Promise<IframeEvalResult> => {
    // Resolve target frames.
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId: p.tabId });
    let targets: Array<{ frameId: number; url: string }> = [];
    if (p.frameId) {
      const fid = Number(p.frameId);
      if (!Number.isFinite(fid)) throw new Error(`bad frameId: ${p.frameId}`);
      const f = allFrames?.find((x) => x.frameId === fid);
      targets = [{ frameId: fid, url: f?.url ?? "" }];
    } else if (p.allFrames || p.frameUrlPattern || p.frameUrlRegex) {
      const re = p.frameUrlRegex ? new RegExp(p.frameUrlRegex) : null;
      for (const f of allFrames ?? []) {
        if (re && !re.test(f.url)) continue;
        if (p.frameUrlPattern && !f.url.includes(p.frameUrlPattern)) continue;
        targets.push({ frameId: f.frameId, url: f.url });
      }
    } else {
      throw new Error("iframe.eval: pass frameId, allFrames, or frameUrl{Pattern,Regex}");
    }

    const frames: IframeEvalResult["frames"] = [];
    for (const t of targets) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: p.tabId, frameIds: [t.frameId] },
          world: "MAIN",
          func: async (code: string) => {
            const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
            const hasReturn = /(^|[^\w.])return[\s(;]/.test(code);
            const body = hasReturn ? code : `return (${code});`;
            const out = await new AsyncFunction(body)();
            return JSON.parse(JSON.stringify(out, (_k, v) => {
              if (typeof v === "function") return `[Function]`;
              if (v instanceof Element) return `[Element <${v.tagName.toLowerCase()}>]`;
              if (typeof v === "undefined") return null;
              return v;
            }));
          },
          args: [p.code],
        });
        frames.push({ frameId: String(t.frameId), url: t.url, value: result });
      } catch (e: any) {
        frames.push({ frameId: String(t.frameId), url: t.url, error: String(e?.message ?? e) });
      }
    }
    return { frames };
  },

  "console.logs": async (p: ConsoleLogsParams): Promise<ConsoleLogsResult> => {
    const mod = await import("./console-log");
    if (p.tabId !== undefined) await mod.enableFor(p.tabId);
    return mod.read(p);
  },

  "accessibility.tree": async (p: AccessibilityTreeParams): Promise<AccessibilityTreeResult> => {
    try {
      await chrome.debugger.sendCommand({ tabId: p.tabId }, "Accessibility.enable");
    } catch (e) {
      throw new Error(
        `accessibility.tree: ${String((e as Error).message || e)} ` +
          `(call attach_debugger_all first if the tab isn't attached)`,
      );
    }
    const tree = (await chrome.debugger.sendCommand(
      { tabId: p.tabId },
      "Accessibility.getFullAXTree",
      {},
    )) as { nodes: any[] };
    const nodes = tree?.nodes ?? [];
    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(String(n.nodeId), n);

    const limit = p.limit ?? 2000;
    let produced = 0;
    let truncated = false;

    function build(id: string): AxNode | null {
      const n = byId.get(id);
      if (!n) return null;
      const ignored = !!n.ignored;
      if (ignored && !p.includeIgnored) {
        const kids = (n.childIds ?? []).map((c: string) => build(String(c))).filter(Boolean) as AxNode[];
        if (kids.length === 1) return kids[0];
        if (kids.length === 0) return null;
        return { nodeId: String(n.nodeId), role: "group", name: "", children: kids };
      }
      if (produced >= limit) { truncated = true; return null; }
      produced++;
      const out: AxNode = {
        nodeId: String(n.nodeId),
        role: n.role?.value ?? "",
        name: n.name?.value ?? "",
        value: n.value?.value,
        description: n.description?.value,
        children: [],
      };
      for (const cid of n.childIds ?? []) {
        const child = build(String(cid));
        if (child) out.children.push(child);
      }
      return out;
    }

    const root = nodes.length ? build(String(nodes[0].nodeId)) : null;
    return { root, nodeCount: produced, truncated };
  },

  // ──────────────────────────────────────────────────────────────────────
  // Tier 9 — shortcuts + CDP emulation + file ops
  // ──────────────────────────────────────────────────────────────────────

  click_by_text: async (p: ClickByTextParams): Promise<ClickByTextResult> => {
    // Reuse find_elements semantics inline (avoid nested rpc call).
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (p: ClickByTextParams) => {
        const role = p.role?.toLowerCase();
        const contains = p.nameContains?.toLowerCase();
        const nameRe = p.nameRegex ? new RegExp(p.nameRegex, p.nameFlags ?? "i") : null;
        const exact = p.name;
        const index = p.index ?? 0;
        const tag = (el: Element) => el.tagName.toLowerCase();
        const roleOf = (el: Element): string => {
          const r = el.getAttribute("role");
          if (r) return r;
          const t = tag(el);
          if (t === "a") return "link";
          if (t === "button") return "button";
          if (t === "input") {
            const tp = (el as HTMLInputElement).type;
            if (tp === "checkbox") return "checkbox";
            if (tp === "radio") return "radio";
            if (tp === "submit" || tp === "button") return "button";
            return "textbox";
          }
          if (t === "select") return "combobox";
          if (t === "textarea") return "textbox";
          if (/^h[1-6]$/.test(t)) return "heading";
          return t;
        };
        const nameOf = (el: Element): string =>
          (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || el.textContent || "").trim();

        const selector = role === "link" ? "a[href]"
          : role === "button" ? "button, [role='button'], input[type='button'], input[type='submit']"
          : "*[role], a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, nav, [tabindex]";

        const hits: HTMLElement[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(selector)) {
          if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
          if (role && roleOf(el) !== role) continue;
          const n = nameOf(el).slice(0, 500);
          if (exact && n !== exact) continue;
          if (contains && !n.toLowerCase().includes(contains)) continue;
          if (nameRe && !nameRe.test(n)) continue;
          hits.push(el);
        }
        if (hits.length === 0) return { clicked: false, selector: "", matchName: "", total: 0 };
        const pick = hits[Math.min(index, hits.length - 1)];
        pick.click();
        return {
          clicked: true,
          selector: pick.id ? `#${CSS.escape(pick.id)}` : tag(pick),
          matchName: nameOf(pick).slice(0, 200),
          total: hits.length,
        };
      },
      args: [p],
    });
    return result as ClickByTextResult;
  },

  drag_drop: async (p: DragDropParams) => {
    await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: async (p: DragDropParams) => {
        const src = document.querySelector<HTMLElement>(p.source);
        const tgt = document.querySelector<HTMLElement>(p.target);
        if (!src) throw new Error(`source not found: ${p.source}`);
        if (!tgt) throw new Error(`target not found: ${p.target}`);
        const sr = src.getBoundingClientRect();
        const tr = tgt.getBoundingClientRect();
        const sCx = sr.left + sr.width / 2, sCy = sr.top + sr.height / 2;
        const tCx = tr.left + tr.width / 2, tCy = tr.top + tr.height / 2;
        const dt = new DataTransfer();
        const mk = (type: string, x: number, y: number) =>
          new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: x, clientY: y,
          });
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const d = p.delayMs ?? 50;
        src.dispatchEvent(mk("dragstart", sCx, sCy));
        await sleep(d);
        tgt.dispatchEvent(mk("dragenter", tCx, tCy));
        tgt.dispatchEvent(mk("dragover", tCx, tCy));
        await sleep(d);
        tgt.dispatchEvent(mk("drop", tCx, tCy));
        src.dispatchEvent(mk("dragend", tCx, tCy));
      },
      args: [p],
    });
    return { ok: true };
  },

  upload_file: async (p: UploadFileParams): Promise<UploadFileResult> => {
    let base64 = p.base64;
    let mime = p.mimeType;
    if (!base64 && p.sourceUrl) {
      // Fetch in page context so credentials apply.
      const tabId = p.tabId;
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (url: string) => {
          const r = await fetch(url, { credentials: "include" });
          const buf = new Uint8Array(await r.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          return { b64: btoa(bin), mime: r.headers.get("content-type") ?? "application/octet-stream" };
        },
        args: [p.sourceUrl],
      });
      base64 = (result as { b64: string }).b64;
      mime = mime ?? (result as { mime: string }).mime;
    }
    if (!base64) throw new Error("upload_file: base64 or sourceUrl required");

    const [{ result: uploadResult }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      world: "MAIN",
      func: (selector: string, filename: string, mime: string, base64: string) => {
        const el = document.querySelector<HTMLInputElement>(selector);
        if (!el) throw new Error(`selector not found: ${selector}`);
        if (el.tagName !== "INPUT" || el.type !== "file") throw new Error("not a file input");
        const bin = atob(base64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const file = new File([buf], filename, { type: mime || "application/octet-stream" });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filename, size: buf.length };
      },
      args: [p.selector, p.filename, mime ?? "application/octet-stream", base64],
    });
    return uploadResult as UploadFileResult;
  },

  set_viewport: async (p: SetViewportParams) => {
    try {
      await chrome.debugger.sendCommand({ tabId: p.tabId }, "Emulation.setDeviceMetricsOverride", p.clear ? {
        width: 0, height: 0, deviceScaleFactor: 0, mobile: false,
      } : {
        width: p.width ?? 0,
        height: p.height ?? 0,
        deviceScaleFactor: p.deviceScaleFactor ?? 1,
        mobile: !!p.mobile,
      });
    } catch (e) {
      throw new Error(`set_viewport: ${String((e as Error).message)} (attach debugger first)`);
    }
    if (p.clear) {
      try { await chrome.debugger.sendCommand({ tabId: p.tabId }, "Emulation.clearDeviceMetricsOverride"); } catch {}
    }
    return { ok: true };
  },

  set_user_agent: async (p: SetUserAgentParams) => {
    try {
      if (p.clear) {
        await chrome.debugger.sendCommand({ tabId: p.tabId }, "Network.setUserAgentOverride", { userAgent: "" });
      } else {
        await chrome.debugger.sendCommand({ tabId: p.tabId }, "Network.setUserAgentOverride", {
          userAgent: p.userAgent,
          acceptLanguage: p.acceptLanguage,
          platform: p.platform,
        });
      }
    } catch (e) {
      throw new Error(`set_user_agent: ${String((e as Error).message)} (attach debugger first)`);
    }
    return { ok: true };
  },

  pdf_export: async (p: PdfExportParams): Promise<PdfExportResult> => {
    try {
      const out = (await chrome.debugger.sendCommand(
        { tabId: p.tabId },
        "Page.printToPDF",
        {
          landscape: !!p.landscape,
          printBackground: p.printBackground !== false,
          paperWidth: p.paperWidth ?? 8.5,
          paperHeight: p.paperHeight ?? 11,
          scale: Math.min(Math.max(p.scale ?? 1, 0.1), 2),
          transferMode: "ReturnAsBase64",
        },
      )) as { data: string };
      const bytes = Math.floor(out.data.length * 3 / 4);
      return { pdfBase64: out.data, bytes };
    } catch (e) {
      throw new Error(`pdf_export: ${String((e as Error).message)} (attach debugger first)`);
    }
  },
};

// Stream fan-out hook — background.ts installs its ws.send() implementation.
let streamEmit: (streamId: string, entry: NetworkEntry) => void = () => {};
export function setStreamEmitter(fn: typeof streamEmit) {
  streamEmit = fn;
}
function emitStream(id: string, entry: NetworkEntry) {
  streamEmit(id, entry);
}
