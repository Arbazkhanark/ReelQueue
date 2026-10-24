// apps/web/src/app/(app)/videos/page.tsx  
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { call, errorMessage } from '@/lib/api';
import { invalidate, useApi } from '@/lib/use-api';
import { formatBytes, formatDuration } from '@/lib/format';
import { applyDraft, moveTo, reverseIds, shuffleIds, sortDrive, sortIds, SORT_LABELS, type DriveSortKey, type SortDir, type SortKey } from '@/lib/video-order';
import type { DriveFileDto, VideoDto } from '@reelqueue/shared';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Modal, Notice, PageHeader, SkeletonBlock, TextField } from '@/components/ui';
import { VideoStatusBadge } from '@/components/status';
import { useToast } from '@/components/toast';

const PAGE_SIZE = 100;
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime']);
const selectCls = 'rounded border border-line bg-transparent px-2 py-1 text-sm';

export default function VideosPage() {
  const q = useApi('listVideos', { query: { page: 1, pageSize: PAGE_SIZE } });
  const cycle = useApi('currentCycle');
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string; caption: string } | null>(null);
  const [del, setDel] = useState<VideoDto | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDrive, setShowDrive] = useState(false);
  // Unsaved publishing order (ids of READY videos). null = what the server has.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const live = cycle.data && (cycle.data.status === 'ACTIVE' || cycle.data.status === 'PAUSED');
  const items = q.data?.items ?? [];
  const ready = applyDraft(items.filter((v) => v.status === 'READY'), draft);
  const others = items.filter((v) => v.status !== 'READY');
  const shown = [...ready, ...others];
  const canReorder = !live && (q.data?.total ?? 0) <= PAGE_SIZE;
  const dirty = draft !== null;
  const ids = ready.map((v) => v.id);

  const sortNow = () => setDraft(sortIds(ready, sortKey, sortDir));
  const shuffleNow = () => setDraft(shuffleIds(ids));
  const reverseNow = () => setDraft(reverseIds(ids));
  const moveVideo = (v: VideoDto, to: number) => setDraft(moveTo(ids, ids.indexOf(v.id), to));

  async function saveOrder() {
    if (!dirty) return;
    setBusy(true);
    try { await call('reorderVideos', { body: { videoIds: ids } }); setDraft(null); invalidate('listVideos'); toast.success('Publishing order saved.'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function saveCaption() {
    if (!editing) return; setBusy(true);
    try { await call('updateVideo', { params: { id: editing.id }, body: { caption: editing.caption.trim() === '' ? null : editing.caption } }); setEditing(null); invalidate('listVideos'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!del) return; setBusy(true);
    try { await call('deleteVideo', { params: { id: del.id } }); setDel(null); invalidate('listVideos', 'storage', 'dashboard'); toast.success('Video deleted.'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function show(v: VideoDto) {
    try { const p = await call('videoPreview', { params: { id: v.id } }); setPreview({ name: v.filename, url: p.url }); }
    catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <>
      <PageHeader title="Videos" description="Ready videos publish in the order shown here (1 first)." />
      <div className="mb-4">
        <Button variant="primary" onClick={() => setShowDrive((x) => !x)}>{showDrive ? 'Close Google Drive' : 'Import from Google Drive'}</Button>
      </div>
      {live ? <div className="mb-4"><Notice tone="info">The order is locked while a cycle is running or paused.</Notice></div> : null}
      {(q.data?.total ?? 0) > PAGE_SIZE ? <div className="mb-4"><Notice tone="warn">Reordering is available for up to {PAGE_SIZE} videos in this version.</Notice></div> : null}

      {showDrive ? <DriveImport videos={items} onImported={() => setDraft(null)} /> : null}

      {ready.length > 1 ? (
        <Card>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Sort publishing order by</span>
              <select className={selectCls} value={sortKey} disabled={!canReorder || busy} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Direction</span>
              <select className={selectCls} value={sortDir} disabled={!canReorder || busy} onChange={(e) => setSortDir(e.target.value as SortDir)}>
                <option value="asc">{sortKey === 'size' ? 'Smallest first' : sortKey === 'uploaded' ? 'Oldest first' : sortKey === 'duration' ? 'Shortest first' : 'A → Z'}</option>
                <option value="desc">{sortKey === 'size' ? 'Largest first' : sortKey === 'uploaded' ? 'Newest first' : sortKey === 'duration' ? 'Longest first' : 'Z → A'}</option>
              </select>
            </label>
            <Button small disabled={!canReorder || busy} onClick={sortNow}>Apply sort</Button>
            <Button small disabled={!canReorder || busy} onClick={shuffleNow}>Shuffle</Button>
            <Button small disabled={!canReorder || busy} onClick={reverseNow}>Reverse</Button>
            <span className="grow" />
            {dirty ? (
              <>
                <Button small disabled={busy} onClick={() => setDraft(null)}>Discard</Button>
                <Button small variant="primary" loading={busy} onClick={() => void saveOrder()}>Save order</Button>
              </>
            ) : null}
          </div>
          {dirty ? <p className="mt-2 text-xs text-muted">Unsaved order. Nothing changes for publishing until you press “Save order”.</p> : <p className="mt-2 text-xs text-muted">Use the sort/shuffle controls or the ⤒ ↑ ↓ ⤓ buttons on each row, then save.</p>}
        </Card>
      ) : null}

      <div className="mt-4">
        {q.error && !q.data ? <ErrorState error={q.error} onRetry={() => void q.reload()} /> : !q.data ? <SkeletonBlock /> : items.length === 0 ? (
          <EmptyState title="No videos yet">Use “Import from Google Drive” above, or upload on the Upload page.</EmptyState>
        ) : (
          <Card>
            <ul className="divide-y divide-line text-sm">
              {shown.map((v) => {
                const idx = ids.indexOf(v.id);
                return (
                  <li key={v.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                    <div className="min-w-0">
                      <p className="break-all font-medium">{v.status === 'READY' ? `${idx + 1}. ` : ''}{v.filename}</p>
                      <p className="text-xs text-muted">{formatBytes(v.sizeBytes)} · {formatDuration(v.durationMs)}{v.width && v.height ? ` · ${v.width}×${v.height}` : ''} · added {new Date(v.createdAt).toLocaleString()} · published {v.publishedCount}×{v.inUse ? ' · queued in a cycle' : ''}</p>
                      {v.caption ? <p className="mt-1 whitespace-pre-wrap text-xs">{v.caption}</p> : null}
                      {v.rejectionReason ? <p className="mt-1 text-xs text-danger">{v.rejectionReason}</p> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <VideoStatusBadge status={v.status} />
                      {v.status === 'READY' ? (
                        <>
                          <Button small disabled={!canReorder || busy || idx === 0} aria-label="Move to top" onClick={() => moveVideo(v, 0)}>⤒</Button>
                          <Button small disabled={!canReorder || busy || idx === 0} aria-label="Move up" onClick={() => moveVideo(v, idx - 1)}>↑</Button>
                          <Button small disabled={!canReorder || busy || idx === ready.length - 1} aria-label="Move down" onClick={() => moveVideo(v, idx + 1)}>↓</Button>
                          <Button small disabled={!canReorder || busy || idx === ready.length - 1} aria-label="Move to bottom" onClick={() => moveVideo(v, ready.length - 1)}>⤓</Button>
                          <Button small onClick={() => void show(v)}>Preview</Button>
                          <Button small onClick={() => setEditing({ id: v.id, caption: v.caption ?? '' })}>Caption</Button>
                        </>
                      ) : null}
                      <Button small variant="danger" onClick={() => setDel(v)}>Delete</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      <Modal open={editing !== null} title="Edit caption" onClose={() => setEditing(null)} footer={<Button variant="primary" loading={busy} onClick={() => void saveCaption()}>Save</Button>}>
        <TextField label="Caption" value={editing?.caption ?? ''} maxLength={2200} onChange={(e) => setEditing(editing ? { ...editing, caption: e.target.value } : null)} />
      </Modal>
      <Modal open={preview !== null} title={preview?.name ?? 'Preview'} onClose={() => setPreview(null)} wide>
        {preview ? <video src={preview.url} controls className="max-h-[70vh] w-full" /> : null}
      </Modal>
      <ConfirmDialog open={del !== null} title="Delete this video?" confirmLabel="Delete" pending={busy} onConfirm={() => void remove()} onClose={() => setDel(null)}>
        {del?.inUse ? 'This video is referenced by a publishing cycle. ' : ''}The file is removed from storage.
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Google Drive → ReelQueue. Instagram can only fetch a video from a public URL, so a Drive file has to be COPIED into
 * ReelQueue's own storage (the S3/R2 bucket). The server does that copy (POST /v1/google-drive/files/:id/import).
 * ---------------------------------------------------------------------------------------------- */
function DriveImport({ videos, onImported }: { videos: VideoDto[]; onImported: () => void }) {
  const status = useApi('googleDriveStatus');
  if (status.error && !status.data) return <div className="mb-4"><Notice tone="warn">Google Drive could not be checked right now.</Notice></div>;
  if (!status.data) return <div className="mb-4"><SkeletonBlock /></div>;
  if (!status.data.enabled || status.data.status !== 'CONNECTED') {
    return <div className="mb-4"><Notice tone="info">Google Drive is not connected. <Link className="underline" href="/storage">Connect it on the Storage page</Link>, then come back.</Notice></div>;
  }
  return <DriveFiles videos={videos} onImported={onImported} />;
}

function DriveFiles({ videos, onImported }: { videos: VideoDto[]; onImported: () => void }) {
  const files = useApi('listDriveFiles', { query: { pageSize: 100 } });
  const toast = useToast();
  const [key, setKey] = useState<DriveSortKey>('name');
  const [dir, setDir] = useState<SortDir>('asc');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [prog, setProg] = useState<{ done: number; total: number; current: string } | null>(null);
  const [errors, setErrors] = useState<{ name: string; message: string }[]>([]);

  const all: DriveFileDto[] = (files.data?.files ?? []).filter((f) => !f.isFolder && VIDEO_MIME.has(f.mimeType.toLowerCase()));
  // Heuristic: same file name and byte size as a video already in ReelQueue.
  const have = new Set(videos.map((v) => `${v.filename}\u0000${v.sizeBytes}`));
  const imported = (f: DriveFileDto) => have.has(`${f.name}\u0000${f.sizeBytes}`);
  const list = sortDrive(all, key, dir);
  const importing = prog !== null;

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectNew = () => setPicked(new Set(list.filter((f) => !imported(f)).map((f) => f.id)));

  async function run() {
    // Import in the order shown on screen: that is the order the videos are appended to the publishing queue.
    const todo = list.filter((f) => picked.has(f.id));
    if (todo.length === 0 || importing) return;
    const failed: { name: string; message: string }[] = [];
    let ok = 0;
    for (let i = 0; i < todo.length; i++) {
      const f = todo[i]!;
      setProg({ done: i, total: todo.length, current: f.name });
      try { await call('importDriveFile', { params: { id: f.id } }); ok++; }
      catch (e) { failed.push({ name: f.name, message: errorMessage(e) }); }
    }
    setProg(null); setErrors(failed); setPicked(new Set());
    invalidate('listVideos', 'storage', 'dashboard'); onImported();
    if (ok > 0) toast.success(`Imported ${ok} video${ok === 1 ? '' : 's'}.`);
    if (failed.length > 0) toast.error(`${failed.length} video${failed.length === 1 ? '' : 's'} could not be imported.`);
  }

  return (
    <div className="mb-4">
      <Card>
        <h2 className="mb-2 text-sm font-semibold">Google Drive</h2>
        {files.error && !files.data ? <ErrorState error={files.error} onRetry={() => void files.reload()} /> : !files.data ? <SkeletonBlock /> : list.length === 0 ? (
          <p className="text-sm text-muted">No MP4/MOV files found. ReelQueue can only see files it created in your Drive (scope drive.file).</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-end gap-2 text-sm">
              <label className="flex flex-col gap-1"><span className="text-xs text-muted">Import order</span>
                <select className={selectCls} value={key} disabled={importing} onChange={(e) => setKey(e.target.value as DriveSortKey)}>
                  <option value="name">File name</option><option value="size">File size</option><option value="modified">Modified time</option>
                </select>
              </label>
              <label className="flex flex-col gap-1"><span className="text-xs text-muted">Direction</span>
                <select className={selectCls} value={dir} disabled={importing} onChange={(e) => setDir(e.target.value as SortDir)}>
                  <option value="asc">Ascending (A→Z, smallest, oldest)</option><option value="desc">Descending (Z→A, largest, newest)</option>
                </select>
              </label>
              <Button small disabled={importing} onClick={selectNew}>Select all new</Button>
              <Button small disabled={importing || picked.size === 0} onClick={() => setPicked(new Set())}>Clear</Button>
              <Button small disabled={importing} onClick={() => void files.reload()}>Refresh</Button>
              <span className="grow" />
              <Button small variant="primary" loading={importing} disabled={picked.size === 0} onClick={() => void run()}>Import {picked.size > 0 ? `${picked.size} selected` : 'selected'}</Button>
            </div>
            {prog ? <p className="mb-2 text-xs text-muted">Importing {prog.done + 1} of {prog.total}: {prog.current} (keep this tab open)</p> : null}
            <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
              {list.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-2">
                  <input type="checkbox" checked={picked.has(f.id)} disabled={importing} onChange={() => toggle(f.id)} aria-label={`Select ${f.name}`} />
                  <span className="min-w-0 grow break-all">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted">{f.sizeBytes !== null ? formatBytes(f.sizeBytes) : '?'}{f.modifiedTime ? ` · ${new Date(f.modifiedTime).toLocaleString()}` : ''}</span>
                  {imported(f) ? <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-xs">already in ReelQueue</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Only the first 100 files are listed. Imported videos are appended after your existing ones; reorder them below.</p>
          </>
        )}
        {errors.length > 0 ? (
          <div className="mt-3"><Notice tone="warn"><ul className="list-disc pl-4">{errors.map((e, i) => <li key={i} className="break-all">{e.name}: {e.message}</li>)}</ul></Notice></div>
        ) : null}
      </Card>
    </div>
  );
}