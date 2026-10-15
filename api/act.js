const { db, auth } = require('./_lib');
const chk = (r) => { if (r.error) throw r.error; return r; };

// Состояние текущего этапа стажёра: сколько статей, все ли открыты, есть ли тест
async function stageState(me) {
  const cur = chk(await db.from('articles').select('id').in('access', ['staff', 'all']).eq('stage', me.stage)).data;
  let readCount = 0;
  if (cur.length) {
    readCount = chk(await db.from('reads').select('article_id')
      .eq('telegram_id', me.telegram_id).in('article_id', cur.map((x) => x.id))).data.length;
  }
  const quiz = chk(await db.from('quizzes').select('*').eq('stage', me.stage)).data[0] || null;
  return {
    count: cur.length,
    allRead: readCount >= cur.length,
    hasQuiz: !!(quiz && (quiz.questions || []).length),
    quiz,
  };
}

module.exports = async (req, res) => {
  const me = await auth(req);
  if (!me) return res.status(403).json({ error: 'no_access' });
  const { action, ...d } = req.body || {};

  try {
    // Отметка «прочитано» доступна всем из списка
    if (action === 'read') {
      chk(await db.from('reads').upsert({ telegram_id: me.telegram_id, article_id: d.article_id }));
      let advanced = false;
      // Если у этапа нет теста, он открывается сам, когда стажёр открыл все его статьи
      if (me.role === 'trainee') {
        const s = await stageState(me);
        if (s.count > 0 && s.allRead && !s.hasQuiz) {
          chk(await db.from('users').update({ stage: me.stage + 1 }).eq('telegram_id', me.telegram_id));
          advanced = true;
        }
      }
      return res.json({ ok: 1, advanced });
    }

    // Тест стажёра: вопросы без правильных ответов, проверка на сервере
    if (action === 'quizGet' || action === 'quizSubmit') {
      if (me.role !== 'trainee') return res.status(403).json({ error: 'trainee_only' });
      const s = await stageState(me);
      if (!s.hasQuiz) return res.status(400).json({ error: 'no_quiz' });
      if (!s.allRead) return res.status(400).json({ error: 'read_first' });
      if (action === 'quizGet') {
        return res.json({
          ok: 1, title: s.quiz.title, pass_percent: s.quiz.pass_percent,
          questions: s.quiz.questions.map((x) => ({ q: x.q, options: x.options })),
        });
      }
      const qs = s.quiz.questions;
      const wrong = [];
      let ok = 0;
      qs.forEach((x, i) => {
        if (Number(d.answers && d.answers[i]) === x.correct) ok++; else wrong.push(i + 1);
      });
      const score = Math.round((ok / qs.length) * 100);
      const passed = score >= s.quiz.pass_percent;
      chk(await db.from('quiz_attempts').insert({ telegram_id: me.telegram_id, stage: me.stage, score, passed }));
      if (passed) chk(await db.from('users').update({ stage: me.stage + 1 }).eq('telegram_id', me.telegram_id));
      return res.json({ ok: 1, score, passed, wrong });
    }

    // Всё остальное только для редакторов
    if (me.role !== 'admin') return res.status(403).json({ error: 'admin_only' });

    const out = { ok: 1 };
    const save = (t, o) => (d.id ? db.from(t).update(o).eq('id', d.id) : db.from(t).insert(o));

    if (action === 'saveSection') chk(await save('sections', { title: d.title, sort_order: d.sort_order || 0 }));
    else if (action === 'deleteSection') chk(await db.from('sections').delete().eq('id', d.id));
    else if (action === 'saveArticle') {
      const row = {
        section_id: d.section_id, title: d.title, body: d.body || '', images: d.images || [],
        access: ['staff', 'partners', 'all'].includes(d.access) ? d.access : 'staff',
        stage: Math.max(0, Math.min(9, Number(d.stage) || 0)),
        updated_at: new Date().toISOString(), updated_by: me.telegram_id,
      };
      // Новая статья встаёт в конец своего раздела
      if (!d.id) {
        const mx = chk(await db.from('articles').select('sort_order').eq('section_id', d.section_id)
          .order('sort_order', { ascending: false }).limit(1)).data;
        row.sort_order = ((mx[0] && mx[0].sort_order) || 0) + 1;
      }
      chk(await save('articles', row));
    }
    else if (action === 'reorder') {
      // Новый порядок статей внутри раздела: ids в нужной очерёдности
      const ids = (d.ids || []).map(Number).filter(Boolean);
      const rs = await Promise.all(ids.map((id, i) => db.from('articles').update({ sort_order: i + 1 }).eq('id', id)));
      rs.forEach(chk);
    }
    else if (action === 'deleteArticle') chk(await db.from('articles').delete().eq('id', d.id));
    else if (action === 'upload') {
      const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
      chk(await db.storage.from('images').upload(name, Buffer.from(d.data, 'base64'), { contentType: 'image/jpeg' }));
      out.name = name;
    }
    else if (action === 'listUsers') out.users = chk(await db.from('users').select('*').order('name')).data;
    else if (action === 'saveUser') chk(await db.from('users').upsert({
      telegram_id: Number(d.telegram_id), name: d.name,
      role: ['admin', 'partner', 'trainee'].includes(d.role) ? d.role : 'reader',
    }));
    else if (action === 'setStage') chk(await db.from('users')
      .update({ stage: Math.max(1, Number(d.stage) || 1) }).eq('telegram_id', d.telegram_id));
    else if (action === 'deleteUser') {
      if (Number(d.telegram_id) === me.telegram_id) throw new Error('Нельзя удалить себя');
      chk(await db.from('users').delete().eq('telegram_id', d.telegram_id));
    }
    else if (action === 'quizList') out.quizzes = chk(await db.from('quizzes').select('*').order('stage')).data;
    else if (action === 'quizSave') {
      const qs = (d.questions || []).map((x, i) => {
        const raw = (x.options || []).map((s) => String(s || '').trim());
        const opts = raw.filter(Boolean);
        const c = raw[x.correct] ? opts.indexOf(raw[x.correct]) : -1;
        if (!String(x.q || '').trim() || opts.length < 2 || c < 0) throw new Error('Вопрос ' + (i + 1) + ' заполнен не полностью');
        return { q: String(x.q).trim(), options: opts, correct: c };
      });
      if (!qs.length) throw new Error('Добавь хотя бы один вопрос');
      chk(await db.from('quizzes').upsert({
        stage: Math.max(1, Number(d.stage) || 1), title: d.title || '',
        pass_percent: Math.max(1, Math.min(100, Number(d.pass_percent) || 80)), questions: qs,
      }, { onConflict: 'stage' }));
    }
    else if (action === 'quizDelete') chk(await db.from('quizzes').delete().eq('stage', Number(d.stage)));
    else if (action === 'progress') {
      // Кто какие статьи открывал: бариста («читает») и стажёры
      out.users = chk(await db.from('users').select('telegram_id,name').eq('role', 'reader').order('name')).data;
      out.trainees = chk(await db.from('users').select('telegram_id,name,stage').eq('role', 'trainee').order('name')).data;
      out.articles = chk(await db.from('articles').select('id,title,stage').in('access', ['staff', 'all']).order('section_id').order('sort_order').order('id')).data;
      out.attempts = chk(await db.from('quiz_attempts').select('telegram_id,stage,score,passed,created_at')
        .order('created_at', { ascending: false }).limit(300)).data;
      let reads = [];
      for (let i = 0; ; i += 1000) {
        const x = chk(await db.from('reads').select('telegram_id,article_id').range(i, i + 999)).data;
        reads = reads.concat(x);
        if (x.length < 1000) break;
      }
      out.reads = reads;
    }
    else return res.status(400).json({ error: 'bad_action' });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || 'error' });
  }
};
