import { useEffect, useMemo, useRef, useState } from 'react';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { CaptureEntry, type CaptureModel } from './components/CaptureEntry';
import { ExistingWorlds } from './components/ExistingWorlds';
import { ConvexProjectClient } from './lib/ConvexProjectClient';
import WorldApp from './WorldApp';

export default function App() {
  const convex = useConvex();
  const client = useMemo(() => new ConvexProjectClient(convex), [convex]);
  const generateUploadUrl = useMutation(api.worlds.generateUploadUrl);
  const claimUpload = useMutation(api.worlds.claimUpload);
  const startFromMedia = useMutation(api.worlds.startFromMedia);
  const deleteWorld = useMutation(api.worlds.deleteWorld);
  const worlds = useQuery(api.worlds.list) ?? [];

  const [worldId, setWorldId] = useState(() => new URLSearchParams(location.search).get('world'));
  const [legacyJob, setLegacyJob] = useState(() => new URLSearchParams(location.search).get('job'));
  const [loading, setLoading] = useState(Boolean(legacyJob));
  const [error, setError] = useState('');
  const activeRequest = useRef(0);
  const busy = useRef(false);

  const openWorld = (id: string) => {
    const url = new URL(location.href);
    url.searchParams.set('world', id);
    url.searchParams.delete('job');
    history.replaceState(null, '', url);
    setLegacyJob(null);
    setWorldId(id);
  };

  // A photo or video kicks off a real Marble generation (kept short: upload, then hand off
  // to the room viewer, which watches the world's status reactively — see WorldApp's
  // roomStatus). A ZIP is an already-generated world, unpacked and pushed into storage.
  const createFromCapture = async (file: File, model: CaptureModel) => {
    if (busy.current) return;
    busy.current = true;
    const request = ++activeRequest.current;
    setLoading(true);
    setError('');
    try {
      const isZip = file.name.toLowerCase().endsWith('.zip');
      let id: string;
      if (isZip) {
        id = await client.importZip(file);
      } else {
        const ticket = await generateUploadUrl();
        const response = await fetch(ticket.url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status}).`);
        const { storageId } = await response.json() as { storageId?: string };
        if (!storageId) throw new Error('Storage did not return an ID for the upload.');
        await claimUpload({ token: ticket.token, storageId: storageId as Id<'_storage'> });
        id = await startFromMedia({ storageId: storageId as Id<'_storage'>, kind: file.type.startsWith('video/') ? 'video' : 'image', name: file.name, model });
      }
      if (request !== activeRequest.current) return;
      openWorld(id);
    } catch (e) {
      if (request === activeRequest.current) setError(e instanceof Error ? e.message : 'Unable to build a world from that capture.');
    } finally {
      if (request === activeRequest.current) { busy.current = false; setLoading(false); }
    }
  };

  // Preserve old local ?job= links (captures the CLI saved locally) by importing them.
  useEffect(() => {
    if (!legacyJob || worldId) return;
    const request = ++activeRequest.current;
    setLoading(true);
    client.importLocalWorld(legacyJob).then((id) => {
      if (request === activeRequest.current) openWorld(id);
    }).catch((e) => {
      if (request === activeRequest.current) setError(e instanceof Error ? e.message : 'Unable to open the saved world.');
    }).finally(() => {
      if (request === activeRequest.current) setLoading(false);
    });
  }, [legacyJob, worldId, client]);

  const newWorld = () => {
    ++activeRequest.current;
    busy.current = false;
    setWorldId(null);
    setLegacyJob(null);
    setLoading(false);
    setError('');
    const url = new URL(location.href);
    for (const key of ['world', 'job', 'room']) url.searchParams.delete(key);
    history.replaceState(null, '', url);
  };

  if (loading || error) return <main className="capture-entry capture-loading" role={error ? 'alert' : 'status'}>
    <div className="capture-card">
      {!error && <div className="capture-spinner" aria-hidden="true" />}
      <p className="capture-kicker">doodleforge</p>
      <h1>{error ? 'Unable to build the world.' : 'Uploading your capture…'}</h1>
      <p className="capture-copy">{error || 'Uploading your capture and starting a real World Labs generation — the room will build in the background.'}</p>
      {error && <>
        <button className="entry-secondary" onClick={newWorld}>Back</button>
      </>}
    </div>
  </main>;

  if (worldId) return <WorldApp key={worldId} initialWorldId={worldId} onNewWorld={newWorld} />;
  return <>
    <CaptureEntry onCreate={(file, model) => void createFromCapture(file, model)} />
    <ExistingWorlds worlds={worlds} onSelect={openWorld} onDelete={(id) => { void deleteWorld({ id: id as Id<'worlds'> }).catch((e) => setError(e instanceof Error ? e.message : 'Could not delete this room.')); }} corner="bottom-right" />
  </>;
}
