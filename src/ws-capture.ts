import type { WsFrame } from "./shared/protocol";

/**
 * WebSocket frame capture via CDP Network.webSocketFrame{Sent,Received}.
 * Hooks into the same chrome.debugger channel the HTTP capture uses — no
 * extra attach needed, provided the tab is already debugger-attached.
 *
 * State keyed by captureId (user-visible) rather than CDP requestId, so
 * multiple overlapping captures on the same tab are OK.
 */

interface Capture {
  tabId: number;
  urlPattern?: string;
  frames: WsFrame[];
  urlByRequestId: Map<string, string>;
  nextIndex: number;
}

const captures = new Map<string, Capture>();
let installed = false;

export function installWsHook() {
  if (installed) return;
  installed = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const p = params as any;
    for (const cap of captures.values()) {
      if (cap.tabId !== tabId) continue;
      switch (method) {
        case "Network.webSocketCreated":
          cap.urlByRequestId.set(p.requestId, p.url);
          break;
        case "Network.webSocketFrameSent":
        case "Network.webSocketFrameReceived": {
          const url = cap.urlByRequestId.get(p.requestId) ?? "";
          if (cap.urlPattern && !url.includes(cap.urlPattern)) continue;
          const frame = p.response;
          const binary = frame.opcode === 2;
          cap.frames.push({
            index: cap.nextIndex++,
            ts: Date.now(),
            url,
            direction: method === "Network.webSocketFrameSent" ? "c2s" : "s2c",
            opcode: frame.opcode,
            payload: frame.payloadData ?? "",
            binary,
          });
          break;
        }
        case "Network.webSocketClosed":
          cap.urlByRequestId.delete(p.requestId);
          break;
      }
    }
  });
}

export function start(captureId: string, tabId: number, urlPattern?: string) {
  captures.set(captureId, {
    tabId,
    urlPattern,
    frames: [],
    urlByRequestId: new Map(),
    nextIndex: 0,
  });
}

export function stop(captureId: string) {
  captures.delete(captureId);
}

export function read(captureId: string, sinceIndex = 0, limit?: number): { frames: WsFrame[]; nextIndex: number } {
  const cap = captures.get(captureId);
  if (!cap) throw new Error(`unknown capture: ${captureId}`);
  let frames = cap.frames.filter((f) => f.index > sinceIndex);
  if (limit) frames = frames.slice(0, limit);
  const nextIndex = frames.length ? frames[frames.length - 1].index : sinceIndex;
  return { frames, nextIndex };
}
