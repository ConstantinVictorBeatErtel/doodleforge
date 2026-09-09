import { useEffect, useRef, useState } from 'react';

export type CaptureModel = 'marble-1.0-draft' | 'marble-1.1';

export function CaptureEntry({ onCreate }: { onCreate: (file: File, model: CaptureModel) => void }) {
  const [model, setModel] = useState<CaptureModel>('marble-1.0-draft');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const isZip = file?.name.toLowerCase().endsWith('.zip') ?? false;

  useEffect(() => {
    if (!file || isZip) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isZip]);

  const choose = (next: File | undefined) => {
    if (!next) return;
    const version = ++selection.current;
    setError('');
    setFile(null);
    const zip = next.name.toLowerCase().endsWith('.zip');
    if (zip) { setFile(next); return; }
    const image = ['image/jpeg', 'image/png', 'image/webp'].includes(next.type);
    const video = ['video/mp4', 'video/quicktime', 'video/webm'].includes(next.type);
    const max = video ? 100 : 20;
    if (!image && !video) return setError('Choose a JPG, PNG, WebP, MP4, MOV, WebM, or ZIP file.');
    if (!next.size) return setError('This file is empty. Choose another capture.');
    if (next.size > max * 1024 * 1024) return setError(`${video ? 'Videos' : 'Images'} must be ${max} MB or smaller.`);
    if (video) {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        URL.revokeObjectURL(probe.src);
        if (version !== selection.current) return;
        if (!Number.isFinite(probe.duration) || probe.duration > 30) setError('Videos must be 30 seconds or shorter.');
        else setFile(next);
      };
      probe.onerror = () => {
        URL.revokeObjectURL(probe.src);
        if (version === selection.current) setError('This video could not be read.');
      };
      probe.src = URL.createObjectURL(next);
      return;
    }
    setFile(next);
  };

  return <main className="capture-entry">
    <div className="capture-card">
      <div className="capture-mark">◎</div>
      <p className="capture-kicker">doodleforge</p>
      <h1>Step inside your space.</h1>
      <p className="capture-copy">Start with a photo, a short video, or a world ZIP.</p>
      <input ref={inputRef} className="capture-input" type="file" aria-label="Choose a capture" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.zip,application/zip,application/x-zip-compressed" onChange={(e) => choose(e.target.files?.[0])} />
      <input ref={photoRef} className="capture-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => choose(e.target.files?.[0])} />
      <input ref={videoRef} className="capture-input" type="file" accept="video/mp4,video/quicktime,video/webm" capture="environment" onChange={(e) => choose(e.target.files?.[0])} />
      <input ref={zipRef} className="capture-input" type="file" aria-label="Upload ZIP" accept=".zip,application/zip,application/x-zip-compressed" onChange={(e) => choose(e.target.files?.[0])} />
      {file ? <div className="capture-preview">
        {isZip ? <div className="capture-zip"><span aria-hidden="true">▤</span><span>World ZIP selected</span></div> : previewUrl && (file.type.startsWith('video/') ? <video src={previewUrl} controls /> : <img src={previewUrl} alt="Selected capture" />)}
        <div><strong>{file.name}</strong><button type="button" onClick={() => {
          ++selection.current;
          setFile(null);
          setError('');
          for (const ref of [inputRef, photoRef, videoRef, zipRef]) if (ref.current) ref.current.value = '';
        }}>Replace</button></div>
      </div> : <button type="button" className="capture-drop" onClick={() => inputRef.current?.click()}>
        <span className="capture-drop-icon">＋</span><strong>Choose a capture</strong><small>Photo, video, or ZIP</small>
      </button>}
      {!file && <div className="capture-actions"><button type="button" onClick={() => photoRef.current?.click()}>Take photo</button><button type="button" onClick={() => videoRef.current?.click()}>Record video</button><button type="button" onClick={() => zipRef.current?.click()}>Upload ZIP</button></div>}
      {!isZip && <div className="capture-quality">
        <label htmlFor="world-quality">Creation quality</label>
        <select id="world-quality" value={model} onChange={e => setModel(e.target.value as CaptureModel)}>
          <option value="marble-1.0-draft">Fast preview</option>
          <option value="marble-1.1">Higher detail</option>
        </select>
        <p>{model === 'marble-1.0-draft'
          ? 'A quick, explorable room. Photos are fastest; videos add more views and preparation time.'
          : 'A more detailed room with Marble 1.1. Allow several minutes and more generation credits.'}</p>
        <small>{model === 'marble-1.0-draft'
          ? 'Draft generation is about 20 seconds after preparation; video preparation can take about 2 minutes. Upload and queue time vary.'
          : 'World generation is about 5 minutes, plus preparation, upload, and queue time.'}</small>
      </div>}
      {error && <p className="capture-error" role="alert">{error}</p>}
      <button type="button" className="capture-create" disabled={!file} onClick={() => file && onCreate(file, model)}>Create my world</button>
      <p className="capture-footnote">A photo or video builds your own World Labs room; a ZIP imports a world you already generated.</p>
    </div>
  </main>;
}
