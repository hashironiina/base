const { db, auth } = require('./_lib');

module.exports = async (req, res) => {
  const me = await auth(req);
  if (!me) return res.status(403).json({ error: 'no_access' });

  const [s, a, r] = await Promise.all([
    db.from('sections').select('*').order('sort_order'),
    db.from('articles').select('*').order('sort_order').order('id'),
    db.from('reads').select('article_id').eq('telegram_id', me.telegram_id),
  ]);

  // Картинки лежат в закрытом хранилище, выдаём временные ссылки на 1 час
  const names = [...new Set((a.data || []).flatMap((x) => x.images))];
  const urls = {};
  if (names.length) {
    const { data } = await db.storage.from('images').createSignedUrls(names, 3600);
    (data || []).forEach((d) => { urls[d.path] = d.signedUrl; });
  }

  res.json({
    me: { id: me.telegram_id, name: me.name, role: me.role },
    sections: s.data || [],
    articles: (a.data || []).map((x) => ({ ...x, imageUrls: x.images.map((n) => urls[n] || '') })),
    read: (r.data || []).map((x) => x.article_id),
  });
};
