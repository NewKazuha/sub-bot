import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

const getApiBase = () => `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}`;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendDocument(filePath, caption = '', { chatId = CONFIG.TELEGRAM.TARGET_CHANNEL, parseMode = 'HTML', retries = 3 } = {}) {
  if (!CONFIG.TELEGRAM.BOT_TOKEN) return { ok: false, description: 'No TELEGRAM_BOT_TOKEN configured' };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const fileName = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer]);

      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      formData.append('document', blob, fileName);
      if (caption) {
        formData.append('caption', parseMode === 'HTML' ? escapeHtml(caption) : caption);
        if (parseMode) formData.append('parse_mode', parseMode);
      }

      const res = await fetch(`${getApiBase()}/sendDocument`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(600000)
      });
      const data = await res.json();
      if (data?.ok) return data;
      console.warn(`Telegram sendDocument attempt ${attempt} response:`, data);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      } else {
        return data;
      }
    } catch (e) {
      console.error(`Telegram sendDocument attempt ${attempt} error (${filePath}):`, e.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      } else {
        return null;
      }
    }
  }
  return null;
}
