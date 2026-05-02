import type { ConsoleLogEntry, ConsoleLogsParams, ConsoleLogsResult } from "./shared/protocol";

/**
 * Ring buffer for console.* output captured via the CDP `Runtime.consoleAPICalled`
 * event. network.ts owns the debugger attachments; this module subscribes to the
 * same event stream by installing its own listener on chrome.debugger.onEvent.
 *
 * We also enable `Runtime.enable` lazily when the first query comes in per tab
 * so non-consumers don't pay the cost of receiving every console frame.
 */

const LIMIT_PER_TAB = 500;
const enabledTabs = new Set<number>();
const bufs = new Map<number, ConsoleLogEntry[]>();

export async function enableFor(tabId: number) {
  if (enabledTabs.has(tabId)) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    enabledTabs.add(tabId);
  } catch (e) {
    console.warn("[reins] Runtime.enable failed", tabId, e);
  }
}

export function init() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    if (method !== "Runtime.consoleAPICalled" && method !== "Runtime.exceptionThrown") return;
    const tabId = source.tabId;
    const buf = bufs.get(tabId) ?? [];
    const p = params as any;

    if (method === "Runtime.consoleAPICalled") {
      const text = (p.args ?? [])
        .map((a: any) => a.value !== undefined ? String(a.value)
          : a.description ? a.description
          : a.unserializableValue ?? "")
        .join(" ");
      buf.push({
        tabId,
        ts: Date.now(),
        level: p.type ?? "log",
        text,
        source: "console",
        url: p.stackTrace?.callFrames?.[0]?.url,
        lineNumber: p.stackTrace?.callFrames?.[0]?.lineNumber,
      });
    } else {
      const ex = p.exceptionDetails;
      buf.push({
        tabId,
        ts: Date.now(),
        level: "error",
        text: ex?.exception?.description ?? ex?.text ?? "uncaught exception",
        source: "exception",
        url: ex?.url,
        lineNumber: ex?.lineNumber,
      });
    }

    if (buf.length > LIMIT_PER_TAB) buf.splice(0, buf.length - LIMIT_PER_TAB);
    bufs.set(tabId, buf);
  });
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId !== undefined) {
      enabledTabs.delete(src.tabId);
      bufs.delete(src.tabId);
    }
  });
}

export async function read(p: ConsoleLogsParams): Promise<ConsoleLogsResult> {
  const levels = p.levels && p.levels.length ? new Set(p.levels) : null;
  const sources = p.sources && p.sources.length ? new Set(p.sources) : null;
  const contains = p.contains;
  const re = p.containsRegex ? new RegExp(p.containsRegex, p.containsFlags ?? "i") : null;
  const since = p.sinceMs ?? 0;
  const limit = p.limit ?? 200;
  const tabIds = p.tabId !== undefined ? [p.tabId] : [...bufs.keys()];
  if (p.tabId !== undefined) await enableFor(p.tabId);

  let out: ConsoleLogEntry[] = [];
  for (const t of tabIds) {
    const buf = bufs.get(t) ?? [];
    for (const e of buf) {
      if (e.ts <= since) continue;
      if (levels && !levels.has(e.level as any)) continue;
      if (sources && !sources.has((e.source ?? "console") as any)) continue;
      if (contains && !e.text.includes(contains)) continue;
      if (re && !re.test(e.text)) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  if (out.length > limit) out = out.slice(out.length - limit);
  return { logs: out };
}
