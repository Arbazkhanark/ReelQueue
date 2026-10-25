// apps/web/src/app/\(app\)/uploads/page.tsx
'use client';

import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { call, errorMessage } from '@/lib/api';
import { invalidate, useApi } from '@/lib/use-api';
import { createUploadSession } from '@/lib/upload-runner';
import type { UploadSession } from '@/lib/upload-runner';
import { failedVideoIds, itemProgress, overallProgress, uploadedVideoIds } from '@/lib/upload-queue';
import type { UploadState } from '@/lib/upload-queue';
import { xhrPut } from '@/lib/xhr-upload';
import { guessContentType } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import type { CompleteUploadResponse, InitUploadResponse } from '@reelqueue/shared';
import { Button, Card, Notice, PageHeader, ProgressBar } from '@/components/ui';
import { VideoStatusBadge } from '@/components/status';
import { useToast } from '@/components/toast';

type Phase = 'idle' | 'initializing' | 'uploading' | 'needs-attention' | 'completing' | 'done';

export default function UploadsPage() {
  const toast = useToast();
  const storage = useApi('storage');
  const input = useRef<HTMLInputElement>(null);
  const files = useRef<File[]>([]);
  const init = useRef<InitUploadResponse | null>(null);
  const session = useRef<UploadSession | null>(null);
  const [state, setState] = useState<UploadState>({ concurrency: 4, items: [] });
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<CompleteUploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === 'initializing' || phase === 'uploading' || phase === 'completing';
  const progress = useMemo(() => overallProgress(state), [state]);

  async function finish(): Promise<void> {
    const ini = init.current; const s = session.current;
    if (!ini || !s) return;
    setPhase('completing');
    try {
      const st = s.getState();
      const r = await call('completeUpload', { params: { batchId: ini.batchId }, body: { uploaded: uploadedVideoIds(st), failed: failedVideoIds(st) } });
      setResult(r); setPhase('done'); invalidate('listVideos', 'storage', 'dashboard');
    } catch (e) { setError(errorMessage(e)); setPhase('needs-attention'); }
  }

  async function begin(picked: File[]): Promise<void> {
    if (picked.length === 0) return;
    files.current = picked; setResult(null); setError(null); setPhase('initializing');
    try {
      const specs = picked.map((f) => ({ filename: f.name, contentType: guessContentType(f.name, f.type), sizeBytes: f.size }));
      const ini = await call('initUpload', { body: { files: specs } });
      init.current = ini;
      const byIndex = new Map(ini.targets.map((t) => [t.index, t]));
      const s = createUploadSession(async (item, signal, onProgress) => {
        const t = byIndex.get(item.index); const f = files.current[item.index];
        if (!t || !f) throw new Error('Missing upload target');
        await xhrPut(t.uploadUrl, t.headers, f, onProgress, signal);
      }, setState);
      session.current = s;
      s.init({ type: 'INIT', files: picked.map((f, index) => ({ index, filename: f.name, sizeBytes: f.size })), targets: ini.targets.map((t) => ({ index: t.index, videoId: t.videoId })), rejected: ini.rejected.map((r) => ({ index: r.index, code: r.code, message: r.message })) });
      setPhase('uploading');
      await s.start();
      if (failedVideoIds(s.getState()).length > 0) setPhase('needs-attention'); else await finish();
    } catch (e) { setError(errorMessage(e)); setPhase('idle'); toast.fail(e); }
  }

  async function retry(): Promise<void> {
    const s = session.current; if (!s) return;
    setPhase('uploading');
    await s.retryAll();
    if (failedVideoIds(s.getState()).length > 0) setPhase('needs-attention'); else await finish();
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => { const l = Array.from(e.target.files ?? []); e.target.value = ''; void begin(l); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); if (!busy) void begin(Array.from(e.dataTransfer.files)); };

  return (
    <>
      <PageHeader title="Upload videos" description="Files go straight to storage from your browser. Each one is checked (size, type, duration, resolution) before it becomes ready." />
      {storage.data?.level === 'FULL' ? <div className="mb-4"><Notice tone="danger">Storage is full. Delete videos before uploading more.</Notice></div> : null}
      <div onDragOver={(e) => e.preventDefault()} onDrop={onDrop} className="card flex flex-col items-center gap-3 border-dashed p-8 text-center">
        <p className="text-sm text-muted">Drop MP4 or MOV files here{storage.data ? ` · ${formatBytes(Math.max(0, storage.data.quotaBytes - storage.data.bytesUsed - storage.data.bytesReserved))} free` : ''}</p>
        <input ref={input} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple className="sr-only" onChange={onPick} aria-label="Choose video files" />
        <Button variant="primary" disabled={busy || storage.data?.level === 'FULL'} onClick={() => input.current?.click()}>Choose files</Button>
      </div>
      {error ? <div className="mt-4"><Notice tone="danger">{error}</Notice></div> : null}
      {state.items.length > 0 ? (
        <Card title="This batch" className="mt-4">
          <ProgressBar value={progress} label="Overall upload progress" />
          <ul className="mt-3 divide-y divide-line text-sm">
            {state.items.map((it) => (
              <li key={it.index} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-all">{it.filename} <span className="text-muted">({formatBytes(it.sizeBytes)})</span></span>
                <span className="flex items-center gap-2">
                  {it.status === 'uploading' ? <span className="w-24"><ProgressBar value={itemProgress(it)} label={`Uploading ${it.filename}`} /></span> : null}
                  <span className={it.status === 'failed' || it.status === 'rejected' ? 'text-danger' : 'text-muted'}>{it.status}{it.error ? `: ${it.error}` : ''}</span>
                </span>
              </li>
            ))}
          </ul>
          {phase === 'needs-attention' ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Notice tone="warn">Some files did not upload.</Notice>
              <Button onClick={() => void retry()}>Retry failed</Button>
              <Button variant="danger" onClick={() => void finish()}>Finish and discard failed</Button>
            </div>
          ) : null}
          {phase === 'completing' ? <p className="mt-3 text-sm text-muted">Checking files…</p> : null}
        </Card>
      ) : null}
      {result ? (
        <Card title="Result" className="mt-4">
          <ul className="divide-y divide-line text-sm">
            {result.videos.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="break-all">{v.filename}</span>
                <span className="flex items-center gap-2"><VideoStatusBadge status={v.status} />{v.rejectionReason ? <span className="text-xs text-danger">{v.rejectionReason}</span> : null}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
