'use strict';
/*
 * Монтажёр — Telegram-бот, который учится стилю монтажа автора.
 * Этап 1: приём готовых роликов-примеров → разбор → «паспорт стиля» → правки автора.
 *
 * Без внешних библиотек: нужен только Node.js 20+ и ffmpeg/ffprobe.
 * Настройки — через переменные окружения (см. montazh-README.md).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ───────────────────────────── Настройки ─────────────────────────────

const CFG = {
  token: (process.env.BOT_TOKEN || '').trim(),
  geminiKey: (process.env.GEMINI_API_KEY || '').trim(),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiUrl: (process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
  // Цена за 1 млн токенов, только для подсказки о расходах в /status
  priceIn: Number(process.env.PRICE_IN || 0.75),
  priceOut: Number(process.env.PRICE_OUT || 3.75),
  // Свой сервер Bot API (нужен для файлов больше 20 МБ)
  botApiUrl: (process.env.BOT_API_URL || '').replace(/\/+$/, ''),
  botApiBin: process.env.BOT_API_BIN || '/usr/local/bin/telegram-bot-api',
  botApiPort: Number(process.env.BOT_API_PORT || 8081),
  apiId: (process.env.TELEGRAM_API_ID || '').trim(),
  apiHash: (process.env.TELEGRAM_API_HASH || '').trim(),
  dataDir: process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'),
  allowed: (process.env.ALLOWED_USERS || '').split(/[,\s]+/).filter(Boolean),
  sceneThreshold: Number(process.env.SCENE_THRESHOLD || 0.3),
  maxExampleSec: Number(process.env.MAX_EXAMPLE_SEC || 600),
  maxExamples: Number(process.env.MAX_EXAMPLES || 30),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
};

const CLOUD_API = 'https://api.telegram.org';
let TG_BASE = CLOUD_API; // куда бот шлёт запросы Telegram
let LOCAL_MODE = false; // true — работает свой сервер Bot API, файлы читаются с диска
let OWNER = ''; // id владельца, если ALLOWED_USERS не задан

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ───────────────────────────── Мелкие помощники ─────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Число по-русски: 1.6 → «1,6» */
function num(n, digits = 1) {
  if (n == null || !isFinite(n)) return '—';
  const r = Number(n).toFixed(digits);
  return (digits > 0 ? r.replace(/\.?0+$/, '') : r).replace('.', ',');
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/** Любое значение из ответа ИИ → короткая строка для показа */
function txt(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (Array.isArray(v)) return v.map(txt).filter(Boolean).join('; ');
  if (typeof v === 'object') {
    return Object.entries(v)
      .map(([k, x]) => [k, txt(x)])
      .filter(([, x]) => x)
      .map(([k, x]) => `${k}: ${x}`)
      .join('; ');
  }
  return String(v).trim();
}

function parseJsonLoose(text) {
  const t = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    /* пробуем вырезать объект из текста */
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (_) {
      /* ниже общая ошибка */
    }
  }
  throw new Error('ИИ вернул ответ не в том формате');
}

/** Запуск внешней программы (ffmpeg, ffprobe) */
function run(cmd, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const cap = (s) => (s.length > 16e6 ? s.slice(-8e6) : s);
    p.stdout.on('data', (d) => (out = cap(out + d)));
    p.stderr.on('data', (d) => (err = cap(err + d)));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)}: обработка заняла слишком много времени`));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`на сервере не найдена программа ${cmd}`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// ───────────────────────────── Хранилище ─────────────────────────────

const users = new Map();
const userDir = (id) => path.join(CFG.dataDir, 'users', String(id));

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1));
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function getUser(id, name) {
  id = String(id);
  if (!users.has(id)) {
    const u = await readJson(path.join(userDir(id), 'state.json'), null);
    users.set(
      id,
      u || { id, name: name || '', seq: 0, examples: [], passport: null, prevPassport: null, corrections: [], usage: { in: 0, out: 0, calls: 0 } }
    );
  }
  return users.get(id);
}
const saveUser = (u) => writeJson(path.join(userDir(u.id), 'state.json'), u);

// ───────────────────────────── Telegram ─────────────────────────────

async function tg(method, params = {}, timeoutMs = 60000) {
  let res;
  try {
    res = await fetch(`${TG_BASE}/bot${CFG.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`Telegram ${method}: нет связи (${e.name || e.message})`);
  }
  const j = await res.json().catch(() => null);
  if (!j || !j.ok) {
    const e = new Error(`Telegram ${method}: ${j ? j.description : `HTTP ${res.status}`}`);
    e.code = j ? j.error_code : res.status;
    throw e;
  }
  return j.result;
}

const kb = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });

function send(chatId, html, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
}

function edit(chatId, messageId, html, extra = {}) {
  return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', ...extra }).catch((e) => {
    if (!/not modified/i.test(e.message)) log('edit:', e.message);
  });
}

/** Длинный текст режется на части по абзацам; кнопки — под последней частью */
async function sendLong(chatId, html, extra = {}) {
  const blocks = html.split('\n\n');
  const parts = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > 3800) {
      parts.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) parts.push(cur);
  let last;
  for (let i = 0; i < parts.length; i++) last = await send(chatId, parts[i], i === parts.length - 1 ? extra : {});
  return last;
}

// ───────────────────────────── Измерения ролика (без ИИ) ─────────────────────────────

async function probe(file) {
  const r = await run(CFG.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000);
  let j;
  try {
    j = JSON.parse(r.out);
  } catch (_) {
    j = null;
  }
  const v = j && (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('это не похоже на видео — файл не открывается');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const frac = (s) => {
    const [x, y] = String(s || '0/1').split('/').map(Number);
    return y ? x / y : x || 0;
  };
  let w = v.width;
  let h = v.height;
  const rot = Math.abs(Number((v.tags && v.tags.rotate) || ((v.side_data_list || []).find((d) => d.rotation != null) || {}).rotation || 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  const duration = Number(j.format.duration) || Number(v.duration) || 0;
  if (!duration) throw new Error('не удалось определить длительность видео');
  const ratio = w / h;
  return {
    duration,
    width: w,
    height: h,
    fps: Math.round((frac(v.avg_frame_rate) || frac(v.r_frame_rate)) * 100) / 100,
    hasAudio: !!a,
    orientation: ratio < 0.9 ? 'вертикальный' : ratio > 1.1 ? 'горизонтальный' : 'квадратный',
    sizeMb: Math.round((Number(j.format.size) / 1e6) * 10) / 10,
  };
}

/** Точные моменты склеек: ffmpeg сравнивает соседние кадры */
async function detectCuts(file, meta) {
  const vf = `scale=320:-2,select='gt(scene,${CFG.sceneThreshold})',metadata=print:file=-`;
  const r = await run(CFG.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', vf, '-f', 'null', '-']);
  if (r.code !== 0) throw new Error('не удалось разобрать видеоряд');
  const cuts = [];
  for (const m of r.out.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(m[1]);
    const prev = cuts.length ? cuts[cuts.length - 1] : 0;
    if (t - prev >= 0.25 && meta.duration - t >= 0.15) cuts.push(Math.round(t * 100) / 100);
  }
  return cuts;
}

function shotStats(cuts, duration) {
  const edges = [0, ...cuts, duration];
  const shots = [];
  for (let i = 1; i < edges.length; i++) shots.push(Math.round((edges[i] - edges[i - 1]) * 100) / 100);
  return {
    shots,
    count: shots.length,
    avg: mean(shots),
    median: median(shots),
    min: Math.min(...shots),
    max: Math.max(...shots),
    cutsPerMin: (cuts.length / duration) * 60,
    first: shots[0],
  };
}

async function audioStats(file, meta) {
  if (!meta.hasAudio) return null;
  const r = await run(CFG.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.35,volumedetect', '-f', 'null', '-']);
  const g = (re) => {
    const m = r.err.match(re);
    return m ? Number(m[1]) : null;
  };
  let silence = 0;
  for (const m of r.err.matchAll(/silence_duration:\s*([\d.]+)/g)) silence += Number(m[1]);
  return {
    meanDb: g(/mean_volume:\s*(-?[\d.]+) dB/),
    maxDb: g(/max_volume:\s*(-?[\d.]+) dB/),
    silenceShare: Math.min(1, silence / meta.duration),
  };
}

/** Сводные цифры по всем разобранным примерам */
function aggregate(examples) {
  const ok = examples.filter((e) => e.shots);
  const all = ok.flatMap((e) => e.shots.shots);
  const durs = ok.map((e) => e.meta.duration);
  const share = (from, to) => (all.length ? all.filter((s) => s >= from && s < to).length / all.length : 0);
  const orient = {};
  for (const e of ok) orient[e.meta.orientation] = (orient[e.meta.orientation] || 0) + 1;
  return {
    count: ok.length,
    durMin: durs.length ? Math.min(...durs) : 0,
    durMax: durs.length ? Math.max(...durs) : 0,
    durMedian: median(durs),
    shotAvg: mean(all),
    shotMedian: median(all),
    cutsPerMin: mean(ok.map((e) => e.shots.cutsPerMin)),
    firstShot: median(ok.map((e) => e.shots.first)),
    buckets: { under1: share(0, 1), s1to2: share(1, 2), s2to4: share(2, 4), over4: share(4, Infinity) },
    orientation: Object.entries(orient).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || '',
    withAudio: ok.filter((e) => e.meta.hasAudio).length,
    silenceShare: mean(ok.filter((e) => e.audio).map((e) => e.audio.silenceShare)),
  };
}

// ───────────────────────────── Gemini ─────────────────────────────

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

async function gfetch(url, opts, timeoutMs) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`нет связи с ИИ-сервисом (${e.name || e.message})`);
  }
}

async function geminiUpload(file) {
  const mime = MIME[path.extname(file).toLowerCase()] || 'video/mp4';
  const size = (await fsp.stat(file)).size;
  const start = await gfetch(
    `${CFG.geminiUrl}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': CFG.geminiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: path.basename(file) } }),
    },
    60000
  );
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw new Error(`ИИ-сервис не принял файл (HTTP ${start.status}): ${(await start.text()).slice(0, 200)}`);
  const body = fs.openAsBlob ? await fs.openAsBlob(file, { type: mime }) : await fsp.readFile(file);
  const up = await gfetch(
    uploadUrl,
    { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body },
    20 * 60 * 1000
  );
  const j = await up.json().catch(() => null);
  let f = j && (j.file || j);
  if (!up.ok || !f || !f.name) throw new Error(`ИИ-сервис не принял файл (HTTP ${up.status})`);
  // Видео обрабатывается на стороне сервиса — ждём готовности
  for (let i = 0; i < 150 && f.state === 'PROCESSING'; i++) {
    await sleep(2000);
    const r = await gfetch(`${CFG.geminiUrl}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': CFG.geminiKey } }, 30000);
    const jj = await r.json().catch(() => null);
    if (r.ok && jj) f = jj.file || jj;
  }
  if (f.state && f.state !== 'ACTIVE') throw new Error('ИИ-сервис не смог обработать это видео');
  return { name: f.name, uri: f.uri, mime };
}

function geminiDelete(name) {
  return gfetch(`${CFG.geminiUrl}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': CFG.geminiKey } }, 30000).catch(() => {});
}

/** Запрос к модели. Возвращает разобранный JSON. */
async function geminiJson(user, parts) {
  const url = `${CFG.geminiUrl}/v1beta/models/${CFG.geminiModel}:generateContent`;
  const base = { contents: [{ role: 'user', parts }] };
  // Сначала просим строгий JSON; если сервис не знает такой настройки — повторяем без неё
  let variants = [{ ...base, generationConfig: { responseMimeType: 'application/json' } }, base];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await gfetch(
      url,
      { method: 'POST', headers: { 'x-goog-api-key': CFG.geminiKey, 'content-type': 'application/json' }, body: JSON.stringify(variants[0]) },
      10 * 60 * 1000
    );
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (j && j.error && j.error.message) || `HTTP ${res.status}`;
      lastErr = new Error(`ИИ-сервис ответил ошибкой: ${msg.slice(0, 300)}`);
      if (res.status === 400 && variants.length > 1) {
        variants = variants.slice(1);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
    const um = (j && j.usageMetadata) || {};
    user.usage.in += um.promptTokenCount || 0;
    user.usage.out += (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
    user.usage.calls += 1;
    const cand = j && j.candidates && j.candidates[0];
    const text = cand && cand.content && (cand.content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    if (!text) {
      const why = (j && j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || 'пустой ответ';
      lastErr = new Error(`ИИ не дал ответа (${why})`);
      continue;
    }
    try {
      return parseJsonLoose(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('ИИ-сервис не отвечает');
}

const EXAMPLE_SCHEMA = `{
  "type": "речь | визуальный | смешанный",
  "topic": "о чём ролик, одна фраза",
  "structure": [{"from": 0, "to": 3, "part": "заход", "what": "что происходит в этой части"}],
  "hook": "чем ролик цепляет в первые 3 секунды",
  "ending": "чем заканчивается, есть ли призыв к действию",
  "speech": {"present": true, "who": "автор в кадре / голос за кадром", "share": "примерная доля ролика с речью, %", "manner": "темп и манера речи"},
  "jump_cuts": "вырезаны ли паузы внутри речи и насколько плотно",
  "broll": "перебивки: что показывают, как часто, какой длины, поверх речи или отдельно",
  "subtitles": {"present": true, "position": "где на экране", "look": "цвет, обводка или плашка, регистр, размер, характер шрифта", "animation": "по словам / по фразам / статично", "highlight": "как выделяются ключевые слова"},
  "titles": "другие надписи, плашки, стикеры, эмодзи",
  "music": {"present": true, "mood": "настроение и жанр", "tempo": "медленный / средний / быстрый", "level": "тише речи / наравне / громче", "on_beat": "попадают ли склейки в бит", "changes": "где вступает, стихает, меняется"},
  "sfx": "звуковые эффекты",
  "transitions": ["виды переходов между планами"],
  "camera_fx": "приближения, наезды, тряска, ускорения и замедления",
  "color": "цвет и свет: тёплый/холодный, контраст, насыщенность, заметный фильтр",
  "framing": "крупность планов и композиция",
  "signature": ["3–6 самых характерных приёмов этого ролика"]
}`;

function promptExample(ex) {
  return `Ты — опытный режиссёр монтажа. Перед тобой готовый ролик автора. Разбери его как образец авторского стиля: мне нужно потом монтировать новые ролики так же.

Точные измерения ролика (сделаны алгоритмом, доверяй им больше, чем собственной оценке):
- длительность: ${ex.meta.duration.toFixed(1)} с, кадр ${ex.meta.width}×${ex.meta.height} (${ex.meta.orientation}), звук: ${ex.meta.hasAudio ? 'есть' : 'нет'}
- найдено склеек: ${ex.cuts.length}; секунды склеек: ${ex.cuts.slice(0, 250).join(', ') || 'нет'}
- средняя длина плана: ${ex.shots.avg.toFixed(2)} с
Алгоритм видит только резкую смену картинки. Склейки внутри одного и того же плана (вырезанные паузы в речи) он может пропускать — оцени их сам.

Описывай только то, что действительно видно и слышно. Если чего-то нет — так и пиши («нет»). Не выдумывай.
Ответь строго одним JSON-объектом без пояснений, значения на русском языке, по этому образцу:
${EXAMPLE_SCHEMA}`;
}

const PASSPORT_SCHEMA = `{
  "format": "тип роликов автора, одна фраза",
  "structure": [{"part": "Заход", "when": "первые 2–3 с", "what": "что автор обычно делает в этой части"}],
  "selection": "какие моменты автор оставляет в ролике и что, судя по примерам, вырезает",
  "pacing": "как автор работает с темпом: где быстрее, где медленнее, от чего зависит длина плана",
  "speech": "речь: кто говорит, манера, вырезаются ли паузы",
  "broll": "перебивки: что показывают, как часто, какой длины",
  "subtitles": {"use": true, "position": "", "look": "", "animation": "", "highlight": ""},
  "titles": "другие надписи и плашки",
  "music": {"use": true, "mood": "", "level": "", "on_beat": ""},
  "sfx": "звуковые эффекты",
  "transitions": "какие переходы и когда",
  "camera_fx": "приближения, наезды, ускорения",
  "color": "цвет и свет",
  "ending": "как автор заканчивает ролики",
  "rules": ["10–15 конкретных правил монтажа в повелительном наклонении, по которым можно собрать новый ролик"],
  "varies": ["что меняется от ролика к ролику и от чего это зависит"],
  "questions": ["до 3 коротких вопросов автору о том, чего по примерам понять нельзя"]
}`;

function compactExample(e) {
  return {
    n: e.n,
    measured: {
      duration_sec: Math.round(e.meta.duration * 10) / 10,
      orientation: e.meta.orientation,
      cuts: e.cuts.length,
      avg_shot_sec: Math.round(e.shots.avg * 100) / 100,
      median_shot_sec: Math.round(e.shots.median * 100) / 100,
      first_shot_sec: e.shots.first,
      cuts_per_min: Math.round(e.shots.cutsPerMin),
      silence_share: e.audio ? Math.round(e.audio.silenceShare * 100) / 100 : null,
    },
    analysis: e.ai,
  };
}

function promptPassport(user, examples, agg) {
  const fixes = user.corrections.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  return `Ты — опытный режиссёр монтажа. Ниже разборы ${examples.length} готовых роликов одного автора. Составь «паспорт стиля»: устойчивые правила, по которым этот автор монтирует. По паспорту другой монтажёр должен собрать новый ролик так, чтобы автор узнал свою руку.

Правила составления:
- В паспорт идёт только то, что повторяется в большинстве роликов. Разовые приёмы — в "varies".
- Пиши конкретно: числа, места на экране, секунды. Никаких общих слов вроде «динамичный монтаж».
- Правила в "rules" должны быть проверяемыми: по каждому можно сказать, выполнено оно или нет.
- Не выдумывай того, чего нет в разборах.${fixes ? '\n- Слова автора важнее наблюдений. Если правка автора противоречит разборам — верь автору.' : ''}

Сводные измерения по всем роликам (точные):
${JSON.stringify(agg)}

Разборы роликов:
${JSON.stringify(examples.map(compactExample))}
${fixes ? `\nПравки автора к прошлым версиям паспорта (обязательно учти все):\n${fixes}\n` : ''}
Ответь строго одним JSON-объектом без пояснений, значения на русском языке, по этому образцу:
${PASSPORT_SCHEMA}`;
}

function promptCorrection(user, text) {
  const earlier = user.corrections.slice(0, -1).map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  return `Ниже «паспорт стиля» монтажа автора в виде JSON и новая правка от самого автора. Внеси правку в паспорт.

Правила:
- Слова автора важнее всего, что написано в паспорте.
- Меняй только то, чего касается правка, остальное оставь как есть. Обнови и связанные пункты в "rules", чтобы паспорт не противоречил сам себе.
- Если правка отвечает на один из вопросов в "questions" — убери этот вопрос.
- Верни паспорт целиком, в том же формате, значения на русском языке, без пояснений.
${earlier ? `\nПрежние правки автора (они уже учтены, не отменяй их):\n${earlier}\n` : ''}
Текущий паспорт:
${JSON.stringify(user.passport.data)}

Новая правка автора:
«${text}»`;
}

// ───────────────────────────── Показ паспорта ─────────────────────────────

function renderPassport(user) {
  const p = user.passport.data || {};
  const m = user.passport.measured;
  const out = [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const line = (label, v) => {
    const s = txt(v);
    return s ? `• ${label ? `<i>${label}:</i> ` : ''}${esc(s)}` : '';
  };
  const block = (title, lines) => {
    const body = lines.filter(Boolean);
    if (body.length) out.push(`<b>${title}</b>\n${body.join('\n')}`);
  };

  out.push(
    `🧬 <b>Паспорт стиля</b> · версия ${user.passport.version} · по ${m.count} ${plural(m.count, 'ролику', 'роликам', 'роликам')}` +
      (p.format ? `\n${esc(txt(p.format))}` : '')
  );

  block('⏱ Темп — измерено по вашим роликам', [
    num(m.durMin, 0) === num(m.durMax, 0)
      ? `• длина ролика: около ${num(m.durMedian, 0)} с`
      : `• длина ролика: ${num(m.durMin, 0)}–${num(m.durMax, 0)} с, обычно около ${num(m.durMedian, 0)} с`,
    `• склейка в среднем каждые ${num(m.shotAvg)} с (≈${num(m.cutsPerMin, 0)} в минуту)`,
    `• первый план: около ${num(m.firstShot)} с`,
    `• планы: ${pct(m.buckets.under1)} короче 1 с · ${pct(m.buckets.s1to2)} по 1–2 с · ${pct(m.buckets.s2to4)} по 2–4 с · ${pct(m.buckets.over4)} длиннее`,
    m.orientation ? `• кадр: ${m.orientation}` : '',
    line('', p.pacing),
  ]);

  if (Array.isArray(p.structure) && p.structure.length) {
    block(
      '🧱 Структура',
      p.structure.map((s) => `• <i>${esc(txt(s.part))}${s.when ? ` (${esc(txt(s.when))})` : ''}:</i> ${esc(txt(s.what))}`)
    );
  }
  block('✂️ Что остаётся в ролике', [line('', p.selection), line('речь', p.speech), line('перебивки', p.broll), line('финал', p.ending)]);

  const sub = p.subtitles || {};
  block('💬 Субтитры и надписи', [
    sub.use === false || sub.present === false
      ? '• субтитров нет'
      : [line('где', sub.position), line('вид', sub.look), line('появление', sub.animation), line('выделение', sub.highlight)].filter(Boolean).join('\n'),
    line('другие надписи', p.titles),
  ]);

  const mus = p.music || {};
  block('🎵 Звук', [
    mus.use === false || mus.present === false ? '• музыки нет' : [line('музыка', mus.mood), line('громкость', mus.level), line('склейки в бит', mus.on_beat)].filter(Boolean).join('\n'),
    line('эффекты', p.sfx),
  ]);

  block('🎬 Картинка', [line('переходы', p.transitions), line('движение', p.camera_fx), line('цвет', p.color)]);

  if (Array.isArray(p.rules) && p.rules.length) block('📋 Правила монтажа', p.rules.map((r, i) => `${i + 1}. ${esc(txt(r))}`));
  if (Array.isArray(p.varies) && p.varies.length) block('🔀 Меняется от ролика к ролику', p.varies.map((r) => `• ${esc(txt(r))}`));
  if (Array.isArray(p.questions) && p.questions.length) block('❓ Чего я не понял по примерам', p.questions.map((r) => `• ${esc(txt(r))}`));

  return out.join('\n\n');
}

// ───────────────────────────── Очередь задач ─────────────────────────────

let chain = Promise.resolve();
const pending = new Map(); // сколько задач ждёт у пользователя

function enqueue(user, chatId, job) {
  pending.set(user.id, (pending.get(user.id) || 0) + 1);
  chain = chain
    .then(job)
    .catch((e) => {
      log('job:', e.stack || e.message);
      return send(chatId, `⚠️ Не получилось: ${esc(e.message)}`).catch(() => {});
    })
    .then(async () => {
      const left = (pending.get(user.id) || 1) - 1;
      pending.set(user.id, left);
      await saveUser(user).catch((e) => log('save:', e.message));
    });
  return chain;
}

// ───────────────────────────── Работа с примерами ─────────────────────────────

function pickVideo(msg) {
  const fromDoc = msg.document && (/^video\//.test(msg.document.mime_type || '') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(msg.document.file_name || ''));
  const v = msg.video || (fromDoc ? msg.document : null) || msg.video_note || null;
  if (!v) return null;
  return { fileId: v.file_id, size: v.file_size || 0, name: v.file_name || '' };
}

async function fetchTelegramFile(fileId, dest) {
  const f = await tg('getFile', { file_id: fileId }, 20 * 60 * 1000);
  if (LOCAL_MODE && path.isAbsolute(f.file_path || '')) {
    await fsp.copyFile(f.file_path, dest);
    fsp.unlink(f.file_path).catch(() => {}); // копия сервера Bot API больше не нужна
    return;
  }
  const res = await fetch(`${CLOUD_API}/file/bot${CFG.token}/${f.file_path}`, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`не удалось скачать файл из Telegram (HTTP ${res.status})`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Ролик в формате, который ИИ-сервис может не принять, перекладываем в mp4 */
async function ensureMp4(file) {
  if (MIME[path.extname(file).toLowerCase()]) return file;
  const out = file.replace(/\.[^.]+$/, '') + '.mp4';
  let r = await run(CFG.ffmpeg, ['-hide_banner', '-y', '-i', file, '-c', 'copy', '-movflags', '+faststart', out]);
  if (r.code !== 0) r = await run(CFG.ffmpeg, ['-hide_banner', '-y', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', out]);
  if (r.code !== 0) throw new Error('не удалось открыть видео этого формата');
  await fsp.unlink(file).catch(() => {});
  return out;
}

async function aiAnalyze(user, ex) {
  const file = path.join(userDir(user.id), 'examples', ex.file);
  const up = await geminiUpload(file);
  try {
    ex.ai = await geminiJson(user, [{ file_data: { mime_type: up.mime, file_uri: up.uri } }, { text: promptExample(ex) }]);
    delete ex.aiError;
  } finally {
    geminiDelete(up.name); // не оставляем видео на серверах ИИ-сервиса
  }
}

async function processExample(user, chatId, v) {
  const n = ++user.seq;
  const st = await send(chatId, `⏳ Пример ${n}: получаю файл…`);
  const say = (t) => edit(chatId, st.message_id, t);
  const dir = path.join(userDir(user.id), 'examples');
  await fsp.mkdir(dir, { recursive: true });
  const ext = (path.extname(v.name) || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
  let file = path.join(dir, `ex-${n}${ext}`);
  try {
    await fetchTelegramFile(v.fileId, file);
    file = await ensureMp4(file);
    const meta = await probe(file);
    if (meta.duration > CFG.maxExampleSec) {
      throw new Error(`ролик длится ${num(meta.duration / 60)} мин. Для примера нужен готовый смонтированный ролик, не исходник`);
    }
    await say(`⏳ Пример ${n}: ищу склейки и измеряю темп…`);
    const cuts = await detectCuts(file, meta);
    const ex = { n, file: path.basename(file), addedAt: new Date().toISOString(), meta, cuts, shots: shotStats(cuts, meta.duration), audio: await audioStats(file, meta), ai: null };
    user.examples.push(ex);
    await saveUser(user);
    await say(`⏳ Пример ${n}: смотрю ролик и разбираю приёмы…`);
    const head = `Пример ${n} · ${num(meta.duration, 0)} с · ${cuts.length} ${plural(cuts.length, 'склейка', 'склейки', 'склеек')} · план ≈${num(ex.shots.avg)} с`;
    try {
      await aiAnalyze(user, ex);
      await say(`✅ ${head}${ex.ai.type ? ` · ${esc(txt(ex.ai.type))}` : ''}`);
    } catch (e) {
      ex.aiError = e.message;
      log('ai:', e.message);
      await say(`⚠️ ${head}\nТемп измерил, но разобрать приёмы не удалось: ${esc(e.message)}. Повторю попытку при сборке паспорта.`);
    }
  } catch (e) {
    await fsp.unlink(file).catch(() => {});
    await say(`⚠️ Пример ${n} не принят: ${esc(e.message)}.`);
  }
}

async function afterExamples(user, chatId) {
  if ((pending.get(user.id) || 0) > 1) return; // ещё есть ролики в очереди
  const n = user.examples.length;
  if (!n) return;
  const hint = n < 5 ? `Для надёжного результата нужно 5–15 роликов — пришлите ещё ${5 - n} или больше.` : 'Этого достаточно. Можно прислать ещё — паспорт станет точнее.';
  const label = user.passport ? '🔄 Обновить паспорт стиля' : '🧬 Собрать паспорт стиля';
  await send(chatId, `Разобрано примеров: <b>${n}</b>. ${hint}`, { reply_markup: kb([[[label, 'build']]]) });
}

// ───────────────────────────── Паспорт стиля ─────────────────────────────

async function buildPassport(user, chatId) {
  if (!user.examples.length) {
    await send(chatId, 'Пока нет ни одного разобранного примера. Пришлите сюда свои готовые ролики.');
    return;
  }
  const st = await send(chatId, '🧠 Собираю паспорт стиля…');
  // Примеры, где ИИ-разбор не удался в прошлый раз, пробуем ещё раз
  for (const ex of user.examples.filter((e) => !e.ai)) {
    await edit(chatId, st.message_id, `🧠 Повторно разбираю пример ${ex.n}…`);
    await aiAnalyze(user, ex).catch((e) => (ex.aiError = e.message));
  }
  const ready = user.examples.filter((e) => e.ai);
  if (!ready.length) {
    await edit(chatId, st.message_id, `⚠️ Не удалось разобрать примеры: ${esc(user.examples[0].aiError || 'ИИ-сервис недоступен')}. Попробуйте позже.`);
    return;
  }
  const agg = aggregate(ready);
  const data = await geminiJson(user, [{ text: promptPassport(user, ready, agg) }]);
  user.prevPassport = null;
  user.passport = { version: ((user.passport && user.passport.version) || 0) + 1, confirmed: false, createdAt: new Date().toISOString(), measured: agg, data };
  await saveUser(user);
  await tg('deleteMessage', { chat_id: chatId, message_id: st.message_id }).catch(() => {});
  await sendLong(chatId, renderPassport(user), { reply_markup: kb([[['✅ Всё верно', 'ok'], ['✏️ Поправить', 'fix']]]) });
}

async function applyCorrection(user, chatId, text) {
  const st = await send(chatId, '✏️ Вношу правку в паспорт…');
  user.corrections.push({ text, at: new Date().toISOString() });
  try {
    const data = await geminiJson(user, [{ text: promptCorrection(user, text) }]);
    user.prevPassport = user.passport;
    user.passport = { ...user.passport, version: user.passport.version + 1, confirmed: false, createdAt: new Date().toISOString(), data };
  } catch (e) {
    user.corrections.pop();
    throw e;
  } finally {
    await tg('deleteMessage', { chat_id: chatId, message_id: st.message_id }).catch(() => {});
  }
  await saveUser(user);
  await sendLong(chatId, renderPassport(user), { reply_markup: kb([[['✅ Принять', 'ok'], ['↩️ Вернуть прежний', 'undo']]]) });
}

// ───────────────────────────── Тексты ─────────────────────────────

const HELLO = `Привет! Я монтажёр, который учится вашему стилю.

<b>Шаг 1.</b> Пришлите сюда 5–15 своих готовых роликов — тех, что уже опубликованы. Можно сразу несколько.
<b>Шаг 2.</b> Я разберу каждый: темп, склейки, субтитры, музыку, структуру — и покажу «паспорт стиля», то есть как я понял вашу манеру.
<b>Шаг 3.</b> Вы подтверждаете паспорт или поправляете его обычным сообщением: «субтитры у меня всегда жёлтые», «склейки реже».

Монтаж новых роликов по паспорту — следующий этап, он ещё в разработке.

Команды: /status — что уже загружено, /style — показать паспорт, /reset — начать заново.`;

const HOW_TO_SAVE = `По ссылке забрать ролик не получится: Instagram не отдаёт видео с музыкой из своей библиотеки.

Пришлите ролик файлом. Свой Reels можно сохранить так: откройте его в Instagram → «⋯» → «Сохранить на устройство» (или «Скачать»), затем отправьте видео сюда.`;

function statusText(user) {
  const L = [];
  if (!user.examples.length) L.push('Примеров пока нет. Пришлите сюда свои готовые ролики.');
  else {
    L.push(`<b>Примеры: ${user.examples.length}</b>`);
    for (const e of user.examples) {
      L.push(`${e.ai ? '✅' : '⚠️'} №${e.n} · ${num(e.meta.duration, 0)} с · ${e.cuts.length} ${plural(e.cuts.length, 'склейка', 'склейки', 'склеек')} · план ≈${num(e.shots.avg)} с${e.ai ? '' : ' · приёмы не разобраны'}`);
    }
    L.push('Убрать пример: /del и номер, например /del 3');
  }
  L.push('');
  L.push(user.passport ? `<b>Паспорт стиля:</b> версия ${user.passport.version}, ${user.passport.confirmed ? 'подтверждён' : 'ждёт подтверждения'}; правок учтено: ${user.corrections.length}` : '<b>Паспорт стиля:</b> ещё не собран');
  const cost = (user.usage.in * CFG.priceIn + user.usage.out * CFG.priceOut) / 1e6;
  L.push(`<b>Расход на ИИ:</b> ≈$${num(cost, 2)} (${user.usage.calls} ${plural(user.usage.calls, 'запрос', 'запроса', 'запросов')})`);
  if (!LOCAL_MODE) L.push('\n⚠️ Бот работает без своего сервера Bot API: принимаются файлы только до 20 МБ.');
  return L.join('\n');
}

// ───────────────────────────── Обработка сообщений ─────────────────────────────

async function loadOwner() {
  const o = await readJson(path.join(CFG.dataDir, 'owner.json'), null);
  OWNER = o && o.id ? String(o.id) : '';
}

/** Доступ: список ALLOWED_USERS, а если он пуст — владельцем становится первый, кто написал /start */
async function hasAccess(msg) {
  const id = String(msg.from.id);
  if (CFG.allowed.includes(id) || (OWNER && OWNER === id)) return true;
  if (!CFG.allowed.length && !OWNER && /^\/start\b/.test(msg.text || '')) {
    OWNER = id;
    await writeJson(path.join(CFG.dataDir, 'owner.json'), { id, at: new Date().toISOString() });
    log('owner set:', id);
    return true;
  }
  return false;
}

async function onMessage(msg) {
  if (!msg.from || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  if (!(await hasAccess(msg))) {
    await send(chatId, !CFG.allowed.length && !OWNER ? 'Напишите /start, чтобы начать.' : `Это закрытый бот. Ваш номер для доступа: <code>${msg.from.id}</code>`);
    return;
  }
  const user = await getUser(msg.from.id, msg.from.first_name);
  const text = (msg.text || '').trim();

  const v = pickVideo(msg);
  if (v) {
    if (user.examples.length + (pending.get(user.id) || 0) >= CFG.maxExamples) {
      await send(chatId, `Примеров уже ${CFG.maxExamples} — этого более чем достаточно. Лишние можно убрать командой /del.`);
      return;
    }
    if (!LOCAL_MODE && v.size > 20 * 1024 * 1024) {
      await send(chatId, '⚠️ Файл больше 20 МБ. Чтобы принимать такие, боту нужен свой сервер Bot API (см. инструкцию по установке). Пока пришлите ролик поменьше или отправьте его как обычное видео, не файлом.');
      return;
    }
    enqueue(user, chatId, async () => {
      await processExample(user, chatId, v);
      await afterExamples(user, chatId);
    });
    return;
  }

  if (/^\/(start|help)\b/.test(text)) return void (await send(chatId, HELLO));
  if (/^\/status\b/.test(text)) return void (await send(chatId, statusText(user)));
  if (/^\/(style|passport)\b/.test(text)) {
    if (user.passport) {
      const buttons = user.passport.confirmed ? [[['✏️ Поправить', 'fix'], ['🔄 Пересобрать', 'build']]] : [[['✅ Всё верно', 'ok'], ['✏️ Поправить', 'fix']]];
      return void (await sendLong(chatId, renderPassport(user), { reply_markup: kb(buttons) }));
    }
    return void enqueue(user, chatId, () => buildPassport(user, chatId));
  }
  if (/^\/reset\b/.test(text)) {
    return void (await send(chatId, 'Удалить все примеры, паспорт стиля и правки? Вернуть их будет нельзя.', { reply_markup: kb([[['🗑 Да, удалить всё', 'reset_yes'], ['Отмена', 'cancel']]]) }));
  }
  const del = text.match(/^\/del(?:ete)?(?:@\w+)?\s*(\d+)?/);
  if (del) {
    const ex = user.examples.find((e) => e.n === Number(del[1]));
    if (!ex) return void (await send(chatId, 'Укажите номер примера из /status, например: /del 3'));
    user.examples = user.examples.filter((e) => e !== ex);
    await fsp.unlink(path.join(userDir(user.id), 'examples', ex.file)).catch(() => {});
    await saveUser(user);
    return void (await send(chatId, `Пример ${ex.n} убран.${user.passport ? ' Чтобы паспорт это учёл, пересоберите его: /style → «Пересобрать».' : ''}`));
  }
  if (text.startsWith('/')) return void (await send(chatId, 'Не знаю такой команды. Есть /status, /style, /reset и /help.'));

  if (/instagram\.com|instagr\.am/i.test(text)) return void (await send(chatId, HOW_TO_SAVE));

  if (text) {
    if (!user.passport) {
      return void (await send(chatId, user.examples.length ? 'Сначала соберём паспорт стиля — тогда его можно будет поправить словами.' : 'Пришлите сюда свои готовые ролики — с них я начну учиться вашему стилю.', user.examples.length ? { reply_markup: kb([[['🧬 Собрать паспорт стиля', 'build']]]) } : {}));
    }
    if (text.length > 2000) return void (await send(chatId, 'Слишком длинная правка. Напишите короче — по одной мысли на сообщение.'));
    return void enqueue(user, chatId, () => applyCorrection(user, chatId, text));
  }

  if (msg.voice || msg.audio) return void (await send(chatId, 'Голосовые я пока не понимаю — напишите правку текстом.'));
  if (msg.photo || msg.document || msg.animation || msg.sticker) await send(chatId, 'Мне нужны видео: пришлите свои готовые ролики.');
}

async function onCallback(q) {
  const msg = q.message;
  const done = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!msg || !msg.chat) return done();
  const chatId = msg.chat.id;
  const id = String(q.from.id);
  if (!(CFG.allowed.includes(id) || (OWNER && OWNER === id))) return done('Нет доступа');
  const user = await getUser(id, q.from.first_name);
  const dropButtons = () => tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});

  switch (q.data) {
    case 'build':
      await done('Собираю…');
      await dropButtons();
      enqueue(user, chatId, () => buildPassport(user, chatId));
      break;
    case 'ok':
      if (!user.passport) return done();
      user.passport.confirmed = true;
      user.prevPassport = null;
      await saveUser(user);
      await done('Сохранено');
      await dropButtons();
      await send(chatId, `✅ Паспорт стиля (версия ${user.passport.version}) сохранён.\n\nЕго можно уточнять в любой момент: просто напишите правку сообщением или пришлите ещё ролики.\n\nМонтаж новых видео по этому паспорту — следующий этап разработки.`);
      break;
    case 'fix':
      await done();
      await send(chatId, 'Напишите одним сообщением, что не так. Например:\n• «субтитры у меня всегда жёлтые, внизу»\n• «музыку я ставлю тише»\n• «в начале всегда крупный план продукта»');
      break;
    case 'undo':
      if (!user.prevPassport) return done('Прежней версии уже нет');
      user.passport = user.prevPassport;
      user.prevPassport = null;
      user.corrections.pop();
      await saveUser(user);
      await done('Вернул');
      await dropButtons();
      await send(chatId, `↩️ Вернул прежний паспорт (версия ${user.passport.version}). Показать его: /style`);
      break;
    case 'reset_yes':
      await fsp.rm(userDir(user.id), { recursive: true, force: true }).catch(() => {});
      users.delete(user.id);
      await done('Удалено');
      await dropButtons();
      await send(chatId, 'Всё удалено. Пришлите ролики — начнём заново.');
      break;
    default:
      await done();
      await dropButtons();
  }
}

async function handleUpdate(u) {
  if (u.message) await onMessage(u.message);
  else if (u.callback_query) await onCallback(u.callback_query);
}

// ───────────────────────────── Запуск ─────────────────────────────

/** Свой сервер Bot API снимает лимит 20 МБ на приём файлов */
async function startLocalBotApi() {
  if (CFG.botApiUrl) {
    TG_BASE = CFG.botApiUrl;
    LOCAL_MODE = true;
    return;
  }
  if (!CFG.apiId || !CFG.apiHash || !fs.existsSync(CFG.botApiBin)) {
    log('Свой сервер Bot API не настроен — работаю через обычный, файлы до 20 МБ.');
    return;
  }
  // Перед переходом на свой сервер бот должен один раз «выйти» с общего
  const marker = path.join(CFG.dataDir, '.cloud-logout-done');
  if (!fs.existsSync(marker)) {
    try {
      const r = await fetch(`${CLOUD_API}/bot${CFG.token}/logOut`, { method: 'POST', signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      log('logOut с общего сервера:', j.ok ? 'ок' : j.description || r.status);
      await fsp.writeFile(marker, new Date().toISOString());
    } catch (e) {
      log('logOut не удался:', e.message);
    }
  }
  const tgDir = path.join(CFG.dataDir, 'tg');
  const tmpDir = path.join(require('os').tmpdir(), 'tg-bot-api');
  await fsp.mkdir(tgDir, { recursive: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  const child = spawn(CFG.botApiBin, ['--local', `--http-port=${CFG.botApiPort}`, '--http-ip-address=127.0.0.1', `--dir=${tgDir}`, `--temp-dir=${tmpDir}`, '--verbosity=1'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TELEGRAM_API_ID: CFG.apiId, TELEGRAM_API_HASH: CFG.apiHash },
  });
  child.on('error', (e) => {
    log('Сервер Bot API не запустился:', e.message);
    process.exit(1);
  });
  child.on('exit', (code) => {
    log('Сервер Bot API остановился, код', code);
    process.exit(1);
  });
  process.on('exit', () => child.kill());
  TG_BASE = `http://127.0.0.1:${CFG.botApiPort}`;
  LOCAL_MODE = true;
  for (let i = 0; i < 90; i++) {
    try {
      await tg('getMe', {}, 5000);
      return;
    } catch (e) {
      if (e.code === 401) throw new Error('Telegram не принял BOT_TOKEN — проверьте переменную');
      await sleep(1000);
    }
  }
  throw new Error('Сервер Bot API не отвечает');
}

async function pollLoop() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 45000);
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => log('update:', e.stack || e.message));
      }
    } catch (e) {
      log('getUpdates:', e.message);
      await sleep(e.code === 409 ? 10000 : 3000);
    }
  }
}

async function main() {
  const missing = ['BOT_TOKEN', 'GEMINI_API_KEY'].filter((k) => !(process.env[k] || '').trim());
  if (missing.length) {
    console.error(`Не заданы переменные: ${missing.join(', ')}. См. montazh-README.md`);
    process.exit(1);
  }
  await fsp.mkdir(CFG.dataDir, { recursive: true });
  await loadOwner();
  await startLocalBotApi();
  const me = await tg('getMe');
  await tg('setMyCommands', {
    commands: [
      { command: 'status', description: 'Что уже загружено' },
      { command: 'style', description: 'Паспорт стиля' },
      { command: 'reset', description: 'Начать заново' },
      { command: 'help', description: 'Как пользоваться' },
    ],
  }).catch(() => {});
  // Railway может ждать ответа на порту — отвечаем «жив»
  if (process.env.PORT) http.createServer((_, res) => res.end('ok')).listen(Number(process.env.PORT));
  log(`Бот @${me.username} запущен. Свой сервер Bot API: ${LOCAL_MODE ? 'да' : 'нет'}. Данные: ${CFG.dataDir}. Модель: ${CFG.geminiModel}`);
  await pollLoop();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Ошибка запуска:', e.message);
    process.exit(1);
  });
}

module.exports = { probe, detectCuts, shotStats, audioStats, aggregate, renderPassport, parseJsonLoose, num, plural, txt };
