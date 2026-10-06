import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent, WebViewErrorEvent, WebViewHttpErrorEvent, WebViewNavigation } from 'react-native-webview/lib/WebViewTypes';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from './theme';

type Props = {
  url: string;
  tokenProvider: (options?: { template?: string }) => Promise<string | null>;
  onExport: (fileName: string, mimeType: string, base64: string) => Promise<void>;
  onClose: () => void;
};
type BridgeMessage = { version: 1; type: 'authRequest'; requestId: string } | { version: 1; type: 'export'; fileName: string; mimeType: string; dataUrl: string };

export function ViewerScreen({ url, tokenProvider, onExport, onClose }: Props) {
  const reported = useRef(false);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const trustedOrigin = useMemo(() => { try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.origin : ''; } catch { return ''; } }, [url]);
  const webView = useRef<WebView>(null);
  const fail = () => { if (reported.current) return; reported.current = true; setLoadStatus('failed'); };

  const onMessage = async (event: WebViewMessageEvent) => {
    if (!trustedOrigin || originOf(event.nativeEvent.url) !== trustedOrigin) return;
    let message: BridgeMessage;
    try { message = JSON.parse(event.nativeEvent.data) as BridgeMessage; } catch { return; }
    if (!message || message.version !== 1) return;
    if (message.type === 'authRequest' && typeof message.requestId === 'string' && message.requestId.length <= 80) {
      try {
        const token = await tokenProvider({ template: 'convex' });
        const detail = JSON.stringify({ requestId: message.requestId, token }).replace(/</g, '\\u003c');
        webView.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('doodleforge:auth-token',{detail:${detail}}));true;`);
      } catch { webView.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('doodleforge:auth-token',{detail:{requestId:${JSON.stringify(message.requestId)},token:null}}));true;`); }
      return;
    }
    if (message.type === 'export' && typeof message.fileName === 'string' && message.fileName.length < 100 && typeof message.dataUrl === 'string' && message.dataUrl.length <= 40_000_000) {
      const mimeType = message.mimeType;
      const ext = message.fileName.toLowerCase().split('.').pop();
      if (!((ext === 'glb' && mimeType === 'model/gltf-binary') || (ext === 'stl' && mimeType === 'model/stl'))) return;
      const match = message.dataUrl.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return;
      try { await onExport(message.fileName, mimeType, match[1]); } catch { fail(); }
    }
  };

  const allowedNavigation = (request: WebViewNavigation) => originOf(request.url) === trustedOrigin;
  return <SafeAreaView style={styles.root}>
    <View style={styles.bar}><Text style={styles.heading}>Room explorer</Text><Pressable accessibilityRole="button" accessibilityLabel="Close room explorer" onPress={onClose} style={styles.close}><Text style={styles.closeText}>Done</Text></Pressable></View>
    <WebView
      ref={webView}
      source={{ uri: url }}
      style={styles.webview}
      allowsInlineMediaPlayback
      bounces={false}
      overScrollMode="never"
      setBuiltInZoomControls={false}
      setDisplayZoomControls={false}
      mediaPlaybackRequiresUserAction={false}
      javaScriptEnabled
      domStorageEnabled
      allowsBackForwardNavigationGestures={false}
      contentInsetAdjustmentBehavior="never"
      originWhitelist={trustedOrigin ? [`${trustedOrigin}/*`] : []}
      onShouldStartLoadWithRequest={allowedNavigation}
      onMessage={onMessage}
      onLoadStart={() => { reported.current = false; setLoadStatus('loading'); }}
      onLoad={() => { reported.current = false; setLoadStatus('ready'); }}
      onError={(e: WebViewErrorEvent) => { void e; fail(); }}
      onHttpError={(e: WebViewHttpErrorEvent) => { if (e.nativeEvent.statusCode >= 500) fail(); }}
    />
    {loadStatus === 'failed' ? <View style={styles.overlay} accessibilityRole="alert">
      <Text style={styles.overlayTitle}>You’re offline or the viewer is unavailable.</Text>
      <Text style={styles.overlayCopy}>Check your connection and try again.</Text>
      <Pressable accessibilityRole="button" onPress={() => { reported.current = false; setLoadStatus('loading'); webView.current?.reload(); }} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.done}><Text style={styles.doneText}>Close viewer</Text></Pressable>
    </View> : loadStatus === 'loading' ? <View style={styles.loading} pointerEvents="none"><ActivityIndicator color={theme.accent} /><Text style={styles.overlayCopy}>Loading your private room…</Text></View> : null}
  </SafeAreaView>;
}

function originOf(raw: string) { try { const u = new URL(raw); return u.protocol === 'https:' ? u.origin : ''; } catch { return ''; } }
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: theme.canvas }, bar: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, backgroundColor: theme.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }, heading: { color: theme.foreground, fontSize: 15, fontWeight: '700' }, close: { padding: 10 }, closeText: { color: theme.accent, fontSize: 15, fontWeight: '700' }, webview: { flex: 1, backgroundColor: theme.canvas }, loading: { position: 'absolute', left: 0, right: 0, top: 52, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: theme.canvas }, overlay: { position: 'absolute', left: 0, right: 0, top: 52, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14, backgroundColor: theme.canvas }, overlayTitle: { color: theme.foreground, fontSize: 22, lineHeight: 29, textAlign: 'center', fontWeight: '700' }, overlayCopy: { color: theme.muted, fontSize: 15, textAlign: 'center', lineHeight: 22 }, retry: { minHeight: 48, minWidth: 160, borderRadius: 12, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, retryText: { color: theme.onAccent, fontWeight: '700' }, done: { padding: 12 }, doneText: { color: theme.foreground, fontWeight: '600' } });
