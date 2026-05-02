import type { EmulateParams, EmulateResult } from "../shared/protocol";

/**
 * emulate — bundle of CDP overrides. Each block is independent; pass only
 * what you want to set. `clear: true` resets every override applied via
 * this tool.
 *
 * Maps to:
 *   viewport          → Emulation.setDeviceMetricsOverride
 *   userAgent         → Network.setUserAgentOverride
 *   network           → Network.emulateNetworkConditions
 *   timezone          → Emulation.setTimezoneOverride
 *   locale            → Emulation.setLocaleOverride
 *   geolocation       → Emulation.setGeolocationOverride
 *   permissions       → Browser.setPermission (per origin)
 *   prefersColorScheme/prefersReducedMotion → Emulation.setEmulatedMedia
 */
export const emulateHandlers: Record<string, (p: any) => Promise<unknown>> = {
  emulate: async (p: EmulateParams): Promise<EmulateResult> => {
    const target = { tabId: p.tabId };
    const applied: string[] = [];

    if (p.clear) {
      await safe(() => chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride"));
      await safe(() => chrome.debugger.sendCommand(target, "Network.setUserAgentOverride", { userAgent: "" }));
      await safe(() => chrome.debugger.sendCommand(target, "Network.emulateNetworkConditions", { offline: false, downloadThroughput: 0, uploadThroughput: 0, latency: 0 }));
      await safe(() => chrome.debugger.sendCommand(target, "Emulation.setTimezoneOverride", { timezoneId: "" }));
      await safe(() => chrome.debugger.sendCommand(target, "Emulation.setLocaleOverride", {}));
      await safe(() => chrome.debugger.sendCommand(target, "Emulation.clearGeolocationOverride"));
      await safe(() => chrome.debugger.sendCommand(target, "Emulation.setEmulatedMedia", { features: [] }));
      applied.push("clear");
      return { ok: true, applied };
    }

    if (p.viewport) {
      await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
        width: p.viewport.width,
        height: p.viewport.height,
        deviceScaleFactor: p.viewport.deviceScaleFactor ?? 1,
        mobile: !!p.viewport.mobile,
      });
      applied.push("viewport");
    }
    if (p.userAgent) {
      await chrome.debugger.sendCommand(target, "Network.setUserAgentOverride", {
        userAgent: p.userAgent.value,
        acceptLanguage: p.userAgent.acceptLanguage,
        platform: p.userAgent.platform,
      });
      applied.push("userAgent");
    }
    if (p.network) {
      const presets: Record<string, { offline: boolean; dl: number; ul: number; lat: number }> = {
        offline: { offline: true, dl: 0, ul: 0, lat: 0 },
        slow_3g: { offline: false, dl: 50 * 1024, ul: 50 * 1024, lat: 400 },
        fast_3g: { offline: false, dl: 180 * 1024, ul: 84 * 1024, lat: 150 },
        slow_4g: { offline: false, dl: 400 * 1024, ul: 400 * 1024, lat: 60 },
      };
      const pre = p.network.preset ? presets[p.network.preset] : null;
      await chrome.debugger.sendCommand(target, "Network.emulateNetworkConditions", {
        offline: pre?.offline ?? p.network.offline ?? false,
        downloadThroughput: pre?.dl ?? p.network.downloadThroughput ?? 0,
        uploadThroughput: pre?.ul ?? p.network.uploadThroughput ?? 0,
        latency: pre?.lat ?? p.network.latencyMs ?? 0,
      });
      applied.push("network");
    }
    if (p.timezone) {
      await chrome.debugger.sendCommand(target, "Emulation.setTimezoneOverride", { timezoneId: p.timezone });
      applied.push("timezone");
    }
    if (p.locale) {
      await chrome.debugger.sendCommand(target, "Emulation.setLocaleOverride", { locale: p.locale });
      applied.push("locale");
    }
    if (p.geolocation) {
      await chrome.debugger.sendCommand(target, "Emulation.setGeolocationOverride", {
        latitude: p.geolocation.latitude,
        longitude: p.geolocation.longitude,
        accuracy: p.geolocation.accuracy ?? 50,
      });
      applied.push("geolocation");
    }
    if (p.prefersColorScheme || p.prefersReducedMotion) {
      const features: Array<{ name: string; value: string }> = [];
      if (p.prefersColorScheme) features.push({ name: "prefers-color-scheme", value: p.prefersColorScheme });
      if (p.prefersReducedMotion) features.push({ name: "prefers-reduced-motion", value: p.prefersReducedMotion });
      await chrome.debugger.sendCommand(target, "Emulation.setEmulatedMedia", { features });
      applied.push("media");
    }
    if (p.permissions) {
      // Browser.setPermission requires Browser-level target; chrome.debugger
      // attached to a tab can call it via the browser-wide target.
      for (const [name, setting] of Object.entries(p.permissions)) {
        try {
          await chrome.debugger.sendCommand(target, "Browser.setPermission", {
            permission: { name },
            setting,
          });
          applied.push(`permission:${name}=${setting}`);
        } catch {
          // Ignore unsupported permission names.
        }
      }
    }

    return { ok: true, applied };
  },
};

async function safe(fn: () => Promise<unknown>) {
  try { await fn(); } catch {}
}
