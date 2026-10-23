// reelqueue/app/web/src/app/(app)/videos/page.tsx
'use client';

import { useState } from 'react';
import { call, errorMessage } from '@/lib/api';
import { invalidate, useApi } from '@/lib/use-api';
import { moveItem } from '@/lib/reorder';
import { formatBytes, formatDuration } from '@/lib/format';
import type { VideoDto } from '@reelqueue/shared';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Modal, Notice, PageHeader, SkeletonBlock, TextField } from '@/components/ui';
import { VideoStatusBadge } from '@/components/status';
import { useToast } from '@/components/toast';

const PAGE_SIZE = 100;

export default function VideosPage() {
  const q = useApi('listVideos', { query: { page: 1, pageSize: PAGE_SIZE } });
  const cycle = useApi('currentCycle');
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string; caption: string } | null>(null);
  const [del, setDel] = useState<VideoDto | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const live = cycle.data && (cycle.data.status === 'ACTIVE' || cycle.data.status === 'PAUSED');
  const ready = (q.data?.items ?? []).filter((v) => v.status === 'READY');
  const canReorder = !live && (q.data?.total ?? 0) <= PAGE_SIZE;

  async function move(v: VideoDto, dir: -1 | 1) {
    const ids = ready.map((x) => x.id); const from = ids.indexOf(v.id); const to = from + dir;
    if (to < 0 || to >= ids.length) return;
    setBusy(true);
    try { await call('reorderVideos', { body: { videoIds: moveItem(ids, from, to) } }); invalidate('listVideos'); }
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
      <PageHeader title="Videos" description="Ready videos publish in this order." />
      {live ? <div className="mb-4"><Notice tone="info">The order is locked while a cycle is running or paused.</Notice></div> : null}
      {(q.data?.total ?? 0) > PAGE_SIZE ? <div className="mb-4"><Notice tone="warn">Reordering is available for up to {PAGE_SIZE} videos in this version.</Notice></div> : null}
      {q.error && !q.data ? <ErrorState error={q.error} onRetry={() => void q.reload()} /> : !q.data ? <SkeletonBlock /> : q.data.items.length === 0 ? <EmptyState title="No videos yet">Upload some on the Upload page.</EmptyState> : (
        <Card>
          <ul className="divide-y divide-line text-sm">
            {q.data.items.map((v) => {
              const idx = ready.findIndex((x) => x.id === v.id);
              return (
                <li key={v.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="break-all font-medium">{v.status === 'READY' ? `${idx + 1}. ` : ''}{v.filename}</p>
                    <p className="text-xs text-muted">{formatBytes(v.sizeBytes)} · {formatDuration(v.durationMs)}{v.width && v.height ? ` · ${v.width}×${v.height}` : ''} · published {v.publishedCount}×{v.inUse ? ' · queued in a cycle' : ''}</p>
                    {v.caption ? <p className="mt-1 whitespace-pre-wrap text-xs">{v.caption}</p> : null}
                    {v.rejectionReason ? <p className="mt-1 text-xs text-danger">{v.rejectionReason}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <VideoStatusBadge status={v.status} />
                    {v.status === 'READY' ? (
                      <>
                        <Button small disabled={!canReorder || busy || idx === 0} aria-label="Move up" onClick={() => void move(v, -1)}>↑</Button>
                        <Button small disabled={!canReorder || busy || idx === ready.length - 1} aria-label="Move down" onClick={() => void move(v, 1)}>↓</Button>
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
