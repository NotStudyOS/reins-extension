import { useEffect, useState } from "react";
import { Loader2, LogIn, RefreshCw, LogOut, ExternalLink, Settings, Copy, Check } from "lucide-react";

interface ExtState {
  serverUrl: string;
  signedIn: boolean;
  email: string | null;
  browserId: string;
  status: "connected" | "connecting" | "disconnected" | "error";
  statusDetail?: string;
}

const PROD_SERVER = "https://reins.vulcanos.pro";
const DASHBOARD_URL = "https://reins.vulcanos.pro/dashboard";

export function Popup() {
  const [state, setState] = useState<ExtState | null>(null);
  const [busy, setBusy] = useState<"signin" | "reconnect" | "signout" | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serverUrl, setServerUrl] = useState(PROD_SERVER);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
    const onChange = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local") void refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  async function refresh() {
    const res = await chrome.runtime.sendMessage({ type: "popup.state" });
    if (res) {
      setState(res);
      setServerUrl(res.serverUrl || PROD_SERVER);
    }
  }

  async function send(action: typeof busy, type: string, payload?: object) {
    setBusy(action);
    try {
      await chrome.runtime.sendMessage({ type, ...payload });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function copyId() {
    if (!state?.browserId) return;
    await navigator.clipboard.writeText(state.browserId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const signedIn = !!state?.signedIn;
  const status = state?.status ?? "disconnected";

  return (
    <div className="px-5 pt-5 pb-4 flex flex-col gap-5 relative">
      <Brand />

      {!signedIn ? (
        <SignedOut
          busy={busy === "signin"}
          serverUrl={serverUrl}
          showAdvanced={showAdvanced}
          onToggleAdvanced={() => setShowAdvanced((v) => !v)}
          onServerChange={setServerUrl}
          onSignIn={() => send("signin", "popup.signIn", { serverUrl })}
        />
      ) : (
        <SignedIn
          email={state?.email ?? null}
          status={status}
          statusDetail={state?.statusDetail}
          browserId={state?.browserId ?? ""}
          copied={copied}
          busy={busy}
          onReconnect={() => send("reconnect", "popup.reconnect")}
          onSignOut={() => send("signout", "popup.signOut")}
          onCopyId={copyId}
        />
      )}

      <Footer />
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="font-mono text-[19px] font-semibold tracking-tight"
        style={{ color: "var(--primary)" }}
      >
        R
      </span>
      <h1 className="font-mono text-[15px] font-semibold tracking-tight">Reins</h1>
      <span className="text-[10px] text-muted-foreground ml-auto self-center">
        browser bridge for any LLM
      </span>
    </div>
  );
}

function SignedOut({
  busy,
  serverUrl,
  showAdvanced,
  onToggleAdvanced,
  onServerChange,
  onSignIn,
}: {
  busy: boolean;
  serverUrl: string;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  onServerChange: (s: string) => void;
  onSignIn: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground max-w-[26ch]">
        Sign in to attach this browser to your Reins account.
      </p>

      <button
        onClick={onSignIn}
        disabled={busy}
        className="group flex items-center gap-2 self-start text-[13px] font-medium transition-colors disabled:opacity-50"
        style={{ color: "var(--primary)" }}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <LogIn className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        )}
        Sign in
        <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
      </button>

      <button
        type="button"
        onClick={onToggleAdvanced}
        className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 self-start"
      >
        <Settings className="size-2.5" />
        {showAdvanced ? "Close" : "Advanced"}
      </button>

      {showAdvanced && (
        <div className="flex flex-col gap-1.5 -mt-2">
          <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
            Server
          </label>
          <input
            className="w-full bg-transparent border-0 border-b border-border focus:border-foreground focus:outline-none px-0 py-1 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/50 transition-colors"
            value={serverUrl}
            onChange={(e) => onServerChange(e.target.value)}
            placeholder={PROD_SERVER}
            disabled={busy}
          />
          <p className="text-[10px] text-muted-foreground">
            Override only when self-hosting or in dev.
          </p>
        </div>
      )}
    </div>
  );
}

function SignedIn({
  email,
  status,
  statusDetail,
  browserId,
  copied,
  busy,
  onReconnect,
  onSignOut,
  onCopyId,
}: {
  email: string | null;
  status: ExtState["status"];
  statusDetail?: string;
  browserId: string;
  copied: boolean;
  busy: "signin" | "reconnect" | "signout" | null;
  onReconnect: () => void;
  onSignOut: () => void;
  onCopyId: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Status status={status} detail={statusDetail} />

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Account
        </span>
        <span className="text-[13px] truncate" title={email ?? ""}>
          {email ?? "—"}
        </span>
      </div>

      <div className="flex items-center gap-5 text-[12px]">
        <button
          onClick={onReconnect}
          disabled={busy !== null}
          className="group flex items-center gap-1.5 font-medium hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: "var(--primary)" }}
        >
          {busy === "reconnect" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3 transition-transform group-hover:rotate-180 duration-500" />
          )}
          Reconnect
        </button>
        <button
          onClick={onSignOut}
          disabled={busy !== null}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
        >
          {busy === "signout" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <LogOut className="size-3" />
          )}
          Sign out
        </button>
      </div>

      {browserId && (
        <button
          type="button"
          onClick={onCopyId}
          className="group flex items-center gap-1.5 self-start text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors font-mono"
          title="Copy full browser id"
        >
          {copied ? (
            <Check className="size-2.5" style={{ color: "var(--primary)" }} />
          ) : (
            <Copy className="size-2.5 opacity-50 group-hover:opacity-100 transition-opacity" />
          )}
          <span>browser <span className="text-foreground/70">{browserId.slice(0, 8)}</span></span>
        </button>
      )}
    </div>
  );
}

function Status({ status, detail }: { status: ExtState["status"]; detail?: string }) {
  const config = {
    connected: {
      label: "Connected",
      color: "rgb(34 197 94)",  // green-500
      pulse: false,
    },
    connecting: {
      label: "Connecting",
      color: "rgb(245 158 11)",  // amber-500
      pulse: true,
    },
    disconnected: {
      label: "Disconnected",
      color: "var(--muted-foreground)",
      pulse: false,
    },
    error: {
      label: "Error",
      color: "rgb(239 68 68)",  // red-500
      pulse: false,
    },
  }[status];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="relative flex size-1.5">
          {config.pulse && (
            <span
              className="absolute inset-0 rounded-full animate-ping"
              style={{ background: config.color, opacity: 0.4 }}
            />
          )}
          <span
            className="relative size-1.5 rounded-full"
            style={{
              background: config.color,
              boxShadow: status === "connected" ? `0 0 8px ${config.color}` : "none",
            }}
          />
        </span>
        <span className="font-mono text-[15px] tracking-tight" style={{ color: config.color }}>
          {config.label}
        </span>
        {detail && (
          <span className="text-[10px] text-muted-foreground truncate" title={detail}>
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="flex items-center justify-between mt-1 pt-3 text-[10px] font-mono"
      style={{ borderTop: "1px solid color-mix(in oklab, var(--border) 60%, transparent)" }}
    >
      <a
        href={DASHBOARD_URL}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        Dashboard
        <ExternalLink className="size-2.5 opacity-60 group-hover:opacity-100 transition-opacity" />
      </a>
      <span className="text-muted-foreground/50">v0.1.0</span>
    </div>
  );
}
