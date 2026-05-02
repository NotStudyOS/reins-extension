import type {
  ApiInspectParams,
  ApiInspectResult,
} from "../../../src/shared/protocol";
import { readNetwork as readNet } from "../net";

/**
 * api_inspect — five modes that share the same source: the network capture
 * buffer. Combined into one tool because they all answer the same kind of
 * question ("what's the API behind this UI?").
 */
export const apiInspectHandlers: Record<string, (p: any) => Promise<unknown>> = {
  api_inspect: async (p: ApiInspectParams): Promise<ApiInspectResult> => {
    const entries = await readNet({
      tabId: p.tabId,
      urlPattern: p.urlPattern,
      urlRegex: p.urlRegex,
      hostRegex: p.hostRegex,
      includeBodies: p.mode === "schema" || p.mode === "graphql",
      limit: 2000,
    });

    switch (p.mode) {
      case "discover": {
        // Group by host+path with method, status, content-type, count.
        const byKey = new Map<string, { method: string; url: string; host: string; path: string; status: number; contentType: string; count: number; sampleSize?: number }>();
        for (const e of entries) {
          const ct = (e.responseHeaders?.["content-type"] || e.responseHeaders?.["Content-Type"] || "").split(";")[0];
          if (!/json|graphql|application\/x-ndjson/.test(ct)) continue;
          let u: URL;
          try { u = new URL(e.url); } catch { continue; }
          const key = `${e.method} ${u.host}${u.pathname}`;
          const cur = byKey.get(key);
          if (cur) cur.count++;
          else byKey.set(key, { method: e.method, url: e.url, host: u.host, path: u.pathname, status: e.status ?? 0, contentType: ct, count: 1 });
        }
        return { mode: "discover", data: { endpoints: [...byKey.values()].sort((a, b) => b.count - a.count) } };
      }

      case "schema": {
        const target = entries.filter((e) => p.fromUrl ? e.url.includes(p.fromUrl) : true && /json/i.test(e.responseHeaders?.["content-type"] || ""));
        const sample = target.slice(0, p.sampleSize ?? 5);
        const samples: any[] = [];
        for (const e of sample) {
          try { samples.push(JSON.parse(e.responseBody || "")); } catch {}
        }
        return { mode: "schema", data: { schema: inferSchema(samples), examples: samples.length, urls: sample.map((s) => s.url) } };
      }

      case "graphql": {
        const ops: any[] = [];
        for (const e of entries) {
          if (!/graphql/i.test(e.url) && !/graphql/i.test(e.responseHeaders?.["content-type"] || "")) continue;
          let body: any = null;
          try { body = JSON.parse(e.requestBody || "null"); } catch {}
          if (!body) continue;
          const list = Array.isArray(body) ? body : [body];
          for (const op of list) {
            if (p.operationName && op.operationName !== p.operationName) continue;
            ops.push({
              operationName: op.operationName,
              query: (op.query || "").slice(0, 8000),
              variables: op.variables,
              status: e.status,
              url: e.url,
              requestId: e.requestId,
            });
          }
        }
        return { mode: "graphql", data: { operations: ops } };
      }

      case "websocket":
        return { mode: "websocket", data: { note: "Use ws_capture_start + ws_read for live frames; this mode is reserved for schema inference once frames are captured." } };

      case "sse": {
        const sse = entries.filter((e) => /text\/event-stream/i.test(e.responseHeaders?.["content-type"] || ""));
        return { mode: "sse", data: { streams: sse.map((e) => ({ url: e.url, status: e.status })) } };
      }

      case "auth": {
        const signals: any[] = [];
        for (const e of entries) {
          const auth = e.requestHeaders?.["authorization"] || e.requestHeaders?.["Authorization"];
          if (auth) signals.push({ kind: "Authorization header", url: e.url, scheme: auth.split(" ")[0] });
          const cookie = e.requestHeaders?.["cookie"] || e.requestHeaders?.["Cookie"];
          if (cookie && /(session|sid|jwt|token|auth)/i.test(cookie)) signals.push({ kind: "auth cookie in request", url: e.url, names: cookie.split(";").map((c) => c.split("=")[0].trim()).filter((n) => /(session|sid|jwt|token|auth)/i.test(n)) });
          const setCookie = e.responseHeaders?.["set-cookie"] || e.responseHeaders?.["Set-Cookie"];
          if (setCookie && /(session|sid|jwt|token|auth)/i.test(setCookie)) signals.push({ kind: "Set-Cookie auth", url: e.url });
        }
        return { mode: "auth", data: { signals: dedupe(signals, (s) => `${s.kind}|${s.url}`) } };
      }
    }
    return { mode: p.mode, data: null, notes: ["unknown mode"] };
  },
};

function dedupe<T>(arr: T[], keyFn: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function inferSchema(samples: any[]): any {
  if (!samples.length) return null;
  const merge = (a: any, b: any): any => {
    const ta = typeOf(a), tb = typeOf(b);
    if (ta !== tb) return { type: union([ta, tb]) };
    if (ta === "array") {
      const items = (a as any[]).concat(b as any[]).reduce((acc, x) => acc ? merge(acc, x) : ({ type: typeOf(x), value: x }), null as any);
      return { type: "array", items: items ?? { type: "unknown" } };
    }
    if (ta === "object") {
      const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      const props: any = {};
      for (const k of keys) props[k] = merge(a?.[k], b?.[k]);
      return { type: "object", properties: props };
    }
    return { type: ta };
  };
  return samples.reduce((acc, s) => merge(acc, s), samples[0]);
}
function typeOf(v: any): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function union(types: string[]): string {
  return [...new Set(types)].sort().join("|");
}
