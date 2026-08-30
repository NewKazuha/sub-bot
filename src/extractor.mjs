import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const WORK_DIR = path.resolve('temp_work');
const OUT_DIR = path.resolve('temp_extracted');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function findAllVideoFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllVideoFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.mkv', '.mp4', '.avi', '.webm'].includes(ext)) results.push(fullPath);
    }
  }
  return results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
}

async function resolveMediafireDirectUrl(mfUrl) {
  try {
    const res = await fetch(mfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const match = html.match(/href=["'](https?:\/\/[^"']*mediafire\.com\/[^"']*\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)["']/i) ||
                  html.match(/aria-label=["']Download file["']\s+href=["']([^"']+)["']/i) ||
                  html.match(/id=["']downloadButton["']\s+href=["']([^"']+)["']/i);
    if (match) return match[1];
  } catch (e) {}
  return mfUrl;
}

export async function processAndExtract(url, itemTitle = 'Episode') {
  const safeTitle = sanitizeFilename(itemTitle);
  if (fs.existsSync(WORK_DIR)) fs.rmSync(WORK_DIR, { recursive: true, force: true });
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fontsDir = path.join(OUT_DIR, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });

  console.log(`\n🚀 [Turbo Extractor] Processing: "${safeTitle}"`);
  console.log(`🔗 Target URL: ${url}`);

  // Case A: Direct Subtitle / ZIP File
  if (/\.(ass|srt|zip|rar)$/i.test(url)) {
    console.log('⚡ Direct subtitle / archive URL detected. Downloading directly...');
    const outName = `${safeTitle}${path.extname(url.split('?')[0])}`;
    run(`aria2c --dir="${OUT_DIR}" --out="${outName}" "${url}"`);
    return {
      subFiles: fs.readdirSync(OUT_DIR).filter(f => /\.(ass|srt)$/i.test(f)).map(f => path.join(OUT_DIR, f)),
      fontZip: fs.readdirSync(OUT_DIR).filter(f => /\.zip$/i.test(f)).map(f => path.join(OUT_DIR, f))[0] || null
    };
  }

  // Case B: Video / Torrent / Cloud Storage Download
  if (url.startsWith('magnet:') || url.includes('.torrent') || url.includes('nyaa.si')) {
    let torrentUrl = url;
    const nyaaMatch = url.match(/^https?:\/\/(?:www\.)?nyaa\.si\/view\/(\d+)/i);
    if (nyaaMatch) torrentUrl = `https://nyaa.si/download/${nyaaMatch[1]}.torrent`;

    const ariaArgs = [
      '--seed-time=0',
      '--summary-interval=5',
      '--file-allocation=none',
      '--enable-mmap=true',
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--bt-max-peers=256',
      `--dir="${WORK_DIR}"`,
      `"${torrentUrl}"`
    ].join(' ');
    run(`aria2c ${ariaArgs}`);
  } else if (url.includes('drive.google.com')) {
    run(`gdown "${url}" -O "${WORK_DIR}/" --fuzzy ${url.includes('/folders/') ? '--folder' : ''}`);
  } else if (url.includes('mediafire.com')) {
    const directMf = await resolveMediafireDirectUrl(url);
    run(`aria2c --dir="${WORK_DIR}" --file-allocation=none --enable-mmap=true --max-connection-per-server=16 --split=16 "${directMf}"`);
  } else if (url.includes('mega.nz')) {
    try {
      run(`megatools dl --path "${WORK_DIR}" "${url}"`);
    } catch {
      run(`python3 -c "from mega import Mega; m = Mega(); m.login(); m.download_url('${url}', '${WORK_DIR}')"`);
    }
  } else if (url.startsWith('http')) {
    run(`aria2c --dir="${WORK_DIR}" --file-allocation=none --enable-mmap=true --max-connection-per-server=16 --split=16 "${url}"`);
  }

  const videoFiles = findAllVideoFiles(WORK_DIR);
  if (videoFiles.length === 0) {
    throw new Error('No video files found after download.');
  }

  const extractedSubs = [];
  const seenFonts = new Set();

  for (let i = 0; i < videoFiles.length; i++) {
    const vFile = videoFiles[i];
    const baseName = sanitizeFilename(path.basename(vFile, path.extname(vFile)));
    console.log(`⚡ Extracting streams from [${i + 1}/${videoFiles.length}]: ${baseName}`);

    let mkvInfo = null;
    try {
      const infoRaw = spawnSync('mkvmerge', ['-J', vFile], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      if (infoRaw.stdout) mkvInfo = JSON.parse(infoRaw.stdout);
    } catch {}

    if (mkvInfo && Array.isArray(mkvInfo.tracks)) {
      const subTracks = mkvInfo.tracks.filter((t) => t.type === 'subtitles');
      const attachments = (mkvInfo.attachments || []).filter((a) => /\.(ttf|otf|ttc|woff|woff2)$/i.test(a.file_name || ''));

      let targetTracks = subTracks.filter((t) => {
        const lang = (t.properties?.language || t.properties?.language_ietf || '').toLowerCase();
        const name = (t.properties?.track_name || '').toLowerCase();
        return lang.includes('ar') || name.includes('arab') || name.includes('عرب');
      });
      if (targetTracks.length === 0) targetTracks = subTracks;

      const trackArgs = [];
      for (const trk of targetTracks) {
        const codec = (trk.codec || '').toLowerCase();
        const ext = codec.includes('subrip') || codec.includes('srt') ? 'srt' : 'ass';
        const trackTitle = trk.properties?.track_name ? `_[${sanitizeFilename(trk.properties.track_name)}]` : '';
        const subOutFile = path.join(OUT_DIR, `${baseName}${trackTitle}.${ext}`);
        trackArgs.push(`${trk.id}:"${subOutFile}"`);
        extractedSubs.push(subOutFile);
      }

      if (trackArgs.length > 0) {
        try { run(`mkvextract tracks "${vFile}" ${trackArgs.join(' ')}`); } catch {}
      }

      if (attachments.length > 0) {
        const toExtract = [];
        for (const att of attachments) {
          const fName = sanitizeFilename(att.file_name || `font_${att.id}.ttf`);
          if (!seenFonts.has(fName.toLowerCase())) {
            seenFonts.add(fName.toLowerCase());
            toExtract.push(`${att.id}:"${path.join(fontsDir, fName)}"`);
          }
        }
        if (toExtract.length > 0) {
          try { run(`mkvextract attachments "${vFile}" ${toExtract.join(' ')}`); } catch {}
        }
      }
    } else {
      const fallbackAss = path.join(OUT_DIR, `${baseName}.ass`);
      try {
        run(`ffmpeg -y -i "${vFile}" -map 0:s:0 -c:s copy "${fallbackAss}"`);
        extractedSubs.push(fallbackAss);
      } catch {}
    }
  }

  let fontZipPath = null;
  if (fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length > 0) {
    fontZipPath = path.join(OUT_DIR, `${safeTitle}_Fonts.zip`);
    try {
      const zip = new AdmZip();
      for (const f of fs.readdirSync(fontsDir)) {
        const fp = path.join(fontsDir, f);
        if (fs.statSync(fp).isFile()) zip.addLocalFile(fp);
      }
      zip.writeZip(fontZipPath);
    } catch (e) {
      console.warn('Font zipping error:', e.message);
    }
  }

  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  return {
    subFiles: extractedSubs.filter(f => fs.existsSync(f)),
    fontZip: fontZipPath && fs.existsSync(fontZipPath) ? fontZipPath : null
  };
}
