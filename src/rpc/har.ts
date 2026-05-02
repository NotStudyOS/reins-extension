import type { NetworkEntry } from "../shared/protocol";

export function toHar(entries: NetworkEntry[]) {
  return {
    log: {
      version: "1.2",
      creator: { name: "reins", version: "0.1.0" },
      entries: entries.map((e) => ({
        startedDateTime: new Date(e.timing?.startedMs ?? Date.now()).toISOString(),
        time: Math.max(0, (e.timing?.endedMs ?? 0) - (e.timing?.startedMs ?? 0)),
        request: {
          method: e.method,
          url: e.url,
          httpVersion: "HTTP/1.1",
          headers: Object.entries(e.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.requestBody?.length ?? -1,
          postData: e.requestBody
            ? { mimeType: e.requestHeaders?.["content-type"] ?? "text/plain", text: e.requestBody }
            : undefined,
        },
        response: {
          status: e.status ?? 0,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: Object.entries(e.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: {
            size: e.responseBody?.length ?? 0,
            mimeType: e.responseHeaders?.["content-type"] ?? "",
            text: e.responseBody,
            encoding: e.responseBase64 ? "base64" : undefined,
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: e.responseBody?.length ?? -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  };
}
