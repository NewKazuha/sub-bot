import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { CONFIG } from '../src/config.mjs';
import { sendDocument } from '../src/telegram.mjs';
import { extractEpisodeNumber, getSafeTelegramFileName } from '../src/telegram-client.mjs';

function decodeBencode(buf) {
  let pos = 0;
  function parse() {
    const byte = buf[pos];
    if (byte === 0x69) { // 'i' integer
      pos++;
      const end = buf.indexOf(0x65, pos);
      const val = parseInt(buf.toString('ascii', pos, end), 10);
      pos = end + 1;
      return val;
    } else if (byte === 0x6c) { // 'l' list
      pos++;
      const list = [];
      while (buf[pos] !== 0x65) {
        list.push(parse());
      }
      pos++;
      return list;
    } else if (byte === 0x64) { // 'd' dict
      pos++;
      const dict = {};
      while (buf[pos] !== 0x65) {
        const key = parse();
        const val = parse();
        dict[key] = val;
      }
      pos++;
      return dict;
    } else if (byte >= 0x30 && byte <= 0x39) { // string
      const colon = buf.indexOf(0x3a, pos);
      const len = parseInt(buf.toString('ascii', pos, colon), 10);
      pos = colon + 1;
      const str = buf.subarray(pos, pos + len);
      pos += len;
      return str.toString('utf8');
    }
    throw new Error('Unknown bencode prefix at ' + pos);
  }
  return parse();
}

function runCommandAsync(cmd, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' });
    let timer = null;
    let killed = false;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { }
        }, 5000).unref?.();
        reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }

    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function findArabicTrack(mkvPath) {
  try {
    const trackInfo = execFileSync('mkvmerge', ['--identify', '--identification-format', 'json', mkvPath], {
      encoding: 'utf8',
      timeout: 30000
    });
    const info = JSON.parse(trackInfo);
    const subTracks = (info.tracks || []).filter(t => t.type === 'subtitles');
    if (subTracks.length === 0) return null;

    const selectedTrack = subTracks.find(t =>
      t.properties?.language === 'ara' ||
      t.properties?.language_ietf === 'ar' ||
      t.properties?.language_ietf === 'ar-SA' ||
      (t.properties?.track_name || '').toLowerCase().includes('arabic') ||
      (t.properties?.track_name || '').toLowerCase().includes('عربي')
    );

    if (!selectedTrack) return null;

    const codec = (selectedTrack.codec || '').toLowerCase();
    const ext = codec.includes('subrip') || codec.includes('srt') ? '.srt' : '.ass';
    return { trackId: selectedTrack.id, ext };
  } catch (e) {
    console.error(`   ⚠️ mkvmerge inspection failed for ${mkvPath}:`, e.message);
    return null;
  }
}

async function main() {
  const torrentUrl = process.env.TORRENT_URL || 'https://nyaa.si/download/2176429.torrent';
  const releaseTitle = process.env.RELEASE_TITLE || '[Netflix] Cyberpunk: Edgerunners 2 - [01 ~ 10]';
  const caption = process.env.CAPTION || releaseTitle;

  console.log(`🚀 Starting Batch Subtitle Extractor & Publisher`);
  console.log(`   🔗 Torrent: ${torrentUrl}`);
  console.log(`   🏷️ Title: ${releaseTitle}`);
  console.log(`   📝 Caption: ${caption}\n`);

  const workDir = path.resolve('batch_work_' + Date.now());
  const subsDir = path.join(workDir, 'subs');
  const mkvDlDir = path.join(workDir, 'mkv_dl');
  fs.mkdirSync(subsDir, { recursive: true });
  fs.mkdirSync(mkvDlDir, { recursive: true });

  const torrentPath = path.join(workDir, 'batch.torrent');

  try {
    console.log(`📥 Downloading torrent file...`);
    const res = await fetch(torrentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to download torrent file`);
    const torrentBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(torrentPath, torrentBuf);
    console.log(`   ✅ Torrent saved (${torrentBuf.length} bytes)`);

    const torrentData = decodeBencode(torrentBuf);
    const files = torrentData.info?.files || [];
    if (files.length === 0) throw new Error('No files found inside torrent structure');

    // Filter and map MKV files with their 1-based index
    const mkvEntries = [];
    files.forEach((f, idx) => {
      const relPath = (f.path || []).join('/');
      if (relPath.toLowerCase().endsWith('.mkv')) {
        const epNum = extractEpisodeNumber(path.basename(relPath));
        mkvEntries.push({
          index: idx + 1,
          name: path.basename(relPath),
          relPath,
          size: f.length,
          epNum: epNum ? parseInt(epNum, 10) : idx + 1
        });
      }
    });

    mkvEntries.sort((a, b) => a.epNum - b.epNum);
    console.log(`   📋 Found ${mkvEntries.length} MKV file(s) in torrent:\n`);
    mkvEntries.forEach(m => console.log(`      [#${m.index}] Ep ${m.epNum}: ${m.name} (${(m.size / 1024 / 1024).toFixed(1)} MB)`));
    console.log('');

    const extractedFiles = [];

    // Sequential download & extract loop (ensures peak disk usage ~1.1GB)
    for (let i = 0; i < mkvEntries.length; i++) {
      const item = mkvEntries[i];
      const epPadded = String(item.epNum).padStart(2, '0');
      console.log(`\n======================================================`);
      console.log(`📥 [${i + 1}/${mkvEntries.length}] Downloading Episode ${epPadded}: ${item.name}`);
      console.log(`   Index: ${item.index} | Size: ${(item.size / 1024 / 1024).toFixed(1)} MB`);
      console.log(`======================================================`);

      // Clean mkv download directory
      fs.rmSync(mkvDlDir, { recursive: true, force: true });
      fs.mkdirSync(mkvDlDir, { recursive: true });

      // Run aria2c for this specific file index only
      await runCommandAsync('aria2c', [
        `--select-file=${item.index}`,
        '--seed-time=0',
        '--max-upload-limit=1K',
        '--file-allocation=none',
        '--max-concurrent-downloads=5',
        '--split=5',
        '--max-connection-per-server=5',
        '--continue=true',
        `--dir=${mkvDlDir}`,
        torrentPath
      ], 35 * 60 * 1000); // 35 minutes per episode

      // Find the downloaded MKV file
      let downloadedMkv = null;
      function findMkv(dir) {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) findMkv(full);
          else if (f.toLowerCase().endsWith('.mkv')) downloadedMkv = full;
        }
      }
      findMkv(mkvDlDir);

      if (!downloadedMkv || !fs.existsSync(downloadedMkv)) {
        console.error(`   ❌ Failed to locate downloaded MKV for Episode ${epPadded}`);
        continue;
      }

      console.log(`   🎬 MKV downloaded: ${path.basename(downloadedMkv)} (${(fs.statSync(downloadedMkv).size / 1024 / 1024).toFixed(1)} MB)`);

      // Inspect tracks for Arabic subtitle
      const track = findArabicTrack(downloadedMkv);
      if (!track) {
        console.warn(`   ⚠️ No Arabic subtitle track found in Episode ${epPadded}`);
      } else {
        const outName = `${getSafeTelegramFileName(releaseTitle, '')} - ${epPadded}${track.ext}`;
        const outPath = path.join(subsDir, outName);
        console.log(`   🔍 Extracting track #${track.trackId} to ${outName}...`);

        execFileSync('mkvextract', ['tracks', downloadedMkv, `${track.trackId}:${outPath}`], {
          stdio: 'pipe',
          timeout: 60000
        });

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 50) {
          console.log(`   ✅ Extracted successfully: ${outName} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
          extractedFiles.push(outPath);
        } else {
          console.error(`   ❌ Subtitle extraction produced empty or invalid file for Episode ${epPadded}`);
        }
      }

      // CRITICAL: Delete the MKV file immediately to free disk space
      console.log(`   🧹 Removing MKV to maintain low disk usage...`);
      fs.rmSync(mkvDlDir, { recursive: true, force: true });
      fs.mkdirSync(mkvDlDir, { recursive: true });
    }

    if (extractedFiles.length === 0) {
      throw new Error('No subtitles could be extracted from any episode in the batch!');
    }

    console.log(`\n🎉 Extracted ${extractedFiles.length} subtitle file(s) total.`);

    // Create final ZIP package
    const zipFileName = `${getSafeTelegramFileName(releaseTitle, '')}.zip`;
    const zipFilePath = path.join(workDir, zipFileName);
    console.log(`\n📦 Packaging into zip: ${zipFileName}...`);

    const zip = new AdmZip();
    for (const subFile of extractedFiles) {
      zip.addLocalFile(subFile);
    }
    zip.writeZip(zipFilePath);

    const zipSize = fs.statSync(zipFilePath).size;
    console.log(`   ✅ Zip created: ${zipFileName} (${(zipSize / 1024).toFixed(1)} KB)`);

    // Publish to Telegram
    console.log(`\n📤 Publishing to Telegram Target Channel (${CONFIG.TELEGRAM.TARGET_CHANNEL})...`);
    const sendRes = await sendDocument(zipFilePath, caption);
    if (sendRes?.ok) {
      console.log(`   ✅ Successfully published! (Telegram Message ID: ${sendRes.result?.message_id})`);
    } else {
      console.error(`   ❌ Failed to publish via Telegram Bot API:`, sendRes);
      // Fallback: try MTProto if session exists
      if (CONFIG.TELEGRAM.SESSION && CONFIG.TELEGRAM.API_ID && CONFIG.TELEGRAM.API_HASH) {
        console.log(`   🔄 Attempting fallback via MTProto client...`);
        const { TelegramClient } = await import('telegram');
        const { StringSession } = await import('telegram/sessions/index.js');
        const client = new TelegramClient(new StringSession(CONFIG.TELEGRAM.SESSION), CONFIG.TELEGRAM.API_ID, CONFIG.TELEGRAM.API_HASH, {
          connectionRetries: 5
        });
        await client.connect();
        const channel = await client.getEntity(CONFIG.TELEGRAM.TARGET_CHANNEL);
        const sent = await client.sendFile(channel, {
          file: zipFilePath,
          caption: caption,
          forceDocument: true
        });
        if (sent) {
          console.log(`   ✅ Successfully posted via MTProto! (Message ID: ${sent.id})`);
        }
        await client.disconnect();
      } else {
        throw new Error('Telegram Bot API failed and no MTProto session available for fallback');
      }
    }

    console.log(`\n✨ Batch process complete!`);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch { }
  }
}

main().catch(err => {
  console.error('\n❌ Fatal batch extraction error:', err);
  process.exit(1);
});
