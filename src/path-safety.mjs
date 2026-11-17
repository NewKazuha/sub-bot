import path from 'node:path';

// Security helpers: remote-controlled names (Telegram document fileName,
// cloud-provider metadata) must never escape the target directory when
// joined into local write/download paths.
export function safeRemoteBaseName(name, fallback = 'download') {
  const base = path.basename(String(name ?? ''))
    // X9: the C0 control characters are removed — a name like
    // "evil\n[+Fonts].ass" must not become a file name (or a zip entry, or a
    // Telegram document name) that carries a line break.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
}

export function isInsideDir(targetPath, baseDir) {
  return path.resolve(targetPath).startsWith(path.resolve(baseDir) + path.sep);
}
