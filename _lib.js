const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Проверка подписи Telegram: убеждаемся, что данные пришли именно из Telegram
function verify(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

// Возвращает пользователя из списка допущенных или null
async function auth(req) {
  const u = verify(req.headers['x-init-data']);
  if (!u) return null;
  const { data } = await db.from('users').select('*').eq('telegram_id', u.id).maybeSingle();
  return data;
}

module.exports = { db, auth };
