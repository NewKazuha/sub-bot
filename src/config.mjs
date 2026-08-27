export const CONFIG = {
  PORT: process.env.PORT || 8080,
  POLL_INTERVAL_MINUTES: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
  
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8860387976:AAE9DGLM24IvRZjWQtmOsJTDkq2FbtgcDW0',
    TARGET_CHANNEL: process.env.TELEGRAM_TARGET_CHANNEL || '-1004296201769',
    API_ID: parseInt(process.env.TELEGRAM_API_ID || '36075557', 10),
    API_HASH: process.env.TELEGRAM_API_HASH || '68f30da0127d11d0a3d063dc5093e8dd',
    SESSION: process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGCD6iceCq51K4smbC1tK2ij0PfAYSSTs9epkp3yuAS8aPj441v5sP7QaSNG4rR3XxYRRrleos3+uEYYrHV3Y/mkH12j1GDhY47NFDnV6SOADjf6tUMlVJ6ZnBvkOUKOlCleQyvkoq9Vb4a/ehFkTyuDCrx7+2o9GflbwmXGcBfLSj5uFJvKHHjCfPakLwq3xkZRrM75Ba4WvwckJ51ro2F7w9VERkn75m7LQdhhGjH7NMNSCIfplVME50qvUZ2LHQrxlMeOEt9pN6cxzqaoPg1g8jZiz65oW4AoQsksx7U+JS2ZiLTucBvPE8q5WISDCRfNQdkhYw/zd8jYvV6oDGQ='
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
