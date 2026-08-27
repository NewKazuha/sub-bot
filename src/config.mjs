export const CONFIG = {
  PORT: process.env.PORT || 8080,
  POLL_INTERVAL_MINUTES: parseInt(process.env.POLL_INTERVAL_MINUTES || '10', 10),
  
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8860387976:AAE9DGLM24IvRZjWQtmOsJTDkq2FbtgcDW0',
    TARGET_CHANNEL: process.env.TELEGRAM_TARGET_CHANNEL || '-1004296201769',
    FANSUB_SOURCE_ID: process.env.TELEGRAM_FANSUB_SOURCE_ID || '-1001031770723',
    OFFICIAL_SOURCE_ID: process.env.TELEGRAM_OFFICIAL_SOURCE_ID || '-1001224725097'
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
      user: process.env.REVIVE_USER || 'Kazuha',
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
