import browser from "webextension-polyfill";
import type {
  MonitorDiffParams,
  MonitorDiffResult,
} from "../shared/protocol";

/**
 * monitor_diff — two-phase snapshot/diff. Snapshots are kept in-memory in the
 * SW; they evict on extension reload (good — they're meant for a session).
 *
 * Fields supported: dom, text, localStorage, sessionStorage, cookies, url,
 * screenshotHash. Each field has a capture fn and a compare fn.
 */
type Snapshot = {
  capturedAt: string;
  fields: string[];
  dom?: string;
  text?: string;
  localStorage?: Record<string, string | null>;
  sessionStorage?: Record<string, string | null>;
  cookies?: Record<string, string>;
  url?: string;
  screenshotHash?: string;
};

const snapshots = new Map<string, Snapshot>();

export const monitorHandlers: Record<string, (p: any) => Promise<unknown>> = {
  monitor_diff: async (p: MonitorDiffParams): Promise<MonitorDiffResult> => {
    if (p.phase === "list") return { phase: "list", keys: [...snapshots.keys()] };
    if (p.phase === "drop") {
      if (!p.key) throw new Error("monitor_diff: drop requires key");
      snapshots.delete(p.key);
      return { phase: "drop", key: p.key, ok: true };
    }
    if (!p.key) throw new Error("monitor_diff: snapshot/diff require key");
    const fields = (p.fields && p.fields.length ? p.fields : ["dom", "localStorage", "sessionStorage", "cookies", "url"]) as string[];

    const snap = await captureSnapshot(p.tabId, fields, p.selector);
    if (p.phase === "snapshot") {
      snapshots.set(p.key, snap);
      return { phase: "snapshot", key: p.key, capturedAt: snap.capturedAt, fields };
    }

    // diff
    const before = snapshots.get(p.key);
    if (!before) throw new Error(`monitor_diff: no snapshot for key="${p.key}"; call phase=snapshot first`);
    const diffs: Array<{ field: string; before?: unknown; after?: unknown; summary?: string }> = [];
    for (const f of fields) {
      const b = (before as any)[f];
      const a = (snap as any)[f];
      if (JSON.stringify(b) === JSON.stringify(a)) continue;
      diffs.push({ field: f, before: b, after: a, summary: summarize(f, b, a) });
    }
    return { phase: "diff", key: p.key, changed: diffs.length > 0, diffs };
  },
};

async function captureSnapshot(tabId: number, fields: string[], selector?: string): Promise<Snapshot> {
  const out: Snapshot = { capturedAt: new Date().toISOString(), fields };
  const wantPage = fields.some((f) => ["dom", "text", "localStorage", "sessionStorage", "url"].includes(f));
  if (wantPage) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (sel: string | null, fields: string[]) => {
        const out: any = {};
        if (fields.includes("url")) out.url = location.href;
        if (fields.includes("dom")) {
          const root = sel ? document.querySelector(sel) : document.documentElement;
          out.dom = (root as any)?.outerHTML?.slice(0, 1_000_000) || "";
        }
        if (fields.includes("text")) {
          const root = sel ? document.querySelector(sel) : document.body;
          out.text = ((root as any)?.innerText || "").slice(0, 200_000);
        }
        const dump = (s: Storage) => {
          const o: Record<string, string | null> = {};
          for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) o[k] = s.getItem(k); }
          return o;
        };
        if (fields.includes("localStorage")) out.localStorage = dump(localStorage);
        if (fields.includes("sessionStorage")) out.sessionStorage = dump(sessionStorage);
        return out;
      },
      args: [selector ?? null, fields],
    });
    Object.assign(out, result);
  }
  if (fields.includes("cookies")) {
    const tab = await browser.tabs.get(tabId);
    if (tab.url) {
      const list = await browser.cookies.getAll({ url: tab.url });
      out.cookies = Object.fromEntries(list.map((c) => [c.name, c.value]));
    }
  }
  if (fields.includes("screenshotHash")) {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId) {
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        out.screenshotHash = await fnv1a(dataUrl);
      } catch {}
    }
  }
  return out;
}

function summarize(field: string, b: any, a: any): string {
  if (typeof b === "string" && typeof a === "string") {
    const bw = b.length, aw = a.length;
    return `${field}: ${bw} → ${aw} chars`;
  }
  if (b && a && typeof b === "object" && typeof a === "object") {
    const bk = Object.keys(b), ak = Object.keys(a);
    const added = ak.filter((k) => !(k in b));
    const removed = bk.filter((k) => !(k in a));
    const changed = ak.filter((k) => k in b && JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    return `${field}: +${added.length} -${removed.length} ~${changed.length}`;
  }
  return `${field} changed`;
}

async function fnv1a(s: string): Promise<string> {
  // Cheap, stable hash for screenshot diffing. Not cryptographic.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
