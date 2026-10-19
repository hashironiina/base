const { db, auth } = require('./_lib');

// Какие уровни доступа видит каждая роль
const VISIBLE = {
  admin: ['staff', 'partners', 'all'],
  reader: ['staff', 'all'],
  partner: ['partners', 'all'],
  trainee: ['staff', 'all'],
};

module.exports = async (req, res) => {
  const real = await auth(req);
  if (!real) return res.status(403).json({ error: 'no_access' });

  // Режим «Посмотреть как»: только для редактора, только просмотр (ничего не сохраняется)
  const q = req.query || {};
  const as = real.role === 'admin' && ['reader', 'trainee', 'partner'].includes(q.as) ? q.as : null;
  const me = as
    ? { ...real, role: as, stage: as === 'trainee' ? Math.max(1, Number(q.stage) || 1) : real.stage }
    : real;
  const levels = VISIBLE[me.role] || ['all'];

  let aq = db.from('articles').select('*').in('access', levels).order('sort_order').order('id');
  // Стажёр видит только статьи уже открытых этапов (этап статьи от 1 до его текущего)
  if (me.role === 'trainee') aq = aq.gte('stage', 1).lte('stage', me.stage);

  const [s, a, r] = await Promise.all([
    db.from('sections').select('*').order('sort_order'),
    aq,
    as ? Promise.resolve({ data: [] }) : db.from('reads').select('article_id').eq('telegram_id', me.telegram_id),
  ]);

  const articles = a.data || [];
  // Не-редакторам показываем только разделы, где для них есть статьи
  const sections = (s.data || []).filter(
    (x) => me.role === 'admin' || articles.some((y) => y.section_id === x.id)
  );

  // Состояние обучения стажёра
  let trainee = null;
  if (me.role === 'trainee') {
    const readSet = new Set((r.data || []).map((x) => x.article_id));
    const cur = articles.filter((x) => x.stage === me.stage);
    const top = await db.from('articles').select('stage').in('access', ['staff', 'all'])
      .order('stage', { ascending: false }).limit(1);
    const max = (top.data && top.data[0] && top.data[0].stage) || 0;
    const qz = await db.from('quizzes').select('questions').eq('stage', me.stage).maybeSingle();
    const n = qz.data && Array.isArray(qz.data.questions) ? qz.data.questions.length : 0;
    trainee = {
      stage: me.stage,
      max,
      done: max > 0 && me.stage > max,
      // В режиме просмотра тест доступен сразу, чтобы редактор мог его попробовать
      canTest: cur.length > 0 && (as ? true : cur.every((x) => readSet.has(x.id))),
      hasQuiz: n > 0,
    };
  }

  // Картинки лежат в закрытом хранилище, выдаём временные ссылки на 1 час
  const names = [...new Set(articles.flatMap((x) => x.images))];
  const urls = {};
  if (names.length) {
    const { data } = await db.storage.from('images').createSignedUrls(names, 3600);
    (data || []).forEach((d) => { urls[d.path] = d.signedUrl; });
  }

  // Файлы (PDF/Word): временные ссылки на скачивание с исходным именем файла
  const furls = {};
  await Promise.all(articles.flatMap((x) => x.files || []).map(async (f) => {
    const { data } = await db.storage.from('images').createSignedUrl(f.path, 3600, { download: f.title });
    furls[f.path] = (data && data.signedUrl) || '';
  }));

  res.json({
    me: { id: me.telegram_id, name: me.name, role: me.role },
    preview: as ? { as, stage: me.stage } : null,
    trainee,
    sections,
    articles: articles.map((x) => ({
      ...x,
      imageUrls: x.images.map((n) => urls[n] || ''),
      files: (x.files || []).map((f) => ({ ...f, url: furls[f.path] || '' })),
    })),
    read: (r.data || []).map((x) => x.article_id),
  });
};
