import path from 'node:path';

// Security helpers: remote-controlled names (Telegram document fileName,
// cloud-provider metadata) must never escape the target directory when
// joined into local write/download paths.
export function safeRemoteBaseName(name, fallback = 'download') {
  const base = path.basename(String(name ?? '')).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
}

export function isInsideDir(targetPath, baseDir) {
  return path.resolve(targetPath).startsWith(path.resolve(baseDir) + path.sep);
}
