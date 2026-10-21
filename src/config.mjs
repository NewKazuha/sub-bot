import fs from 'node:fs';
import path from 'node:path';

// Automatically load local .env if present
try {
  const envFile = path.resolve('.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (line && !line.startsWith('#') && line.includes('=')) {
        const idx = line.indexOf('=');
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k && !process.env[k]) process.env[k] = v;
      }
    }
  }
} catch { }

let sessionFileFallback = '';
try {
  const sessionFilePath = path.resolve('SESSION_STRING.txt');
  if (fs.existsSync(sessionFilePath)) {
    sessionFileFallback = fs.readFileSync(sessionFilePath, 'utf8').trim();
  }
} catch { }

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3080', 10),
  POLL_INTERVAL_MINUTES: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
  
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TARGET_CHANNEL: process.env.TELEGRAM_TARGET_CHANNEL || '',
    API_ID: parseInt(process.env.TELEGRAM_API_ID || '0', 10),
    API_HASH: process.env.TELEGRAM_API_HASH || '',
    SESSION: process.env.TELEGRAM_SESSION || sessionFileFallback || ''
  },

  SITES: [
    {
      id: 'rhythm',
      name: 'Rhythm-Sub',
      base: 'https://rhythm-sub.com',
      user: process.env.RHYTHM_USER || '',
      pass: process.env.RHYTHM_PASS || ''
    },
    {
      id: 'revive',
      name: 'Revive',
      base: 'https://revivesubs.com',
      user: process.env.REVIVE_USER || '',
      pass: process.env.REVIVE_PASS || ''
    },
    {
      id: 'lazysano',
      name: 'LazySano',
      base: 'https://lazysano.com',
      user: process.env.LAZYSANO_USER || '',
      pass: process.env.LAZYSANO_PASS || ''
    },
    {
      id: 'celestial',
      name: 'Celestial Dragons',
      base: 'https://www.celestial-dragons.com',
      user: process.env.CELESTIAL_USER || '',
      pass: process.env.CELESTIAL_PASS || ''
    },
    {
      id: 'animesan',
      name: 'Anime-San',
      base: 'https://www.anime-san.com',
      user: process.env.ANIMESAN_USER || '',
      pass: process.env.ANIMESAN_PASS || ''
    }
  ]
};
