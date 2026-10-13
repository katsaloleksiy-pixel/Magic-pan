'use strict';
/*
 * Магическая кастрюля — Telegram-бот, который учится стилю монтажа автора и монтирует по нему.
 * Учёба: готовые ролики-примеры → разбор → «паспорт стиля» → правки автора.
 * Монтаж: исходники (видео, перебивки, озвучка) → расшифровка речи и описание планов →
 *          план монтажа от ИИ по паспорту → сборка в ffmpeg → готовый ролик → правки текстом.
 *
 * Без внешних библиотек: нужен только Node.js 20+ и ffmpeg/ffprobe.
 * Настройки — через переменные окружения (см. Magic pan-README.md).
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
  // Монтаж
  maxSourceSec: Number(process.env.MAX_SOURCE_SEC || 1800), // один исходник — до 30 мин
  maxProjectSec: Number(process.env.MAX_PROJECT_SEC || 3600), // все исходники ролика — до 60 мин
  maxSources: Number(process.env.MAX_SOURCES || 20),
  fps: Number(process.env.OUTPUT_FPS || 30),
  fontsDir: process.env.FONTS_DIR || path.join(__dirname, 'fonts'),
  subFont: process.env.SUB_FONT || 'Montserrat ExtraBold',
  pauseMax: Number(process.env.PAUSE_MAX || 0.4), // паузы в речи длиннее этого вырезаются
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
const AUDIO_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4' };

async function gfetch(url, opts, timeoutMs) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`нет связи с ИИ-сервисом (${e.name || e.message})`);
  }
}

async function geminiUpload(file, waitMs = 5 * 60 * 1000) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || AUDIO_MIME[ext] || 'video/mp4';
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
  const deadline = Date.now() + waitMs;
  while (f.state === 'PROCESSING' && Date.now() < deadline) {
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
async function geminiJson(user, parts, opts = {}) {
  const url = `${CFG.geminiUrl}/v1beta/models/${CFG.geminiModel}:generateContent`;
  const base = { contents: [{ role: 'user', parts }] };
  // Сначала просим строгий JSON (и, если нужно, длинный ответ и экономный разбор видео);
  // если сервис не знает какой-то настройки — повторяем без неё
  const json = { responseMimeType: 'application/json' };
  const full = { ...json };
  if (opts.long) full.maxOutputTokens = 65536;
  if (opts.lowRes) full.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  let variants = [{ ...base, generationConfig: full }];
  if (opts.lowRes) variants.push({ ...base, generationConfig: { ...full, mediaResolution: undefined } });
  if (opts.long || opts.lowRes) variants.push({ ...base, generationConfig: json });
  variants.push(base);
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
    if (cand && cand.finishReason === 'MAX_TOKENS') {
      throw new Error('ответ ИИ не поместился — исходник слишком длинный, разделите его на части');
    }
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

// ═════════════════════════════ МОНТАЖ ═════════════════════════════

const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** 75.4 → «1:15» */
function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const projDir = (user) => path.join(userDir(user.id), 'project');

function newProject(user) {
  user.projSeq = (user.projSeq || 0) + 1;
  user.project = { id: user.projSeq, seq: 0, sources: [], brief: [], fixes: [], plan: null, prevPlan: null, version: 0, result: null, prevResult: null, open: false, createdAt: new Date().toISOString() };
  return user.project;
}

async function resetProject(user) {
  await fsp.rm(projDir(user), { recursive: true, force: true }).catch(() => {});
  user.hold = [];
  return newProject(user);
}

async function freeMb(dir) {
  try {
    const s = await fsp.statfs(dir);
    return (s.bavail * s.bsize) / 1e6;
  } catch (_) {
    return Infinity;
  }
}

// ───────────────────────────── Исходники: приём и разбор ─────────────────────────────

/** Видео или звук из сообщения */
function pickMedia(msg) {
  const v = pickVideo(msg);
  if (v) return { ...v, kind: 'video' };
  const d = msg.document;
  const audioDoc = d && (/^audio\//.test(d.mime_type || '') || /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac)$/i.test(d.file_name || ''));
  const a = msg.voice || msg.audio || (audioDoc ? d : null);
  if (!a) return null;
  const byMime = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/aac': '.aac' };
  const name = a.file_name || `audio${byMime[a.mime_type] || '.ogg'}`;
  return { fileId: a.file_id, size: a.file_size || 0, name, kind: 'audio' };
}

async function probeAudio(file) {
  const r = await run(CFG.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000);
  let j;
  try {
    j = JSON.parse(r.out);
  } catch (_) {
    j = null;
  }
  const a = j && (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw new Error('в файле нет звука');
  const duration = Number(j.format.duration) || Number(a.duration) || 0;
  if (!duration) throw new Error('не удалось определить длительность записи');
  return { duration, hasAudio: true };
}

/** Где в записи тишина. Порог подстраивается под громкость записи. */
async function silenceMap(wav, duration) {
  const v = await run(CFG.ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = v.err.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const meanDb = m ? Number(m[1]) : -30;
  const noise = clamp(meanDb - 14, -55, -25);
  const r = await run(CFG.ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${noise.toFixed(1)}dB:d=0.2`, '-f', 'null', '-']);
  const silences = [];
  let start = null;
  for (const line of r.err.split('\n')) {
    let mm = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (mm) {
      start = Math.max(0, Number(mm[1]));
      continue;
    }
    mm = line.match(/silence_end:\s*([\d.]+)/);
    if (mm && start != null) {
      silences.push([r2(start), r2(Number(mm[1]))]);
      start = null;
    }
  }
  if (start != null) silences.push([r2(start), r2(duration)]);
  const silent = silences.reduce((s, [a, b]) => s + (b - a), 0);
  return { silences, speechShare: clamp(1 - silent / duration, 0, 1) };
}

/** Отрезки со звуком (дополнение к тишине) — подсказка ИИ для точного времени */
function soundIslands(silences, duration) {
  const out = [];
  let cur = 0;
  for (const [a, b] of silences) {
    if (a - cur >= 0.15) out.push([r2(cur), r2(a)]);
    cur = Math.max(cur, b);
  }
  if (duration - cur >= 0.15) out.push([r2(cur), r2(duration)]);
  return out;
}

/** Время фраз от ИИ приблизительное — подтягиваем начало и конец к реальным границам тишины */
function snapPhrases(raw, silences, duration) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((p) => ({ start: Number(p && p.start), end: Number(p && p.end), text: String((p && p.text) || '').replace(/\s+/g, ' ').trim() }))
    .filter((p) => isFinite(p.start) && isFinite(p.end) && p.text && p.end > p.start)
    .sort((a, b) => a.start - b.start);
  const near = (t) => silences.find(([a, b]) => t >= a - 0.35 && t <= b + 0.35);
  const out = [];
  for (const p of list) {
    let s = clamp(p.start, 0, duration);
    let e = clamp(p.end, 0, duration);
    const ss = near(s);
    if (ss) s = Math.max(ss[0], ss[1] - 0.06);
    const se = near(e);
    if (se) e = Math.min(se[1], se[0] + 0.1);
    if (e - s < 0.25) {
      s = clamp(p.start, 0, duration);
      e = clamp(p.end, 0, duration);
    }
    if (e - s < 0.2) continue;
    out.push({ start: r2(s), end: r2(e), text: p.text });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) {
      const mid = r2((out[i].start + out[i - 1].end) / 2);
      out[i - 1].end = mid;
      out[i].start = mid;
    }
  }
  return out.filter((p) => p.end - p.start >= 0.2);
}

function normShots(raw, src) {
  const kinds = ['talking', 'broll', 'junk'];
  const list = (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      start: r2(clamp(Number(s && s.start), 0, src.duration)),
      end: r2(clamp(Number(s && s.end), 0, src.duration)),
      kind: kinds.includes(s && s.kind) ? s.kind : 'broll',
      what: txt(s && s.what).slice(0, 160),
      quality: ['good', 'ok', 'bad'].includes(s && s.quality) ? s.quality : 'ok',
    }))
    .filter((s) => isFinite(s.start) && isFinite(s.end) && s.end - s.start >= 0.3)
    .sort((a, b) => a.start - b.start);
  if (list.length) return list;
  const talking = src.ai && src.ai.phrases && src.ai.phrases.length;
  return [{ start: 0, end: r2(src.duration), kind: talking ? 'talking' : 'broll', what: 'весь файл', quality: 'ok' }];
}

function promptTranscribe(src) {
  const isl = soundIslands(src.silences || [], src.duration);
  const hint = isl.length && isl.length <= 600 ? `\nПодсказка — отрезки, где алгоритм слышит звук (секунды): ${isl.map(([a, b]) => `${a}–${b}`).join(', ')}\n` : '';
  return `Это звуковая дорожка исходника для монтажа ролика (длительность ${src.duration.toFixed(1)} с). Расшифруй ВСЮ речь дословно, на языке оригинала — русском или украинском. Не переводи, не исправляй слова, не пропускай куски.

Разбей речь на фразы по 1–10 секунд по естественным паузам. Если человек повторяет фразу несколько раз (дубли), сбивается или бросает фразу на полуслове — записывай каждую попытку отдельной фразой.
start и end — секунды от начала записи с точностью 0,1 с. Время должно точно совпадать со звуком: start — первый звук фразы, end — последний.
${hint}
Если речи нет — верни пустой список фраз.
Ответь строго одним JSON-объектом без пояснений:
{"language": "ru | uk | mixed | none", "phrases": [{"start": 1.2, "end": 4.8, "text": "..."}]}`;
}

function promptShots(src) {
  return `Это исходное видео для монтажа ролика (длительность ${src.duration.toFixed(1)} с, кадр ${src.width}×${src.height}). Раздели его на планы — непрерывные куски с одним содержанием — и опиши каждый так, чтобы монтажёр мог выбрать перебивки, не глядя видео.

Для каждого плана:
- start, end — секунды от начала видео, точность 0,1 с;
- kind: "talking" — человек говорит в камеру; "broll" — то, что годится в перебивку (продукт, процесс, место, детали, люди без синхрона); "junk" — брак: тряска, расфокус, камера смотрит в пол, случайная съёмка;
- what — что в кадре, 4–12 слов, конкретно (не «красивый кадр», а «нарезка лосося крупным планом»);
- quality: "good" | "ok" | "bad".
Однородные куски длиннее 12 с дели на части. Планы должны покрывать всё видео без пропусков.

Ответь строго одним JSON-объектом без пояснений:
{"shots": [{"start": 0, "end": 4.5, "kind": "broll", "what": "...", "quality": "good"}]}`;
}

/** Расшифровка речи и описание планов. Уже сделанное не повторяется. */
async function analyzeSource(user, src) {
  const dir = projDir(user);
  src.ai = src.ai || {};
  if (!src.ai.phrases) {
    if (!src.hasAudio || !src.wav || src.speechShare < 0.04) {
      src.ai.phrases = [];
      src.ai.language = 'none';
    } else {
      const up = await geminiUpload(path.join(dir, src.wav));
      try {
        const j = await geminiJson(user, [{ file_data: { mime_type: up.mime, file_uri: up.uri } }, { text: promptTranscribe(src) }], { long: true });
        src.ai.language = txt(j.language) || '';
        src.ai.phrases = snapPhrases(j.phrases, src.silences || [], src.duration).map((p, i) => ({ id: `${src.n}.${i + 1}`, ...p }));
      } finally {
        geminiDelete(up.name);
      }
    }
  }
  if (src.kind === 'video' && !src.ai.shots) {
    const up = await geminiUpload(path.join(dir, src.file), 15 * 60 * 1000);
    try {
      const j = await geminiJson(user, [{ file_data: { mime_type: up.mime, file_uri: up.uri } }, { text: promptShots(src) }], { long: true, lowRes: true });
      src.ai.shots = normShots(j.shots, src).map((s, i) => ({ id: `${src.n}#${i + 1}`, ...s }));
    } finally {
      geminiDelete(up.name);
    }
  }
}

const LANG = { ru: 'рус.', uk: 'укр.', mixed: 'рус. и укр.' };

function sourceLine(src) {
  const kind = src.kind === 'audio' ? 'озвучка' : 'видео';
  const parts = [`Исходник ${src.n} · ${kind} ${fmtDur(src.duration)}`];
  const ai = src.ai || {};
  if (ai.phrases) parts.push(ai.phrases.length ? `речь: ${ai.phrases.length} ${plural(ai.phrases.length, 'фраза', 'фразы', 'фраз')}${LANG[ai.language] ? ` (${LANG[ai.language]})` : ''}` : 'без речи');
  if (ai.shots) {
    const b = ai.shots.filter((s) => s.kind === 'broll' && s.quality !== 'bad').length;
    parts.push(`${ai.shots.length} ${plural(ai.shots.length, 'план', 'плана', 'планов')}${b ? `, для перебивок: ${b}` : ''}`);
  }
  return `${src.aiError ? '⚠️' : '✅'} ${parts.join(' · ')}`;
}

async function processSource(user, chatId, m) {
  const p = user.project;
  const n = ++p.seq;
  const st = await send(chatId, `⏳ Исходник ${n}: получаю файл…`);
  const say = (t) => edit(chatId, st.message_id, t);
  const dir = projDir(user);
  await fsp.mkdir(dir, { recursive: true });
  const ext = (path.extname(m.name) || (m.kind === 'audio' ? '.ogg' : '.mp4')).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
  let file = path.join(dir, `src-${n}${ext}`);
  try {
    if (m.size && (await freeMb(dir)) < (m.size / 1e6) * 1.5 + 300) {
      throw new Error('на диске сервера мало места. Начните новый ролик (/new) или удалите лишние примеры (/learn → /del)');
    }
    await fetchTelegramFile(m.fileId, file);
    let meta;
    if (m.kind === 'video') {
      file = await ensureMp4(file);
      meta = await probe(file);
    } else {
      meta = await probeAudio(file);
    }
    if (meta.duration > CFG.maxSourceSec) throw new Error(`файл длится ${fmtDur(meta.duration)}, можно до ${fmtDur(CFG.maxSourceSec)}`);
    const total = p.sources.reduce((s, x) => s + x.duration, 0) + meta.duration;
    if (total > CFG.maxProjectSec) throw new Error(`все исходники вместе длиннее ${Math.round(CFG.maxProjectSec / 60)} мин`);
    const src = { n, kind: m.kind, file: path.basename(file), duration: meta.duration, width: meta.width || 0, height: meta.height || 0, orientation: meta.orientation || '', hasAudio: !!meta.hasAudio, silences: [], speechShare: 0, ai: null };
    if (src.hasAudio) {
      await say(`⏳ Исходник ${n}: слушаю звук…`);
      src.wav = `src-${n}.wav`;
      const wr = await run(CFG.ffmpeg, ['-hide_banner', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path.join(dir, src.wav)]);
      if (wr.code !== 0) {
        src.hasAudio = false;
        delete src.wav;
      } else {
        Object.assign(src, await silenceMap(path.join(dir, src.wav), src.duration));
      }
    }
    if (src.kind === 'audio' && !src.hasAudio) throw new Error('не удалось прочитать звук');
    if (user.project !== p) throw new Error('пока файл загружался, вы начали новый ролик');
    p.sources.push(src);
    await saveUser(user);
    await say(`⏳ Исходник ${n}: ${src.kind === 'audio' ? 'расшифровываю речь' : 'расшифровываю речь и смотрю кадры'}…`);
    try {
      await analyzeSource(user, src);
      delete src.aiError;
      await say(sourceLine(src));
    } catch (e) {
      src.aiError = e.message;
      log('source ai:', e.message);
      await say(`${sourceLine(src)}\nРазобрать не удалось: ${esc(e.message)}. Повторю попытку при монтаже.`);
    }
  } catch (e) {
    await fsp.unlink(file).catch(() => {});
    await say(`⚠️ Исходник ${n} не принят: ${esc(e.message)}.`);
  }
}

const montageKb = (p) => kb([[['🎬 Смонтировать', 'm_go'], ['🗑 Очистить', 'm_clear']]]);

async function afterSources(user, chatId) {
  if ((pending.get(user.id) || 0) > 1) return; // ещё есть файлы в очереди
  const p = user.project;
  if (!p || !p.sources.length) return;
  const v = p.sources.filter((s) => s.kind === 'video').length;
  const a = p.sources.length - v;
  const what = [v ? `видео: ${v}` : '', a ? `озвучка: ${a}` : ''].filter(Boolean).join(', ');
  await send(
    chatId,
    `Исходников: <b>${p.sources.length}</b> (${what}).\nМожно прислать ещё или написать пожелание к ролику, например «ролик на 30 секунд, начни с цены».`,
    { reply_markup: montageKb(p) }
  );
}

// ───────────────────────────── План монтажа ─────────────────────────────

/** Что есть в проекте: фразы речи (основа ролика) и планы для перебивок */
function projectContext(user) {
  const p = user.project;
  const has = (s) => s.ai && s.ai.phrases && s.ai.phrases.length;
  const audio = p.sources.filter((s) => s.kind === 'audio' && has(s));
  const voiceover = audio.length > 0;
  const spine = voiceover ? audio : p.sources.filter((s) => s.kind === 'video' && has(s));
  const phrases = spine.flatMap((s) => s.ai.phrases.map((ph) => ({ ...ph, src: s.n })));
  const allShots = p.sources.filter((s) => s.kind === 'video' && s.ai && s.ai.shots).flatMap((s) => s.ai.shots.map((x) => ({ ...x, src: s.n })));
  let shots = allShots.filter((s) => s.kind === 'broll' && s.quality !== 'bad');
  if (!shots.length) shots = allShots.filter((s) => s.kind === 'broll');
  if (voiceover && !shots.length) shots = allShots.filter((s) => s.kind !== 'junk');
  if (voiceover && !shots.length) shots = allShots;
  return {
    voiceover,
    phrases,
    shots,
    bySrc: new Map(p.sources.map((s) => [s.n, s])),
    phraseById: new Map(phrases.map((x) => [x.id, x])),
    shotById: new Map(shots.map((x) => [x.id, x])),
  };
}

function passportBrief(user) {
  const d = (user.passport && user.passport.data) || {};
  const keys = ['format', 'structure', 'selection', 'pacing', 'speech', 'broll', 'subtitles', 'titles', 'transitions', 'camera_fx', 'ending', 'rules'];
  const out = {};
  for (const k of keys) if (d[k] != null) out[k] = d[k];
  return out;
}

function measuredLine(user) {
  const m = user.passport && user.passport.measured;
  if (!m || !m.count) return '';
  return `Измерено по готовым роликам автора: длина обычно ${num(m.durMedian, 0)} с (от ${num(m.durMin, 0)} до ${num(m.durMax, 0)}), склейка в среднем каждые ${num(m.shotAvg)} с, первый план ≈${num(m.firstShot)} с, кадр ${m.orientation || 'вертикальный'}.`;
}

function catalogText(ctx) {
  const ph = ctx.phrases.map((x) => `${x.id} | ${r2(x.start)}–${r2(x.end)} | ${num(x.end - x.start)} с | ${x.text}`).join('\n');
  const sh = ctx.shots.map((x) => `${x.id} | ${r2(x.start)}–${r2(x.end)} (${num(x.end - x.start)} с) | ${x.kind}, ${x.quality} | ${x.what}`).join('\n');
  return `Фразы речи (id | секунды в исходнике | длительность | текст):\n${ph}\n\nПланы видео для перебивок (id | секунды | вид, качество | что в кадре):\n${sh || 'нет'}`;
}

const PLAN_SCHEMA = `{"idea": "о чём ролик, одна фраза", "keep": ["1.3", "1.5"], "broll": [{"phrase": "1.5", "shot": "2#3", "offset": 0.5, "dur": 2}], "cover": [{"phrase": "3.1", "shots": ["1#2", "2#5"]}], "zoom": ["1.3"], "jumpcut_zoom": false, "cut_pauses": true, "subtitles": {"on": true, "position": "bottom", "size": "medium", "color": "#FFFFFF", "highlight": "#FFD400", "uppercase": false, "words": 3, "style": "outline"}, "notes": ["..."]}`;

function promptPlan(user, ctx) {
  const p = user.project;
  const wishes = [...p.brief, ...p.fixes].map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `Ты — монтажёр автора. Собери из исходников новый ролик так, как его смонтировал бы сам автор, строго по его «паспорту стиля».

Паспорт стиля (JSON):
${JSON.stringify(passportBrief(user))}
${measuredLine(user)}

Режим: ${ctx.voiceover ? 'ОЗВУЧКА — основа ролика отдельная запись голоса. Видеоряд целиком собирается из планов исходников (поле "cover"); звук видео не используется.' : 'РЕЧЬ В КАДРЕ — основа ролика видео, где автор говорит. Под его речь идёт его же картинка, перебивки ставятся поверх (поле "broll").'}
${wishes ? `\nПожелания автора к этому ролику (они важнее паспорта):\n${wishes}\n` : ''}
${catalogText(ctx)}

Как собирать:
1. "keep" — id фраз в том порядке, в котором они пойдут в ролике. Это сценарий ролика.
   - Из дублей одной мысли оставь одну, лучшую — обычно последнюю целую. Убери оговорки, оборванные фразы, «так, ещё раз», лишние повторы и фразы не по теме.
   - Длина ролика — как обычно у автора, если в пожеланиях не сказано иначе. Сумма длительностей выбранных фраз ≈ длина ролика.
   - Порядок исходный. Можно вынести в начало одну сильную фразу, если по паспорту ролик начинается с крючка.
2. ${ctx.voiceover ? '"cover" — для КАЖДОЙ фразы из keep 1–3 плана, которые показывают то, о чём говорится в этой фразе. Число планов на фразу — по темпу автора: длительность фразы / средняя длина плана. Без нужды планы не повторяй. "broll" оставь пустым.' : '"broll" — перебивки поверх речи там, где фраза говорит о том, что видно в каком-то плане. offset — секунды от начала фразы, dur — длина перебивки по темпу автора. Перебивка не длиннее самого плана. Сколько перебивок и как часто — как у автора в паспорте; если перебивок у автора нет и в пожеланиях их не просят — оставь пустой список. "cover" оставь пустым.'}
3. "zoom" — id фраз, где сделать приближение на говорящего, если автор так делает. Иначе пустой список.
4. "jumpcut_zoom" — true, если автор прячет склейки внутри речи сменой крупности.
5. "cut_pauses" — true, если автор вырезает паузы в речи.
6. "subtitles" — субтитры по паспорту: on (есть ли вообще), position (bottom | middle | top), size (small | medium | large), color (#RRGGBB), highlight (#RRGGBB — цвет выделенного слова, или "" если автор не выделяет), uppercase (true/false), words (сколько слов на экране за раз, 1–6), style (outline — обводка | box — плашка | shadow — тень).
7. "notes" — 2–5 коротких пунктов для автора: что сделано и почему.

Используй только id из списков выше. Ответь строго одним JSON-объектом без пояснений, тексты на русском:
${PLAN_SCHEMA}`;
}

/** План в том виде, в котором его видит ИИ */
function planForAi(plan) {
  return { idea: plan.idea, keep: plan.keep, broll: plan.broll, cover: plan.cover, zoom: plan.zoom, jumpcut_zoom: plan.jumpcutZoom, cut_pauses: plan.cutPauses, subtitles: plan.subtitles };
}

function promptFix(user, ctx, text) {
  const p = user.project;
  const earlier = p.fixes.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const dur = p.result ? `${num(p.result.duration)} с` : 'неизвестно';
  return `Ты — монтажёр автора. Ниже план, по которому сейчас смонтирован ролик, и правка автора. Исправь план.

Правила:
- Сделай ровно то, что просит автор. Остальное не меняй.
- Если правка про стиль (субтитры, темп, перебивки) — меняй соответствующие поля.
- Используй только id из списков ниже.
- Верни план целиком в том же формате. В "notes" — 1–3 пункта: что изменено.

Паспорт стиля (JSON):
${JSON.stringify(passportBrief(user))}

Режим: ${ctx.voiceover ? 'ОЗВУЧКА (видеоряд — поле "cover")' : 'РЕЧЬ В КАДРЕ (перебивки — поле "broll")'}

${catalogText(ctx)}

Текущий план (длительность ролика сейчас: ${dur}):
${JSON.stringify(planForAi(p.plan))}
${earlier ? `\nПрежние правки автора (уже учтены, не отменяй их):\n${earlier}\n` : ''}
Правка автора:
«${text}»

Ответь строго одним JSON-объектом без пояснений, по образцу:
${PLAN_SCHEMA}`;
}

function hexColor(v, fallback) {
  const m = String(v || '').trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

/** Проверка ответа ИИ: только существующие куски, разумные числа */
function normalizePlan(raw, ctx) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const keep = (Array.isArray(r.keep) ? r.keep : []).map(String).filter((id) => ctx.phraseById.has(id) && !seen.has(id) && seen.add(id));
  if (!keep.length) throw new Error('ИИ не выбрал ни одного куска речи');
  const kept = new Set(keep);
  const shotId = (x) => String(x && typeof x === 'object' ? x.shot || x.id : x);
  const broll = (Array.isArray(r.broll) ? r.broll : [])
    .map((b) => ({ phrase: String(b && b.phrase), shot: shotId(b), offset: Math.max(0, Number(b && b.offset) || 0), dur: Number(b && b.dur) || 0, from: b && b.from != null && isFinite(Number(b.from)) ? Number(b.from) : null }))
    .filter((b) => kept.has(b.phrase) && ctx.shotById.has(b.shot) && b.dur >= 0.4);
  const cover = (Array.isArray(r.cover) ? r.cover : [])
    .map((c) => ({ phrase: String(c && c.phrase), shots: (Array.isArray(c && c.shots) ? c.shots : []).map(shotId).filter((id) => ctx.shotById.has(id)).slice(0, 4) }))
    .filter((c) => kept.has(c.phrase) && c.shots.length);
  const zoom = (Array.isArray(r.zoom) ? r.zoom : []).map(String).filter((id) => kept.has(id));
  const s = r.subtitles && typeof r.subtitles === 'object' ? r.subtitles : {};
  const subtitles = {
    on: s.on !== false,
    position: ['bottom', 'middle', 'top'].includes(s.position) ? s.position : 'bottom',
    size: ['small', 'medium', 'large'].includes(s.size) ? s.size : 'medium',
    color: hexColor(s.color, '#FFFFFF'),
    highlight: hexColor(s.highlight, ''),
    uppercase: s.uppercase === true,
    words: clamp(Math.round(Number(s.words) || 3), 1, 6),
    style: ['outline', 'box', 'shadow'].includes(s.style) ? s.style : 'outline',
  };
  const notes = (Array.isArray(r.notes) ? r.notes : []).map(txt).filter(Boolean).slice(0, 6);
  return { idea: txt(r.idea).slice(0, 300), keep, broll, cover, zoom, jumpcutZoom: r.jumpcut_zoom === true, cutPauses: r.cut_pauses !== false, subtitles, notes };
}

// ───────────────────────────── Монтажный лист ─────────────────────────────

/** Фраза без длинных пауз: список кусков [начало, конец] в исходнике */
function cutSilences(s, e, silences, gap, pad) {
  const parts = [];
  let cur = s;
  let end = e;
  for (const [a, b] of silences) {
    if (b <= cur || a >= end) continue;
    if (a <= cur) {
      cur = Math.max(cur, Math.min(end, b - pad)); // тишина в начале фразы
      continue;
    }
    if (b >= end) {
      end = Math.min(end, a + pad); // тишина в конце фразы
      break;
    }
    if (b - a < gap) continue; // короткая пауза внутри фразы остаётся
    const from = a + pad;
    const to = b - pad;
    if (to - from > 0.05) {
      parts.push([cur, from]);
      cur = to;
    }
  }
  if (end - cur > 0.05) parts.push([cur, end]);
  return parts.filter(([x, y]) => y - x >= 0.1);
}

/** Кусок картинки o ложится поверх монтажного листа и заменяет то, что под ним */
function overlayPiece(pieces, o, fps) {
  const out = [];
  for (const p of pieces) {
    if (p.f1 <= o.f0 || p.f0 >= o.f1) {
      out.push(p);
      continue;
    }
    if (p.f0 < o.f0) out.push({ ...p, f1: o.f0 });
    if (p.f1 > o.f1) out.push({ ...p, f0: o.f1, from: p.from + (o.f1 - p.f0) / fps });
  }
  out.push(o);
  return out.sort((a, b) => a.f0 - b.f0);
}

/** Дыры в картинке закрываем продолжением соседнего плана */
function fillGaps(pieces, total, fps) {
  const ps = pieces.filter((p) => p.f1 > p.f0).sort((a, b) => a.f0 - b.f0);
  if (!ps.length) return ps;
  if (ps[0].f0 > 0) {
    ps[0].from = Math.max(0, ps[0].from - ps[0].f0 / fps);
    ps[0].f0 = 0;
  }
  for (let i = 1; i < ps.length; i++) if (ps[i].f0 > ps[i - 1].f1) ps[i - 1].f1 = ps[i].f0;
  ps[ps.length - 1].f1 = total;
  return ps;
}

function mergePieces(pieces, fps) {
  const out = [];
  for (const p of pieces) {
    const q = out[out.length - 1];
    if (q && q.src === p.src && q.zoom === p.zoom && q.f1 === p.f0 && Math.abs(q.from + (q.f1 - q.f0) / fps - p.from) < 0.02) q.f1 = p.f1;
    else out.push({ ...p });
  }
  return out;
}

/**
 * Монтажный лист: звук — куски фраз подряд, картинка — список планов.
 * Время считается в кадрах, чтобы звук и картинка не разъезжались.
 */
function buildTimeline(plan, ctx, fps = CFG.fps) {
  const chunks = [];
  const span = new Map();
  let f = 0;
  for (const id of plan.keep) {
    const ph = ctx.phraseById.get(id);
    const src = ctx.bySrc.get(ph.src);
    const parts = plan.cutPauses ? cutSilences(ph.start, ph.end, src.silences || [], CFG.pauseMax, 0.08) : [[ph.start, ph.end]];
    const f0 = f;
    for (const [a, b] of parts) {
      const n = Math.round((b - a) * fps);
      if (n < 3) continue;
      chunks.push({ phrase: id, src: ph.src, a, f0: f, f1: f + n });
      f += n;
    }
    if (f > f0) span.set(id, [f0, f]);
  }
  const total = f;
  if (!total) throw new Error('после вырезания пауз от речи ничего не осталось');

  let pieces = [];
  const centered = (shot, need, from) => {
    if (from != null && from >= shot.start && from < shot.end - 0.3) return from;
    const avail = shot.end - shot.start;
    return avail > need ? shot.start + (avail - need) / 2 : shot.start;
  };
  if (!ctx.voiceover) {
    const zoomSet = new Set(plan.zoom);
    let alt = false;
    let prev = null;
    for (const c of chunks) {
      const jump = prev && prev.src === c.src && Math.abs(prev.a + (prev.f1 - prev.f0) / fps - c.a) > 0.05;
      alt = jump ? !alt : false;
      const zoom = zoomSet.has(c.phrase) ? 1.15 : plan.jumpcutZoom && alt ? 1.12 : 1;
      pieces.push({ f0: c.f0, f1: c.f1, src: c.src, from: c.a, zoom });
      prev = c;
    }
    for (const b of plan.broll) {
      const sp = span.get(b.phrase);
      const shot = ctx.shotById.get(b.shot);
      if (!sp || !shot) continue;
      const g0 = sp[0] + Math.round(b.offset * fps);
      const from = centered(shot, b.dur, b.from);
      const len = Math.min(Math.round(b.dur * fps), Math.round((shot.end - from) * fps), total - g0);
      if (g0 >= total || len < Math.round(0.4 * fps)) continue;
      pieces = overlayPiece(pieces, { f0: g0, f1: g0 + len, src: shot.src, from, zoom: 1, broll: true }, fps);
    }
  } else {
    for (const c of plan.cover) {
      const sp = span.get(c.phrase);
      if (!sp) continue;
      const k = c.shots.length;
      const L = sp[1] - sp[0];
      for (let i = 0; i < k; i++) {
        const g0 = sp[0] + Math.round((L * i) / k);
        const g1 = sp[0] + Math.round((L * (i + 1)) / k);
        const shot = ctx.shotById.get(c.shots[i]);
        if (g1 > g0) pieces = overlayPiece(pieces, { f0: g0, f1: g1, src: shot.src, from: centered(shot, (g1 - g0) / fps), zoom: 1, broll: true }, fps);
      }
    }
    if (!pieces.length) {
      // ИИ не подобрал картинку — раскладываем планы по очереди
      if (!ctx.shots.length) throw new Error('нет видео, чтобы закрыть озвучку картинкой');
      const slot = Math.round(3 * fps);
      for (let g = 0, i = 0; g < total; g += slot, i++) {
        const shot = ctx.shots[i % ctx.shots.length];
        pieces.push({ f0: g, f1: Math.min(total, g + slot), src: shot.src, from: centered(shot, 3), zoom: 1, broll: true });
      }
    }
    pieces = fillGaps(pieces, total, fps);
  }
  return { chunks, pieces: mergePieces(pieces, fps), total, span, fps };
}

// ───────────────────────────── Субтитры ─────────────────────────────

function assColor(hex, alpha = '00') {
  const h = hexColor(hex, '#FFFFFF').slice(1);
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Субтитры по словам. Время слов внутри фразы распределяется по длине слов. */
function makeAss(plan, ctx, tl, W, H) {
  const st = plan.subtitles;
  const base = Math.min(W, H);
  const size = Math.round(base * { small: 0.06, medium: 0.075, large: 0.095 }[st.size]);
  const align = { bottom: 2, middle: 5, top: 8 }[st.position];
  const marginV = st.position === 'bottom' ? Math.round(H * 0.2) : st.position === 'top' ? Math.round(H * 0.14) : 0;
  const prim = assColor(st.color);
  const hl = st.highlight ? assColor(st.highlight) : '';
  let border = 1;
  let outline = Math.max(2, Math.round(size * 0.08));
  let shadow = 0;
  let outCol = '&H00000000';
  let backCol = '&H80000000';
  if (st.style === 'shadow') {
    outline = Math.max(1, Math.round(size * 0.03));
    shadow = Math.max(2, Math.round(size * 0.06));
  } else if (st.style === 'box') {
    border = 3;
    outline = Math.max(4, Math.round(size * 0.2));
    outCol = '&H60000000';
    backCol = '&H60000000';
  }
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${CFG.subFont},${size},${prim},${prim},${outCol},${backCol},1,0,0,0,100,100,0,0,${border},${outline},${shadow},${align},${Math.round(W * 0.08)},${Math.round(W * 0.08)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const clean = (w) => (st.uppercase ? w.toUpperCase() : w).replace(/[{}\\]/g, '');
  const events = [];
  for (const id of plan.keep) {
    const sp = tl.span.get(id);
    if (!sp) continue;
    const t0 = sp[0] / tl.fps;
    const t1 = sp[1] / tl.fps;
    const words = ctx.phraseById.get(id).text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const weight = words.map((w) => w.length + 2);
    const sum = weight.reduce((a, b) => a + b, 0);
    let acc = 0;
    const timed = words.map((w, i) => {
      const a = t0 + ((t1 - t0) * acc) / sum;
      acc += weight[i];
      return { w: clean(w), a, b: t0 + ((t1 - t0) * acc) / sum };
    });
    // группы по N слов; конец предложения начинает новую группу
    const groups = [];
    let g = [];
    for (const x of timed) {
      g.push(x);
      if (g.length >= st.words || /[.!?…]$/.test(x.w)) {
        groups.push(g);
        g = [];
      }
    }
    if (g.length) groups.push(g);
    for (const grp of groups) {
      if (hl) {
        grp.forEach((x, i) => {
          const line = grp.map((y, j) => (j === i ? `{\\1c${hl}}${y.w}{\\1c${prim}}` : y.w)).join(' ');
          events.push(`Dialogue: 0,${assTime(x.a)},${assTime(i === grp.length - 1 ? grp[grp.length - 1].b : grp[i + 1].a)},Sub,,0,0,0,,${line}`);
        });
      } else {
        events.push(`Dialogue: 0,${assTime(grp[0].a)},${assTime(grp[grp.length - 1].b)},Sub,,0,0,0,,${grp.map((y) => y.w).join(' ')}`);
      }
    }
  }
  return head + events.join('\n') + '\n';
}

// ───────────────────────────── Сборка видео ─────────────────────────────

let hasAssFilter = null;
async function assAvailable() {
  if (hasAssFilter == null) {
    const r = await run(CFG.ffmpeg, ['-hide_banner', '-filters'], 30000).catch(() => ({ out: '' }));
    hasAssFilter = /\sass\s/.test(r.out);
  }
  return hasAssFilter;
}

const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

function outputSize(user, ctx) {
  let o = user.passport && user.passport.measured && user.passport.measured.orientation;
  if (!o) {
    const v = [...ctx.bySrc.values()].find((s) => s.kind === 'video');
    o = v ? v.orientation : 'вертикальный';
  }
  if (o === 'горизонтальный') return [1920, 1080];
  if (o === 'квадратный') return [1080, 1080];
  return [1080, 1920];
}

async function ff(args, what) {
  const r = await run(CFG.ffmpeg, ['-hide_banner', '-nostats', '-loglevel', 'error', ...args]);
  if (r.code !== 0) {
    log('ffmpeg:', what, r.err.slice(-1500));
    throw new Error(`не удалось ${what}`);
  }
}

async function renderMontage(user, ctx, plan, say) {
  const p = user.project;
  const dir = projDir(user);
  const work = path.join(dir, 'render');
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  const fps = CFG.fps;
  const [W, H] = outputSize(user, ctx);
  const tl = buildTimeline(plan, ctx, fps);
  const srcFile = (n) => path.join(dir, ctx.bySrc.get(n).file);
  const list = (files) => files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
  try {
    // 1. Звук: куски речи подряд, с короткими фейдами на стыках
    await say(`🎬 Собираю звук (${tl.chunks.length} ${plural(tl.chunks.length, 'кусок', 'куска', 'кусков')})…`);
    const aFiles = [];
    for (let i = 0; i < tl.chunks.length; i++) {
      const c = tl.chunks[i];
      const len = (c.f1 - c.f0) / fps;
      const out = path.join(work, `a${i}.wav`);
      await ff(['-y', '-ss', c.a.toFixed(3), '-i', srcFile(c.src), '-vn', '-ac', '2', '-ar', '48000', '-af', `apad,atrim=0:${len.toFixed(4)},afade=t=in:d=0.008,afade=t=out:st=${Math.max(0, len - 0.012).toFixed(4)}:d=0.012`, '-c:a', 'pcm_s16le', out], 'вырезать звук');
      aFiles.push(out);
    }
    await fsp.writeFile(path.join(work, 'a.txt'), list(aFiles));
    const audio = path.join(work, 'audio.wav');
    await ff(['-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'a.txt'), '-c', 'copy', audio], 'склеить звук');

    // 2. Картинка: каждый план отдельно в одном формате, потом склейка без перекодирования
    const vFiles = [];
    for (let i = 0; i < tl.pieces.length; i++) {
      const pc = tl.pieces[i];
      if (i % 3 === 0) await say(`🎬 Режу видео: ${i + 1} из ${tl.pieces.length}…`);
      const frames = pc.f1 - pc.f0;
      const dur = frames / fps;
      const src = ctx.bySrc.get(pc.src);
      const from = clamp(pc.from, 0, Math.max(0, src.duration - 0.2));
      const z = pc.zoom || 1;
      const vf = [
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        z > 1 ? `scale=trunc(iw*${z}/2)*2:trunc(ih*${z}/2)*2` : '',
        `crop=${W}:${H}:(iw-${W})/2:(ih-${H})*${z > 1 ? 0.4 : 0.5}`,
        'setsar=1',
        `fps=${fps}`,
        `tpad=stop_mode=clone:stop_duration=${(dur + 1).toFixed(3)}`,
        'format=yuv420p',
      ].filter(Boolean).join(',');
      const out = path.join(work, `v${i}.mp4`);
      await ff(['-y', '-ss', from.toFixed(3), '-i', srcFile(pc.src), '-an', '-sn', '-dn', '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', String(fps * 2), '-r', String(fps), '-video_track_timescale', '15360', out], 'вырезать кусок видео');
      vFiles.push(out);
    }
    await fsp.writeFile(path.join(work, 'v.txt'), list(vFiles));
    const video = path.join(work, 'video.mp4');
    await ff(['-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'v.txt'), '-c', 'copy', video], 'склеить видео');

    // 3. Субтитры, громкость, итоговый файл
    await say('🎬 Вшиваю субтитры и выравниваю громкость…');
    let subsNote = '';
    let vf = '';
    if (plan.subtitles.on) {
      if (await assAvailable()) {
        const ass = path.join(work, 'subs.ass');
        await fsp.writeFile(ass, makeAss(plan, ctx, tl, W, H));
        vf = `ass=${filterPath(ass)}${fs.existsSync(CFG.fontsDir) ? `:fontsdir=${filterPath(CFG.fontsDir)}` : ''}`;
      } else subsNote = 'Субтитры не вшиты: на сервере нет нужного модуля ffmpeg.';
    }
    p.version += 1;
    const out = path.join(dir, `result-${p.version}.mp4`);
    await ff(
      ['-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', ...(vf ? ['-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out],
      'собрать итоговый ролик'
    );
    return { v: p.version, file: path.basename(out), duration: tl.total / fps, width: W, height: H, chunks: tl.chunks.length, broll: tl.pieces.filter((x) => x.broll).length, subsNote, at: new Date().toISOString() };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Отправка готового ролика. Свой сервер Bot API берёт файл прямо с диска. */
async function sendVideoFile(chatId, file, extra = {}) {
  const params = { chat_id: chatId, supports_streaming: true, parse_mode: 'HTML', ...extra };
  if (LOCAL_MODE) return tg('sendVideo', { ...params, video: `file://${path.resolve(file)}` }, 30 * 60 * 1000);
  const size = (await fsp.stat(file)).size;
  if (size > 49 * 1024 * 1024) throw new Error('ролик больше 50 МБ — без своего сервера Bot API Telegram его не примет');
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const blob = fs.openAsBlob ? await fs.openAsBlob(file, { type: 'video/mp4' }) : new Blob([await fsp.readFile(file)], { type: 'video/mp4' });
  fd.append('video', blob, path.basename(file));
  let res;
  try {
    res = await fetch(`${TG_BASE}/bot${CFG.token}/sendVideo`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30 * 60 * 1000) });
  } catch (e) {
    throw new Error(`Telegram sendVideo: нет связи (${e.name || e.message})`);
  }
  const j = await res.json().catch(() => null);
  if (!j || !j.ok) throw new Error(`Telegram sendVideo: ${j ? j.description : `HTTP ${res.status}`}`);
  return j.result;
}

function resultCaption(p, extraNote) {
  const r = p.result;
  const plan = p.plan;
  const L = [`🎬 <b>Ролик · вариант ${r.v || p.version}</b> · ${fmtDur(r.duration)}`];
  if (plan.idea) L.push(esc(plan.idea));
  const facts = [`кусков речи: ${r.chunks}`, r.broll ? `перебивок: ${r.broll}` : '', plan.subtitles.on ? 'субтитры: да' : 'без субтитров'].filter(Boolean);
  L.push(facts.join(' · '));
  for (const n of plan.notes.slice(0, 4)) L.push(`• ${esc(n)}`);
  if (extraNote) L.push(`⚠️ ${esc(extraNote)}`);
  L.push('\nПравки пишите сообщением: «убери вторую фразу», «субтитры крупнее и жёлтые», «больше перебивок».');
  let c = L.join('\n');
  if (c.length > 1000) c = c.slice(0, 990) + '…';
  return c;
}

const resultKb = (p) => kb([[...(p.prevResult ? [['↩️ Прошлый вариант', 'm_undo']] : []), ['🆕 Новый ролик', 'm_new']]]);

/** Монтаж с нуля (fixText пустой) или правка уже готового ролика */
async function makeMontage(user, chatId, fixText) {
  const p = user.project;
  if (!user.passport) return void (await send(chatId, 'Сначала научите меня своему стилю: /learn'));
  if (!p || !p.sources.length) return void (await send(chatId, 'Пришлите исходники ролика: видео, перебивки, озвучку.'));
  if (fixText && !p.plan) fixText = '';
  const st = await send(chatId, fixText ? '✏️ Вношу правку…' : '🎬 Начинаю монтаж…');
  const say = (t) => edit(chatId, st.message_id, t);
  try {
    for (const s of p.sources.filter((x) => x.aiError || !x.ai || !x.ai.phrases || (x.kind === 'video' && !x.ai.shots))) {
      await say(`🎬 Разбираю исходник ${s.n}…`);
      try {
        await analyzeSource(user, s);
        delete s.aiError;
      } catch (e) {
        s.aiError = e.message;
      }
    }
    const ctx = projectContext(user);
    if (!ctx.phrases.length) {
      const err = p.sources.find((s) => s.aiError);
      throw new Error(err ? `не удалось расшифровать речь: ${err.aiError}` : 'не нашёл речи ни в одном исходнике. Пришлите видео, где вы говорите, или озвучку голосовым');
    }
    await say(fixText ? '✏️ Меняю план монтажа…' : '🧠 Выбираю лучшие дубли и подбираю перебивки…');
    const raw = await geminiJson(user, [{ text: fixText ? promptFix(user, ctx, fixText) : promptPlan(user, ctx) }], { long: true });
    const plan = normalizePlan(raw, ctx);
    const res = await renderMontage(user, ctx, plan, say);
    // старый прошлый вариант больше не нужен
    if (p.prevResult && p.prevResult.file !== res.file) await fsp.unlink(path.join(projDir(user), p.prevResult.file)).catch(() => {});
    p.prevResult = p.result;
    p.prevPlan = p.plan;
    p.result = res;
    p.plan = plan;
    p.open = false;
    if (fixText) p.fixes.push(fixText);
    res.fixes = [...p.fixes];
    await saveUser(user);
    await say('📤 Отправляю ролик…');
    await sendVideoFile(chatId, path.join(projDir(user), res.file), { caption: resultCaption(p, res.subsNote), width: res.width, height: res.height, duration: Math.round(res.duration), reply_markup: resultKb(p) });
    await tg('deleteMessage', { chat_id: chatId, message_id: st.message_id }).catch(() => {});
  } catch (e) {
    await say(`⚠️ ${fixText ? 'Правку внести' : 'Смонтировать'} не получилось: ${esc(e.message)}`);
    log('montage:', e.stack || e.message);
  }
}

async function undoMontage(user, chatId) {
  const p = user.project;
  if (!p || !p.prevResult) return void (await send(chatId, 'Прошлого варианта уже нет.'));
  [p.result, p.prevResult] = [p.prevResult, p.result];
  [p.plan, p.prevPlan] = [p.prevPlan, p.plan];
  p.fixes = [...(p.result.fixes || [])];
  await saveUser(user);
  await sendVideoFile(chatId, path.join(projDir(user), p.result.file), { caption: resultCaption(p, ''), width: p.result.width, height: p.result.height, duration: Math.round(p.result.duration), reply_markup: resultKb(p) });
}

// ───────────────────────────── Тексты ─────────────────────────────

const HELLO = `Привет! Я Магическая кастрюля — монтажёр, который учится вашему стилю.

<b>Учёба</b> (/learn)
1. Пришлите 5–15 своих готовых роликов — тех, что уже опубликованы.
2. Я разберу их и покажу «паспорт стиля» — как я понял вашу манеру.
3. Подтвердите паспорт или поправьте его сообщением: «субтитры у меня всегда жёлтые».

<b>Монтаж</b> (/edit)
1. Пришлите исходники одного ролика: видео, где вы говорите, отдельные перебивки, озвучку голосовым или аудиофайлом.
2. Если нужно — напишите пожелание: «ролик на 30 секунд, начни с цены».
3. Нажмите «🎬 Смонтировать». Готовый ролик придёт сюда, правки — сообщением.

Команды: /status — что загружено, /style — паспорт, /new — новый ролик, /reset — удалить всё.`;

const EDIT_HELLO = `🎬 <b>Режим монтажа.</b>

Пришлите исходники одного ролика:
• видео, где вы говорите (можно несколько файлов и дублей);
• отдельные перебивки — продукт, процесс, место;
• или озвучку голосовым / аудиофайлом — тогда видеоряд я подберу под каждую фразу.

Пожелания к ролику пишите текстом. Потом нажмите «🎬 Смонтировать».
Новый ролик — /new. Вернуться к учёбе на примерах — /learn.`;

const HOW_TO_SAVE = `По ссылке забрать ролик не получится: Instagram не отдаёт видео с музыкой из своей библиотеки.

Пришлите ролик файлом. Свой Reels можно сохранить так: откройте его в Instagram → «⋯» → «Сохранить на устройство» (или «Скачать»), затем отправьте видео сюда.`;

function statusText(user) {
  if (user.mode === 'edit') return editStatusText(user);
  const L = ['📚 <b>Режим учёбы.</b> Монтаж — /edit\n'];
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

function costLine(user) {
  const cost = (user.usage.in * CFG.priceIn + user.usage.out * CFG.priceOut) / 1e6;
  return `<b>Расход на ИИ:</b> ≈$${num(cost, 2)} (${user.usage.calls} ${plural(user.usage.calls, 'запрос', 'запроса', 'запросов')})`;
}

function editStatusText(user) {
  const p = user.project;
  const L = ['🎬 <b>Режим монтажа.</b> Учёба на примерах — /learn\n'];
  if (!p || !p.sources.length) L.push('Исходников пока нет. Пришлите видео или озвучку.');
  else {
    L.push(`<b>Ролик №${p.id}, исходники: ${p.sources.length}</b>`);
    for (const s of p.sources) L.push(sourceLine(s));
    L.push('Убрать исходник: /del и номер, например /del 2');
  }
  if (p && p.brief.length) L.push(`\n<b>Пожелания:</b>\n${p.brief.map((t) => `• ${esc(t)}`).join('\n')}`);
  if (p && p.result) L.push(`\n<b>Готово:</b> вариант ${p.result.v || p.version}, ${fmtDur(p.result.duration)}; правок: ${p.fixes.length}`);
  L.push('');
  L.push(user.passport ? `<b>Паспорт стиля:</b> версия ${user.passport.version}${user.passport.confirmed ? '' : ' (ещё не подтверждён)'}` : '<b>Паспорт стиля:</b> ещё не собран — /learn');
  L.push(costLine(user));
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

  if (!user.mode) user.mode = user.passport && user.passport.confirmed ? 'edit' : 'learn';
  const m = pickMedia(msg);
  if (m) {
    if (!LOCAL_MODE && m.size > 20 * 1024 * 1024) {
      await send(chatId, '⚠️ Файл больше 20 МБ. Чтобы принимать такие, боту нужен свой сервер Bot API (см. инструкцию по установке). Пока пришлите файл поменьше.');
      return;
    }
    if (user.mode === 'edit') return void (await onSourceMedia(user, chatId, m));
    if (m.kind === 'audio') {
      return void (await send(chatId, user.passport ? 'Озвучка нужна для монтажа. Перейдите в режим монтажа: /edit — и пришлите её снова.' : 'Голосовые и аудио понадобятся для монтажа. Сначала научите меня стилю: пришлите свои готовые ролики.'));
    }
    if (user.examples.length + (pending.get(user.id) || 0) >= CFG.maxExamples) {
      await send(chatId, `Примеров уже ${CFG.maxExamples} — этого более чем достаточно. Лишние можно убрать командой /del.`);
      return;
    }
    enqueue(user, chatId, async () => {
      await processExample(user, chatId, m);
      await afterExamples(user, chatId);
    });
    return;
  }

  if (/^\/(start|help)\b/.test(text)) return void (await send(chatId, HELLO));
  if (/^\/status\b/.test(text)) return void (await send(chatId, statusText(user)));
  if (/^\/edit\b/.test(text)) {
    if (!user.passport) return void (await send(chatId, 'Сначала научите меня своему стилю: пришлите 5–15 готовых роликов и соберите паспорт.'));
    user.mode = 'edit';
    if (!user.project) newProject(user);
    await saveUser(user);
    return void (await send(chatId, EDIT_HELLO + (user.passport.confirmed ? '' : '\n\n⚠️ Паспорт стиля ещё не подтверждён — монтирую по текущей версии.')));
  }
  if (/^\/learn\b/.test(text)) {
    user.mode = 'learn';
    await saveUser(user);
    return void (await send(chatId, '📚 <b>Режим учёбы.</b> Присылайте готовые ролики-примеры — я уточню паспорт стиля. Вернуться к монтажу — /edit'));
  }
  if (/^\/new\b/.test(text)) {
    if (!user.passport) return void (await send(chatId, 'Сначала научите меня своему стилю: пришлите 5–15 готовых роликов.'));
    if (busy(user)) return void (await send(chatId, BUSY));
    user.mode = 'edit';
    await resetProject(user);
    await saveUser(user);
    return void (await send(chatId, `🆕 Ролик №${user.project.id}. Присылайте исходники.`));
  }
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
  if (del && user.mode === 'edit') {
    const p = user.project;
    const s = p && p.sources.find((x) => x.n === Number(del[1]));
    if (!s) return void (await send(chatId, 'Укажите номер исходника из /status, например: /del 2'));
    if (busy(user)) return void (await send(chatId, BUSY));
    p.sources = p.sources.filter((x) => x !== s);
    for (const f of [s.file, s.wav]) if (f) await fsp.unlink(path.join(projDir(user), f)).catch(() => {});
    await saveUser(user);
    return void (await send(chatId, `Исходник ${s.n} убран.`));
  }
  if (del) {
    const ex = user.examples.find((e) => e.n === Number(del[1]));
    if (!ex) return void (await send(chatId, 'Укажите номер примера из /status, например: /del 3'));
    user.examples = user.examples.filter((e) => e !== ex);
    await fsp.unlink(path.join(userDir(user.id), 'examples', ex.file)).catch(() => {});
    await saveUser(user);
    return void (await send(chatId, `Пример ${ex.n} убран.${user.passport ? ' Чтобы паспорт это учёл, пересоберите его: /style → «Пересобрать».' : ''}`));
  }
  if (text.startsWith('/')) return void (await send(chatId, 'Не знаю такой команды. Есть /status, /style, /edit, /learn, /new, /reset и /help.'));

  if (/instagram\.com|instagr\.am/i.test(text)) return void (await send(chatId, HOW_TO_SAVE));

  if (text && user.awaitFix && user.passport) {
    user.awaitFix = false;
    if (text.length > 2000) return void (await send(chatId, 'Слишком длинная правка. Напишите короче — по одной мысли на сообщение.'));
    return void enqueue(user, chatId, () => applyCorrection(user, chatId, text));
  }

  if (text && user.mode === 'edit') {
    if (text.length > 2000) return void (await send(chatId, 'Слишком длинно. Напишите короче — по одной мысли на сообщение.'));
    if (!user.project) newProject(user);
    const p = user.project;
    if (p.result) return void enqueue(user, chatId, () => makeMontage(user, chatId, text));
    if (!p.sources.length && !pending.get(user.id)) {
      p.brief.push(text);
      await saveUser(user);
      return void (await send(chatId, 'Записал пожелание. Теперь пришлите исходники ролика: видео, перебивки или озвучку.'));
    }
    p.brief.push(text);
    await saveUser(user);
    return void (await send(chatId, `Учту при монтаже: «${esc(text)}».`, { reply_markup: montageKb(p) }));
  }

  if (text) {
    if (!user.passport) {
      return void (await send(chatId, user.examples.length ? 'Сначала соберём паспорт стиля — тогда его можно будет поправить словами.' : 'Пришлите сюда свои готовые ролики — с них я начну учиться вашему стилю.', user.examples.length ? { reply_markup: kb([[['🧬 Собрать паспорт стиля', 'build']]]) } : {}));
    }
    if (text.length > 2000) return void (await send(chatId, 'Слишком длинная правка. Напишите короче — по одной мысли на сообщение.'));
    return void enqueue(user, chatId, () => applyCorrection(user, chatId, text));
  }

  if (msg.photo || msg.document || msg.animation || msg.sticker) {
    await send(chatId, user.mode === 'edit' ? 'Мне нужны видео или звук: исходники ролика или озвучка.' : 'Мне нужны видео: пришлите свои готовые ролики.');
  }
}

const BUSY = 'Подождите, я ещё обрабатываю прошлые файлы — нажмите ещё раз, когда закончу.';
const busy = (user) => (pending.get(user.id) || 0) > 0;

/** Видео или звук в режиме монтажа */
async function onSourceMedia(user, chatId, m) {
  if (!user.project) newProject(user);
  const p = user.project;
  // К готовому ролику прислали ещё файлы — спрашиваем, к какому ролику они
  if (p.result && !p.open) {
    user.hold = user.hold || [];
    user.hold.push(m);
    if (user.hold.length === 1) {
      await send(chatId, 'Это для текущего ролика или для нового?', { reply_markup: kb([[['➕ К этому ролику', 'hold_add'], ['🆕 Новый ролик', 'hold_new']]]) });
    }
    return;
  }
  if (p.sources.length + (pending.get(user.id) || 0) >= CFG.maxSources) {
    return void (await send(chatId, `Исходников уже ${CFG.maxSources}. Лишние можно убрать командой /del.`));
  }
  enqueue(user, chatId, async () => {
    if (user.project !== p) return;
    await processSource(user, chatId, m);
    await afterSources(user, chatId);
  });
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
      user.mode = 'edit';
      if (!user.project) newProject(user);
      await saveUser(user);
      await send(chatId, `✅ Паспорт стиля (версия ${user.passport.version}) сохранён.\n\nУточнить его можно в любой момент: /style → «Поправить», или пришлите ещё примеров в режиме учёбы (/learn).`);
      await send(chatId, EDIT_HELLO);
      break;
    case 'fix':
      await done();
      user.awaitFix = true;
      await send(chatId, 'Напишите одним сообщением, что не так в паспорте. Например:\n• «субтитры у меня всегда жёлтые, внизу»\n• «музыку я ставлю тише»\n• «в начале всегда крупный план продукта»');
      break;
    case 'm_go': {
      await dropButtons();
      const p = user.project;
      if (!p || (!p.sources.length && !busy(user))) {
        await done();
        await send(chatId, 'Сначала пришлите исходники ролика.');
        break;
      }
      await done('Монтирую…');
      enqueue(user, chatId, () => makeMontage(user, chatId, ''));
      break;
    }
    case 'm_clear':
    case 'm_new':
    case 'hold_new':
      if (busy(user)) return done('Подождите, я ещё занят');
      await done(q.data === 'm_clear' ? 'Очищено' : 'Новый ролик');
      await dropButtons();
      {
        const held = q.data === 'hold_new' ? user.hold || [] : [];
        await resetProject(user);
        user.mode = 'edit';
        await saveUser(user);
        await send(chatId, q.data === 'm_clear' ? 'Исходники удалены. Присылайте новые.' : `🆕 Ролик №${user.project.id}. ${held.length ? 'Беру присланные файлы.' : 'Присылайте исходники.'}`);
        for (const m of held) await onSourceMedia(user, chatId, m);
      }
      break;
    case 'hold_add': {
      await done('Добавляю');
      await dropButtons();
      const held = user.hold || [];
      user.hold = [];
      if (user.project) user.project.open = true;
      for (const m of held) await onSourceMedia(user, chatId, m);
      break;
    }
    case 'm_undo':
      await done();
      enqueue(user, chatId, () => undoMontage(user, chatId));
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
      { command: 'new', description: 'Новый ролик' },
      { command: 'edit', description: 'Режим монтажа' },
      { command: 'learn', description: 'Учёба на примерах' },
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

module.exports = { _test: { sendVideoFile, setBase: (b) => (TG_BASE = b) }, probe, detectCuts, shotStats, audioStats, aggregate, renderPassport, parseJsonLoose, num, plural, txt, snapPhrases, cutSilences, overlayPiece, fillGaps, mergePieces, buildTimeline, normalizePlan, makeAss, silenceMap };
