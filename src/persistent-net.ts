/**
 * Persistent network buffer that survives MV3 service-worker restarts.
 *
 * MV3 SWs are terminated aggressively (~30s idle); without this layer, every
 * snooze loses the in-memory buffer. We hydrate from chrome.storage.session
 * on boot and persist asynchronously as new entries land.
 *
 * Uses session storage (not local) because:
 *  - session is wiped on browser shutdown which matches intuitive network-tab
 *    semantics ("I started recording when I opened the browser");
 *  - it's uncapped beyond ~10 MB soft limit (local is stricter).
 */

import type { NetworkEntry } from "./shared/protocol";

const STORAGE_KEY = "reins/net-buffer";
type PartialEntry = NetworkEntry & { loaded?: boolean };
type TabBuffer = Record<string, PartialEntry>;

let mem: Map<number, Map<string, PartialEntry>> = new Map();
let hydrated = false;
let persistQueued = false;

async function hydrate() {
  if (hydrated) return;
  try {
    const raw = await chrome.storage.session.get(STORAGE_KEY);
    const blob = (raw[STORAGE_KEY] ?? {}) as Record<string, TabBuffer>;
    for (const [k, v] of Object.entries(blob)) {
      mem.set(Number(k), new Map(Object.entries(v)));
    }
  } catch (e) {
    console.warn("[reins] net-buffer hydrate failed", e);
  } finally {
    hydrated = true;
  }
}

function schedulePersist() {
  if (persistQueued) return;
  persistQueued = true;
  // Coalesce bursts so we don't hammer storage on every CDP event.
  setTimeout(async () => {
    persistQueued = false;
    const blob: Record<string, TabBuffer> = {};
    for (const [tabId, tabBuf] of mem) {
      blob[String(tabId)] = Object.fromEntries(tabBuf);
    }
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: blob });
    } catch (e) {
      console.warn("[reins] net-buffer persist failed", e);
    }
  }, 250);
}

export async function buf(tabId: number): Promise<Map<string, PartialEntry>> {
  await hydrate();
  let b = mem.get(tabId);
  if (!b) {
    b = new Map();
    mem.set(tabId, b);
  }
  return b;
}

export function markDirty() {
  schedulePersist();
}

export async function clearTab(tabId?: number) {
  await hydrate();
  if (tabId === undefined) mem.clear();
  else mem.delete(tabId);
  schedulePersist();
}

export async function snapshot(): Promise<Map<number, Map<string, PartialEntry>>> {
  await hydrate();
  return mem;
}
