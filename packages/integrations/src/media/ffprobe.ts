import { execFile } from 'node:child_process';
import { parseFfprobe, type MediaMetadata } from '@reelqueue/core';

/**
 * Probes a video (local path or short-lived https URL) with ffprobe. Pluggable media layer: a future transcoder
 * would live next to this. Arguments are passed as an argv array (no shell), the input is validated, and output is
 * size-capped. The URL is never logged.
 */
export async function probeVideo(input: string, opts: { timeoutMs?: number; ffprobePath?: string } = {}): Promise<MediaMetadata | null> {
  // if (!/^https:\/\//.test(input) && !input.startsWith('/')) throw new Error('probeVideo input must be an https URL or an absolute path');

  const isHttps = /^https:\/\//i.test(input);

  const isLocalHttp =
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input);

  if (!isHttps && !isLocalHttp && !input.startsWith('/')) {
    throw new Error(
      'probeVideo input must be an https URL, localhost HTTP URL, or an absolute path'
    );
  }

  // const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-protocol_whitelist', 'file,https,tcp,tls,crypto', '-i', input];
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-protocol_whitelist',
    'file,http,https,tcp,tls,crypto',
    '-i',
    input,
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(opts.ffprobePath ?? 'ffprobe', args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(new Error('ffprobe failed to read the media'));
      resolve(out);
    });
  });
  try {
    return parseFfprobe(JSON.parse(stdout));
  } catch {
    return null;
  }
}
