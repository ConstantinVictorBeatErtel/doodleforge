import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, useAuth, useUser } from '@clerk/expo';
import { AuthView } from '@clerk/expo/native';
import { tokenCache } from '@clerk/expo/token-cache';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { theme } from './src/theme';
import { ViewerScreen } from './src/ViewerScreen';

const clerkKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? '';
const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL?.trim() ?? '';
const viewerUrl = process.env.EXPO_PUBLIC_VIEWER_URL?.trim() ?? '';
const privacyUrl = process.env.EXPO_PUBLIC_PRIVACY_URL?.trim() ?? '';
const supportUrl = process.env.EXPO_PUBLIC_SUPPORT_URL?.trim() ?? '';
const consentKey = 'doodleforge.ai-consent.v1';

export default function App() {
  if (!clerkKey || !convexUrl || !isHttpsUrl(viewerUrl) || !isHttpsUrl(privacyUrl) || !isHttpsUrl(supportUrl)) return <SafeAreaProvider><Setup /></SafeAreaProvider>;
  return <SafeAreaProvider><ClerkProvider publishableKey={clerkKey} tokenCache={tokenCache}>
    <StatusBar style="light" />
    <AuthenticatedApp />
  </ClerkProvider></SafeAreaProvider>;
}

function AuthenticatedApp() {
  const { isSignedIn, isLoaded, getToken, signOut } = useAuth();
  const { user } = useUser();
  const [consented, setConsented] = useState<boolean | null>(null);
  const [openingViewer, setOpeningViewer] = useState(false);
  const [busy, setBusy] = useState(false);
  const convex = useMemo(() => new ConvexHttpClient(convexUrl), []);

  const acceptConsent = useCallback(async () => {
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem(consentKey, new Date().toISOString());
    setConsented(true);
  }, []);
  useEffect(() => {
    import('@react-native-async-storage/async-storage').then(({ default: store }) =>
      store.getItem(consentKey).then(value => setConsented(Boolean(value))));
  }, []);

  const capture = async (source: 'camera' | 'library') => {
    if (busy) return;
    setBusy(true);
    try {
      const result = source === 'camera'
        ? await pickFromCamera()
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.9, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (asset.type === 'video' && asset.duration && asset.duration > 60_000) throw new Error('Choose a video no longer than 60 seconds.');
      const maxBytes = asset.type === 'video' ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
      if (asset.fileSize && asset.fileSize > maxBytes) throw new Error(`Choose a ${asset.type === 'video' ? 'video under 100 MB' : 'photo under 20 MB'}.`);
      const token = await getToken({ template: 'convex' });
      if (!token) throw new Error('Could not create an authenticated backend session. Check the Clerk Convex JWT template.');
      convex.setAuth(token);
      let uri = asset.uri;
      let contentType = asset.mimeType || (asset.type === 'video' ? 'video/quicktime' : 'image/jpeg');
      let fileName = asset.fileName || (asset.type === 'video' ? 'capture.mov' : 'capture.jpg');
      if (asset.type !== 'video' && /heic|heif/i.test(contentType + fileName)) {
        const image = await ImageManipulator.manipulate(uri).renderAsync();
        const converted = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
        uri = converted.uri; contentType = 'image/jpeg'; fileName = fileName.replace(/\.(heic|heif)$/i, '.jpg');
      }
      const ticket = await convex.mutation(anyApi.worlds.generateUploadUrl, {});
      const uploaded = await fetch(uri).then(response => response.blob());
      if (!uploaded.size) throw new Error('The selected file is empty or could not be read.');
      const uploadResponse = await fetch(ticket.url, { method: 'POST', headers: { 'Content-Type': contentType }, body: uploaded });
      if (!uploadResponse.ok) throw new Error(`Upload failed (${uploadResponse.status}). Check your connection and try again.`);
      const { storageId } = await uploadResponse.json() as { storageId: string };
      await convex.mutation(anyApi.worlds.claimUpload, { token: ticket.token, storageId });
      const worldId = await convex.mutation(anyApi.worlds.startFromMedia, {
        storageId, kind: asset.type === 'video' ? 'video' : 'image', name: fileName,
      });
      setOpeningViewer(true);
      setViewerWorld(String(worldId));
    } catch (error) {
      Alert.alert('Could not start generation', error instanceof Error ? error.message : 'Please try again.');
    } finally { setBusy(false); }
  };

  const deleteAccount = () => Alert.alert('Delete account and creations?', 'This permanently deletes your worlds, objects, uploads, and account. Cleanup is queued before your sign-in is removed.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete account', style: 'destructive', onPress: async () => {
      setBusy(true);
      try {
        if (!user?.deleteSelfEnabled) throw new Error('Account deletion is disabled for this Clerk configuration. Contact support or enable self-deletion before release.');
        const token = await getToken({ template: 'convex' });
        if (!token) throw new Error('Your backend session expired. Sign in again to delete your account.');
        convex.setAuth(token);
        await convex.mutation(anyApi.account.deleteMyData, {});
        await user.delete();
        await signOut();
      }
      catch (error) { Alert.alert('Deletion could not finish', error instanceof Error ? error.message : 'Try again while online.'); }
      finally { setBusy(false); }
    } },
  ]);

  const [viewerWorld, setViewerWorld] = useState<string | undefined>();
  if (consented === null || !isLoaded) return <Centered><ActivityIndicator color={theme.accent} /></Centered>;
  if (!consented) return <Consent onAccept={acceptConsent} />;
  if (!isSignedIn) return <SafeAreaView style={styles.auth}><Text style={styles.brand}>doodleforge</Text><AuthView isDismissible={false} /></SafeAreaView>;
  if (openingViewer && viewerUrlValid()) return <ViewerScreen url={withWorld(viewerUrl, viewerWorld)} tokenProvider={getToken} onClose={() => setOpeningViewer(false)} onExport={(fileName, mimeType, base64) => shareExport(fileName, mimeType, base64)} />;

  return <SafeAreaView style={styles.root}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.brand}>doodleforge</Text>
      <Text style={styles.title}>Make a room from a moment.</Text>
      <Text style={styles.copy}>Choose a photo or a short video to create a private 3D room. AI generation sends your selected capture and prompt to World Labs. Drawings and prompts can also be sent to fal and Tripo when you use the room tools.</Text>
      {busy ? <ActivityIndicator style={{ marginVertical: 20 }} color={theme.accent} /> : <>
        <Button label="Take a photo" onPress={() => void capture('camera')} />
        <Button label="Choose photo or video" onPress={() => void capture('library')} secondary />
      </>}
      <Button label="Open room explorer" onPress={() => { if (!viewerUrlValid()) { Alert.alert('Viewer is not configured', 'Set EXPO_PUBLIC_VIEWER_URL to the trusted HTTPS viewer deployment, then rebuild.'); return; } setViewerWorld(undefined); setOpeningViewer(true); }} secondary />
      <View style={styles.rule} />
      <Text style={styles.copy}>{user?.primaryEmailAddress?.emailAddress || 'Signed in'}</Text>
      <Button label="Sign out" onPress={() => void signOut()} secondary />
      <Button label="Delete account and creations" onPress={deleteAccount} destructive />
      <Pressable onPress={() => void Linking.openURL(privacyUrl)}><Text style={styles.link}>Privacy policy</Text></Pressable>
      <Pressable onPress={() => void Linking.openURL(supportUrl)}><Text style={styles.link}>Support</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}

function viewerUrlValid() { return isHttpsUrl(viewerUrl); }
function isHttpsUrl(raw: string) { try { return new URL(raw).protocol === 'https:'; } catch { return false; } }
async function pickFromCamera() {
  let permission = await ImagePicker.getCameraPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert('Camera access is off', 'Allow camera access in Settings to take a room photo.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => void Linking.openSettings() }]);
    return { canceled: true as const, assets: null };
  }
  return ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
}
function withWorld(url: string, worldId?: string) { const parsed = new URL(url); if (worldId) parsed.searchParams.set('world', worldId); return parsed.toString(); }

async function shareExport(fileName: string, mimeType: string, base64: string) {
  if (base64.length > 40_000_000) throw new Error('This export is too large to share from the iPhone app.');
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const file = new File(Paths.cache, safeName);
  file.create({ intermediates: true, overwrite: true });
  file.write(base64, { encoding: 'base64' });
  if (!(await Sharing.isAvailableAsync())) throw new Error('The iOS share sheet is unavailable.');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: 'Save or share your 3D object' });
}

function Setup() { return <Centered><Text style={styles.brand}>doodleforge</Text><Text style={styles.title}>App setup is incomplete</Text><Text style={styles.copy}>Set the Clerk publishable key, Convex URL, trusted HTTPS viewer URL, privacy policy URL, and support URL for this build.</Text></Centered>; }
function Consent({ onAccept }: { onAccept: () => void }) { return <Centered><Text style={styles.brand}>doodleforge</Text><Text style={styles.title}>Your creations, your choice.</Text><Text style={styles.copy}>Room photos, videos, and text prompts are sent to World Labs to generate a room. Drawings and prompts are sent to fal and Tripo to create 3D objects. Your creations stay private in your account. You can delete individual creations in the explorer or delete your account and its data in Settings.</Text><Pressable onPress={() => void Linking.openURL(privacyUrl)}><Text style={styles.link}>Read the privacy policy</Text></Pressable><Button label="Agree and continue" onPress={onAccept} /></Centered>; }
function Centered({ children }: { children: React.ReactNode }) { return <SafeAreaView style={styles.center}>{children}</SafeAreaView>; }
function Button({ label, onPress, secondary = false, destructive = false }: { label: string; onPress: () => void; secondary?: boolean; destructive?: boolean }) { return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.button, secondary && styles.secondary, destructive && styles.destructive]}><Text style={[styles.buttonText, secondary && styles.secondaryText, destructive && styles.destructiveText]}>{label}</Text></Pressable>; }
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: theme.canvas }, auth: { flex: 1, backgroundColor: theme.canvas, paddingTop: 50 }, content: { flexGrow: 1, padding: 24, paddingTop: 72, gap: 14 }, center: { flex: 1, backgroundColor: theme.canvas, padding: 28, alignItems: 'stretch', justifyContent: 'center', gap: 16 }, brand: { color: theme.accent, fontSize: 15, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase' }, title: { color: theme.foreground, fontSize: 32, fontWeight: '700', lineHeight: 39, marginTop: 10 }, copy: { color: theme.muted, fontSize: 15, lineHeight: 23, marginBottom: 8 }, fine: { color: theme.muted, fontSize: 12, lineHeight: 18, marginTop: 8 }, link: { color: theme.accent, fontWeight: '600', paddingVertical: 6 }, button: { minHeight: 54, borderRadius: 14, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginTop: 4 }, buttonText: { color: theme.onAccent, fontSize: 16, fontWeight: '700' }, secondary: { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }, secondaryText: { color: theme.foreground }, destructive: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.error }, destructiveText: { color: theme.error }, rule: { height: 1, backgroundColor: theme.border, marginVertical: 10 } });
