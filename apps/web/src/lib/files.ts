const EXT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

/** Browsers often leave File.type empty (e.g. .mov on some OSes); fall back to the extension. The API still validates. */
export function guessContentType(filename: string, browserType: string): string {
  if (browserType) return browserType;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? 'application/octet-stream';
}
