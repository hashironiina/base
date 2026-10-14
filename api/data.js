const { db, auth } = require('./_lib');

// Какие уровни доступа видит каждая роль
const VISIBLE = {
  admin: ['staff', 'partners', 'all'],
  reader: ['staff', 'all'],
  partner: ['partners', 'all'],
};

module.exports = async (req, res) => {
  const me = await auth(req);
  if (!me) return res.status(403).json({ error: 'no_access' });
  const levels = VISIBLE[me.role] || ['all'];

  const [s, a, r] = await Promise.all([
    db.from('sections').select('*').order('sort_order'),
    db.from('articles').select('*').in('access', levels).order('sort_order').order('id'),
    db.from('reads').select('article_id').eq('telegram_id', me.telegram_id),
  ]);

  const articles = a.data || [];
  // Не-редакторам показываем только разделы, где для них есть статьи
  const sections = (s.data || []).filter(
    (x) => me.role === 'admin' || articles.some((y) => y.section_id === x.id)
  );

  // Картинки лежат в закрытом хранилище, выдаём временные ссылки на 1 час
  const names = [...new Set(articles.flatMap((x) => x.images))];
  const urls = {};
  if (names.length) {
    const { data } = await db.storage.from('images').createSignedUrls(names, 3600);
    (data || []).forEach((d) => { urls[d.path] = d.signedUrl; });
  }

  res.json({
    me: { id: me.telegram_id, name: me.name, role: me.role },
    sections,
    articles: articles.map((x) => ({ ...x, imageUrls: x.images.map((n) => urls[n] || '') })),
    read: (r.data || []).map((x) => x.article_id),
  });
};
