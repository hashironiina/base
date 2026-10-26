const { db, auth } = require('./_lib');
const chk = (r) => { if (r.error) throw r.error; return r; };

// ---- Выгрузка результатов тестов: Word (.docx) и Excel (.csv) без внешних библиотек ----
const CRC_T = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_T[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Простейший zip (без сжатия): docx — это zip с XML-файлами
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const wx = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrun = (t, o = {}) => '<w:r><w:rPr>' + (o.b ? '<w:b/>' : '') + (o.i ? '<w:i/>' : '') + (o.sz ? '<w:sz w:val="' + o.sz + '"/>' : '') +
  '</w:rPr><w:t xml:space="preserve">' + wx(t) + '</w:t></w:r>';
const wpara = (t, o = {}) => '<w:p><w:pPr><w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after == null ? 120 : o.after) + '"/></w:pPr>' + wrun(t, o) + '</w:p>';
const wcell = (t, w, hdr) => '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (hdr ? '<w:shd w:val="clear" w:color="auto" w:fill="E9E2D8"/>' : '') + '</w:tcPr>' +
  String(t == null ? '' : t).split('\n').map((l) => '<w:p>' + wrun(l, { b: hdr }) + '</w:p>').join('') + '</w:tc>';
const wtable = (rows, widths) => '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="999999"/>').join('') +
  '</w:tblBorders></w:tblPr><w:tblGrid>' + widths.map((w) => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>' +
  rows.map((r, i) => '<w:tr>' + r.map((c, j) => wcell(c, widths[j], i === 0)).join('') + '</w:tr>').join('') + '</w:tbl><w:p/>';

function buildExport({ att, names, format, tz }) {
  const zone = typeof tz === 'string' && tz.length < 60 ? tz : 'Europe/Moscow';
  const fmt = (v) => {
    try { return new Date(v).toLocaleString('ru-RU', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(v); }
  };
  const nm = (id) => names[id] || ('ID ' + id);
  const by = {};
  att.forEach((a) => { (by[a.telegram_id] = by[a.telegram_id] || []).push(a); });
  const ids = Object.keys(by).sort((a, b) => nm(a).localeCompare(nm(b), 'ru'));
  const stamp = new Date().toISOString().slice(0, 10);
  const wrongOf = (a) => (a.detail || []).filter((m) => !m.ok);

  if (format === 'csv') {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['Стажёр', 'Этап', 'Дата', 'Результат, %', 'Итог', 'Ошибки']];
    ids.forEach((id) => by[id].forEach((a) => rows.push([
      nm(id), a.stage, fmt(a.created_at), a.score, a.passed ? 'сдан' : 'не сдан',
      a.detail ? wrongOf(a).map((m) => m.q + ' — ответил: ' + m.chosen + '; правильно: ' + m.correct).join('\n') : 'детали не сохранены',
    ])));
    return {
      buffer: Buffer.from('\ufeff' + rows.map((r) => r.map(q).join(';')).join('\r\n'), 'utf8'),
      filename: 'test-results-' + stamp + '.csv',
      mime: 'text/csv',
    };
  }

  let body = wpara('Результаты тестов стажёров', { b: 1, sz: 36, after: 80 }) + wpara('Выгрузка от ' + fmt(new Date()), { i: 1, after: 240 });
  body += wpara('Сводка', { b: 1, sz: 28, before: 120 });
  const sum = [['Стажёр', 'Этап', 'Попыток', 'Лучший результат', 'Итог']];
  ids.forEach((id) => {
    [...new Set(by[id].map((a) => a.stage))].sort((a, b) => a - b).forEach((g) => {
      const a = by[id].filter((x) => x.stage === g);
      const okA = a.find((x) => x.passed);
      sum.push([nm(id), String(g), String(a.length), Math.max(...a.map((x) => x.score)) + '%', okA ? 'сдан ' + fmt(okA.created_at) : 'не сдан']);
    });
  });
  body += wtable(sum, [2400, 800, 1100, 1700, 3000]);
  ids.forEach((id) => {
    body += wpara(nm(id), { b: 1, sz: 28, before: 240 });
    by[id].forEach((a) => {
      body += wpara('Этап ' + a.stage + ' — ' + fmt(a.created_at) + ' — ' + a.score + '% (' + (a.passed ? 'сдан' : 'не сдан') + ')', { b: 1, before: 120, after: 80 });
      if (!a.detail) body += wpara('Детали этой попытки не сохранились.', { i: 1 });
      else if (!wrongOf(a).length) body += wpara('Ошибок нет.');
      else body += wtable([['Вопрос', 'Ответ стажёра', 'Правильный ответ']].concat(wrongOf(a).map((m) => [m.q, m.chosen, m.correct])), [4200, 2400, 2400]);
    });
  });
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return {
    buffer: zipStore([
      { name: '[Content_Types].xml', data: Buffer.from(types, 'utf8') },
      { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
      { name: 'word/document.xml', data: Buffer.from(doc, 'utf8') },
    ]),
    filename: 'test-results-' + stamp + '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

// Отправка файла в личный чат с ботом (надёжнее, чем ссылка из приложения)
async function tgSendDoc(chatId, filename, buffer, mime, caption) {
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', caption);
    fd.append('document', new Blob([buffer], { type: mime }), filename);
    const r = await fetch('https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/sendDocument', { method: 'POST', body: fd });
    const j = await r.json();
    return !!j.ok;
  } catch (e) { return false; }
}



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

// Если стажёр прошёл последний этап, он автоматически становится бариста
async function promoteIfDone(me, newStage, appUrl) {
  const top = chk(await db.from('articles').select('stage').in('access', ['staff', 'all']).eq('draft', false)
    .order('stage', { ascending: false }).limit(1)).data;
  const max = (top[0] && top[0].stage) || 0;
  if (!(max > 0 && newStage > max)) return false;
  chk(await db.from('users').update({ role: 'reader' }).eq('telegram_id', me.telegram_id));
  const admins = chk(await db.from('users').select('telegram_id,name').eq('role', 'admin')).data;
  await broadcast(admins, '🎓 ' + me.name + ' прошёл(а) обучение. Роль изменена: стажёр → бариста.', appUrl);
  await tgSend(me.telegram_id, '🎉 Обучение пройдено! Теперь тебе открыты все материалы.', appUrl);
  return true;
}

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
      let graduated = false;
      // Если у этапа нет теста, он открывается сам, когда стажёр открыл все его статьи
      if (me.role === 'trainee') {
        const s = await stageState(me);
        if (s.count > 0 && s.allRead && !s.hasQuiz) {
          chk(await db.from('users').update({ stage: me.stage + 1 }).eq('telegram_id', me.telegram_id));
          advanced = true;
          graduated = await promoteIfDone(me, me.stage + 1, appUrl);
        }
      }
      return res.json({ ok: 1, advanced, graduated });
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
      let graduated = false;
      if (!pv) {
        chk(await db.from('quiz_attempts').insert({ telegram_id: me.telegram_id, stage: me.stage, score, passed, detail }));
        if (passed) {
          chk(await db.from('users').update({ stage: me.stage + 1 }).eq('telegram_id', me.telegram_id));
          graduated = await promoteIfDone(me, me.stage + 1, appUrl);
        }
      }
      return res.json({ ok: 1, score, passed, wrong, graduated, preview: pv, wrongQ: detail.filter((m) => !m.ok).map((m) => m.q) });
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
      // Выгрузка результатов тестов: Word (.docx) с разбором ошибок или Excel (.csv)
      let att = [];
      for (let i = 0; ; i += 1000) {
        let q = db.from('quiz_attempts').select('telegram_id,stage,score,passed,created_at,detail')
          .order('created_at', { ascending: true }).range(i, i + 999);
        if (d.telegram_id) q = q.eq('telegram_id', d.telegram_id);
        const x = chk(await q).data;
        att = att.concat(x);
        if (x.length < 1000) break;
      }
      if (!att.length) out.empty = true;
      else {
        const names = {};
        chk(await db.from('users').select('telegram_id,name')).data.forEach((u) => { names[u.telegram_id] = u.name; });
        const f = buildExport({ att, names, format: d.format === 'csv' ? 'csv' : 'doc', tz: d.tz });
        // Основной путь: бот присылает файл в личный чат
        if (await tgSendDoc(me.telegram_id, f.filename, f.buffer, f.mime, 'Результаты тестов стажёров')) out.sent = true;
        else {
          // Запасной путь: ссылка на скачивание
          try {
            const old = await db.storage.from('images').list('exports', { limit: 100 });
            const dead = (old.data || []).filter((x) => Date.now() - new Date(x.created_at).getTime() > 3600e3).map((x) => 'exports/' + x.name);
            if (dead.length) await db.storage.from('images').remove(dead);
            const path = 'exports/' + Date.now() + '-' + f.filename;
            chk(await db.storage.from('images').upload(path, f.buffer, { contentType: f.mime }));
            const sg = await db.storage.from('images').createSignedUrl(path, 600, { download: f.filename });
            if (sg.error) throw sg.error;
            out.url = sg.data.signedUrl;
          } catch (e) {
            throw new Error('Не получилось отправить файл. Открой чат с ботом, нажми Start и повтори');
          }
        }
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
