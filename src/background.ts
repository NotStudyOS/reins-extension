import browser from "webextension-polyfill";
import type { NetworkEntry, RpcRequest, RpcResponse } from "./shared/protocol";
import { handlers, setStreamEmitter } from "./rpc";
import { installPageCommitCapture, setSessionId, setWsSender } from "./page-commit";

/**
 * Background service worker (Chrome MV3).
 *
 *   1. Persist server URL + OAuth tokens + browserId in chrome.storage.
 *   2. Maintain a WebSocket to `<server>/ws` authenticated via two
 *      Sec-WebSocket-Protocol entries:
 *        bearer.<access_token>   — OAuth bearer
 *        browser.<browserId>     — routing key (random uuid per profile)
 *   3. On incoming RpcRequest, dispatch to handlers.ts.
 */

const KEY_CONFIG = "reins/config";
const KEY_IDENTITY = "reins/identity";
const KEY_BROWSER_ID = "reins/browserId";
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

interface Config {
  serverUrl: string;
}
interface Identity {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;     // ms epoch
  email: string | null;
  sub: string;
}

let ws: WebSocket | null = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectGeneration = 0;
let droppedEventSends = 0;
let lastStatus: { status: "connected" | "connecting" | "disconnected" | "error"; detail?: string } = {
  status: "disconnected",
};

async function loadConfig(): Promise<Config | null> {
  const raw = await browser.storage.local.get(KEY_CONFIG);
  return (raw[KEY_CONFIG] as Config) ?? null;
}
async function saveConfig(cfg: Config) {
  await browser.storage.local.set({ [KEY_CONFIG]: cfg });
}
async function loadIdentity(): Promise<Identity | null> {
  const raw = await browser.storage.local.get(KEY_IDENTITY);
  return (raw[KEY_IDENTITY] as Identity) ?? null;
}
async function saveIdentity(id: Identity) {
  await browser.storage.local.set({ [KEY_IDENTITY]: id });
}
async function clearIdentity() {
  await browser.storage.local.remove(KEY_IDENTITY);
}

async function getOrCreateBrowserId(): Promise<string> {
  const raw = await browser.storage.local.get(KEY_BROWSER_ID);
  let id = raw[KEY_BROWSER_ID] as string | undefined;
  if (!id) {
    id = (crypto as { randomUUID?: () => string }).randomUUID?.()
      ?? `b${Math.random().toString(36).slice(2)}${Date.now()}`;
    await browser.storage.local.set({ [KEY_BROWSER_ID]: id });
  }
  return id;
}

function normalizeServerUrl(serverUrl: string): string {
  const url = serverUrl.trim().replace(/\/$/, "");
  if (!url) throw new Error("server url required");
  const parsed = new URL(url);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
  if (parsed.protocol === "http:" && !local) throw new Error("server url must use https");
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("server url must be http(s)");
  return url;
}

function wsUrlFor(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/ws`;
  return parsed.toString();
}

// ---- OAuth via chrome.identity.launchWebAuthFlow ----

const KEY_OAUTH_CLIENT = "reins/oauth_client";

interface OAuthClient { clientId: string; clientSecret?: string }

async function getOrRegisterClient(serverUrl: string): Promise<OAuthClient> {
  const raw = await browser.storage.local.get(KEY_OAUTH_CLIENT);
  const existing = raw[KEY_OAUTH_CLIENT] as OAuthClient | undefined;
  if (existing?.clientId) return existing;

  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const res = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Reins Browser Extension",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  const client: OAuthClient = { clientId: body.client_id, clientSecret: body.client_secret };
  await browser.storage.local.set({ [KEY_OAUTH_CLIENT]: client });
  return client;
}

async function signIn(serverUrl: string): Promise<Identity> {
  const normalized = normalizeServerUrl(serverUrl);
  await saveConfig({ serverUrl: normalized });

  const client = await getOrRegisterClient(normalized);
  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const authUrl = new URL(`${normalized}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  // PKCE
  const verifier = randomB64Url(48);
  const challenge = await s256(verifier);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  console.log("[reins] launchWebAuthFlow URL:", authUrl.toString());
  console.log("[reins] redirect_uri:", redirectUri);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!responseUrl) throw new Error("no response from auth flow");
  const code = new URL(responseUrl).searchParams.get("code");
  if (!code) throw new Error("missing code in callback");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const tokenRes = await fetch(`${normalized}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const t = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  // OAuth tokens are opaque (not JWT), so we can't read claims
  // locally. Fetch /platform/me with the new bearer to populate
  // email/sub from the server-side identity claims.
  let email: string | null = null;
  let sub = "";
  try {
    const meRes = await fetch(`${normalized}/whoami`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as { sub?: string; email?: string | null };
      email = me.email ?? null;
      sub = me.sub ?? "";
    }
  } catch {
    /* leave blank; popup shows '—' until next refresh */
  }
  const identity: Identity = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    email,
    sub,
  };
  await saveIdentity(identity);
  return identity;
}

function decodeJwt(t: string): Record<string, unknown> {
  const parts = t.split(".");
  if (parts.length !== 3) return {};
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(bin);
  } catch {
    return {};
  }
}

function randomB64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  let bin = "";
  const view = new Uint8Array(hash);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- WebSocket lifecycle ----

async function reconnectNow() {
  connectGeneration++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) ws.close(1000, "manual reconnect");
  ws = null;
  await connect();
}

async function connect() {
  const generation = connectGeneration;
  const cfg = await loadConfig();
  const id = await loadIdentity();
  if (!cfg || !id) {
    setStatus({ status: "disconnected", detail: id ? "no server configured" : "not signed in" });
    return;
  }
  if (id.expiresAt && id.expiresAt < Date.now() + 30_000) {
    setStatus({ status: "error", detail: "token expired — sign in again" });
    return;
  }
  const browserId = await getOrCreateBrowserId();
  // Subprotocols can't carry tokens (RFC 6455 forbids `.` `:` `_` etc.).
  // Bearer + browser id ride in the query string instead. TLS keeps them
  // private; in dev (ws://localhost) they're plaintext but only on loopback.
  const url = `${wsUrlFor(cfg.serverUrl)}?bearer=${encodeURIComponent(id.accessToken)}&browser=${encodeURIComponent(browserId)}`;
  setStatus({ status: "connecting" });
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
    ws = socket;
  } catch (e) {
    setStatus({ status: "error", detail: (e as Error).message });
    scheduleReconnect(generation);
    return;
  }

  socket.addEventListener("open", () => {
    if (generation !== connectGeneration || ws !== socket) {
      socket.close(1000, "stale connection");
      return;
    }
    setStatus({ status: "connected" });
    reconnectDelayMs = RECONNECT_MIN_MS;
    const sid = (crypto as { randomUUID?: () => string }).randomUUID?.()
      ?? `s${Math.random().toString(36).slice(2)}${Date.now()}`;
    setSessionId(sid);
  });

  socket.addEventListener("message", async (ev) => {
    if (generation !== connectGeneration || ws !== socket) return;
    let msg: RpcRequest | { event: string; data: unknown };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!("id" in msg)) return;
    const reply: RpcResponse = { id: msg.id };
    const handler = handlers[msg.method];
    if (!handler) {
      reply.error = `unknown method: ${msg.method}`;
    } else {
      try {
        reply.result = await handler(msg.params ?? {});
      } catch (e) {
        reply.error = (e as Error).message || String(e);
      }
    }
    try {
      socket.send(JSON.stringify(reply));
    } catch (e) {
      console.error("[reins] reply send failed", e);
    }
  });

  socket.addEventListener("close", (ev) => {
    if (generation !== connectGeneration || ws !== socket) return;
    ws = null;
    setSessionId(null);
    setStatus({ status: "disconnected", detail: ev.reason || `code ${ev.code}` });
    scheduleReconnect(generation);
  });

  socket.addEventListener("error", () => {
    if (generation !== connectGeneration || ws !== socket) return;
    setStatus({ status: "error" });
  });
}

function scheduleReconnect(generation: number) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (generation !== connectGeneration) return;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
    void connect();
  }, reconnectDelayMs);
}

function setStatus(s: typeof lastStatus) {
  lastStatus = s;
  void browser.storage.local.set({ "reins/status": s });
}

function sendEvent(event: string, data: unknown): boolean {
  if (ws?.readyState !== WebSocket.OPEN) {
    droppedEventSends++;
    return false;
  }
  try {
    ws.send(JSON.stringify({ event, data }));
    return true;
  } catch (e) {
    droppedEventSends++;
    console.warn("[reins] event send failed", event, e);
    return false;
  }
}

// ---- Popup message bus ----

browser.runtime.onMessage.addListener(async (raw: unknown) => {
  const msg = raw as { type?: string; serverUrl?: string };
  if (msg?.type === "popup.state") {
    const cfg = await loadConfig();
    const id = await loadIdentity();
    const browserId = await getOrCreateBrowserId();
    return {
      serverUrl: cfg?.serverUrl ?? "",
      signedIn: !!id && id.expiresAt > Date.now(),
      email: id?.email ?? null,
      browserId,
      status: lastStatus.status,
      statusDetail: lastStatus.detail,
    };
  }
  if (msg?.type === "popup.signIn") {
    const url = msg.serverUrl ?? (await loadConfig())?.serverUrl ?? "";
    await signIn(url);
    await reconnectNow();
    return { ok: true };
  }
  if (msg?.type === "popup.signOut") {
    await clearIdentity();
    if (ws) ws.close(1000, "signed out");
    ws = null;
    setStatus({ status: "disconnected", detail: "signed out" });
    return { ok: true };
  }
  if (msg?.type === "popup.reconnect") {
    await reconnectNow();
    return { ok: true };
  }
  if (msg?.type === "reins/status") {
    return { connected: ws?.readyState === WebSocket.OPEN, droppedEventSends };
  }
});

setStreamEmitter((streamId: string, entry: NetworkEntry) => {
  sendEvent("network.stream", { streamId, entry });
});

browser.tabs.onRemoved.addListener((tabId) => {
  sendEvent("tab.closed", { tabId });
});

setWsSender((msg) => {
  if (ws?.readyState !== WebSocket.OPEN) {
    droppedEventSends++;
    return;
  }
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    droppedEventSends++;
    console.warn("[reins] page event send failed", e);
  }
});
installPageCommitCapture();

void connect();
