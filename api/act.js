const { db, auth } = require('./_lib');
const chk = (r) => { if (r.error) throw r.error; return r; };

// Отправка сообщения человеку от имени бота (кнопка открывает приложение)
async function tgSend(chatId, text, appUrl) {
  const body = { chat_id: chatId, text };
  if (appUrl) body.reply_markup = { inline_keyboard: [[{ text: 'Открыть базу знаний', web_app: { url: appUrl } }]] };
  try {
    const r = await fetch('https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    return !!j.ok;
  } catch (e) { return false; }
}
// Рассылка пачками по 15, чтобы не упереться в лимиты Telegram
async function broadcast(users, text, appUrl) {
  const failed = [];
  let sent = 0;
  for (let i = 0; i < users.length; i += 15) {
    const part = users.slice(i, i + 15);
    const rs = await Promise.all(part.map((u) => tgSend(u.telegram_id, text, appUrl)));
    rs.forEach((ok, k) => { if (ok) sent++; else failed.push(part[k].name); });
  }
  return { sent, failed };
}

// ---- Заявки на пончики ----
async function orderCfg() {
  const r = chk(await db.from('settings').select('value').eq('key', 'orders')).data[0];
  const v = (r && r.value) || {};
  return {
    items: Array.isArray(v.items) ? v.items : [],
    points: Array.isArray(v.points) ? v.points : [],
    recipient: Number(v.recipient) || null,
  };
}
// Кому слать заявки: назначенному получателю, а если его нет — всем редакторам
async function orderTo(cfg) {
  const all = chk(await db.from('users').select('telegram_id,name,role')).data;
  const one = cfg.recipient ? all.filter((u) => u.telegram_id === cfg.recipient) : [];
  return one.length ? one : all.filter((u) => u.role === 'admin');
}
const fdate = (s) => String(s).split('-').reverse().join('.');

// Состояние текущего этапа стажёра: сколько статей, все ли открыты, есть ли тест
async function stageState(me) {
  const cur = chk(await db.from('articles').select('id').in('access', ['staff', 'all']).eq('draft', false).eq('stage', me.stage)).data;
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
  const appUrl = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);

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
      // Редактор может «примерить» тест стажёра в режиме просмотра: ответы не сохраняются
      const pv = me.role === 'admin' && Number(d.preview_stage) > 0;
      if (me.role !== 'trainee' && !pv) return res.status(403).json({ error: 'trainee_only' });
      const eff = pv ? { ...me, stage: Number(d.preview_stage) } : me;
      const s = await stageState(eff);
      if (!s.hasQuiz) return res.status(400).json({ error: 'no_quiz' });
      if (!pv && !s.allRead) return res.status(400).json({ error: 'read_first' });
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
      // Сохраняем, что именно отвечал стажёр (вопрос, его ответ, правильный ответ)
      const detail = qs.map((x, i) => {
        const a = Number(d.answers && d.answers[i]);
        return { q: x.q, chosen: x.options[a] != null ? x.options[a] : '—', correct: x.options[x.correct], ok: a === x.correct };
      });
      if (!pv) {
        chk(await db.from('quiz_attempts').insert({ telegram_id: me.telegram_id, stage: me.stage, score, passed, detail }));
        if (passed) chk(await db.from('users').update({ stage: me.stage + 1 }).eq('telegram_id', me.telegram_id));
      }
      return res.json({ ok: 1, score, passed, wrong, preview: pv, wrongQ: detail.filter((m) => !m.ok).map((m) => m.q) });
    }

    // Предложения по улучшению: отправлять могут все
    if (action === 'sugCreate') {
      const kinds = { idea: 'Идея', error: 'Ошибка в статье', other: 'Другое' };
      const text = String(d.text || '').trim().slice(0, 2000);
      if (text.length < 5) throw new Error('Опиши предложение подробнее');
      const kind = kinds[d.kind] ? d.kind : 'other';
      const since = new Date(Date.now() - 864e5).toISOString();
      const cnt = chk(await db.from('suggestions').select('id').eq('created_by', me.telegram_id).gte('created_at', since)).data.length;
      if (cnt >= 10) throw new Error('Сегодня уже отправлено много предложений, попробуй завтра');
      const artId = Number(d.article_id) || null;
      const row = chk(await db.from('suggestions').insert({ created_by: me.telegram_id, kind, text, article_id: artId }).select('id')).data[0];
      let art = null;
      if (artId) { const a = chk(await db.from('articles').select('title').eq('id', artId)).data[0]; art = a && a.title; }
      const admins = chk(await db.from('users').select('telegram_id,name').eq('role', 'admin')).data;
      await broadcast(admins, '💡 Предложение №' + row.id + ' (' + kinds[kind] + ')\nот: ' + me.name + (art ? '\nСтатья: «' + art + '»' : '') + '\n\n' + text, appUrl);
      return res.json({ ok: 1 });
    }
    // Заявки на пончики: создавать и отменять свои могут бариста и редактор
    if (['orderCreate', 'orderMine', 'orderCancel'].includes(action)) {
      if (!['admin', 'reader'].includes(me.role)) return res.status(403).json({ error: 'admin_only' });
      const cfg = await orderCfg();
      if (action === 'orderMine') {
        return res.json({ ok: 1, orders: chk(await db.from('orders').select('*').eq('created_by', me.telegram_id).order('created_at', { ascending: false }).limit(20)).data });
      }
      if (action === 'orderCancel') {
        const o = chk(await db.from('orders').select('id,status,point').eq('id', d.id).eq('created_by', me.telegram_id)).data[0];
        if (!o) throw new Error('Заявка не найдена');
        if (o.status !== 'new') throw new Error('Заявку уже приняли, отменить нельзя');
        chk(await db.from('orders').update({ status: 'cancelled' }).eq('id', o.id));
        await broadcast(await orderTo(cfg), '🍩 Заявка №' + o.id + ' отменена (' + o.point + ')', appUrl);
        return res.json({ ok: 1 });
      }
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((x) => ({ name: String(x.name || '').slice(0, 80), qty: Math.max(0, Math.min(999, Number(x.qty) || 0)) }))
        .filter((x) => x.name && x.qty > 0).slice(0, 60);
      if (!items.length) throw new Error('Добавь хотя бы одну позицию');
      const point = String(d.point || '').trim().slice(0, 80);
      if (!point) throw new Error('Выбери точку');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) throw new Error('Укажи дату');
      const comment = String(d.comment || '').trim().slice(0, 500);
      const ins = chk(await db.from('orders').insert({ created_by: me.telegram_id, point, need_date: d.date, items, comment }).select('id'));
      const id = ins.data[0].id;
      const text = '🍩 Новая заявка №' + id + '\nТочка: ' + point + '\nНа дату: ' + fdate(d.date) + '\nОт: ' + me.name + '\n' +
        items.map((x) => '• ' + x.name + ': ' + x.qty).join('\n') + (comment ? '\nКомментарий: ' + comment : '');
      const r = await broadcast(await orderTo(cfg), text, appUrl);
      return res.json({ ok: 1, id, sent: r.sent });
    }
    // Управление заявками: редактор или назначенный получатель
    if (['orderList', 'orderStatus', 'orderSummary'].includes(action)) {
      const cfg = await orderCfg();
      if (me.role !== 'admin' && me.telegram_id !== cfg.recipient) return res.status(403).json({ error: 'admin_only' });
      if (action === 'orderList') {
        const orders = chk(await db.from('orders').select('*').order('need_date', { ascending: false }).order('created_at', { ascending: false }).limit(100)).data;
        const names = {};
        chk(await db.from('users').select('telegram_id,name')).data.forEach((u) => { names[u.telegram_id] = u.name; });
        return res.json({ ok: 1, orders, names });
      }
      if (action === 'orderStatus') {
        if (!['new', 'accepted', 'shipped', 'cancelled'].includes(d.status)) throw new Error('Неверный статус');
        const o = chk(await db.from('orders').update({ status: d.status }).eq('id', d.id).select('id,created_by')).data[0];
        if (o && o.created_by !== me.telegram_id) {
          const lab = { new: 'снова новая', accepted: 'принята', shipped: 'отгружена', cancelled: 'отменена' }[d.status];
          await tgSend(o.created_by, '🍩 Заявка №' + o.id + ': ' + lab, appUrl);
        }
        return res.json({ ok: 1 });
      }
      // Сводка на дату: сколько чего заказали всего и по точкам
      const rows = chk(await db.from('orders').select('point,items').eq('need_date', d.date).neq('status', 'cancelled')).data;
      const total = {};
      const per = {};
      rows.forEach((o) => (o.items || []).forEach((i) => {
        total[i.name] = (total[i.name] || 0) + i.qty;
        if (!per[o.point]) per[o.point] = {};
        per[o.point][i.name] = (per[o.point][i.name] || 0) + i.qty;
      }));
      return res.json({ ok: 1, count: rows.length, total: Object.entries(total).sort((a, b) => b[1] - a[1]), per });
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
        body_html: typeof d.body_html === 'string' ? d.body_html.slice(0, 200000) : null,
        access: ['staff', 'partners', 'all'].includes(d.access) ? d.access : 'staff',
        stage: Math.max(0, Math.min(9, Number(d.stage) || 0)),
        draft: !!d.draft,
        files: (Array.isArray(d.files) ? d.files : [])
          .filter((f) => f && typeof f.path === 'string' && f.path.startsWith('files/'))
          .slice(0, 10)
          .map((f) => ({ path: f.path, title: String(f.title || 'Файл').slice(0, 200), size: Number(f.size) || 0 })),
        updated_at: new Date().toISOString(), updated_by: me.telegram_id,
      };
      // Новая статья встаёт в конец своего раздела
      if (!d.id) {
        const mx = chk(await db.from('articles').select('sort_order').eq('section_id', d.section_id)
          .order('sort_order', { ascending: false }).limit(1)).data;
        row.sort_order = ((mx[0] && mx[0].sort_order) || 0) + 1;
      }
      const r = chk(await save('articles', row).select('id'));
      out.id = d.id || (r.data[0] && r.data[0].id);
    }
    else if (action === 'sugList') {
      const items = chk(await db.from('suggestions').select('*').order('created_at', { ascending: false }).limit(100)).data;
      const names = {};
      chk(await db.from('users').select('telegram_id,name')).data.forEach((u) => { names[u.telegram_id] = u.name; });
      const ids = [...new Set(items.map((x) => x.article_id).filter(Boolean))];
      const titles = {};
      if (ids.length) chk(await db.from('articles').select('id,title').in('id', ids)).data.forEach((a) => { titles[a.id] = a.title; });
      out.items = items.map((x) => ({ ...x, art: x.article_id ? titles[x.article_id] || null : null }));
      out.names = names;
    }
    else if (action === 'sugStatus') {
      if (!['new', 'seen', 'done'].includes(d.status)) throw new Error('Неверный статус');
      const sg = chk(await db.from('suggestions').update({ status: d.status }).eq('id', d.id).select('id,created_by')).data[0];
      if (sg && d.status !== 'new' && sg.created_by !== me.telegram_id) {
        await tgSend(sg.created_by, '💡 Твоё предложение №' + sg.id + ': ' + (d.status === 'done' ? 'сделано, спасибо!' : 'рассмотрено'), appUrl);
      }
    }
    else if (action === 'orderConfigGet') out.config = await orderCfg();
    else if (action === 'orderConfigSave') {
      const lines = (a) => (Array.isArray(a) ? a : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 100);
      chk(await db.from('settings').upsert({
        key: 'orders',
        value: { items: lines(d.items), points: lines(d.points), recipient: Number(d.recipient) || null },
      }, { onConflict: 'key' }));
    }
    else if (action === 'fileUrl') {
      // Адрес для прямой загрузки файла в хранилище (в обход лимита размера Vercel)
      const ext = ['.pdf', '.doc', '.docx'].includes(d.ext) ? d.ext : null;
      if (!ext) throw new Error('Подходят только PDF и Word');
      const path = 'files/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
      const r = await db.storage.from('images').createSignedUploadUrl(path);
      if (r.error) throw r.error;
      out.signedUrl = r.data.signedUrl;
      out.path = path;
    }
    else if (action === 'fileUpload') {
      // Запасной путь: файл до ~3 МБ через сервер
      const path = String(d.path || '');
      const ext = (path.match(/\.(pdf|docx?)$/) || [])[0];
      if (!path.startsWith('files/') || !ext) throw new Error('Неверный файл');
      const types = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      chk(await db.storage.from('images').upload(path, Buffer.from(d.data, 'base64'), { contentType: types[ext], upsert: true }));
    }
    else if (action === 'exportResults') {
      // Выгрузка результатов тестов: Word (.doc) с разбором ошибок или Excel (.csv)
      const tz = typeof d.tz === 'string' && d.tz.length < 60 ? d.tz : 'Europe/Moscow';
      const fmt = (v) => {
        try { return new Date(v).toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return String(v); }
      };
      let att = [];
      for (let i = 0; ; i += 1000) {
        let q = db.from('quiz_attempts').select('telegram_id,stage,score,passed,created_at,detail')
          .order('created_at', { ascending: true }).range(i, i + 999);
        if (d.telegram_id) q = q.eq('telegram_id', d.telegram_id);
        const x = chk(await q).data;
        att = att.concat(x);
        if (x.length < 1000) break;
      }
      if (!att.length) out.url = null;
      else {
        const names = {};
        chk(await db.from('users').select('telegram_id,name')).data.forEach((u) => { names[u.telegram_id] = u.name; });
        const nm = (id) => names[id] || ('ID ' + id);
        const by = {};
        att.forEach((a) => { (by[a.telegram_id] = by[a.telegram_id] || []).push(a); });
        const ids = Object.keys(by).sort((a, b) => nm(a).localeCompare(nm(b), 'ru'));
        const stamp = new Date().toISOString().slice(0, 10);
        let body, ext, ctype;
        if (d.format === 'csv') {
          const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
          const rows = [['Стажёр', 'Этап', 'Дата', 'Результат, %', 'Итог', 'Ошибки']];
          ids.forEach((id) => by[id].forEach((a) => rows.push([
            nm(id), a.stage, fmt(a.created_at), a.score, a.passed ? 'сдан' : 'не сдан',
            a.detail ? a.detail.filter((m) => !m.ok).map((m) => m.q + ' — ответил: ' + m.chosen + '; правильно: ' + m.correct).join('\n') : 'детали не сохранены',
          ])));
          body = '\ufeff' + rows.map((r) => r.map(q).join(';')).join('\r\n');
          ext = 'csv'; ctype = 'text/csv; charset=utf-8';
        } else {
          const h = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          let html = '<h1>Результаты тестов стажёров</h1><p>Выгрузка от ' + h(fmt(new Date())) + '</p>';
          html += '<h2>Сводка</h2><table><tr><th>Стажёр</th><th>Этап</th><th>Попыток</th><th>Лучший результат</th><th>Итог</th></tr>';
          ids.forEach((id) => {
            [...new Set(by[id].map((a) => a.stage))].sort((a, b) => a - b).forEach((g) => {
              const a = by[id].filter((x) => x.stage === g);
              const best = Math.max(...a.map((x) => x.score));
              const okA = a.find((x) => x.passed);
              html += '<tr><td>' + h(nm(id)) + '</td><td>' + g + '</td><td>' + a.length + '</td><td>' + best + '%</td><td>' + (okA ? 'сдан ' + h(fmt(okA.created_at)) : 'не сдан') + '</td></tr>';
            });
          });
          html += '</table>';
          ids.forEach((id) => {
            html += '<h2>' + h(nm(id)) + '</h2>';
            by[id].forEach((a) => {
              html += '<h3>Этап ' + a.stage + ' — ' + h(fmt(a.created_at)) + ' — ' + a.score + '% (' + (a.passed ? 'сдан' : 'не сдан') + ')</h3>';
              if (!a.detail) html += '<p><i>Детали этой попытки не сохранились.</i></p>';
              else {
                const w = a.detail.filter((m) => !m.ok);
                if (!w.length) html += '<p>Ошибок нет.</p>';
                else {
                  html += '<table><tr><th>Вопрос</th><th>Ответ стажёра</th><th>Правильный ответ</th></tr>';
                  w.forEach((m) => { html += '<tr><td>' + h(m.q) + '</td><td>' + h(m.chosen) + '</td><td>' + h(m.correct) + '</td></tr>'; });
                  html += '</table>';
                }
              }
            });
          });
          body = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>Результаты тестов</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}table{border-collapse:collapse;margin:6px 0 12px}td,th{border:1px solid #999;padding:4px 8px;vertical-align:top}th{background:#e9e2d8}h1{font-size:20pt}h2{font-size:15pt;margin-top:18pt}h3{font-size:12pt}</style></head><body>' + html + '</body></html>';
          ext = 'doc'; ctype = 'application/msword';
        }
        // Удаляем выгрузки старше часа, чтобы не копились
        try {
          const old = await db.storage.from('images').list('exports', { limit: 100 });
          const dead = (old.data || []).filter((f) => Date.now() - new Date(f.created_at).getTime() > 3600e3).map((f) => 'exports/' + f.name);
          if (dead.length) await db.storage.from('images').remove(dead);
        } catch (e) { /* не критично */ }
        const path = 'exports/' + Date.now() + '.' + ext;
        chk(await db.storage.from('images').upload(path, Buffer.from(body, 'utf8'), { contentType: ctype }));
        const sg = await db.storage.from('images').createSignedUrl(path, 600, { download: 'test-results-' + stamp + '.' + ext });
        if (sg.error) throw sg.error;
        out.url = sg.data.signedUrl;
      }
    }
    else if (action === 'notify') {
      // Уведомление в Telegram: об одной статье или свободное сообщение
      const appUrl = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
      const all = chk(await db.from('users').select('telegram_id,name,role,stage').neq('role', 'admin')).data;
      let to, text;
      if (d.article_id) {
        const a = chk(await db.from('articles').select('title,access,stage,section_id,draft').eq('id', d.article_id)).data[0];
        if (!a) throw new Error('Статья не найдена');
        if (a.draft) throw new Error('Статья в черновиках: уведомление не отправлено');
        const sec = chk(await db.from('sections').select('title').eq('id', a.section_id)).data[0];
        const roles = a.access === 'partners' ? ['partner'] : a.access === 'all' ? ['reader', 'trainee', 'partner'] : ['reader', 'trainee'];
        // Стажёр получает уведомление, только если статья уже открыта на его этапе
        to = all.filter((u) => roles.includes(u.role) && (u.role !== 'trainee' || (a.stage >= 1 && u.stage >= a.stage)));
        text = (d.kind === 'new' ? '📚 Новая статья' : '📚 Статья обновлена') + '\n«' + a.title + '»' + (sec ? '\nРаздел: ' + sec.title : '');
      } else {
        const set = { all: ['reader', 'trainee', 'partner'], staff: ['reader', 'trainee'], trainees: ['trainee'], partners: ['partner'] }[d.audience] || ['reader', 'trainee'];
        to = all.filter((u) => set.includes(u.role));
        text = String(d.text || '').trim();
        if (!text) throw new Error('Введи текст сообщения');
      }
      Object.assign(out, await broadcast(to, text.slice(0, 3500), appUrl));
      out.total = to.length;
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
    else if (action === 'setRole') {
      if (Number(d.telegram_id) === me.telegram_id) throw new Error('Свою роль менять нельзя');
      if (!['admin', 'reader', 'partner', 'trainee'].includes(d.role)) throw new Error('Неверная роль');
      chk(await db.from('users').update({ role: d.role }).eq('telegram_id', d.telegram_id));
    }
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
      const stage = Math.max(1, Number(d.stage) || 1);
      const row = {
        stage, title: d.title || '',
        pass_percent: Math.max(1, Math.min(100, Number(d.pass_percent) || 80)), questions: qs,
      };
      const old = Number(d.old_stage) || 0;
      if (old && old !== stage) {
        // Перенос теста на другой этап: целевой этап должен быть свободен
        const clash = chk(await db.from('quizzes').select('id').eq('stage', stage)).data;
        if (clash.length) throw new Error('На этапе ' + stage + ' уже есть тест. Выбери свободный этап или сначала удали тот тест');
        chk(await db.from('quizzes').update(row).eq('stage', old));
      } else chk(await db.from('quizzes').upsert(row, { onConflict: 'stage' }));
    }
    else if (action === 'quizDelete') chk(await db.from('quizzes').delete().eq('stage', Number(d.stage)));
    else if (action === 'progress') {
      // Кто какие статьи открывал: бариста («читает») и стажёры
      out.users = chk(await db.from('users').select('telegram_id,name').eq('role', 'reader').order('name')).data;
      const nmap = {};
      chk(await db.from('users').select('telegram_id,name')).data.forEach((u) => { nmap[u.telegram_id] = u.name; });
      out.names = nmap;
      out.trainees = chk(await db.from('users').select('telegram_id,name,stage').eq('role', 'trainee').order('name')).data;
      out.articles = chk(await db.from('articles').select('id,title,stage').in('access', ['staff', 'all']).eq('draft', false).order('section_id').order('sort_order').order('id')).data;
      let attempts = [];
      for (let i = 0; ; i += 1000) {
        const x = chk(await db.from('quiz_attempts').select('id,telegram_id,stage,score,passed,created_at,detail')
          .order('created_at', { ascending: false }).range(i, i + 999)).data;
        attempts = attempts.concat(x);
        if (x.length < 1000) break;
      }
      out.attempts = attempts;
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
