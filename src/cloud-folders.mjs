import { File } from 'megajs';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ====================================================================
// Episode matching utilities
// ====================================================================

export function extractEpisodesFromText(text) {
  if (!text) return [];
  const cleaned = text.replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z|\.mkv|\.mp4/gi, '');
  const eps = new Set();

  // Range matching: "07 & 08", "07-08", "07_08", "07 to 08"
  const rangeMatch = cleaned.match(/(\d{1,4})\s*(?:[-&~–]|to|and)\s*(\d{1,4})/i);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (!isNaN(start) && !isNaN(end) && Math.abs(end - start) <= 50) {
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      for (let i = min; i <= max; i++) eps.add(String(i));
    }
  }

  // Single numbers: " - 08", "E08", "EP08", "Episode 8", " #8", " [08]"
  const singleMatches = cleaned.matchAll(/(?:-\s*|ep(?:isode)?\s*|e\s*|#\s*|\[|\s+)(\d{1,4})(?:\s*v\d+)?(?:\s*\]|\s*\[|\s*\(|\s*\.|\s*$|\s+)/gi);
  for (const m of singleMatches) {
    const num = m[1].replace(/^0+/, '') || '0';
    eps.add(num);
  }

  return Array.from(eps);
}

export function matchesEpisode(filename, targetEp) {
  if (!targetEp) return true;
  const targetNorm = targetEp.replace(/^0+/, '') || '0';
  const foundEps = extractEpisodesFromText(filename);
  return foundEps.includes(targetNorm);
}

// ====================================================================
// Mega Folder & File Handler (Pure JS via megajs)
// ====================================================================

export async function listMegaFolder(folderUrl) {
  try {
    if (/mega\.nz\/(file|#!)/i.test(folderUrl) && !/mega\.nz\/folder/i.test(folderUrl)) {
      const file = File.fromURL(folderUrl);
      await file.loadAttributes();
      return [{
        name: file.name || 'unknown',
        size: file.size || 0,
        node: file
      }];
    }

    const folder = File.fromURL(folderUrl);
    await folder.loadAttributes();

    const files = [];
    function walk(node) {
      if (node.children) {
        for (const child of node.children) walk(child);
      } else if (node.name) {
        files.push({
          name: node.name,
          size: node.size || 0,
          node
        });
      }
    }
    walk(folder);
    return files;
  } catch (e) {
    console.warn(`   ⚠️ Mega folder listing failed:`, e.message);
    return [];
  }
}

export async function downloadMegaNode(megaNode, destPath) {
  const dlStream = megaNode.download();
  const fileStream = createWriteStream(destPath);
  await pipeline(dlStream, fileStream);
  return destPath;
}

export async function findBestFileInMegaFolder(folderUrl, targetEpisode = null) {
  const files = await listMegaFolder(folderUrl);
  if (files.length === 0) return null;

  console.log(`   📂 Mega folder: ${files.length} file(s) found`);
  const clean = files.filter(f => !/hardsub|hard[\s_-]*sub/i.test(f.name));

  // 1. Direct subtitle files (.ass/.srt/.zip/.rar/.7z)
  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  if (subFiles.length > 0) {
    if (targetEpisode) {
      const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) {
        console.log(`   ✅ Mega: subtitle matched EP ${targetEpisode}: ${match.name}`);
        return { node: match.node, name: match.name, type: 'subtitle', size: match.size };
      }
    }
    const latest = subFiles[subFiles.length - 1];
    console.log(`   ✅ Mega: using latest subtitle: ${latest.name}`);
    return { node: latest.node, name: latest.name, type: 'subtitle', size: latest.size };
  }

  // 2. Softsub MKV files
  const mkvFiles = clean.filter(f => /\.mkv$/i.test(f.name));
  if (mkvFiles.length > 0) {
    if (targetEpisode) {
      const match = mkvFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) {
        console.log(`   🎬 Mega: MKV matched EP ${targetEpisode}: ${match.name} (${(match.size / 1024 / 1024).toFixed(0)} MB)`);
        return { node: match.node, name: match.name, type: 'mkv', size: match.size };
      }
    }
    const latest = mkvFiles[mkvFiles.length - 1];
    console.log(`   🎬 Mega: using latest MKV: ${latest.name}`);
    return { node: latest.node, name: latest.name, type: 'mkv', size: latest.size };
  }

  return null;
}

// ====================================================================
// Mediafire Folder & File Handler (via Mediafire Public API & Cheerio)
// ====================================================================

export async function resolveMediafireDirectDownload(mfUrl) {
  try {
    const res = await fetch(mfUrl, {
      headers: { 'User-Agent': UA }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = cheerio.load(html);
    const dlBtn = doc('#downloadButton').attr('href') || doc('a[aria-label="Download file"]').attr('href');
    if (dlBtn && dlBtn.startsWith('http')) return dlBtn;
    return null;
  } catch {
    return null;
  }
}

export async function listMediafireFolder(folderUrl) {
  const match = folderUrl.match(/folder\/([a-zA-Z0-9]+)/i);
  if (!match) return [];
  const folderKey = match[1];

  const apiUrl = `https://www.mediafire.com/api/1.4/folder/get_content.php?folder_key=${folderKey}&content_type=files&response_format=json`;
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA }
    });
    const data = await res.json();
    const files = data?.response?.folder_content?.files || [];
    return files.map(f => ({
      name: f.filename,
      size: parseInt(f.size || 0, 10),
      quickkey: f.quickkey,
      directUrl: f.links?.normal_download || `https://www.mediafire.com/file/${f.quickkey}/${encodeURIComponent(f.filename)}/file`
    }));
  } catch (e) {
    console.warn(`   ⚠️ Mediafire folder listing failed:`, e.message);
    return [];
  }
}

export async function findBestFileInMediafire(mfUrl, targetEpisode = null) {
  // If single file URL
  if (!mfUrl.includes('/folder/')) {
    const direct = await resolveMediafireDirectDownload(mfUrl);
    if (direct) {
      const isMkv = /\.mkv$/i.test(mfUrl) || /\.mkv$/i.test(direct);
      return {
        name: path.basename(new URL(direct).pathname),
        directUrl: direct,
        type: isMkv ? 'mkv' : 'subtitle'
      };
    }
    return null;
  }

  // If folder URL
  const files = await listMediafireFolder(mfUrl);
  if (files.length === 0) return null;

  console.log(`   📂 Mediafire folder: ${files.length} file(s) found`);
  const clean = files.filter(f => !/hardsub|hard[\s_-]*sub/i.test(f.name));

  // 1. Direct subtitle files (.ass/.srt/.zip/.rar/.7z)
  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  if (subFiles.length > 0) {
    let chosen = subFiles[subFiles.length - 1];
    if (targetEpisode) {
      const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) chosen = match;
    }
    console.log(`   ✅ Mediafire: found subtitle ${chosen.name}`);
    const resolved = await resolveMediafireDirectDownload(chosen.directUrl);
    return {
      name: chosen.name,
      directUrl: resolved || chosen.directUrl,
      type: 'subtitle',
      size: chosen.size
    };
  }

  // 2. MKV files
  const mkvFiles = clean.filter(f => /\.mkv$/i.test(f.name));
  if (mkvFiles.length > 0) {
    let chosen = mkvFiles[mkvFiles.length - 1];
    if (targetEpisode) {
      const match = mkvFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) chosen = match;
    }
    console.log(`   🎬 Mediafire: found MKV ${chosen.name}`);
    const resolved = await resolveMediafireDirectDownload(chosen.directUrl);
    return {
      name: chosen.name,
      directUrl: resolved || chosen.directUrl,
      type: 'mkv',
      size: chosen.size
    };
  }

  return null;
}

// ====================================================================
// Google Drive Folder & File Handler
// ====================================================================

export function isDriveFolderUrl(url) {
  return /drive\.google\.com\/(?:drive\/)?folders\//i.test(url);
}

export function extractDriveFileId(url) {
  if (!url) return null;
  const match = url.match(/(?:file\/d\/|id=)([\w-]{20,})/);
  return match ? match[1] : null;
}

export function getDriveDirectUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
}

export async function listDriveFolder(folderUrl) {
  try {
    const idMatch = folderUrl.match(/(?:folders|folderview\?id=)\/?([\w-]{20,})/);
    if (!idMatch) return [];
    const folderId = idMatch[1];

    const listUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
    const res = await fetch(listUrl, {
      headers: { 'User-Agent': UA },
      redirect: 'follow'
    });

    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const files = [];

    $('[data-id]').each((_, el) => {
      const id = $(el).attr('data-id');
      const name = $(el).find('.flip-entry-title').text().trim() ||
                   $(el).attr('data-tooltip') ||
                   $(el).text().trim();
      if (id && name && name.length > 1) {
        files.push({
          name,
          id,
          isFolder: $(el).hasClass('flip-entry-list-folder') || $(el).find('.flip-entry-list-folder').length > 0
        });
      }
    });

    if (files.length === 0) {
      const dataRegex = /\["([\w-]{25,})","([^"]+)"/g;
      let m;
      while ((m = dataRegex.exec(html)) !== null) {
        const id = m[1];
        const name = m[2];
        if (!files.some(f => f.id === id)) {
          files.push({ name, id, isFolder: false });
        }
      }
    }

    return files;
  } catch (e) {
    console.warn(`   ⚠️ Google Drive listing failed:`, e.message);
    return [];
  }
}

export async function findBestFileInDrive(driveUrl, targetEpisode = null) {
  // If single file
  if (!isDriveFolderUrl(driveUrl)) {
    const id = extractDriveFileId(driveUrl);
    if (id) {
      return {
        id,
        name: `drive_file_${id}`,
        directUrl: getDriveDirectUrl(id),
        type: 'unknown'
      };
    }
    return null;
  }

  let files = await listDriveFolder(driveUrl);
  if (files.length === 0) return null;

  // Navigate into Softsub subfolder if present
  const softsubFolder = files.find(f => f.isFolder && /soft\s*sub/i.test(f.name));
  if (softsubFolder) {
    const subUrl = `https://drive.google.com/drive/folders/${softsubFolder.id}`;
    files = await listDriveFolder(subUrl);
  }

  const clean = files.filter(f => !f.isFolder && !/hardsub|hard[\s_-]*sub/i.test(f.name));

  // 1. Subtitles
  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  if (subFiles.length > 0) {
    let chosen = subFiles[subFiles.length - 1];
    if (targetEpisode) {
      const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) chosen = match;
    }
    console.log(`   ✅ Drive: subtitle ${chosen.name}`);
    return {
      id: chosen.id,
      name: chosen.name,
      directUrl: getDriveDirectUrl(chosen.id),
      type: 'subtitle'
    };
  }

  // 2. MKV files
  const mkvFiles = clean.filter(f => /\.mkv$/i.test(f.name));
  if (mkvFiles.length > 0) {
    let chosen = mkvFiles[mkvFiles.length - 1];
    if (targetEpisode) {
      const match = mkvFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) chosen = match;
    }
    console.log(`   🎬 Drive: MKV ${chosen.name}`);
    return {
      id: chosen.id,
      name: chosen.name,
      directUrl: getDriveDirectUrl(chosen.id),
      type: 'mkv'
    };
  }

  return null;
}
