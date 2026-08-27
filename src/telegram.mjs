import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

const API_BASE = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}`;

export async function sendMessage(text, { chatId = CONFIG.TELEGRAM.TARGET_CHANNEL, parseMode = 'HTML' } = {}) {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode })
    });
    return await res.json();
  } catch (e) {
    console.error('Telegram sendMessage error:', e.message);
    return null;
  }
}

export async function sendDocument(filePath, caption = '', { chatId = CONFIG.TELEGRAM.TARGET_CHANNEL, parseMode = 'HTML' } = {}) {
  try {
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer]);

    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', blob, fileName);
    if (caption) {
      formData.append('caption', caption);
      formData.append('parse_mode', parseMode);
    }

    const res = await fetch(`${API_BASE}/sendDocument`, {
      method: 'POST',
      body: formData
    });
    return await res.json();
  } catch (e) {
    console.error(`Telegram sendDocument error (${filePath}):`, e.message);
    return null;
  }
}

export async function sendPhoto(photoUrl, caption = '', { chatId = CONFIG.TELEGRAM.TARGET_CHANNEL, parseMode = 'HTML' } = {}) {
  try {
    const res = await fetch(`${API_BASE}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: parseMode })
    });
    return await res.json();
  } catch (e) {
    console.error('Telegram sendPhoto error:', e.message);
    return null;
  }
}
