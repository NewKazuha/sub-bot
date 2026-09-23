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
  PORT: process.env.PORT || 8080,
  POLL_INTERVAL_MINUTES: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
  
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TARGET_CHANNEL: process.env.TELEGRAM_TARGET_CHANNEL || '-1004296201769',
    API_ID: parseInt(process.env.TELEGRAM_API_ID || '36075557', 10),
    API_HASH: process.env.TELEGRAM_API_HASH || '68f30da0127d11d0a3d063dc5093e8dd',
    SESSION: process.env.TELEGRAM_SESSION || sessionFileFallback || ''
  },

  SITES: [
    {
      id: 'rhythm',
      name: 'Rhythm-Sub',
      base: 'https://rhythm-sub.com',
      feed: 'https://rhythm-sub.com/feed/',
      user: process.env.RHYTHM_USER || 'amrm31638@gmail.com',
      pass: process.env.RHYTHM_PASS || '5NdrLv6Ln!S5VVr(02PGgu99'
    },
    {
      id: 'revive',
      name: 'Revive',
      base: 'https://revivesubs.com',
      feed: 'https://revivesubs.com/feed/',
      user: process.env.REVIVE_USER || 'amrm31638@gmail.com',
      pass: process.env.REVIVE_PASS || '246810121416m'
    },
    {
      id: 'lazysano',
      name: 'LazySano',
      base: 'https://lazysano.com',
      feed: 'https://lazysano.com/feed/',
      user: process.env.LAZYSANO_USER || 'kirio',
      pass: process.env.LAZYSANO_PASS || '246810121416m'
    },
    {
      id: 'celestial',
      name: 'Celestial Dragons',
      base: 'https://www.celestial-dragons.com',
      feed: 'https://www.celestial-dragons.com/feed/',
      user: process.env.CELESTIAL_USER || 'AMRM31638',
      pass: process.env.CELESTIAL_PASS || '246810121416_Mm'
    },
    {
      id: 'animesan',
      name: 'Anime-San',
      base: 'https://www.anime-san.com',
      feed: 'https://www.anime-san.com/feed/',
      user: process.env.ANIMESAN_USER || 'AMRM31638',
      pass: process.env.ANIMESAN_PASS || '246810121416_Mm'
    }
  ]
};
