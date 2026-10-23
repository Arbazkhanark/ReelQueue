// // apps/web/src/app/\(app\)/storage/page.tsx
// 'use client';

// import { useEffect, useRef, useState } from 'react';
// import type { ChangeEvent } from 'react';
// import type { DriveFileDto } from '@reelqueue/shared';
// import { API_ORIGIN, call, errorMessage } from '@/lib/api';
// import { invalidate, useApi } from '@/lib/use-api';
// import { formatBytes, formatDateTime } from '@/lib/format';
// import { xhrPut } from '@/lib/xhr-upload';
// import { driveRedirectNotice, driveViewState, uploadPercent, validateDriveUpload } from '@/lib/drive-ui';
// import type { UploadPhase } from '@/lib/drive-ui';
// import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Notice, PageHeader, ProgressBar, SkeletonBlock } from '@/components/ui';
// import { useToast } from '@/components/toast';

// /**
//  * Google Drive is an ADDITIONAL storage integration. Videos that ReelQueue publishes to Instagram still go through the existing
//  * object storage (S3-compatible); nothing here changes that. Tokens never reach the browser: uploads go straight to a
//  * short-lived Google resumable-upload URL created by the API.
//  */
// export default function StoragePage() {
//   const status = useApi('googleDriveStatus');
//   const view = driveViewState({ data: status.data, error: status.error, loading: !status.data && !status.error });
//   const connected = view === 'CONNECTED';
//   const files = useApi('listDriveFiles', { query: { pageSize: 25 }, enabled: connected });
//   const toast = useToast();
//   const [extra, setExtra] = useState<DriveFileDto[]>([]);
//   const [next, setNext] = useState<string | null>(null);
//   const [loadingMore, setLoadingMore] = useState(false);
//   const [busy, setBusy] = useState<string | null>(null);
//   const [confirmDisconnect, setConfirmDisconnect] = useState(false);
//   const [confirmDelete, setConfirmDelete] = useState<DriveFileDto | null>(null);
//   const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
//   const abort = useRef<AbortController | null>(null);
//   const [notice, setNotice] = useState<ReturnType<typeof driveRedirectNotice>>(null);

//   useEffect(() => { // outcome of the Google redirect (?connected=1 / ?error=CODE); the query is then removed from the URL
//     const n = driveRedirectNotice(window.location.search);
//     if (n) { setNotice(n); window.history.replaceState(null, '', window.location.pathname); invalidate('googleDriveStatus'); }
//   }, []);
//   useEffect(() => { setExtra([]); setNext(files.data?.nextPageToken ?? null); }, [files.data]);
//   useEffect(() => () => abort.current?.abort(), []);

//   async function connect() {
//     setBusy('connect');
//     try { const r = await call('connectGoogleDrive'); window.location.assign(r.authorizationUrl); }
//     catch (x) { toast.fail(x); setBusy(null); }
//   }
//   async function disconnect() {
//     setBusy('disconnect');
//     try { await call('disconnectGoogleDrive'); invalidate('googleDriveStatus', 'listDriveFiles'); toast.success('Google Drive disconnected.'); }
//     catch (x) { toast.error(errorMessage(x)); } finally { setBusy(null); setConfirmDisconnect(false); }
//   }
//   async function loadMore() {
//     if (!next) return;
//     setLoadingMore(true);
//     try { const r = await call('listDriveFiles', { query: { pageSize: 25, pageToken: next } }); setExtra((e) => [...e, ...r.files]); setNext(r.nextPageToken); }
//     catch (x) { toast.error(errorMessage(x)); } finally { setLoadingMore(false); }
//   }
//   async function remove(f: DriveFileDto) {
//     setBusy(f.id);
//     try { await call('deleteDriveFile', { params: { id: f.id } }); invalidate('listDriveFiles'); toast.success('File deleted from Google Drive.'); }
//     catch (x) { toast.error(errorMessage(x)); } finally { setBusy(null); setConfirmDelete(null); }
//   }
//   async function onPick(e: ChangeEvent<HTMLInputElement>) {
//     const f = e.target.files?.[0]; e.target.value = '';
//     if (!f) return;
//     const bad = validateDriveUpload(f);
//     if (bad) { setPhase({ kind: 'failed', name: f.name, message: bad }); return; }
//     const ctl = new AbortController(); abort.current = ctl;
//     setPhase({ kind: 'uploading', name: f.name, percent: 0 });
//     try {
//       const s = await call('startDriveUpload', { body: { filename: f.name, contentType: f.type, sizeBytes: f.size } });
//       await xhrPut(s.sessionUri, { 'Content-Type': f.type }, f, (loaded) => setPhase({ kind: 'uploading', name: f.name, percent: uploadPercent(loaded, f.size) }), ctl.signal);
//       setPhase({ kind: 'done', name: f.name }); invalidate('listDriveFiles');
//     } catch (x) { setPhase({ kind: 'failed', name: f.name, message: ctl.signal.aborted ? 'Upload cancelled.' : errorMessage(x) }); }
//   }

//   const all = [...(files.data?.files ?? []), ...extra];
//   return (
//     <>
//       <PageHeader title="Storage" description="Optional Google Drive integration. Your videos for Instagram publishing keep using ReelQueue’s main storage; Drive is a separate place to keep copies." />
//       {notice ? <div className="mb-4"><Notice tone={notice.tone}>{notice.text}</Notice></div> : null}

//       {view === 'LOADING' ? <SkeletonBlock label="Loading Google Drive status" /> : null}
//       {view === 'ERROR' ? <ErrorState error={status.error} onRetry={() => void status.reload()} /> : null}
//       {view === 'DISABLED' ? <EmptyState title="Google Drive is not enabled on this server">The administrator has not configured Google Drive. Everything else keeps working.</EmptyState> : null}

//       {view === 'DISCONNECTED' || view === 'REAUTH_REQUIRED' ? (
//         <Card title="Google Drive">
//           {view === 'REAUTH_REQUIRED' ? <Notice tone="warn" title="Reconnect needed">Google no longer accepts the saved permission. Connect again to continue.</Notice> : <p className="mb-3 text-sm text-muted">Connect Google Drive to keep videos in a “ReelQueue” folder in your own Drive.</p>}
//           <p className="mb-3 text-sm text-muted">ReelQueue asks only for access to files it creates itself (the <code>drive.file</code> permission). It cannot see the rest of your Drive.</p>
//           <Button variant="primary" loading={busy === 'connect'} onClick={() => void connect()}>{view === 'REAUTH_REQUIRED' ? 'Reconnect Google Drive' : 'Connect Google Drive'}</Button>
//         </Card>
//       ) : null}

//       {connected ? (
//         <>
//           <Card title="Google Drive" className="mb-4" actions={<Badge tone="ok">Connected</Badge>}>
//             <p className="text-sm text-muted">Connected {formatDateTime(status.data?.connectedAt)}. Only files created by ReelQueue are shown.</p>
//             <div className="mt-3 flex flex-wrap items-center gap-2">
//               <label className="inline-flex cursor-pointer items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-sunken focus-within:ring-2">
//                 <span>Upload video to Drive</span>
//                 <input type="file" accept="video/mp4,video/quicktime" className="sr-only" onChange={(e) => void onPick(e)} disabled={phase.kind === 'uploading'} />
//               </label>
//               {phase.kind === 'uploading' ? <Button small onClick={() => abort.current?.abort()}>Cancel</Button> : null}
//               <Button small variant="danger" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
//             </div>
//             <div className="mt-3" aria-live="polite">
//               {phase.kind === 'uploading' ? <ProgressBar value={phase.percent} label={`Uploading ${phase.name}`} /> : null}
//               {phase.kind === 'done' ? <Notice tone="ok">{phase.name} was uploaded to Google Drive.</Notice> : null}
//               {phase.kind === 'failed' ? <Notice tone="danger" title="Upload failed">{phase.message}</Notice> : null}
//             </div>
//           </Card>

//           {files.error && !files.data ? <ErrorState error={files.error} onRetry={() => void files.reload()} /> : !files.data ? <SkeletonBlock label="Loading files" /> : all.length === 0 ? <EmptyState title="No files yet">Files you upload here appear in this list.</EmptyState> : (
//             <>
//               <div className="overflow-x-auto rounded-lg border border-line">
//                 <table className="w-full text-left text-sm">
//                   <caption className="sr-only">Files in your ReelQueue folder on Google Drive</caption>
//                   <thead className="bg-sunken text-xs uppercase text-muted"><tr><th scope="col" className="px-3 py-2">Name</th><th scope="col" className="px-3 py-2">Type</th><th scope="col" className="px-3 py-2">Size</th><th scope="col" className="px-3 py-2">Modified</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
//                   <tbody>
//                     {all.map((f) => (
//                       <tr key={f.id} className="border-t border-line">
//                         <td className="px-3 py-2 font-medium break-all">{f.name}</td>
//                         <td className="px-3 py-2">{f.isFolder ? 'Folder' : f.mimeType}</td>
//                         <td className="px-3 py-2">{f.sizeBytes === null ? '—' : formatBytes(f.sizeBytes)}</td>
//                         <td className="px-3 py-2">{f.modifiedTime ? formatDateTime(f.modifiedTime) : '—'}</td>
//                         <td className="px-3 py-2 text-right whitespace-nowrap">
//                           {f.isFolder ? null : <a className="mr-2 underline" href={`${API_ORIGIN}/v1/google-drive/files/${encodeURIComponent(f.id)}/content`} download>Download</a>}
//                           {f.managedByReelQueue ? <Button small variant="danger" loading={busy === f.id} onClick={() => setConfirmDelete(f)}>Delete</Button> : null}
//                         </td>
//                       </tr>
//                     ))}
//                   </tbody>
//                 </table>
//               </div>
//               {next ? <div className="mt-3 text-center"><Button loading={loadingMore} onClick={() => void loadMore()}>Load more</Button></div> : null}
//             </>
//           )}
//         </>
//       ) : null}

//       <ConfirmDialog open={confirmDisconnect} title="Disconnect Google Drive?" confirmLabel="Disconnect" pending={busy === 'disconnect'} onConfirm={() => void disconnect()} onClose={() => setConfirmDisconnect(false)}>
//         ReelQueue forgets its access to your Drive and asks Google to revoke it. Files already in your Drive are not deleted.
//       </ConfirmDialog>
//       <ConfirmDialog open={confirmDelete !== null} title="Delete this file from Google Drive?" confirmLabel="Delete" pending={confirmDelete !== null && busy === confirmDelete.id} onConfirm={() => { if (confirmDelete) void remove(confirmDelete); }} onClose={() => setConfirmDelete(null)}>
//         {confirmDelete?.name} will be removed from your Google Drive.
//       </ConfirmDialog>
//     </>
//   );
// }

















// apps/web/src/app/\(app\)/storage/page.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { DriveFileDto } from '@reelqueue/shared';
import { API_ORIGIN, call, errorMessage } from '@/lib/api';
import { invalidate, useApi } from '@/lib/use-api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { driveRedirectNotice, driveViewState, uploadPercent, validateDriveUpload } from '@/lib/drive-ui';
import type { UploadPhase } from '@/lib/drive-ui';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Notice, PageHeader, ProgressBar, SkeletonBlock } from '@/components/ui';
import { useToast } from '@/components/toast';

/**
 * Google Drive is an ADDITIONAL storage integration. Videos that ReelQueue publishes to Instagram still go through the existing
 * object storage (S3-compatible); nothing here changes that. Tokens never reach the browser: uploads go straight to a
 * authenticated ReelQueue API; the browser never sees Google's resumable-upload URL.
 */
export default function StoragePage() {
  const status = useApi('googleDriveStatus');
  const view = driveViewState({ data: status.data, error: status.error, loading: !status.data && !status.error });
  const connected = view === 'CONNECTED';
  const files = useApi('listDriveFiles', { query: { pageSize: 25 }, enabled: connected });
  const toast = useToast();
  const [extra, setExtra] = useState<DriveFileDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DriveFileDto | null>(null);
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState<ReturnType<typeof driveRedirectNotice>>(null);

  useEffect(() => { // outcome of the Google redirect (?connected=1 / ?error=CODE); the query is then removed from the URL
    const n = driveRedirectNotice(window.location.search);
    if (n) { setNotice(n); window.history.replaceState(null, '', window.location.pathname); invalidate('googleDriveStatus'); }
  }, []);
  useEffect(() => { setExtra([]); setNext(files.data?.nextPageToken ?? null); }, [files.data]);
  useEffect(() => () => abort.current?.abort(), []);

  async function connect() {
    setBusy('connect');
    try { const r = await call('connectGoogleDrive'); window.location.assign(r.authorizationUrl); }
    catch (x) { toast.fail(x); setBusy(null); }
  }
  async function disconnect() {
    setBusy('disconnect');
    try { await call('disconnectGoogleDrive'); invalidate('googleDriveStatus', 'listDriveFiles'); toast.success('Google Drive disconnected.'); }
    catch (x) { toast.error(errorMessage(x)); } finally { setBusy(null); setConfirmDisconnect(false); }
  }
  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try { const r = await call('listDriveFiles', { query: { pageSize: 25, pageToken: next } }); setExtra((e) => [...e, ...r.files]); setNext(r.nextPageToken); }
    catch (x) { toast.error(errorMessage(x)); } finally { setLoadingMore(false); }
  }
  async function remove(f: DriveFileDto) {
    setBusy(f.id);
    try { await call('deleteDriveFile', { params: { id: f.id } }); invalidate('listDriveFiles'); toast.success('File deleted from Google Drive.'); }
    catch (x) { toast.error(errorMessage(x)); } finally { setBusy(null); setConfirmDelete(null); }
  }
  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const bad = validateDriveUpload(f);
    if (bad) { setPhase({ kind: 'failed', name: f.name, message: bad }); return; }
    const ctl = new AbortController(); abort.current = ctl;
    setPhase({ kind: 'uploading', name: f.name, percent: 0 });

    try {
      // CHANGED: POST bytes to our authenticated API; never PUT directly to Google's cross-origin URL.
      // XHR is used here to preserve upload progress and cancellation support.
      const url = new URL('/v1/google-drive/uploads', API_ORIGIN);
      url.searchParams.set('filename', f.name);
      url.searchParams.set('contentType', f.type || 'application/octet-stream');

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const onAbort = () => xhr.abort();
        ctl.signal.addEventListener('abort', onAbort, { once: true });
        xhr.open('POST', url.toString());
        xhr.withCredentials = true; // NEW: send the existing secure session cookie to the API.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setPhase({ kind: 'uploading', name: f.name, percent: uploadPercent(event.loaded, f.size) });
          }
        };
        xhr.onerror = () => reject(new Error('Network error while uploading to ReelQueue API.'));
        xhr.onabort = () => reject(new Error('Upload cancelled.'));
        xhr.onload = () => {
          ctl.signal.removeEventListener('abort', onAbort);
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            try {
              const parsed = JSON.parse(xhr.responseText) as { error?: { message?: string } };
              reject(new Error(parsed.error?.message || `Upload failed (HTTP ${xhr.status}).`));
            } catch {
              reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
            }
          }
        };
        xhr.send(f);
      });
      setPhase({ kind: 'done', name: f.name });
      invalidate('listDriveFiles');
    } catch (x) {
      setPhase({ kind: 'failed', name: f.name, message: ctl.signal.aborted ? 'Upload cancelled.' : errorMessage(x) });
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  }

  const all = [...(files.data?.files ?? []), ...extra];
  return (
    <>
      <PageHeader title="Storage" description="Optional Google Drive integration. Your videos for Instagram publishing keep using ReelQueue’s main storage; Drive is a separate place to keep copies." />
      {notice ? <div className="mb-4"><Notice tone={notice.tone}>{notice.text}</Notice></div> : null}

      {view === 'LOADING' ? <SkeletonBlock label="Loading Google Drive status" /> : null}
      {view === 'ERROR' ? <ErrorState error={status.error} onRetry={() => void status.reload()} /> : null}
      {view === 'DISABLED' ? <EmptyState title="Google Drive is not enabled on this server">The administrator has not configured Google Drive. Everything else keeps working.</EmptyState> : null}

      {view === 'DISCONNECTED' || view === 'REAUTH_REQUIRED' ? (
        <Card title="Google Drive">
          {view === 'REAUTH_REQUIRED' ? <Notice tone="warn" title="Reconnect needed">Google no longer accepts the saved permission. Connect again to continue.</Notice> : <p className="mb-3 text-sm text-muted">Connect Google Drive to keep videos in a “ReelQueue” folder in your own Drive.</p>}
          <p className="mb-3 text-sm text-muted">ReelQueue asks only for access to files it creates itself (the <code>drive.file</code> permission). It cannot see the rest of your Drive.</p>
          <Button variant="primary" loading={busy === 'connect'} onClick={() => void connect()}>{view === 'REAUTH_REQUIRED' ? 'Reconnect Google Drive' : 'Connect Google Drive'}</Button>
        </Card>
      ) : null}

      {connected ? (
        <>
          <Card title="Google Drive" className="mb-4" actions={<Badge tone="ok">Connected</Badge>}>
            <p className="text-sm text-muted">Connected {formatDateTime(status.data?.connectedAt)}. Only files created by ReelQueue are shown.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-sunken focus-within:ring-2">
                <span>Upload video to Drive</span>
                <input type="file" accept="video/mp4,video/quicktime" className="sr-only" onChange={(e) => void onPick(e)} disabled={phase.kind === 'uploading'} />
              </label>
              {phase.kind === 'uploading' ? <Button small onClick={() => abort.current?.abort()}>Cancel</Button> : null}
              <Button small variant="danger" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
            </div>
            <div className="mt-3" aria-live="polite">
              {phase.kind === 'uploading' ? <ProgressBar value={phase.percent} label={`Uploading ${phase.name}`} /> : null}
              {phase.kind === 'done' ? <Notice tone="ok">{phase.name} was uploaded to Google Drive.</Notice> : null}
              {phase.kind === 'failed' ? <Notice tone="danger" title="Upload failed">{phase.message}</Notice> : null}
            </div>
          </Card>

          {files.error && !files.data ? <ErrorState error={files.error} onRetry={() => void files.reload()} /> : !files.data ? <SkeletonBlock label="Loading files" /> : all.length === 0 ? <EmptyState title="No files yet">Files you upload here appear in this list.</EmptyState> : (
            <>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Files in your ReelQueue folder on Google Drive</caption>
                  <thead className="bg-sunken text-xs uppercase text-muted"><tr><th scope="col" className="px-3 py-2">Name</th><th scope="col" className="px-3 py-2">Type</th><th scope="col" className="px-3 py-2">Size</th><th scope="col" className="px-3 py-2">Modified</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {all.map((f) => (
                      <tr key={f.id} className="border-t border-line">
                        <td className="px-3 py-2 font-medium break-all">{f.name}</td>
                        <td className="px-3 py-2">{f.isFolder ? 'Folder' : f.mimeType}</td>
                        <td className="px-3 py-2">{f.sizeBytes === null ? '—' : formatBytes(f.sizeBytes)}</td>
                        <td className="px-3 py-2">{f.modifiedTime ? formatDateTime(f.modifiedTime) : '—'}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {f.isFolder ? null : <a className="mr-2 underline" href={`${API_ORIGIN}/v1/google-drive/files/${encodeURIComponent(f.id)}/content`} download>Download</a>}
                          {f.managedByReelQueue ? <Button small variant="danger" loading={busy === f.id} onClick={() => setConfirmDelete(f)}>Delete</Button> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {next ? <div className="mt-3 text-center"><Button loading={loadingMore} onClick={() => void loadMore()}>Load more</Button></div> : null}
            </>
          )}
        </>
      ) : null}

      <ConfirmDialog open={confirmDisconnect} title="Disconnect Google Drive?" confirmLabel="Disconnect" pending={busy === 'disconnect'} onConfirm={() => void disconnect()} onClose={() => setConfirmDisconnect(false)}>
        ReelQueue forgets its access to your Drive and asks Google to revoke it. Files already in your Drive are not deleted.
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete !== null} title="Delete this file from Google Drive?" confirmLabel="Delete" pending={confirmDelete !== null && busy === confirmDelete.id} onConfirm={() => { if (confirmDelete) void remove(confirmDelete); }} onClose={() => setConfirmDelete(null)}>
        {confirmDelete?.name} will be removed from your Google Drive.
      </ConfirmDialog>
    </>
  );
}