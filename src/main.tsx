import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import App from "./App";
import './styles.css';

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

declare global { interface Window { ReactNativeWebView?: { postMessage(message: string): void } } }

function useNativeAuth() {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const pending = useRef(new Map<string, (value: string | null) => void>());
  const requestToken = useCallback(() => new Promise<string | null>((resolve) => {
    const bridge = window.ReactNativeWebView;
    if (!bridge) { setToken(null); setIsLoading(false); resolve(null); return; }
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => { pending.current.delete(requestId); setIsLoading(false); resolve(null); }, 10_000);
    pending.current.set(requestId, (value) => { window.clearTimeout(timer); setToken(value); setIsLoading(false); resolve(value); });
    bridge.postMessage(JSON.stringify({ version: 1, type: "authRequest", requestId }));
  }), []);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; token?: string | null }>).detail;
      if (detail?.requestId && pending.current.has(detail.requestId)) pending.current.get(detail.requestId)!(typeof detail.token === "string" ? detail.token : null);
    };
    window.addEventListener("doodleforge:auth-token", receive);
    void requestToken();
    return () => { window.removeEventListener("doodleforge:auth-token", receive); for (const resolve of pending.current.values()) resolve(null); pending.current.clear(); };
  }, [requestToken]);
  return { isLoading, isAuthenticated: Boolean(token), fetchAccessToken: requestToken };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {convex ? <ConvexProviderWithAuth client={convex} useAuth={useNativeAuth}>
      <App />
    </ConvexProviderWithAuth> : <main className="capture-entry"><div className="capture-card">
      <p className="capture-kicker">doodleforge</p><h1>Connect your workspace.</h1>
      <p className="capture-copy">Start the Convex development backend, then reload this page.</p>
      <code>npx convex dev</code>
    </div></main>}
  </React.StrictMode>,
);
