import type {
  AttachDebuggerAllResult,
  BlockUrlsParams,
  BlockUrlsResult,
  HarExportParams,
  HarExportResult,
  InterceptClearParams,
  InterceptSetParams,
  InterceptSetResult,
  NetworkEntry,
  NetworkStreamStartParams,
  NetworkStreamStartResult,
  NetworkStreamStopParams,
  ReadNetworkFilters,
  ThrottleNetworkParams,
  WaitForNetworkIdleParams,
  WaitForNetworkIdleResult,
  WsCaptureStartParams,
  WsCaptureStartResult,
  WsCaptureStopParams,
  WsReadParams,
  WsReadResult,
} from "../shared/protocol";
import {
  addStream,
  attachAll,
  clearNetwork as clearNet,
  readNetwork as readNet,
  removeStream,
} from "../net";
import { clearRules, setRules } from "../intercept";
import { start as wsStart, stop as wsStop, read as wsRead } from "../ws-capture";
import { walkPath } from "./dom-path";
import { toHar } from "./har";
import { sleep } from "./runtime";

type StreamEmitter = (streamId: string, entry: NetworkEntry) => void;

export function createNetworkHandlers(emitStream: StreamEmitter): Record<string, (params: any) => Promise<unknown>> {
  return {
    read_network: async (p: ReadNetworkFilters) => ({ entries: await readNet(p) }),

    read_network_extract: async (p: any) => {
      const entries = await readNet({ ...p, includeBodies: true });
      const flatten = p.flatten !== false;
      const unique = p.unique === true;
      const maxItems = typeof p.maxItems === "number" ? p.maxItems : 5000;
      const expr = String(p.extract ?? "");
      const items: unknown[] = [];
      const errors: Array<{ url: string; error: string }> = [];
      let matched = 0;
      for (const entry of entries) {
        matched++;
        const bodyStr: string | undefined = (entry as any).responseBody;
        if (bodyStr === undefined) continue;
        const ct = entry.responseHeaders?.["content-type"] ?? entry.responseHeaders?.["Content-Type"] ?? "";
        let body: unknown = bodyStr;
        if (/json/i.test(ct)) {
          try { body = JSON.parse(bodyStr); } catch {}
        }
        let out: unknown;
        try {
          out = walkPath(body, expr);
        } catch (e: any) {
          errors.push({ url: entry.url, error: String(e?.message ?? e) });
          continue;
        }
        if (out === undefined) continue;
        if (flatten && Array.isArray(out)) items.push(...out);
        else items.push(out);
        if (items.length >= maxItems) break;
      }
      let final: unknown[] = items.slice(0, maxItems);
      if (unique) {
        const seen = new Set<string>();
        const dedup: unknown[] = [];
        for (const v of final) {
          const k = typeof v === "object" ? JSON.stringify(v) : String(v);
          if (seen.has(k)) continue;
          seen.add(k);
          dedup.push(v);
        }
        final = dedup;
      }
      return { matchedEntries: matched, items: final, errors };
    },

    clear_network: async (p: { tabId?: number }) => {
      await clearNet(p?.tabId);
      return { ok: true };
    },

    attach_debugger_all: async (): Promise<AttachDebuggerAllResult> => attachAll(),

    "intercept.set": async (p: InterceptSetParams): Promise<InterceptSetResult> => {
      return { ruleIds: await setRules(p.tabId, p.rules) };
    },

    "intercept.clear": async (p: InterceptClearParams) => {
      await clearRules(p?.tabId, p?.ruleIds);
      return { ok: true };
    },

    "network.stream_start": async (p: NetworkStreamStartParams): Promise<NetworkStreamStartResult> => {
      const streamId = `s${Math.random().toString(36).slice(2, 10)}`;
      addStream(streamId, p, (entry) => emitStream(streamId, entry));
      return { streamId };
    },

    "network.stream_stop": async (p: NetworkStreamStopParams) => {
      removeStream(p.streamId);
      return { ok: true };
    },

    har_export: async (p: HarExportParams): Promise<HarExportResult> => {
      const entries = await readNet({
        tabId: p.tabId,
        urlPattern: p.urlPattern,
        includeBodies: p.includeBodies,
      });
      const har = toHar(entries);
      return { harJson: JSON.stringify(har) };
    },

    "ws.capture_start": async (p: WsCaptureStartParams): Promise<WsCaptureStartResult> => {
      const captureId = `c${Math.random().toString(36).slice(2, 10)}`;
      wsStart(captureId, p.tabId, p.urlPattern);
      return { captureId };
    },

    "ws.capture_stop": async (p: WsCaptureStopParams) => {
      wsStop(p.captureId);
      return { ok: true };
    },

    "ws.read": async (p: WsReadParams): Promise<WsReadResult> => wsRead(
      p.captureId,
      p.sinceIndex ?? 0,
      p.limit,
    ),

    wait_for_network_idle: async (p: WaitForNetworkIdleParams): Promise<WaitForNetworkIdleResult> => {
      const start = Date.now();
      const timeout = start + (p.timeoutMs ?? 15_000);
      const idleMs = p.idleMs ?? 800;
      let observed = 0;
      let lastSeenMs = start;
      let lastTotal = 0;
      while (Date.now() < timeout) {
        const entries = await readNet({
          tabId: p.tabId,
          urlPattern: p.urlPattern,
          sinceMs: start - 1,
          limit: 10_000,
        });
        if (entries.length > lastTotal) {
          const latest = entries[entries.length - 1]?.timing?.startedMs ?? Date.now();
          lastSeenMs = Math.max(lastSeenMs, latest);
          observed = entries.length;
          lastTotal = entries.length;
        }
        if (Date.now() - lastSeenMs >= idleMs) {
          return { idle: true, elapsedMs: Date.now() - start, observedRequests: observed };
        }
        await sleep(120);
      }
      return { idle: false, elapsedMs: Date.now() - start, observedRequests: observed };
    },

    throttle_network: async (p: ThrottleNetworkParams) => {
      const presets: Record<string, { offline: boolean; dl: number; ul: number; lat: number }> = {
        offline: { offline: true, dl: 0, ul: 0, lat: 0 },
        slow_3g: { offline: false, dl: 50 * 1024, ul: 50 * 1024, lat: 400 },
        fast_3g: { offline: false, dl: 180 * 1024, ul: 84 * 1024, lat: 150 },
        slow_4g: { offline: false, dl: 400 * 1024, ul: 400 * 1024, lat: 60 },
        reset: { offline: false, dl: 0, ul: 0, lat: 0 },
      };
      const preset = p.preset ? presets[p.preset] : null;
      const params = {
        offline: preset?.offline ?? p.offline ?? false,
        downloadThroughput: preset?.dl ?? p.downloadThroughput ?? 0,
        uploadThroughput: preset?.ul ?? p.uploadThroughput ?? 0,
        latency: preset?.lat ?? p.latencyMs ?? 0,
      };
      try {
        await chrome.debugger.sendCommand({ tabId: p.tabId }, "Network.emulateNetworkConditions", params);
      } catch (e) {
        throw new Error(`throttle_network: ${String((e as Error).message)} (attach debugger first)`);
      }
      return { ok: true, ...params };
    },

    block_urls: async (p: BlockUrlsParams): Promise<BlockUrlsResult> => {
      const rules = p.patterns.map((pat) => ({
        urlPattern: pat,
        regex: !!p.regex,
        action: "block" as const,
      }));
      return { ruleIds: await setRules(p.tabId, rules) };
    },
  };
}
