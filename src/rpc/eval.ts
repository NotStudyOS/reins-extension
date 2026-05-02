import type {
  EvalParams,
  ServiceWorkerEvalParams,
  ServiceWorkerEvalResult,
} from "../../../src/shared/protocol";
import { runInMainWorld, sleep } from "./runtime";

export const evalHandlers: Record<string, (params: any) => Promise<unknown>> = {
  eval: async (p: EvalParams) => {
    const result = await runInMainWorld(
      p.tabId,
      async (code: string) => {
        const AsyncFunction = (async () => {}).constructor as new (
          ...args: string[]
        ) => (...args: unknown[]) => Promise<unknown>;

        let hasReturn = false;
        {
          let depth = 0, inStr: string | null = null;
          for (let i = 0; i < code.length; i++) {
            const c = code[i];
            if (inStr) { if (c === inStr && code[i - 1] !== "\\") inStr = null; continue; }
            if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
            if (c === "{" || c === "(" || c === "[") { depth++; continue; }
            if (c === "}" || c === ")" || c === "]") { depth--; continue; }
            if (depth !== 0) continue;
            if (c === "r" && code.slice(i, i + 6) === "return" && /[\s(;]/.test(code[i + 6] || " ")) {
              const prev = code[i - 1];
              if (!prev || /[^\w.]/.test(prev) || i === 0) { hasReturn = true; break; }
            }
          }
        }
        let body: string;
        if (hasReturn) {
          body = code;
        } else {
          const trimmed = code.replace(/;\s*$/, "");
          let lastSemi = -1, depth = 0, inStr: string | null = null;
          for (let i = trimmed.length - 1; i >= 0; i--) {
            const c = trimmed[i];
            if (inStr) { if (c === inStr && trimmed[i - 1] !== "\\") inStr = null; continue; }
            if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
            if (c === ")" || c === "}" || c === "]") { depth++; continue; }
            if (c === "(" || c === "{" || c === "[") { depth--; continue; }
            if (c === ";" && depth === 0) { lastSemi = i; break; }
          }
          body = lastSemi === -1
            ? `return (${trimmed});`
            : `${trimmed.slice(0, lastSemi)};\nreturn (${trimmed.slice(lastSemi + 1)});`;
        }
        let out: unknown;
        try {
          out = await new AsyncFunction(body)();
        } catch (e) {
          return { __evalError: String((e as Error).message || e) };
        }
        try {
          return JSON.parse(JSON.stringify(out, (_k, v) => {
            if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
            if (v instanceof Element) return `[Element <${v.tagName.toLowerCase()}>]`;
            if (v instanceof Node) return `[Node ${v.nodeName}]`;
            if (typeof v === "bigint") return v.toString();
            if (typeof v === "undefined") return null;
            return v;
          }));
        } catch {
          return String(out);
        }
      },
      [p.code],
    );
    if (result && typeof result === "object" && "__evalError" in (result as object)) {
      throw new Error((result as { __evalError: string }).__evalError);
    }
    return { value: result };
  },

  eval_wait: async (p: {
    tabId: number;
    expression: string;
    pollMs?: number;
    timeoutMs?: number;
  }) => {
    const poll = p.pollMs ?? 500;
    const deadline = Date.now() + (p.timeoutMs ?? 30_000);
    let last: unknown = null;
    while (Date.now() < deadline) {
      const result = await runInMainWorld(
        p.tabId,
        (expr: string) => {
          try {
            const v = new Function(`return (${expr});`)();
            if (!v) return { __ewPending: true };
            try {
              return JSON.parse(JSON.stringify(v, (_k, vv) => {
                if (typeof vv === "function") return `[Function]`;
                if (vv instanceof Element) return `[Element]`;
                if (typeof vv === "undefined") return null;
                return vv;
              }));
            } catch {
              return String(v);
            }
          } catch (e) {
            return { __ewError: String((e as Error).message || e) };
          }
        },
        [p.expression],
      );
      if (result && typeof result === "object" && "__ewError" in (result as object)) {
        throw new Error((result as { __ewError: string }).__ewError);
      }
      if (result && typeof result === "object" && "__ewPending" in (result as object)) {
        last = null;
      } else {
        return { value: result };
      }
      await sleep(poll);
    }
    throw new Error(`eval_wait: expression ${JSON.stringify(p.expression)} still falsy after ${p.timeoutMs ?? 30_000}ms (last=${JSON.stringify(last)})`);
  },

  eval_fetch: async (p: { tabId: number; bucket?: string }) => {
    const bucket = p.bucket ?? "__result";
    const result = await runInMainWorld(
      p.tabId,
      (b: string) => {
        const w = window as unknown as Record<string, unknown>;
        const v = w[b];
        if (v === undefined) return { __efPending: true };
        try {
          return { value: JSON.parse(JSON.stringify(v, (_k, vv) => {
            if (typeof vv === "function") return `[Function]`;
            if (vv instanceof Element) return `[Element]`;
            if (typeof vv === "undefined") return null;
            return vv;
          })) };
        } catch {
          return { value: String(v) };
        }
      },
      [bucket],
    );
    if (result && typeof result === "object" && "__efPending" in (result as object)) {
      return { pending: true };
    }
    return result;
  },

  eval_chunk: async (p: {
    tabId: number;
    bucket?: string;
    chunkIndex: number;
    chunkSize?: number;
  }) => {
    const bucket = p.bucket ?? "__result";
    const size = p.chunkSize ?? 18_000;
    const idx = p.chunkIndex;
    const result = await runInMainWorld(
      p.tabId,
      (b: string, i: number, s: number) => {
        const w = window as unknown as Record<string, unknown>;
        const raw = w[b];
        if (raw === undefined) return { pending: true };
        const str = typeof raw === "string" ? raw : JSON.stringify(raw);
        const total = Math.ceil(str.length / s);
        if (i < 0 || i >= total) return { chunk: "", chunkIndex: i, totalChunks: total, totalBytes: str.length };
        return {
          chunk: str.slice(i * s, (i + 1) * s),
          chunkIndex: i,
          totalChunks: total,
          totalBytes: str.length,
        };
      },
      [bucket, idx, size],
    );
    return result;
  },

  read_page: async (p: { tabId: number; extract?: any }) => {
    const want = p.extract ?? {};
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: (want: any) => {
        const out: any = {
          title: document.title,
          url: location.href,
          text: document.body?.innerText ?? "",
        };
        const ext: any = {};
        let touched = false;
        if (want.jsonLd) {
          touched = true;
          const blobs: unknown[] = [];
          for (const s of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
            try { blobs.push(JSON.parse(s.textContent || "")); } catch {}
          }
          ext.jsonLd = blobs;
        }
        if (want.openGraph) {
          touched = true;
          const og: Record<string, string> = {};
          for (const m of document.querySelectorAll<HTMLMetaElement>('meta[property^="og:"]')) {
            const k = m.getAttribute("property")!;
            og[k] = m.content;
          }
          ext.openGraph = og;
        }
        if (want.twitter) {
          touched = true;
          const tw: Record<string, string> = {};
          for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name^="twitter:"]')) {
            tw[m.name] = m.content;
          }
          ext.twitter = tw;
        }
        if (want.tables) {
          touched = true;
          const tables: Array<{ headers: string[]; rows: string[][] }> = [];
          for (const t of document.querySelectorAll<HTMLTableElement>("table")) {
            const headers = [...t.querySelectorAll<HTMLTableCellElement>("thead th, thead td")].map((c) => (c.innerText || "").trim());
            const rows: string[][] = [];
            for (const tr of t.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
              rows.push([...tr.querySelectorAll<HTMLTableCellElement>("td, th")].map((c) => (c.innerText || "").trim()));
            }
            // Fallback: no thead/tbody markup.
            if (!headers.length && !rows.length) {
              const all = [...t.querySelectorAll<HTMLTableRowElement>("tr")];
              if (all.length) {
                const head = [...all[0].querySelectorAll<HTMLTableCellElement>("td, th")].map((c) => (c.innerText || "").trim());
                const body = all.slice(1).map((tr) => [...tr.querySelectorAll<HTMLTableCellElement>("td, th")].map((c) => (c.innerText || "").trim()));
                tables.push({ headers: head, rows: body });
                continue;
              }
            }
            tables.push({ headers, rows });
          }
          ext.tables = tables;
        }
        if (want.headings) {
          touched = true;
          ext.headings = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].map((h) => ({
            level: parseInt(h.tagName.slice(1), 10),
            text: (h.innerText || "").trim(),
          }));
        }
        if (want.links) {
          touched = true;
          ext.links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => ({
            href: a.href,
            text: (a.innerText || "").trim(),
            rel: a.rel || undefined,
          }));
        }
        if (touched) out.extracted = ext;
        return out;
      },
      args: [want],
    });
    return result;
  },

  "service_worker.eval": async (_p: ServiceWorkerEvalParams): Promise<ServiceWorkerEvalResult> => {
    throw new Error("service_worker.eval not yet implemented; would require CDP Target+Runtime pairing");
  },
};
