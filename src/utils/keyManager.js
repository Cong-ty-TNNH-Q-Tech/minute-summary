'use strict';

const keys = [];
let index = 0;

function init() {
  const raw = process.env.GEMINI_API_KEYS || '';
  const parsed = raw.split(',').map((k) => k.trim()).filter(Boolean);

  if(parsed.length === 0)
    throw new Error('No GEMINI_API_KEYS provided in environment variables.');

  keys.push(...parsed);
  console.log(`[KeyManager] Loaded ${keys.length} Gemini API key(s).`);
}

function getNext() {
  if(keys.length === 0) throw new Error('[KeyManager] Not initialized.');
  const key = keys[index];
  index = (index + 1) % keys.length;
  return key;
}

// Thử từng key, rotate khi gặp lỗi quota/rate-limit
async function withRotation(fn) {
  if(keys.length === 0) throw new Error('[KeyManager] Not initialized.');

  let lastError;
  const tried = new Set();

  for(let i = 0; i < keys.length; i++) {
    const key = getNext();
    if(tried.has(key)) continue;
    tried.add(key);

    try {
      return await fn(key);
    } catch(err) {
      const isQuota =
        err.status === 429 ||
        (err.message &&
          (err.message.includes('quota') ||
            err.message.includes('RESOURCE_EXHAUSTED') ||
            err.message.includes('rate limit')));

      if(isQuota) {
        console.warn('[KeyManager] Quota exceeded, rotating to next key...');
        lastError = err;
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('[KeyManager] All API keys exhausted.');
}

module.exports = { init, getNext, withRotation };
