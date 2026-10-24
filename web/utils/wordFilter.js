const { pool } = require('../config/db');

class WordFilter {
  constructor() {
    this.forbiddenWords = [];
    this.lastFetched = 0;
    this.cacheTime = 60000; // Cache for 1 minute
  }

  async fetchWords() {
    if (Date.now() - this.lastFetched < this.cacheTime && this.forbiddenWords.length > 0) {
      return this.forbiddenWords;
    }

    try {
      const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "forbidden_words"');
      if (settings.length > 0 && settings[0].setting_value) {
        this.forbiddenWords = settings[0].setting_value
          .split(',')
          .map(w => w.trim().toLowerCase().replace(/ё/g, 'е'))
          .filter(w => w.length > 0);
        // Longest first for replace; also build quick lookup
        this.forbiddenWords.sort((a, b) => b.length - a.length);
        this._longWords = this.forbiddenWords.filter(w => w.length >= 4);
        this._shortWords = this.forbiddenWords.filter(w => w.length === 3);
      } else {
        this.forbiddenWords = [];
        this._longWords = [];
        this._shortWords = [];
      }
      this.lastFetched = Date.now();
    } catch (e) {
      console.error('Error fetching forbidden words:', e);
    }
    return this.forbiddenWords;
  }

  normalize(text) {
    return String(text || '').toLowerCase().replace(/ё/g, 'е');
  }

  async filter(text) {
    if (!text) return text;
    await this.fetchWords();
    if (this.forbiddenWords.length === 0) return text;

    let filteredText = text;
    // Cap work: prefer longer tokens; skip ultra-short noise already filtered in seed
    for (const word of this.forbiddenWords) {
      if (word.length < 3) continue;
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filteredText = filteredText.replace(new RegExp(escaped, 'gi'), '***');
    }
    return filteredText;
  }

  async containsBadWords(text) {
    if (!text) return false;
    await this.fetchWords();
    if (this.forbiddenWords.length === 0) return false;

    const lowerText = this.normalize(text);
    for (const word of this._longWords || this.forbiddenWords.filter(w => w.length >= 4)) {
      if (lowerText.includes(word)) return true;
    }
    for (const word of this._shortWords || []) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu');
      if (re.test(lowerText) || lowerText === word) return true;
    }
    return false;
  }
}

const wordFilter = new WordFilter();
module.exports = wordFilter;
