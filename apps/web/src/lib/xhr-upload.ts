/** Direct-to-storage PUT with upload progress (fetch has no upload progress events, hence XHR). */

export class UploadHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadHttpError';
  }
}

/** Headers the browser forbids us to set; sending them via setRequestHeader is a no-op that logs warnings. */
const FORBIDDEN = new Set(['content-length', 'host', 'origin', 'cookie', 'user-agent', 'connection']);

export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  status: number;
  timeout: number;
  withCredentials: boolean;
}

export function xhrPut(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
  createXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const xhr = createXhr();
    xhr.open('PUT', url);
    xhr.withCredentials = false; // presigned URL: never send our cookies to the storage origin
    xhr.timeout = 30 * 60 * 1000;
    for (const [k, v] of Object.entries(headers)) {
      if (!FORBIDDEN.has(k.toLowerCase())) xhr.setRequestHeader(k, v);
    }
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 403) reject(new UploadHttpError('Storage refused the upload (HTTP 403). The upload link may have expired.', 403));
      else reject(new UploadHttpError(`Storage responded with HTTP ${xhr.status}.`, xhr.status));
    };
    xhr.onerror = () => {
      done();
      reject(new UploadHttpError('Network error while uploading (also check the storage bucket CORS settings).', 0));
    };
    xhr.ontimeout = () => {
      done();
      reject(new UploadHttpError('The upload timed out.', 0));
    };
    xhr.onabort = () => {
      done();
      reject(new Error('Cancelled'));
    };
    xhr.send(body);
  });
}
