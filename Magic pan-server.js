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
  // Запасная модель — когда основная перегружена. Пустое значение отключает
  geminiFallback: process.env.GEMINI_FALLBACK_MODEL != null ? process.env.GEMINI_FALLBACK_MODEL.trim() : 'gemini-3.1-flash-lite',
  geminiUrl: (process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
  // Цена за 1 млн токенов, только для подсказки о расходах в /status
  priceIn: Number(process.env.PRICE_IN || 0.75),
  priceOut: Number(process.env.PRICE_OUT || 3.75),
  // прогноз: сколько входных токенов Gemini тратит на секунду видео/аудио (при MEDIA_RESOLUTION_LOW)
  tokPerSec: Number(process.env.TOK_PER_SEC || 70),
  keepProjects: Number(process.env.KEEP_PROJECTS || 5), // сколько прошлых роликов с исходниками хранить для /history
  tz: process.env.TZ_NAME || 'Europe/Kyiv',
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
  aiParallel: Number(process.env.AI_PARALLEL || 3), // сколько исходников разбирать одновременно
  batchMax: Number(process.env.AI_BATCH || 8), // сколько коротких видео разбирать одним запросом
  batchMaxSec: Number(process.env.AI_BATCH_SEC || 90), // «короткое» видео — до стольких секунд
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
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
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
  return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }).catch((e) => {
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

/** Загрузка файла в Gemini с повтором при обрыве связи или перегрузке */
async function geminiUpload(file, waitMs = 5 * 60 * 1000) {
  for (let i = 1; ; i++) {
    try {
      return await geminiUploadOnce(file, waitMs);
    } catch (e) {
      if (i >= 3 || !/нет связи|HTTP 5\d\d|HTTP 429/.test(e.message)) throw e;
      log('upload retry:', e.message);
      await sleep(5000 * i);
    }
  }
}

async function geminiUploadOnce(file, waitMs) {
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
// ── Лимиты Gemini ──
const exhausted = new Map(); // модель → когда снова доступна (дневной лимит)

function nextQuotaReset() {
  // дневные лимиты Google сбрасываются в полночь по тихоокеанскому времени — берём с запасом +1 ч
  const now = new Date();
  const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(la);
  midnight.setHours(24, 0, 0, 0);
  return now.getTime() + (midnight - la) + 3600e3;
}

/** Первая доступная модель: основная, потом запасная. except — исключить текущую */
function pickModel(except) {
  for (const m of [CFG.geminiModel, CFG.geminiFallback]) {
    if (!m || m === except) continue;
    const until = exhausted.get(m);
    if (until && until > Date.now()) continue;
    return m;
  }
  return null;
}

function quotaInfo(err) {
  const det = Array.isArray(err.details) ? err.details : [];
  const ids = det.flatMap((d) => (d.violations || []).map((v) => `${v.quotaId || ''} ${v.quotaMetric || ''}`)).join(' ') + ' ' + (err.message || '');
  const retry = det.find((d) => d.retryDelay);
  return { daily: /PerDay/i.test(ids), free: /free_?tier/i.test(ids), retrySec: retry ? parseFloat(retry.retryDelay) : null };
}

function quotaError(perMinute) {
  const e = new Error(
    perMinute
      ? 'Google ограничивает число запросов в минуту на бесплатном тарифе Gemini — подождите пару минут или подключите оплату в Google AI Studio'
      : 'на сегодня закончился бесплатный лимит запросов к Gemini. Подключите оплату в Google AI Studio (aistudio.google.com → Billing) — лимиты станут намного выше — или подождите до завтра'
  );
  e.quota = true;
  return e;
}

async function geminiJson(user, parts, opts = {}) {
  const base = { contents: [{ role: 'user', parts }] };
  // Сначала просим строгий JSON (и, если нужно, длинный ответ и экономный разбор видео);
  // если сервис не знает какой-то настройки — повторяем без неё
  // Необязательные настройки снимаем по одной, если сервис их не принимает
  const extras = [];
  if (opts.fast) extras.push(['thinkingConfig', { thinkingLevel: 'low' }]);
  if (opts.lowRes) extras.push(['mediaResolution', 'MEDIA_RESOLUTION_LOW']);
  if (opts.long) extras.push(['maxOutputTokens', 65536]);
  let variants = [];
  for (let i = 0; i <= extras.length; i++) {
    variants.push({ ...base, generationConfig: Object.assign({ responseMimeType: 'application/json' }, Object.fromEntries(extras.slice(i))) });
  }
  variants.push(base);
  let lastErr;
  // Перегрузку и лимит «в минуту» пережидаем; дневной лимит — сразу переходим на запасную модель
  let model = pickModel();
  if (!model) throw quotaError();
  let overloads = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    let res;
    try {
      res = await gfetch(
        `${CFG.geminiUrl}/v1beta/models/${model}:generateContent`,
        { method: 'POST', headers: { 'x-goog-api-key': CFG.geminiKey, 'content-type': 'application/json' }, body: JSON.stringify(variants[0]) },
        10 * 60 * 1000
      );
    } catch (e) {
      // обрыв связи — повторяем, как при перегрузке
      overloads++;
      lastErr = e;
      lastErr.overload = true;
      if (overloads > 5) break;
      await sleep(5000 * overloads);
      continue;
    }
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (j && j.error) || {};
      const msg = err.message || `HTTP ${res.status}`;
      lastErr = new Error(`ИИ-сервис ответил ошибкой: ${msg.slice(0, 200)}`);
      if (res.status === 400 && variants.length > 1) {
        variants = variants.slice(1);
        continue;
      }
      if (res.status === 429 && /quota/i.test(msg)) {
        const q = quotaInfo(err);
        if (q.daily) {
          exhausted.set(model, nextQuotaReset());
          log(`Gemini ${model}: дневной лимит исчерпан`);
          model = pickModel();
          if (!model) throw quotaError();
          if (opts.onWait) await opts.onWait('дневной лимит основной модели исчерпан — перехожу на запасную');
          continue;
        }
        overloads++;
        if (overloads > 6) {
          lastErr = quotaError(true);
          break;
        }
        const wait = clamp(q.retrySec || 30, 5, 65);
        if (opts.onWait) await opts.onWait(`лимит запросов в минуту — жду ${wait} с`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        overloads++;
        lastErr = new Error('серверы Google сейчас перегружены');
        lastErr.overload = true;
        if (overloads === 3 && CFG.geminiFallback && CFG.geminiFallback !== model && pickModel(model)) {
          log(`Gemini ${model} перегружен, перехожу на ${CFG.geminiFallback}`);
          model = CFG.geminiFallback;
          if (opts.onWait) await opts.onWait('ИИ перегружен — переключаюсь на запасную модель');
          continue;
        }
        if (overloads > 6) break;
        const wait = Math.min(30, 5 * 2 ** Math.min(overloads - 1, 3));
        if (opts.onWait) await opts.onWait(`ИИ перегружен — жду ${wait} с и пробую снова`);
        await sleep(wait * 1000);
        continue;
      }
      throw lastErr;
    }
    const um = (j && j.usageMetadata) || {};
    user.usage.in += um.promptTokenCount || 0;
    user.usage.out += (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
    user.usage.calls += 1;
    // расход считается и на весь ролик (для отчёта по каждому варианту)
    if (user.project) {
      const sp = (user.project.spend = user.project.spend || { in: 0, out: 0, calls: 0 });
      sp.in += um.promptTokenCount || 0;
      sp.out += (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
      sp.calls += 1;
    }
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
const pending = new Map(); // сколько задач у пользователя: в работе + ждут
const waiting = new Map(); // сколько задач ещё не начаты
const bgJobs = new Map(); // разборы ИИ, которые идут параллельно очереди: user.id → Set<Promise>

const bgCount = (user) => (bgJobs.get(user.id) || new Set()).size;
const isBusy = (user) => (pending.get(user.id) || 0) > 0 || bgCount(user) > 0;

function enqueue(user, chatId, job) {
  pending.set(user.id, (pending.get(user.id) || 0) + 1);
  waiting.set(user.id, (waiting.get(user.id) || 0) + 1);
  activity(user, chatId);
  queueNote(user, chatId);
  chain = chain
    .then(() => {
      waiting.set(user.id, Math.max(0, (waiting.get(user.id) || 1) - 1));
      queueNote(user, chatId);
      return job();
    })
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

/** Фоновая задача (разбор ИИ) — не держит очередь, но учитывается как «занят» */
function background(user, chatId, job) {
  if (!bgJobs.has(user.id)) bgJobs.set(user.id, new Set());
  const set = bgJobs.get(user.id);
  const pr = Promise.resolve()
    .then(job)
    .catch((e) => log('bg:', e.stack || e.message))
    .finally(() => {
      set.delete(pr);
      saveUser(user).catch(() => {});
    });
  set.add(pr);
  activity(user, chatId);
  return pr;
}

/** Пока бот работает, в шапке чата висит «печатает…» */
const actTimers = new Map();
function activity(user, chatId) {
  if (actTimers.has(user.id)) return;
  const ping = () => tg('sendChatAction', { chat_id: chatId, action: 'typing' }, 10000).catch(() => {});
  ping();
  const iv = setInterval(() => {
    if (!isBusy(user)) {
      clearInterval(iv);
      actTimers.delete(user.id);
      return;
    }
    ping();
  }, 4500);
  actTimers.set(user.id, iv);
}

/** Одно сообщение «в очереди: N» на пользователя — альбом из 10 видео не даёт 10 сообщений */
const notes = new Map(); // user.id → { id, timer, text }
function queueNote(user, chatId) {
  const n = notes.get(user.id) || {};
  notes.set(user.id, n);
  clearTimeout(n.timer);
  n.timer = setTimeout(async () => {
    const w = waiting.get(user.id) || 0;
    const text = w > 0 ? `📥 Ещё в очереди: <b>${w}</b>. Обрабатываю по одному — у каждого файла будет своё сообщение со статусом.` : '';
    if (text === n.text) return;
    n.text = text;
    if (!text) {
      if (n.id) await tg('deleteMessage', { chat_id: chatId, message_id: n.id }).catch(() => {});
      n.id = null;
    } else if (n.id) await edit(chatId, n.id, text);
    else n.id = (await send(chatId, text).catch(() => ({}))).message_id || null;
  }, 800);
}

/**
 * Статус задачи в одном сообщении: текст этапа + сколько времени идёт.
 * Таймер обновляется каждые 10 секунд, чтобы было видно, что бот не завис.
 */
async function progress(user, chatId, first) {
  const msg = await send(chatId, `${first}`);
  const t0 = Date.now();
  let text = first;
  let alive = true;
  const draw = () => edit(chatId, msg.message_id, `${text} <i>${fmtDur((Date.now() - t0) / 1000)}</i>`);
  const iv = setInterval(() => alive && draw(), 10000);
  // запоминаем, чтобы после перезапуска сервера честно написать, что задача прервалась
  user.live = (user.live || []).filter((x) => x.id !== msg.message_id).concat({ chatId, id: msg.message_id, text: first });
  saveUser(user).catch(() => {});
  return {
    id: msg.message_id,
    set(t) {
      text = t;
      const l = (user.live || []).find((x) => x.id === msg.message_id);
      if (l) l.text = t;
      return alive ? draw() : null;
    },
    async done(t, extra) {
      alive = false;
      clearInterval(iv);
      user.live = (user.live || []).filter((x) => x.id !== msg.message_id);
      if (t === null) return tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      return edit(chatId, msg.message_id, t, extra);
    },
  };
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
  const st = await progress(user, chatId, `⏳ Пример ${n}: получаю файл…`);
  const say = (t) => st.set(t);
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
    dropInbox(user, v);
    await saveUser(user);
    await say(`⏳ Пример ${n}: смотрю ролик и разбираю приёмы…`);
    const head = `Пример ${n} · ${num(meta.duration, 0)} с · ${cuts.length} ${plural(cuts.length, 'склейка', 'склейки', 'склеек')} · план ≈${num(ex.shots.avg)} с`;
    try {
      await aiAnalyze(user, ex);
      await st.done(`✅ ${head}${ex.ai.type ? ` · ${esc(txt(ex.ai.type))}` : ''}`);
    } catch (e) {
      ex.aiError = e.message;
      log('ai:', e.message);
      await st.done(`⚠️ ${head}\nТемп измерил, но разобрать приёмы не удалось: ${esc(e.message)}. Повторю попытку при сборке паспорта.`);
    }
  } catch (e) {
    dropInbox(user, v);
    await fsp.unlink(file).catch(() => {});
    await st.done(`⚠️ Пример ${n} не принят: ${esc(e.message)}.`);
  }
}

// ───────────────────────────── Входящие файлы переживают перезапуск ─────────────────────────────

function addInbox(user, type, m) {
  user.inbox = (user.inbox || []).concat({ type, m, at: new Date().toISOString() });
  saveUser(user).catch(() => {});
}
function dropInbox(user, m) {
  user.inbox = (user.inbox || []).filter((x) => x.m.fileId !== m.fileId);
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
  const st = await progress(user, chatId, '🧠 Собираю паспорт стиля…');
  let data;
  let agg;
  let ready;
  try {
    // Примеры, где ИИ-разбор не удался в прошлый раз, пробуем ещё раз
    for (const ex of user.examples.filter((e) => !e.ai)) {
      await st.set(`🧠 Повторно разбираю пример ${ex.n}…`);
      await aiAnalyze(user, ex).catch((e) => (ex.aiError = e.message));
    }
    ready = user.examples.filter((e) => e.ai);
    if (!ready.length) {
      await st.done(`⚠️ Не удалось разобрать примеры: ${esc(user.examples[0].aiError || 'ИИ-сервис недоступен')}. Попробуйте позже.`);
      return;
    }
    await st.set('🧠 Собираю паспорт стиля…');
    agg = aggregate(ready);
    data = await geminiJson(user, [{ text: promptPassport(user, ready, agg) }]);
  } catch (e) {
    await st.done(`⚠️ Собрать паспорт не получилось: ${esc(e.message)}`);
    return;
  }
  user.prevPassport = null;
  user.passport = { version: ((user.passport && user.passport.version) || 0) + 1, confirmed: false, createdAt: new Date().toISOString(), measured: agg, data };
  await saveUser(user);
  await st.done(null);
  await sendLong(chatId, renderPassport(user), { reply_markup: kb([[['✅ Всё верно', 'ok'], ['✏️ Поправить', 'fix']]]) });
}

async function applyCorrection(user, chatId, text) {
  const st = await progress(user, chatId, '✏️ Вношу правку в паспорт…');
  user.corrections.push({ text, at: new Date().toISOString() });
  try {
    const data = await geminiJson(user, [{ text: promptCorrection(user, text) }]);
    user.prevPassport = user.passport;
    user.passport = { ...user.passport, version: user.passport.version + 1, confirmed: false, createdAt: new Date().toISOString(), data };
  } catch (e) {
    user.corrections.pop();
    await st.done(`⚠️ Правку внести не получилось: ${esc(e.message)}`);
    return;
  }
  await st.done(null);
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

const projDir = (user, p = user.project) => path.join(userDir(user.id), (p && p.dir) || 'project');

function newProject(user) {
  user.projSeq = (user.projSeq || 0) + 1;
  user.project = { id: user.projSeq, dir: `projects/${user.projSeq}`, seq: 0, stage: 'talk', sources: [], brief: [], fixes: [], plan: null, version: 0, result: null, history: [], final: null, open: false, createdAt: new Date().toISOString() };
  return user.project;
}

/** Все смонтированные варианты ролика (старые проекты без истории — из текущего результата) */
function ensureHistory(p) {
  if (!p.history) p.history = p.result ? [{ ...p.result, plan: p.plan, fixes: [...(p.fixes || [])] }] : [];
  return p.history;
}

/** Ролик с вариантами уходит в архив вместе с исходниками — к нему можно вернуться через /history */
async function archiveProject(user, p) {
  p.open = false;
  p.archivedAt = new Date().toISOString();
  user.archive = [p, ...(user.archive || []).filter((x) => x.id !== p.id)];
  const extra = user.archive.slice(CFG.keepProjects);
  user.archive = user.archive.slice(0, CFG.keepProjects);
  for (const old of extra) await fsp.rm(projDir(user, old), { recursive: true, force: true }).catch(() => {});
}

async function resetProject(user) {
  const cur = user.project;
  if (cur && ensureHistory(cur).length) await archiveProject(user, cur);
  else if (cur) await fsp.rm(projDir(user, cur), { recursive: true, force: true }).catch(() => {});
  user.hold = [];
  user.replace = null;
  user.inbox = (user.inbox || []).filter((x) => x.type !== 'source');
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
Ещё укажи "speech": true, если в видео слышна речь человека (в кадре или за кадром), и false, если только шум, музыка или тишина.

Ответь строго одним JSON-объектом без пояснений:
{"speech": false, "shots": [{"start": 0, "end": 4.5, "kind": "broll", "what": "...", "quality": "good"}]}`;
}

/** Расшифровка речи и описание планов. Уже сделанное не повторяется. */
/** Нужна ли этому исходнику ещё работа ИИ */
function needsAnalysis(user, s) {
  const ai = s.ai || {};
  if (s.kind === 'video' && !ai.shots) return true;
  if (ai.phrases) return false;
  return s.kind === 'audio' || s.role !== 'broll';
}

const ROLE_NAME = { talk: 'речь в кадре', broll: 'перебивка', voice: 'озвучка' };
const ROLE_ICON = { talk: '🎤', broll: '🎞', voice: '🎙' };
const roleOf = (s) => s.role || (s.kind === 'audio' ? 'voice' : 'talk');

/**
 * Разбор исходника. Видео: сначала планы (и есть ли в нём речь), потом — только если речь
 * нужна — расшифровка. Перебивки (роль broll) не расшифровываются вовсе; видео с ролью «речь»
 * расшифровывается, даже если в ролике есть отдельная озвучка (гибрид: речь в кадре + закадровый голос).
 */
async function analyzeSource(user, src, opts = {}) {
  const dir = projDir(user);
  src.ai = src.ai || {};
  if (src.kind === 'video' && !src.ai.shots) {
    // короткие видео разбираются пачкой — один запрос к ИИ на несколько файлов
    const j = src.duration <= CFG.batchMaxSec ? await shotsBatched(user, src, opts) : await aiSlot(() => shotsSingle(user, src, opts));
    src.ai.hasSpeech = j.speech !== false;
    src.ai.shots = normShots(j.shots, src).map((s, i) => ({ id: `${src.n}#${i + 1}`, ...s }));
  }
  if (src.ai.phrases) return;
  const noSpeech = roleOf(src) === 'broll' || !src.hasAudio || !src.wav || src.speechShare < 0.04 || (src.kind === 'video' && src.ai.hasSpeech === false);
  if (noSpeech) {
    src.ai.phrases = [];
    src.ai.language = 'none';
    return;
  }
  await aiSlot(async () => {
    const up = await geminiUpload(path.join(dir, src.wav));
    try {
      const j = await geminiJson(user, [{ file_data: { mime_type: up.mime, file_uri: up.uri } }, { text: promptTranscribe(src) }], { long: true, fast: true, onWait: opts.onWait });
      src.ai.language = txt(j.language) || '';
      src.ai.phrases = snapPhrases(j.phrases, src.silences || [], src.duration).map((p, i) => ({ id: `${src.n}.${i + 1}`, ...p }));
    } finally {
      geminiDelete(up.name);
    }
  });
}

async function shotsSingle(user, src, opts = {}) {
  const up = await geminiUpload(path.join(projDir(user), src.file), 15 * 60 * 1000);
  try {
    return await geminiJson(user, [{ file_data: { mime_type: up.mime, file_uri: up.uri } }, { text: promptShots(src) }], { long: true, lowRes: true, fast: true, onWait: opts.onWait });
  } finally {
    geminiDelete(up.name);
  }
}

// ── Пакетный разбор коротких видео: альбом из 10 перебивок — 1–2 запроса вместо 10 ──
const shotBatches = new Map(); // user.id → { items, timer }

function shotsBatched(user, src, opts = {}) {
  return new Promise((resolve, reject) => {
    let b = shotBatches.get(user.id);
    if (!b) {
      b = { items: [] };
      shotBatches.set(user.id, b);
    }
    b.items.push({ src, resolve, reject, onWait: opts.onWait });
    clearTimeout(b.timer);
    const flush = () => {
      clearTimeout(b.timer);
      if (shotBatches.get(user.id) === b) shotBatches.delete(user.id);
      runShotBatch(user, b.items);
    };
    const total = b.items.reduce((s, x) => s + x.src.duration, 0);
    if (b.items.length >= CFG.batchMax || total >= CFG.batchMaxSec * 3) flush();
    // в очереди ещё есть файлы — ждём их; очередь пуста — отправляем почти сразу
    else b.timer = setTimeout(flush, (waiting.get(user.id) || 0) > 0 ? 8000 : 1500);
  });
}

function promptShotsBatch(n) {
  return `Выше ${n} исходных видео для монтажа одного ролика, каждое подписано номером («Файл 1», «Файл 2»…). Для КАЖДОГО файла отдельно раздели видео на планы — непрерывные куски с одним содержанием — и опиши каждый так, чтобы монтажёр мог выбрать перебивки, не глядя видео.

Для каждого плана:
- start, end — секунды от начала ЭТОГО файла, точность 0,1 с;
- kind: "talking" — человек говорит в камеру; "broll" — то, что годится в перебивку (продукт, процесс, место, детали, люди без синхрона); "junk" — брак: тряска, расфокус, камера смотрит в пол, случайная съёмка;
- what — что в кадре, 4–12 слов, конкретно (не «красивый кадр», а «нарезка лосося крупным планом»);
- quality: "good" | "ok" | "bad".
Планы должны покрывать весь файл без пропусков. Для каждого файла укажи "speech": true, если в нём слышна речь человека, и false, если только шум, музыка или тишина.

Ответь строго одним JSON-объектом без пояснений, по одному элементу на каждый файл:
{"files": [{"file": 1, "speech": false, "shots": [{"start": 0, "end": 4.5, "kind": "broll", "what": "...", "quality": "good"}]}]}`;
}

async function runShotBatch(user, items) {
  if (items.length === 1) {
    const it = items[0];
    try {
      it.resolve(await aiSlot(() => shotsSingle(user, it.src, { onWait: it.onWait })));
    } catch (e) {
      it.reject(e);
    }
    return;
  }
  const onWait = (t) => Promise.all(items.map((x) => (x.onWait ? x.onWait(t) : null)));
  const ups = [];
  try {
    await aiSlot(async () => {
      for (const it of items) ups.push(await geminiUpload(path.join(projDir(user), it.src.file), 15 * 60 * 1000));
      const parts = [];
      items.forEach((it, i) => {
        parts.push({ text: `Файл ${i + 1} (длительность ${it.src.duration.toFixed(1)} с, кадр ${it.src.width}×${it.src.height}):` });
        parts.push({ file_data: { mime_type: ups[i].mime, file_uri: ups[i].uri } });
      });
      parts.push({ text: promptShotsBatch(items.length) });
      const j = await geminiJson(user, parts, { long: true, lowRes: true, fast: true, onWait });
      const files = Array.isArray(j.files) ? j.files : [];
      items.forEach((it, i) => {
        const f = files.find((x) => Number(x && x.file) === i + 1) || files[i];
        if (f && Array.isArray(f.shots)) it.resolve(f);
        else it.reject(new Error('ИИ пропустил этот файл'));
      });
    });
  } catch (e) {
    items.forEach((it) => it.reject(e));
  } finally {
    ups.forEach((u) => geminiDelete(u.name));
  }
}

/** Разбор с ожиданием, если Google перегружен: до трёх заходов с паузой в минуту */
async function analyzePatiently(user, src, say) {
  for (let round = 1; ; round++) {
    try {
      await analyzeSource(user, src, { onWait: (t) => say(`⏳ Исходник ${src.n}: ${t}…`) });
      delete src.aiError;
      return;
    } catch (e) {
      if (e.quota || !e.overload || round >= 3) throw e;
      await say(`⏳ Исходник ${src.n}: серверы Google перегружены — повторю через минуту (попытка ${round + 1} из 3)…`);
      await sleep(60000);
    }
  }
}

const LANG = { ru: 'рус.', uk: 'укр.', mixed: 'рус. и укр.' };

function sourceLine(src) {
  const role = roleOf(src);
  const parts = [`Исходник ${src.n} · ${ROLE_ICON[role]} ${ROLE_NAME[role]} ${fmtDur(src.duration)}`];
  const ai = src.ai || {};
  if (role !== 'broll' && ai.phrases) parts.push(ai.phrases.length ? `речь: ${ai.phrases.length} ${plural(ai.phrases.length, 'фраза', 'фразы', 'фраз')}${LANG[ai.language] ? ` (${LANG[ai.language]})` : ''}` : 'без речи');
  if (ai.shots) {
    const b = ai.shots.filter((s) => s.kind === 'broll' && s.quality !== 'bad').length;
    parts.push(`${ai.shots.length} ${plural(ai.shots.length, 'план', 'плана', 'планов')}${b ? `, для перебивок: ${b}` : ''}`);
  }
  if (role === 'broll' && !ai.shots && !src.aiError) parts.push('принят, разберу после этапа 2');
  return `${src.aiError ? '⚠️' : ai.shots || ai.phrases ? '✅' : '📥'} ${parts.join(' · ')}`;
}

async function processSource(user, chatId, m) {
  const p = user.project;
  const n = ++p.seq;
  const st = await progress(user, chatId, `⏳ Исходник ${n}: получаю файл…`);
  const say = (t) => st.set(t);
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
    const src = { n, kind: m.kind, role: m.kind === 'audio' ? 'voice' : m.role === 'broll' ? 'broll' : 'talk', file: path.basename(file), duration: meta.duration, width: meta.width || 0, height: meta.height || 0, fps: meta.fps || 0, orientation: meta.orientation || '', hasAudio: !!meta.hasAudio, silences: [], speechShare: 0, ai: null };
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
    if (m.replaceN) {
      // замена: старый исходник убираем (готовые варианты в истории остаются)
      const old = p.sources.find((x) => x.n === m.replaceN);
      if (old) {
        p.sources = p.sources.filter((x) => x !== old);
        for (const f of [old.file, old.wav]) if (f) await fsp.unlink(path.join(dir, f)).catch(() => {});
      }
      src.replaced = m.replaceN;
    }
    dropInbox(user, m);
    await saveUser(user);
    // Перебивки этапа 2 пока только принимаем: ИИ разберёт их, когда этап закончится
    if (src.role === 'broll' && stageOf(p) === 'broll') return void (await st.done(sourceLine(src)));
    // Разбор ИИ идёт параллельно: очередь сразу берёт следующий файл
    await say(`⏳ Исходник ${n}: жду очереди к ИИ…`);
    background(user, chatId, () =>
      (async () => {
        await say(`⏳ Исходник ${n}: ${src.kind === 'audio' ? 'расшифровываю речь' : 'смотрю кадры'}…`);
        try {
          await analyzePatiently(user, src, say);
          await st.done(sourceLine(src) + (src.replaced ? ` — 🔁 вместо исходника ${src.replaced}` : ''));
        } catch (e) {
          src.aiError = e.message;
          log('source ai:', e.message);
          await st.done(`📥 Исходник ${n} принят (${ROLE_NAME[roleOf(src)]} ${fmtDur(src.duration)}). Разобрать пока не удалось: ${esc(e.message)}${e.quota ? '' : '. Повторю сам при монтаже'}.`);
        }
      })()
    ).then(() => setTimeout(() => afterSources(user, chatId).catch(() => {}), 50));
  } catch (e) {
    dropInbox(user, m);
    await fsp.unlink(file).catch(() => {});
    await st.done(`⚠️ Исходник ${n} не принят: ${esc(e.message)}.`);
  }
}

/** Не больше CFG.aiParallel разборов ИИ одновременно */
let aiActive = 0;
const aiWaiters = [];
async function aiSlot(fn) {
  while (aiActive >= CFG.aiParallel) await new Promise((r) => aiWaiters.push(r));
  aiActive++;
  try {
    return await fn();
  } finally {
    aiActive--;
    const next = aiWaiters.shift();
    if (next) next();
  }
}

// ── Мастер нового ролика: 4 этапа ──
const STAGE_NO = { talk: 1, broll: 2, brief: 3, ready: 4 };
const STAGE_NAME = { talk: 'Речь', broll: 'Перебивки', brief: 'Пожелания', ready: 'Монтаж' };
const stageOf = (p) => (p && STAGE_NO[p.stage] ? p.stage : 'talk');
const stageDots = (n) => [1, 2, 3, 4].map((i) => (i < n ? '✅' : i === n ? '🔵' : '⚪')).join('');
const stageLine = (p) => `${stageDots(STAGE_NO[stageOf(p)])} Сейчас: <b>этап ${STAGE_NO[stageOf(p)]} из 4 · ${STAGE_NAME[stageOf(p)]}</b>`;

function stageKb(p) {
  const st = stageOf(p);
  if (st === 'talk') return kb([[['➡️ Дальше: перебивки', 'st_broll']]]);
  if (st === 'broll') return kb([[['➡️ Дальше: пожелания', 'st_brief']], [['⬅️ Назад: речь', 'st_talk']]]);
  if (st === 'brief') return kb([[p.brief.length ? ['➡️ Дальше: монтаж', 'st_ready'] : ['🎨 На выбор ИИ', 'st_ready']], [['⬅️ Назад: перебивки', 'st_broll']]]);
  return kb([[['▶️ Смонтировать', 'm_run']], [['✍️ Пожелания', 'st_brief'], ['➕ Ещё файлы', 'st_talk']], [['🗑 Начать заново', 'm_clear']]]);
}
const montageKb = stageKb;

function introText(user, p, extra = '') {
  const warn = user.passport && !user.passport.confirmed ? '\n\n⚠️ Паспорт стиля ещё не подтверждён — монтирую по текущей версии.' : '';
  return `🎬 <b>Режим монтажа · Ролик №${p.id}</b>

Соберём ролик за 4 этапа. На каждом я скажу, что прислать, и дам кнопку «Дальше»:

1️⃣ <b>Речь</b> — видео, где вы говорите в камеру, и/или голосовое сообщение с закадровым текстом
2️⃣ <b>Перебивки</b> — видео для картинки: продукт, процесс, место. Речь в них не слушаю
3️⃣ <b>Пожелания</b> — коротко, каким должен быть ролик, или «на выбор ИИ»
4️⃣ <b>Монтаж и правки</b> — покажу цену, смонтирую, правки пишете текстом

Этапы можно пропускать: например, только голосовое + перебивки или только видео с речью.${extra ? `\n\n${extra}` : ''}${warn}`;
}

function stageText(user, p) {
  const st = stageOf(p);
  const head = `${stageDots(STAGE_NO[st])}\n<b>Этап ${STAGE_NO[st]} из 4 · ${STAGE_NAME[st]}</b>\n\n`;
  if (st === 'talk') {
    return head + `Пришлите сюда то, что должно звучать в ролике:
🎤 <b>видео, где вы говорите</b> в камеру — можно несколько файлов и дублей, лучший выберу сам;
🎙 <b>голосовое сообщение</b> — зажмите микрофон внизу чата и наговорите текст (или пришлите аудиофайл). Под него я подберу картинку.

Можно и видео, и голосовое вместе. Речи в ролике не будет — сразу жмите «Дальше».

⏳ Пришлите все файлы и <b>дождитесь моей сводки</b> «Исходников: …» — в ней будет кнопка «Дальше».`;
  }
  if (st === 'broll') {
    return head + `Пришлите видео, которые пойдут картинкой: продукт, процесс, место, детали, люди. Звук и речь в них я не слушаю.
💡 Видео, снятые в 60 кадров/с, смогу плавно замедлить.

Сейчас только принимаю файлы — разберу их, когда нажмёте «Дальше». Перебивок нет — тоже жмите «Дальше».

⏳ Пришлите все перебивки и <b>дождитесь моей сводки</b> «Исходников: …» — в ней будет кнопка «Дальше».`;
  }
  if (st === 'brief') {
    const had = p.brief.length ? `\n\nУже записано:\n${p.brief.map((t) => `• ${esc(t)}`).join('\n')}` : '';
    return head + `Напишите коротко, каким должен быть ролик, например:
• «ролик на 30 секунд, начни с цены»
• «динамично, в конце — призыв написать в директ»
Можно несколькими сообщениями.

Или нажмите «🎨 На выбор ИИ» — смонтирую по вашему паспорту стиля${creativeOn(user) ? ' и сам усилю ролик ради удержания' : ''}.${had}`;
  }
  return readyText(user, p);
}

function readyText(user, p) {
  const cnt = (r) => p.sources.filter((s) => roleOf(s) === r).length;
  const src = [cnt('talk') ? `🎤 с речью: ${cnt('talk')}` : '', cnt('voice') ? `🎙 озвучка: ${cnt('voice')}` : '', cnt('broll') ? `🎞 перебивки: ${cnt('broll')}` : ''].filter(Boolean).join(' · ');
  const wishes = p.brief.length ? p.brief.map((t) => `• ${esc(t)}`).join('\n') : `🎨 на выбор ИИ — по вашему паспорту стиля${creativeOn(user) ? ' и с усилением ради удержания' : ''}`;
  const est = estimateCost(user);
  const wait = p.sources.some((s) => needsAnalysis(user, s) && !s.aiError) ? '\n⏳ Ещё разбираю исходники — можно нажать «Смонтировать» сейчас: начну, как только закончу.' : '';
  return `${stageDots(4)}
<b>Этап 4 из 4 · Монтаж</b>

<b>Исходники:</b> ${src || 'нет'}
<b>Пожелания:</b>
${wishes}

💰 <b>Прогноз расхода на ИИ:</b> ≈${fmtUsd(est.low)}–${fmtUsd(est.high)}. ${esc(est.note)}${wait}

Нажмите «▶️ Смонтировать». Готовый ролик придёт сюда, правки пишите обычным сообщением — у каждой правки будет своя цена.`;
}

/** Начать новый ролик: вводная про 4 этапа + первый этап */
async function startWizard(user, chatId, extra = '') {
  const p = user.project || newProject(user);
  p.stage = 'talk';
  await saveUser(user);
  await send(chatId, introText(user, p, extra));
  await send(chatId, stageText(user, p), { reply_markup: stageKb(p) });
}

/** Сменить этап. Уходя с этапа перебивок — запускаем их разбор в фоне. */
async function setStage(user, chatId, stage) {
  const p = user.project || newProject(user);
  if (stage === 'ready' && !p.sources.length && !(pending.get(user.id) || 0)) {
    p.stage = 'talk';
    await saveUser(user);
    return send(chatId, '⚠️ Для монтажа нужен хотя бы один файл. Начнём с этапа 1.\n\n' + stageText(user, p), { reply_markup: stageKb(p) });
  }
  p.stage = stage; // файлы, присланные с этого момента, уже идут в новый этап
  p.summarySig = '';
  if (STAGE_NO[stage] > 2) await kickDeferred(user, chatId);
  if (isBusy(user)) {
    // следующий шаг покажем, только когда всё присланное обработано
    p.nextStage = stage;
    await saveUser(user);
    return send(chatId, `⏳ <b>Подождите, я ещё обрабатываю файлы.</b> Ничего не нажимайте — как только закончу, сам пришлю этап ${STAGE_NO[stage]}: «${STAGE_NAME[stage]}».`);
  }
  delete p.nextStage;
  await saveUser(user);
  await send(chatId, stageText(user, p), { reply_markup: stageKb(p) });
}

/** Перебивки этапа 2 принимаются без ИИ; разбираем их одним заходом, когда этап закончен */
const kicked = new Set();
async function kickDeferred(user, chatId) {
  const p = user.project;
  if (!p) return;
  const key = (s) => `${user.id}:${p.id}:${s.n}`;
  const todo = p.sources.filter((s) => roleOf(s) === 'broll' && needsAnalysis(user, s) && !kicked.has(key(s)));
  if (!todo.length) return;
  todo.forEach((s) => kicked.add(key(s)));
  const st = await progress(user, chatId, `🎞 Разбираю перебивки: ${todo.length}…`);
  background(user, chatId, async () => {
    let fail = 0;
    await Promise.all(
      todo.map((s) =>
        analyzePatiently(user, s, (t) => st.set(t))
          .catch((e) => {
            s.aiError = e.message;
            fail++;
          })
          .finally(() => kicked.delete(key(s)))
      )
    );
    setTimeout(() => afterSources(user, chatId).catch(() => {}), 50);
    await saveUser(user);
    await st.done(fail ? `⚠️ Перебивки: разобрано ${todo.length - fail} из ${todo.length}. Остальные попробую ещё раз при монтаже.` : `✅ Перебивки разобраны: ${todo.length}. ${todo.map((s) => sourceLine(s).replace(/^✅ /, '')).join('; ')}`);
  });
}

/** Переназначить роль уже принятого видео: перебивка ↔ речь */
async function remarkSource(user, chatId, src, role) {
  src.role = role;
  src.ai = src.ai || {};
  if (role === 'broll') {
    src.ai.phrases = [];
    src.ai.language = 'none';
    delete src.aiError;
    await saveUser(user);
    return send(chatId, sourceLine(src));
  }
  delete src.ai.phrases;
  delete src.ai.language;
  await saveUser(user);
  if (!needsAnalysis(user, src)) return send(chatId, sourceLine(src));
  const st = await progress(user, chatId, `⏳ Исходник ${src.n}: расшифровываю речь…`);
  background(user, chatId, async () => {
    try {
      await analyzePatiently(user, src, (t) => st.set(t));
      await st.done(sourceLine(src));
    } catch (e) {
      src.aiError = e.message;
      await st.done(`⚠️ Исходник ${src.n}: разобрать речь не удалось: ${esc(e.message)}. Повторю при монтаже.`);
    }
    await saveUser(user);
  });
}

/** Итог по исходникам — когда всё принято и разобрано */
async function afterSources(user, chatId) {
  if (isBusy(user)) return; // ещё есть файлы в очереди или идёт разбор
  const p = user.project;
  if (!p) return;
  const sig = p.sources.map((s) => s.n).join(',');
  if (p.nextStage) {
    // пользователь уже нажал «Дальше» — вместо сводки сразу следующий этап
    const next = p.nextStage;
    delete p.nextStage;
    p.summarySig = sig;
    return setStage(user, chatId, next);
  }
  if (!p.sources.length) return;
  if (p.summarySig === sig) return; // этот набор уже показан
  p.summarySig = sig;
  const cnt = (r) => p.sources.filter((s) => roleOf(s) === r).length;
  const what = [cnt('talk') ? `с речью: ${cnt('talk')}` : '', cnt('broll') ? `перебивки: ${cnt('broll')}` : '', cnt('voice') ? `озвучка: ${cnt('voice')}` : ''].filter(Boolean).join(', ');
  await send(
    chatId,
    `Исходников: <b>${p.sources.length}</b> (${what}).\n${stageLine(p)}\n${{ talk: 'Можно прислать ещё видео с речью или голосовое. Всё — жмите «Дальше».', broll: 'Можно прислать ещё перебивки. Всё — жмите «Дальше».', brief: 'Напишите пожелания или жмите кнопку ниже.', ready: 'Файл добавлен. Можно монтировать.' }[stageOf(p)]}`,
    { reply_markup: montageKb(p) }
  );
}

// ───────────────────────────── План монтажа ─────────────────────────────

/** Что есть в проекте: фразы речи (основа ролика) и планы для перебивок */
function projectContext(user) {
  const p = user.project;
  const has = (s) => s.ai && s.ai.phrases && s.ai.phrases.length;
  const audio = p.sources.filter((s) => s.kind === 'audio' && has(s));
  const talkSrc = p.sources.filter((s) => s.kind === 'video' && roleOf(s) === 'talk' && has(s));
  const voiceover = audio.length > 0; // есть закадровый голос
  const talk = talkSrc.length > 0; // есть речь в кадре
  const hybrid = voiceover && talk;
  // Фразы в порядке исходников: сначала речь в кадре, затем озвучка; у каждой — откуда она
  const phrases = [...talkSrc, ...audio].flatMap((s) => s.ai.phrases.map((ph) => ({ ...ph, src: s.n, voice: s.kind === 'audio' })));
  // Частота итогового ролика — по исходникам: 25 fps в 30 не превратить без дёрганья (каждый пятый кадр — дубль)
  const fps = projectFps(p.sources);
  const slowMaxOf = (s) => clamp(Math.floor((s.fps || 0) / fps + 0.01), 1, 4);
  const allShots = p.sources.filter((s) => s.kind === 'video' && s.ai && s.ai.shots).flatMap((s) => s.ai.shots.map((x) => ({ ...x, src: s.n, slowMax: slowMaxOf(s) })));
  let shots = allShots.filter((s) => s.kind === 'broll' && s.quality !== 'bad');
  if (!shots.length) shots = allShots.filter((s) => s.kind === 'broll');
  // Без речи вообще — ролик собирается только из картинки
  const visual = !phrases.length;
  if ((voiceover || visual) && !shots.length) shots = allShots.filter((s) => s.kind !== 'junk');
  if ((voiceover || visual) && !shots.length) shots = allShots;
  return {
    voiceover,
    talk,
    hybrid,
    visual,
    phrases,
    shots,
    fps,
    bySrc: new Map(p.sources.map((s) => [s.n, s])),
    slowable: shots.some((x) => x.slowMax > 1),
    phraseById: new Map(phrases.map((x) => [x.id, x])),
    shotById: new Map(shots.map((x) => [x.id, x])),
  };
}

/**
 * Базовая частота кадров ролика: 24, 25 или 30 — та, что у большей части видео по длительности
 * (60 → 30, 50 → 25). Если исходники разные, побеждает самая «тяжёлая» по секундам.
 */
function projectFps(sources) {
  const weight = new Map();
  for (const s of sources) {
    if (s.kind !== 'video' || !s.fps) continue;
    let f = s.fps;
    while (f > 31) f /= 2; // 60 → 30, 50 → 25, 120 → 30
    const base = [24, 25, 30].reduce((b, c) => (Math.abs(c - f) < Math.abs(b - f) ? c : b), 30);
    weight.set(base, (weight.get(base) || 0) + s.duration);
  }
  let best = CFG.fps;
  let w = -1;
  for (const [f, d] of weight) if (d > w) [best, w] = [f, d];
  return best;
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
  const tag = (x) => (ctx.hybrid ? ` | ${x.voice ? 'озвучка' : 'в кадре'}` : '');
  const ph = ctx.phrases.map((x) => `${x.id}${tag(x)} | ${r2(x.start)}–${r2(x.end)} | ${num(x.end - x.start)} с | ${x.text}`).join('\n');
  const sh = ctx.shots.map((x) => `${x.id} | ${r2(x.start)}–${r2(x.end)} (${num(x.end - x.start)} с) | ${x.kind}, ${x.quality}${x.slowMax > 1 ? `, можно замедлить ×${x.slowMax}` : ''} | ${x.what}`).join('\n');
  return `Фразы речи (id${ctx.hybrid ? ' | откуда: в кадре — автор говорит на видео, озвучка — закадровый голос' : ''} | секунды в исходнике | длительность | текст):\n${ph}\n\nПланы видео для перебивок (id | секунды | вид, качество | что в кадре):\n${sh || 'нет'}`;
}

const PLAN_SCHEMA = `{"idea": "о чём ролик, одна фраза", "keep": ["1.3", "1.5"], "broll": [{"phrase": "1.5", "shot": "2#3", "offset": 0.5, "dur": 2}], "cover": [{"phrase": "3.1", "shots": ["1#2", "2#5"]}], "zoom": ["1.3"], "jumpcut_zoom": false, "cut_pauses": true, "slow": ["2#3"], "subtitles": {"on": true, "position": "bottom", "size": "medium", "color": "#FFFFFF", "highlight": "#FFD400", "uppercase": false, "words": 3, "style": "outline"}, "notes": ["..."]}`;

const VISUAL_SCHEMA = `{"idea": "о чём ролик, одна фраза", "sequence": [{"shot": "1#2", "dur": 1.5}, {"shot": "3#1", "dur": 2}], "slow": ["3#1"], "keep_sound": true, "notes": ["..."]}`;

function promptVisual(user, ctx, wishes) {
  return `Ты — монтажёр автора. Собери ролик только из видеоряда (речи нет) так, как его смонтировал бы сам автор, по его «паспорту стиля».

Паспорт стиля (JSON):
${JSON.stringify(passportBrief(user))}
${measuredLine(user)}

${creativeBlock(user, ctx)}
${wishes ? `\nПожелания автора к этому ролику (они важнее паспорта):\n${wishes}\n` : ''}
Планы видео (id | секунды | вид, качество | что в кадре):
${ctx.shots.map((x) => `${x.id} | ${r2(x.start)}–${r2(x.end)} (${num(x.end - x.start)} с) | ${x.kind}, ${x.quality}${x.slowMax > 1 ? `, можно замедлить ×${x.slowMax}` : ''} | ${x.what}`).join('\n')}

Как собирать:
1. "sequence" — планы в порядке показа и длительность каждого в секундах (dur не больше длины плана). Начни с самого цепляющего кадра. Темп и длина ролика — как у автора, если в пожеланиях не сказано иначе. Брак и слабые планы не бери. Один план — один раз.
2. "keep_sound" — true, если живой звук планов стоит оставить (шипение, нарезка); false — если там шум и лучше тишина под будущую музыку.
3. "slow" — ${ctx.slowable ? 'Планы с пометкой «можно замедлить» сняты на 60 кадров и больше: их можно показать плавно замедленными, перечислив id в "slow". Замедление — инструмент: продлить удачный кадр, закрыть нехватку видео, подчеркнуть деталь, если это в духе автора. Замедленный план занимает в ролике во столько же раз больше времени (dur считай по ролику, не по исходнику). Остальным оставь пустой список.' : 'оставь пустым: исходники сняты на 30 кадров, плавно замедлить их нельзя.'}
4. "notes" — 2–4 коротких пункта для автора: что сделано.

Используй только id из списка. Ответь строго одним JSON-объектом без пояснений, тексты на русском:
${VISUAL_SCHEMA}`;
}

const creativeOn = (user) => user.creative !== false;

/** Блок про удержание: ИИ не только копирует стиль, но и усиливает ролик */
function creativeBlock(user, ctx) {
  if (!creativeOn(user)) return 'Творческая свобода выключена: строго следуй паспорту и пожеланиям, ничего не добавляй от себя.';
  const tools = ctx.visual
    ? 'порядок и длительность планов, замедление'
    : `порядок фраз, отбор фраз, перебивки${ctx.voiceover ? ' и планы под озвучку' : ''}, наезды, замедление, субтитры`;
  return `Творческая свобода (автор разрешил): ты не только повторяешь стиль автора, но и усиливаешь ролик ради удержания и вовлечённости — как опытный монтажёр коротких видео. Инструменты: ${tools}.
- Первые 1–2 секунды — крючок: самая интригующая фраза, цифра, вопрос или самый сильный кадр. Приветствия и разгон («всем привет, сегодня расскажу…») убирай или переноси в конец.
- Каждые 2–4 секунды в кадре что-то меняется: перебивка, наезд, смена плана, замедление. Без мельтешения и в духе автора.
- Вырезай всё, что не двигает историю: повторы, «ну», «вот», «короче», затянутые концовки.
- Финал — на сильной мысли, выводе или призыве, а не на «ну вот как-то так».
- Паспорт — основа. Ради удержания можно отойти от него в деталях, но стиль автора должен остаться узнаваемым.
В "notes" отдельным пунктом скажи, что сделано ради удержания.`;
}

function variantNote(p) {
  const prev = ensureHistory(p).slice(-3).map((h) => JSON.stringify(planForAi(h.plan)));
  return `Автор просит ДРУГОЙ вариант этого ролика. Сделай заметно иначе, чем прошлые варианты: другой крючок в начале, другой порядок или подбор фраз, другие перебивки и планы, другой темп. Пожелания автора выше сохрани.\nПрошлые варианты (не повторяй их):\n${prev.join('\n')}`;
}

function promptPlan(user, ctx, opts = {}) {
  const p = user.project;
  let wishes = [...p.brief, ...p.fixes].map((t, i) => `${i + 1}. ${t}`).join('\n');
  if (opts.variant && ensureHistory(p).length) wishes += (wishes ? '\n' : '') + variantNote(p);
  if (ctx.visual) return promptVisual(user, ctx, wishes);
  return `Ты — монтажёр автора. Собери из исходников новый ролик так, как его смонтировал бы сам автор, строго по его «паспорту стиля».

Паспорт стиля (JSON):
${JSON.stringify(passportBrief(user))}
${measuredLine(user)}

Режим: ${modeLine(ctx)}

${creativeBlock(user, ctx)}
${wishes ? `\nПожелания автора к этому ролику (они важнее паспорта):\n${wishes}\n` : ''}
${catalogText(ctx)}

Как собирать:
1. "keep" — id фраз в том порядке, в котором они пойдут в ролике. Это сценарий ролика.
   - Из дублей одной мысли оставь одну, лучшую — обычно последнюю целую. Убери оговорки, оборванные фразы, «так, ещё раз», лишние повторы и фразы не по теме.
   - Длина ролика — как обычно у автора, если в пожеланиях не сказано иначе. Сумма длительностей выбранных фраз ≈ длина ролика.
   - Порядок исходный. Можно вынести в начало одну сильную фразу, если по паспорту ролик начинается с крючка.
2. ${ctx.hybrid ? '"cover" — для КАЖДОЙ фразы озвучки из keep 1–3 плана, которые показывают то, о чём в ней говорится (число планов — по темпу автора: длительность фразы / средняя длина плана). "broll" — перебивки поверх фраз в кадре там, где сказанное видно в каком-то плане: offset — секунды от начала фразы, dur — длина перебивки по темпу автора, не длиннее плана. Один и тот же план без нужды не повторяй.' : ctx.voiceover ? '"cover" — для КАЖДОЙ фразы из keep 1–3 плана, которые показывают то, о чём говорится в этой фразе. Число планов на фразу — по темпу автора: длительность фразы / средняя длина плана. Без нужды планы не повторяй. "broll" оставь пустым.' : '"broll" — перебивки поверх речи там, где фраза говорит о том, что видно в каком-то плане. offset — секунды от начала фразы, dur — длина перебивки по темпу автора. Перебивка не длиннее самого плана. Сколько перебивок и как часто — как у автора в паспорте; если перебивок у автора нет и в пожеланиях их не просят — оставь пустой список. "cover" оставь пустым.'}
3. "zoom" — id фраз, где сделать приближение на говорящего, если автор так делает. Иначе пустой список.
4. "jumpcut_zoom" — true, если автор прячет склейки внутри речи сменой крупности.
5. "cut_pauses" — true, если автор вырезает паузы в речи.
5a. "slow" — ${ctx.slowable ? 'Планы с пометкой «можно замедлить» сняты на 60 кадров и больше: их можно показать плавно замедленными, перечислив id в "slow". Замедление — инструмент: продлить удачный кадр, закрыть нехватку видео, подчеркнуть деталь, если это в духе автора. Замедленный план занимает в ролике во столько же раз больше времени (dur считай по ролику, не по исходнику). Речь в кадре не замедляется — только перебивки и планы из "cover".' : 'оставь пустым: исходники сняты на 30 кадров, плавно замедлить их нельзя.'}
6. "subtitles" — субтитры по паспорту: on (есть ли вообще), position (bottom | middle | top), size (small | medium | large), color (#RRGGBB), highlight (#RRGGBB — цвет выделенного слова, или "" если автор не выделяет), uppercase (true/false), words (сколько слов на экране за раз, 1–6), style (outline — обводка | box — плашка | shadow — тень).
7. "notes" — 2–5 коротких пунктов для автора: что сделано и почему.

Используй только id из списков выше. Ответь строго одним JSON-объектом без пояснений, тексты на русском:
${PLAN_SCHEMA}`;
}

function modeLine(ctx) {
  if (ctx.hybrid) return 'ГИБРИД — есть и речь автора в кадре, и отдельная закадровая запись. Сценарий ("keep") собирается из фраз обоих видов в любом порядке: фраза в кадре идёт со своей картинкой (перебивки поверх — поле "broll"), фраза озвучки закрывается планами исходников (поле "cover"). Не дублируй одну мысль из двух источников.';
  if (ctx.voiceover) return 'ОЗВУЧКА — основа ролика отдельная запись голоса. Видеоряд целиком собирается из планов исходников (поле "cover"); звук видео не используется.';
  return 'РЕЧЬ В КАДРЕ — основа ролика видео, где автор говорит. Под его речь идёт его же картинка, перебивки ставятся поверх (поле "broll").';
}

/** План в том виде, в котором его видит ИИ */
function planForAi(plan) {
  if (plan.sequence && plan.sequence.length) return { idea: plan.idea, sequence: plan.sequence, slow: plan.slow, keep_sound: plan.keepSound };
  return { idea: plan.idea, keep: plan.keep, broll: plan.broll, cover: plan.cover, zoom: plan.zoom, jumpcut_zoom: plan.jumpcutZoom, cut_pauses: plan.cutPauses, slow: plan.slow, subtitles: plan.subtitles };
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

Режим: ${ctx.visual ? 'БЕЗ РЕЧИ (видеоряд — поле "sequence")' : ctx.hybrid ? 'ГИБРИД (фразы в кадре — своя картинка и перебивки "broll"; фразы озвучки — планы в "cover")' : ctx.voiceover ? 'ОЗВУЧКА (видеоряд — поле "cover")' : 'РЕЧЬ В КАДРЕ (перебивки — поле "broll")'}

${catalogText(ctx)}

Текущий план (длительность ролика сейчас: ${dur}):
${JSON.stringify(planForAi(p.plan))}
${earlier ? `\nПрежние правки автора (уже учтены, не отменяй их):\n${earlier}\n` : ''}
Правка автора:
«${text}»

Ответь строго одним JSON-объектом без пояснений, по образцу:
${ctx.visual ? VISUAL_SCHEMA : PLAN_SCHEMA}`;
}

function hexColor(v, fallback) {
  const m = String(v || '').trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

/** Проверка ответа ИИ: только существующие куски, разумные числа */
function normalizePlan(raw, ctx) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const shotId = (x) => String(x && typeof x === 'object' ? x.shot || x.id : x);
  const notesOf = () => (Array.isArray(r.notes) ? r.notes : []).map(txt).filter(Boolean).slice(0, 6);
  // замедлить можно только планы с запасом кадров (60 fps и выше)
  const slow = [...new Set((Array.isArray(r.slow) ? r.slow : []).map(shotId))].filter((id) => ctx.shotById.has(id) && ctx.shotById.get(id).slowMax > 1);
  if (ctx.visual) {
    let sequence = (Array.isArray(r.sequence) ? r.sequence : [])
      .map((x) => ({ shot: shotId(x), dur: Number(x && x.dur) || 0 }))
      .filter((x) => ctx.shotById.has(x.shot) && x.dur >= 0.4);
    if (!sequence.length) sequence = ctx.shots.map((s) => ({ shot: s.id, dur: Math.min(2.5, s.end - s.start) })).filter((x) => x.dur >= 0.4);
    if (!sequence.length) throw new Error('нет подходящих планов для ролика');
    const off = { on: false, position: 'bottom', size: 'medium', color: '#FFFFFF', highlight: '', uppercase: false, words: 3, style: 'outline' };
    return { idea: txt(r.idea).slice(0, 300), keep: [], broll: [], cover: [], zoom: [], jumpcutZoom: false, cutPauses: false, slow, subtitles: off, notes: notesOf(), sequence, keepSound: r.keep_sound !== false };
  }
  const seen = new Set();
  const keep = (Array.isArray(r.keep) ? r.keep : []).map(String).filter((id) => ctx.phraseById.has(id) && !seen.has(id) && seen.add(id));
  if (!keep.length) throw new Error('ИИ не выбрал ни одного куска речи');
  const kept = new Set(keep);
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
  return { idea: txt(r.idea).slice(0, 300), keep, broll, cover, zoom, jumpcutZoom: r.jumpcut_zoom === true, cutPauses: r.cut_pauses !== false, slow, subtitles, notes };
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
    if (p.f1 > o.f1) out.push({ ...p, f0: o.f1, from: p.from + (o.f1 - p.f0) / fps / (p.slow || 1) });
  }
  out.push(o);
  return out.sort((a, b) => a.f0 - b.f0);
}

/** Дыры в картинке закрываем продолжением соседнего плана */
function fillGaps(pieces, total, fps) {
  const ps = pieces.filter((p) => p.f1 > p.f0).sort((a, b) => a.f0 - b.f0);
  if (!ps.length) return ps;
  if (ps[0].f0 > 0) {
    ps[0].from = Math.max(0, ps[0].from - ps[0].f0 / fps / (ps[0].slow || 1));
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
    if (q && q.src === p.src && q.zoom === p.zoom && (q.slow || 1) === (p.slow || 1) && q.f1 === p.f0 && Math.abs(q.from + (q.f1 - q.f0) / fps / (p.slow || 1) - p.from) < 0.02) q.f1 = p.f1;
    else out.push({ ...p });
  }
  return out;
}

/**
 * Монтажный лист: звук — куски фраз подряд, картинка — список планов.
 * Время считается в кадрах, чтобы звук и картинка не разъезжались.
 */
function buildTimeline(plan, ctx, fps = ctx.fps || CFG.fps) {
  const chunks = [];
  const span = new Map();
  let f = 0;
  const slowSet = new Set(plan.slow || []);
  const slowOf = (shot) => (slowSet.has(shot.id) ? shot.slowMax || 1 : 1);
  if (ctx.visual) {
    // Без речи: планы подряд, звук — живой звук этих же планов или тишина
    const pieces = [];
    for (const it of plan.sequence) {
      const shot = ctx.shotById.get(it.shot);
      const slow = slowOf(shot);
      const avail = (shot.end - shot.start) * slow; // сколько секунд ролика даёт план
      const dur = Math.min(it.dur, avail);
      const n = Math.round(dur * fps);
      if (n < 3) continue;
      const from = shot.start + Math.max(0, (avail - dur) / 2 / slow);
      const src = ctx.bySrc.get(shot.src);
      pieces.push({ f0: f, f1: f + n, src: shot.src, from, zoom: 1, broll: true, slow });
      chunks.push({ phrase: null, src: shot.src, a: from, f0: f, f1: f + n, mute: slow > 1 || !plan.keepSound || !src.hasAudio });
      f += n;
    }
    if (!f) throw new Error('планы получились слишком короткими');
    return { chunks, pieces, total: f, span, fps };
  }
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
  // need — секунды ролика; в исходнике при замедлении нужно меньше
  const centered = (shot, need, from) => {
    const srcNeed = need / slowOf(shot);
    if (from != null && from >= shot.start && from < shot.end - 0.3) return from;
    const avail = shot.end - shot.start;
    return avail > srcNeed ? shot.start + (avail - srcNeed) / 2 : shot.start;
  };
  // Фразы в кадре: картинка — то же видео, что и звук (с наездами, если нужно)
  const zoomSet = new Set(plan.zoom);
  let alt = false;
  let prev = null;
  for (const c of chunks) {
    const ph = ctx.phraseById.get(c.phrase);
    if (ph.voice) {
      prev = null;
      continue; // озвучка: картинку даст cover
    }
    const jump = prev && prev.src === c.src && Math.abs(prev.a + (prev.f1 - prev.f0) / fps - c.a) > 0.05;
    alt = jump ? !alt : false;
    const zoom = zoomSet.has(c.phrase) ? 1.15 : plan.jumpcutZoom && alt ? 1.12 : 1;
    pieces.push({ f0: c.f0, f1: c.f1, src: c.src, from: c.a, zoom });
    prev = c;
  }
  // Перебивки поверх речи в кадре
  for (const b of plan.broll) {
    const sp = span.get(b.phrase);
    const shot = ctx.shotById.get(b.shot);
    if (!sp || !shot) continue;
    const g0 = sp[0] + Math.round(b.offset * fps);
    const slow = slowOf(shot);
    const from = centered(shot, b.dur, b.from);
    const len = Math.min(Math.round(b.dur * fps), Math.round((shot.end - from) * slow * fps), total - g0);
    if (g0 >= total || len < Math.round(0.4 * fps)) continue;
    pieces = overlayPiece(pieces, { f0: g0, f1: g0 + len, src: shot.src, from, zoom: 1, broll: true, slow }, fps);
  }
  // Озвучка: планы, подобранные ИИ, делят фразу поровну
  for (const c of plan.cover) {
    const sp = span.get(c.phrase);
    if (!sp) continue;
    const k = c.shots.length;
    const L = sp[1] - sp[0];
    for (let i = 0; i < k; i++) {
      const g0 = sp[0] + Math.round((L * i) / k);
      const g1 = sp[0] + Math.round((L * (i + 1)) / k);
      const shot = ctx.shotById.get(c.shots[i]);
      if (g1 > g0) pieces = overlayPiece(pieces, { f0: g0, f1: g1, src: shot.src, from: centered(shot, (g1 - g0) / fps), zoom: 1, broll: true, slow: slowOf(shot) }, fps);
    }
  }
  // Куски озвучки, которые ИИ не закрыл картинкой, — планы по очереди
  const voiceSpans = plan.keep.filter((id) => ctx.phraseById.get(id).voice && span.has(id)).map((id) => span.get(id));
  if (voiceSpans.length) {
    const slot = Math.round(3 * fps);
    let i = 0;
    for (const [s0, s1] of voiceSpans) {
      let g = s0;
      while (g < s1) {
        const covered = pieces.find((pc) => pc.f0 <= g && pc.f1 > g);
        if (covered) {
          g = covered.f1;
          continue;
        }
        const next = pieces.filter((pc) => pc.f0 > g).reduce((m, pc) => Math.min(m, pc.f0), s1);
        const g1 = Math.min(next, g + slot, s1);
        if (g1 - g >= 3) {
          if (!ctx.shots.length) throw new Error('нет видео, чтобы закрыть озвучку картинкой');
          const shot = ctx.shots[i++ % ctx.shots.length];
          pieces = overlayPiece(pieces, { f0: g, f1: g1, src: shot.src, from: centered(shot, (g1 - g) / fps), zoom: 1, broll: true }, fps);
        }
        g = g1;
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
  const fps = ctx.fps || CFG.fps;
  const [W, H] = outputSize(user, ctx);
  const tl = buildTimeline(plan, ctx, fps);
  if (process.env.DEBUG_TL) log('timeline:', JSON.stringify(tl.pieces.map((x) => ({ f0: x.f0, f1: x.f1, src: x.src, from: r2(x.from), slow: x.slow || 1, z: x.zoom }))));
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
      if (c.mute) {
        await ff(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', len.toFixed(4), '-c:a', 'pcm_s16le', out], 'подготовить тишину');
      } else {
        const fade = ctx.visual ? 0.15 : 0.01; // между планами без речи звук мягко перетекает
        await ff(['-y', '-ss', c.a.toFixed(3), '-i', srcFile(c.src), '-vn', '-ac', '2', '-ar', '48000', '-af', `apad,atrim=0:${len.toFixed(4)},afade=t=in:d=${fade * 0.8},afade=t=out:st=${Math.max(0, len - fade).toFixed(4)}:d=${fade}`, '-c:a', 'pcm_s16le', out], 'вырезать звук');
      }
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
      const z = pc.zoom || 1;
      const slow = pc.slow || 1;
      // если куску не хватает исходника до конца файла — сдвигаем начало назад, иначе картинка замрёт
      const need = dur / slow + 0.1;
      const from = clamp(pc.from, 0, Math.max(0, src.duration - need));
      const vf = [
        'setpts=PTS-STARTPTS', // первый кадр ровно в нуле: без лишнего дубля на стыке
        slow > 1 ? `setpts=${slow}*PTS` : '', // 60 fps → плавное замедление: кадры не дублируются, а растягиваются по времени
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        z > 1 ? `scale=trunc(iw*${z}/2)*2:trunc(ih*${z}/2)*2` : '',
        `crop=${W}:${H}:(iw-${W})/2:(ih-${H})*${z > 1 ? 0.4 : 0.5}`,
        'setsar=1',
        `fps=${fps}`,
        `tpad=stop_mode=clone:stop_duration=${(dur + 1).toFixed(3)}`,
        'format=yuv420p',
      ].filter(Boolean).join(',');
      const out = path.join(work, `v${i}.mp4`);
      await ff(['-y', '-ss', from.toFixed(3), '-i', srcFile(pc.src), '-an', '-sn', '-dn', '-vf', vf, '-frames:v', String(frames), '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '0', '-g', String(fps * 2), '-r', String(fps), '-video_track_timescale', '15360', out], 'вырезать кусок видео');
      vFiles.push(out);
    }
    await fsp.writeFile(path.join(work, 'v.txt'), list(vFiles));
    const video = path.join(work, 'video.mp4');
    await ff(['-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'v.txt'), '-c', 'copy', '-avoid_negative_ts', 'make_zero', video], 'склеить видео');

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
      ['-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', ...(vf ? ['-vf', vf] : []), '-fps_mode', 'cfr', '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-video_track_timescale', '15360', '-af', ctx.visual ? 'volume=0.7' : 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out],
      'собрать итоговый ролик'
    );
    await checkSmooth(out, tl.total, fps);
    return { v: p.version, visual: !!ctx.visual, file: path.basename(out), duration: tl.total / fps, width: W, height: H, fps, chunks: tl.chunks.length, broll: tl.pieces.filter((x) => x.broll).length, slow: tl.pieces.filter((x) => (x.slow || 1) > 1).length, subsNote, at: new Date().toISOString() };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** После сборки: кадров столько, сколько в монтажном листе, и метки идут ровно — иначе в лог */
async function checkSmooth(file, frames, fps) {
  const r = await run(CFG.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], 120000).catch(() => null);
  if (!r || r.code !== 0) return;
  const pts = r.out.split('\n').map(parseFloat).filter((x) => isFinite(x));
  let bad = 0;
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i] - pts[i - 1] - 1 / fps) > 0.004) bad++;
  if (bad || Math.abs(pts.length - frames) > 2) log(`render check: кадров ${pts.length} (ожидалось ${frames}), неровных стыков ${bad}`);
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
  const L = [`🎬 <b>Ролик №${p.id} · вариант ${r.v || p.version}</b> · ${fmtDur(r.duration)}${p.final === r.v ? ' · ✅ финальный' : ''}`];
  if (r.kind === 'fix' && r.fixText) L.push(`✏️ Правка к варианту ${r.from}: «${esc(r.fixText.slice(0, 120))}»`);
  else if (r.kind === 'variant') L.push(`🔄 Другая версия (на основе варианта ${r.from})`);
  if (plan.idea) L.push(esc(plan.idea));
  const facts = (r.visual ? [`планов: ${r.chunks}`, 'без речи', plan.keepSound ? 'живой звук' : 'без звука — под музыку'] : [`кусков речи: ${r.chunks}`, r.broll ? `перебивок: ${r.broll}` : '', plan.subtitles.on ? 'субтитры: да' : 'без субтитров']).concat(r.slow ? [`замедлений: ${r.slow}`] : []).filter(Boolean);
  L.push(facts.join(' · '));
  if (r.cost) L.push(`💰 Этот вариант: ≈${fmtUsd(r.cost.usd)} (запросов ИИ: ${r.cost.calls}) · всего по ролику: ≈${fmtUsd(usdOf(spendOf(p)))}`);
  for (const n of plan.notes.slice(0, 4)) L.push(`• ${esc(n)}`);
  if (extraNote) L.push(`⚠️ ${esc(extraNote)}`);
  L.push('\nПравку можно написать сразу сообщением: «убери вторую фразу», «субтитры крупнее».');
  let c = L.join('\n');
  if (c.length > 1000) c = c.slice(0, 990) + '…';
  return c;
}

/** Кнопки под готовым роликом. В кнопках номер варианта — они работают и под старыми сообщениями. */
const resultKb = (p) => {
  const v = p.result ? p.result.v : 0;
  return kb([
    [['✏️ Правка', `r_fix:${v}`], ['🔄 Другой вариант', `r_alt:${v}`]],
    [['✅ Всё подходит', `r_ok:${v}`], ['🧬 Уникализировать', `r_uniq:${v}`]],
    [['🔁 Заменить исходник', 'r_swap'], ...(prevVariant(p) ? [['↩️ Прошлый вариант', 'm_undo']] : [])],
    [['🗂 История', 'r_hist'], ['🆕 Новый ролик', 'm_new']],
  ]);
};

/** Монтаж с нуля (fixText пустой) или правка уже готового ролика */
async function makeMontage(user, chatId, fixText, opts = {}) {
  const p = user.project;
  if (!user.passport) return void (await send(chatId, 'Сначала научите меня своему стилю: /learn'));
  if (!p || !p.sources.length) return void (await send(chatId, 'Пришлите исходники ролика: видео, перебивки, озвучку.'));
  if (fixText && !p.plan) fixText = '';
  const spent0 = snapSpend(p);
  const st = await progress(user, chatId, fixText ? '✏️ Вношу правку…' : opts.variant ? '🔄 Делаю другой вариант…' : '🎬 Начинаю монтаж…');
  const say = (t) => st.set(t);
  try {
    const bg = [...(bgJobs.get(user.id) || [])];
    if (bg.length) {
      await say(`⏳ Дожидаюсь разбора исходников (осталось: ${bg.length})…`);
      await Promise.all(bg);
    }
    const todo = p.sources.filter((x) => needsAnalysis(user, x));
    await Promise.all(
      todo.map(async (s) => {
        await say(`🎬 Разбираю исходники: ${todo.length}…`);
        try {
          await analyzePatiently(user, s, say);
        } catch (e) {
          s.aiError = e.message;
          if (e.quota) throw e;
        }
      })
    );
    const ctx = projectContext(user);
    if (!ctx.phrases.length && !ctx.shots.length) {
      const err = p.sources.find((s) => s.aiError);
      throw new Error(err ? `не удалось разобрать исходники: ${err.aiError}` : 'в исходниках нечего монтировать');
    }
    await say(fixText ? '✏️ Меняю план монтажа…' : ctx.visual ? '🧠 Подбираю планы и темп…' : '🧠 Выбираю лучшие дубли и подбираю перебивки…');
    const planSnap = snapSpend(p);
    const raw = await geminiJson(user, [{ text: fixText ? promptFix(user, ctx, fixText) : promptPlan(user, ctx, opts) }], { long: true, onWait: (t) => say(`🧠 ${t}…`) });
    const pt = spendDelta(planSnap, spendOf(p));
    p.lastPlanTok = { in: pt.in, out: pt.out }; // запомним для прогноза следующего монтажа
    const plan = normalizePlan(raw, ctx);
    const res = await renderMontage(user, ctx, plan, say);
    const runSpend = spendDelta(spent0, spendOf(p));
    res.cost = { in: runSpend.in, out: runSpend.out, calls: runSpend.calls, usd: usdOf(runSpend) };
    // каждый вариант остаётся в истории ролика
    ensureHistory(p);
    if (fixText) p.fixes.push(fixText);
    res.fixes = [...p.fixes];
    res.plan = plan;
    res.kind = fixText ? 'fix' : opts.variant ? 'variant' : 'new';
    res.from = p.result ? p.result.v : null;
    if (fixText) res.fixText = fixText;
    p.history.push(res);
    p.result = res;
    p.plan = plan;
    p.open = false;
    p.stage = 'ready';
    await saveUser(user);
    await say('📤 Отправляю ролик…');
    await sendVideoFile(chatId, path.join(projDir(user), res.file), { caption: resultCaption(p, res.subsNote), width: res.width, height: res.height, duration: Math.round(res.duration), reply_markup: resultKb(p) });
    await st.done(null);
  } catch (e) {
    const lost = spendDelta(spent0, spendOf(p));
    const spentNote = lost.calls ? ` Уже потрачено на ИИ: ≈${fmtUsd(usdOf(lost))}.` : '';
    await st.done(`⚠️ ${fixText ? 'Правку внести' : 'Смонтировать'} не получилось: ${esc(e.message)}.${spentNote}`, fixText ? {} : { reply_markup: kb([[['🔁 Попробовать ещё раз', 'm_go']]]) });
    log('montage:', e.stack || e.message);
  }
}

/** Вариант, из которого сделан текущий (для «↩️ Прошлый вариант») */
function prevVariant(p) {
  const h = ensureHistory(p);
  if (!p.result) return null;
  return h.find((x) => x.v === p.result.from) || h[h.findIndex((x) => x.v === p.result.v) - 1] || null;
}

/** Сделать вариант текущим (правки пойдут от него) */
function useVariant(user, v) {
  const p = user.project;
  const it = p && ensureHistory(p).find((x) => x.v === Number(v));
  if (!it) return null;
  if (!p.result || p.result.v !== it.v) {
    p.result = it;
    p.plan = it.plan;
    p.fixes = [...(it.fixes || [])];
  }
  return it;
}

async function showVariant(user, chatId, it, note = '') {
  const p = user.project;
  const file = path.join(projDir(user), it.file);
  if (!fs.existsSync(file)) return send(chatId, `Файл варианта ${it.v} не сохранился. Можно сделать новый: «🔄 Другой вариант».`);
  return sendVideoFile(chatId, file, { caption: resultCaption(p, note), width: it.width, height: it.height, duration: Math.round(it.duration), reply_markup: resultKb(p) });
}

async function undoMontage(user, chatId) {
  const p = user.project;
  const prev = p && prevVariant(p);
  if (!prev) return void (await send(chatId, 'Прошлого варианта нет.'));
  useVariant(user, prev.v);
  await saveUser(user);
  await showVariant(user, chatId, prev);
}

// ───────────────────────────── Тексты ─────────────────────────────

const HELLO = `Привет! Я Магическая кастрюля — монтажёр, который учится вашему стилю.

<b>Учёба</b> (/learn)
1. Пришлите 5–15 своих готовых роликов — тех, что уже опубликованы.
2. Я разберу их и покажу «паспорт стиля» — как я понял вашу манеру.
3. Подтвердите паспорт или поправьте его сообщением: «субтитры у меня всегда жёлтые».

<b>Монтаж</b> (/edit или /new) — 4 этапа, на каждом подскажу, что делать:
1. Речь: видео, где вы говорите, и/или голосовое с закадровым текстом.
2. Перебивки: видео для картинки — продукт, процесс, место.
3. Пожелания к ролику — или «на выбор ИИ».
4. Монтаж: покажу цену, смонтирую, правки — сообщением.

Команды: /status — что загружено, /style — паспорт, /new — новый ролик, /history — готовые ролики, /reset — удалить всё.`;



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

const usdOf = (t) => (t.in * CFG.priceIn + t.out * CFG.priceOut) / 1e6;
const fmtUsd = (x) => (x < 0.01 ? `$${num(x, 3)}` : `$${num(x, 2)}`);
const spendOf = (p) => (p && p.spend) || { in: 0, out: 0, calls: 0 };
const snapSpend = (p) => ({ ...spendOf(p) });
const spendDelta = (a, b) => ({ in: b.in - a.in, out: b.out - a.out, calls: b.calls - a.calls });

/**
 * Прогноз перед монтажом: разбор ещё не разобранных исходников (по длине видео)
 * плюс сам запрос монтажа. Для монтажа берём фактический расход прошлого запроса, если он был.
 */
function estimateCost(user) {
  const p = user.project;
  const todo = (p ? p.sources : []).filter((s) => needsAnalysis(user, s));
  const secs = todo.reduce((a, s) => a + (s.duration || 0), 0);
  const analysis = { in: Math.round(secs * CFG.tokPerSec) + todo.length * 2000, out: todo.length * 1200 };
  const plan = (p && p.lastPlanTok) || { in: 15000, out: 2000 };
  const usd = usdOf({ in: analysis.in + plan.in, out: analysis.out + plan.out });
  const note = todo.length
    ? `Разбор ${todo.length} ${plural(todo.length, 'исходник', 'исходника', 'исходников')} и монтаж.`
    : 'Исходники уже разобраны — считаю только монтаж.';
  return { usd, low: usd * 0.6, high: usd * 1.6, note };
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
    L.push('Убрать исходник: /del 2. Переназначить: /broll 2 (перебивка) или /talk 2 (речь)');
    L.push(stageLine(p));
  }
  if (p && p.brief.length) L.push(`\n<b>Пожелания:</b>\n${p.brief.map((t) => `• ${esc(t)}`).join('\n')}`);
  if (p && p.result) L.push(`\n<b>Готово:</b> вариант ${p.result.v || p.version}, ${fmtDur(p.result.duration)}; правок: ${p.fixes.length}`);
  L.push('');
  L.push(user.passport ? `<b>Паспорт стиля:</b> версия ${user.passport.version}${user.passport.confirmed ? '' : ' (ещё не подтверждён)'}` : '<b>Паспорт стиля:</b> ещё не собран — /learn');
  L.push(creativeOn(user) ? '<b>Творческая свобода ИИ:</b> включена (/creative — выключить)' : '<b>Творческая свобода ИИ:</b> выключена (/creative — включить)');
  if (p && p.spend && p.spend.calls) L.push(`<b>Ролик №${p.id}, потрачено на ИИ:</b> ≈${fmtUsd(usdOf(p.spend))} (запросов: ${p.spend.calls})`);
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
    addInbox(user, 'example', m);
    queueExample(user, chatId, m);
    return;
  }

  if (/^\/(start|help)\b/.test(text)) return void (await send(chatId, HELLO));
  if (/^\/status\b/.test(text)) return void (await send(chatId, statusText(user)));
  if (/^\/edit\b/.test(text)) {
    if (!user.passport) return void (await send(chatId, 'Сначала научите меня своему стилю: пришлите 5–15 готовых роликов и соберите паспорт.'));
    user.mode = 'edit';
    const fresh = !user.project || (!user.project.sources.length && !user.project.brief.length && !user.project.result);
    if (!user.project) newProject(user);
    await saveUser(user);
    if (fresh) return void (await startWizard(user, chatId));
    if (user.project.result) return void (await send(chatId, `🎬 <b>Ролик №${user.project.id}</b> готов. Правки пишите сообщением, новый ролик — /new.`));
    return void (await send(chatId, `🎬 <b>Продолжаем ролик №${user.project.id}.</b>\n\n` + stageText(user, user.project), { reply_markup: stageKb(user.project) }));
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
    return void (await startWizard(user, chatId));
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
  if (/^\/history\b/.test(text)) return void (await showHistory(user, chatId));
  if (/^\/creative\b/.test(text)) {
    user.creative = !creativeOn(user);
    await saveUser(user);
    return void (await send(chatId, user.creative ? '🎨 Творческая свобода <b>включена</b>: ИИ будет усиливать ролик ради удержания — крючок в начале, смена картинки каждые пару секунд, без воды. Выключить — /creative ещё раз.' : '📐 Творческая свобода <b>выключена</b>: ИИ строго следует паспорту и вашим пожеланиям. Включить — /creative.'));
  }
  const role = text.match(/^\/(broll|talk)(?:@\w+)?\s*(\d+)?/);
  if (role) {
    if (!user.passport) return void (await send(chatId, 'Сначала научите меня своему стилю: /learn'));
    user.mode = 'edit';
    const stage = role[1];
    if (!role[2]) return void (await setStage(user, chatId, stage));
    const p = user.project;
    const s = p && p.sources.find((x) => x.n === Number(role[2]));
    if (!s) return void (await send(chatId, `Укажите номер исходника из /status, например: /${stage} 2`));
    if (s.kind === 'audio') return void (await send(chatId, 'Озвучка — это всегда озвучка, её роль не меняется.'));
    if (busy(user)) return void (await send(chatId, BUSY));
    if (roleOf(s) === stage) return void (await send(chatId, sourceLine(s)));
    p.summarySig = '';
    if (p.result) p.open = true;
    return void (await remarkSource(user, chatId, s, stage));
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
  if (text.startsWith('/')) return void (await send(chatId, 'Не знаю такой команды. Есть /status, /style, /edit, /learn, /new, /history, /broll, /talk, /creative, /reset и /help.'));

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
    p.brief.push(text);
    await saveUser(user);
    const st = stageOf(p);
    const tail = {
      talk: `Учту на этапе монтажа. А сейчас — ${stageLine(p).replace(/^\S+ Сейчас: /, '')}: пришлите видео с речью или голосовое, либо жмите «Дальше».`,
      broll: `Учту на этапе монтажа. А сейчас — ${stageLine(p).replace(/^\S+ Сейчас: /, '')}: пришлите перебивки или жмите «Дальше».`,
      brief: 'Ещё пожелание — пишите следующим сообщением. Всё — жмите «Дальше: монтаж».',
      ready: 'Учту при монтаже.',
    }[st];
    return void (await send(chatId, `✍️ Записал пожелание: «${esc(text)}».\n${tail}`, { reply_markup: stageKb(p) }));
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
const busy = (user) => isBusy(user);

/** Видео или звук в режиме монтажа */
async function onSourceMedia(user, chatId, m) {
  if (!user.project) newProject(user);
  const p = user.project;
  if (user.replace && user.replace.pid === p.id && !m.replaceN) {
    const old = p.sources.find((x) => x.n === user.replace.n);
    m.replaceN = user.replace.n;
    m.role = m.kind === 'audio' ? 'voice' : old && roleOf(old) !== 'voice' ? roleOf(old) : 'talk';
    user.replace = null;
    p.open = true;
  }
  if (!m.role) m.role = m.kind === 'audio' ? 'voice' : stageOf(p) === 'talk' ? 'talk' : 'broll';
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
  if (!(user.inbox || []).some((x) => x.m.fileId === m.fileId)) addInbox(user, 'source', m);
  p.summarySig = '';
  queueSource(user, chatId, m);
}

function queueSource(user, chatId, m) {
  const p = user.project || newProject(user);
  enqueue(user, chatId, async () => {
    if (user.project !== p) return dropInbox(user, m);
    await processSource(user, chatId, m);
  }).then(() => setTimeout(() => afterSources(user, chatId).catch(() => {}), 50));
}

function queueExample(user, chatId, m) {
  enqueue(user, chatId, async () => {
    await processExample(user, chatId, m);
    await afterExamples(user, chatId);
  });
}

// ───────────────────────────── После монтажа: история, уникализация, замена ─────────────────────────────

function fmtWhen(iso) {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: CFG.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch (_) {
    return String(iso || '').slice(5, 16).replace('T', ' ');
  }
}

const allProjects = (user) => [user.project, ...(user.archive || [])].filter((p) => p && ensureHistory(p).length);

async function showHistory(user, chatId) {
  const list = allProjects(user);
  if (!list.length) return send(chatId, '🗂 История пуста: пока нет смонтированных роликов.');
  const L = ['🗂 <b>История роликов</b>\n'];
  for (const p of list) {
    const h = ensureHistory(p);
    const idea = (h[h.length - 1].plan && h[h.length - 1].plan.idea) || '';
    L.push(`${p === user.project ? '▶️ ' : ''}<b>Ролик №${p.id}</b> · ${fmtWhen(p.createdAt)} · вариантов: ${h.length}${p.final ? ` · ✅ финальный: ${p.final}` : ''}${idea ? `\n${esc(idea.slice(0, 80))}` : ''}`);
  }
  L.push(`\nОткройте ролик, чтобы посмотреть варианты и продолжить правки. Храню последние ${CFG.keepProjects} роликов вместе с исходниками.`);
  const btns = list.map((p) => [`📂 №${p.id}`, `h_p:${p.id}`]);
  const rows = [];
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  return send(chatId, L.join('\n'), { reply_markup: kb(rows) });
}

async function showVariants(user, chatId) {
  const p = user.project;
  const h = ensureHistory(p);
  if (!h.length) return send(chatId, `В ролике №${p.id} пока нет готовых вариантов.`);
  const kind = (x) => (x.kind === 'fix' ? `правка к ${x.from}` : x.kind === 'variant' ? 'другая версия' : 'монтаж');
  const L = [`📂 <b>Ролик №${p.id}</b> — варианты:\n`];
  for (const x of h) {
    L.push(`<b>${x.v}.</b> ${fmtDur(x.duration)} · ${kind(x)}${x.cost ? ` · ${fmtUsd(x.cost.usd)}` : ''}${p.final === x.v ? ' · ✅ финальный' : ''}${p.result && p.result.v === x.v ? ' · текущий' : ''}${x.fixText ? `\n    «${esc(x.fixText.slice(0, 70))}»` : ''}`);
  }
  L.push('\nВыберите вариант — пришлю его, и правки пойдут от него.');
  const btns = h.map((x) => [`▶️ ${x.v}`, `h_v:${x.v}`]);
  const rows = [];
  for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
  rows.push([['🗂 Все ролики', 'r_hist']]);
  return send(chatId, L.join('\n'), { reply_markup: kb(rows) });
}

/** Открыть ролик из архива: текущий уходит в архив, выбранный становится текущим */
async function openProject(user, id) {
  if (user.project && user.project.id === id) return user.project;
  const p = (user.archive || []).find((x) => x.id === id);
  if (!p) return null;
  user.archive = user.archive.filter((x) => x !== p);
  const cur = user.project;
  if (cur && ensureHistory(cur).length) await archiveProject(user, cur);
  else if (cur) await fsp.rm(projDir(user, cur), { recursive: true, force: true }).catch(() => {});
  delete p.archivedAt;
  p.open = false;
  p.stage = 'ready';
  user.project = p;
  user.mode = 'edit';
  return p;
}

async function swapMenu(user, chatId) {
  const p = user.project;
  if (!p || !p.sources.length) return send(chatId, 'В этом ролике нет исходников.');
  const L = ['🔁 <b>Какой исходник заменить?</b>\n'];
  for (const s of p.sources) L.push(sourceLine(s).replace(/^\S+ /, ''));
  L.push('\nПосле замены нажмите «▶️ Смонтировать» — получится новый вариант. Прежние варианты останутся в истории.');
  const btns = p.sources.map((s) => [`${ROLE_ICON[roleOf(s)]} ${s.n}`, `sw:${s.n}`]);
  const rows = [];
  for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
  rows.push([['➕ Добавить речь', 'add:talk'], ['➕ Добавить перебивки', 'add:broll']]);
  return send(chatId, L.join('\n'), { reply_markup: kb(rows) });
}

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a, b) => (Math.random() < 0.5 ? rnd(-b, -a) : rnd(a, b)); // не ближе a к нулю

/**
 * Уникализация: копии готового ролика с небольшими изменениями картинки, звука, длины и метаданных.
 * Без ИИ — только ffmpeg, поэтому бесплатно.
 */
async function uniqueize(user, chatId, it, n) {
  const p = user.project;
  const dir = projDir(user);
  const srcFile = path.join(dir, it.file);
  if (!fs.existsSync(srcFile)) return send(chatId, 'Файл этого варианта не сохранился.');
  const W = it.width || 1080;
  const H = it.height || 1920;
  const fps = it.fps || CFG.fps;
  const st = await progress(user, chatId, `🧬 Делаю копии варианта ${it.v}: 0 из ${n}…`);
  try {
    for (let i = 1; i <= n; i++) {
      await st.set(`🧬 Делаю копии варианта ${it.v}: ${i} из ${n}…`);
      const z = rnd(1.04, 1.08);
      const ang = pick(0.15, 0.5);
      const sp = 1 + pick(0.01, 0.03);
      const trim = rnd(0.05, 0.3);
      const br = pick(0.01, 0.04);
      const ct = 1 + pick(0.01, 0.04);
      const sat = 1 + pick(0.02, 0.08);
      const ox = Math.round(rnd(-6, 6));
      const oy = Math.round(rnd(-10, 10));
      const crf = Math.round(rnd(18, 23));
      const vf = [
        `scale=trunc(${W}*${z.toFixed(4)}/2)*2:trunc(${H}*${z.toFixed(4)}/2)*2`,
        `rotate=${ang.toFixed(3)}*PI/180:ow=iw:oh=ih:c=black`,
        `crop=${W}:${H}:(iw-${W})/2+${ox}:(ih-${H})/2+${oy}`,
        `eq=brightness=${br.toFixed(3)}:contrast=${ct.toFixed(3)}:saturation=${sat.toFixed(3)}`,
        `noise=alls=${Math.round(rnd(1, 4))}:allf=t`,
        `setpts=PTS/${sp.toFixed(4)}`,
        `fps=${fps}`,
        'format=yuv420p',
      ].join(',');
      const out = path.join(dir, `uniq-${it.v}-${i}.mp4`);
      await ff(
        ['-y', '-ss', trim.toFixed(3), '-i', srcFile, '-vf', vf, '-af', `atempo=${sp.toFixed(4)},volume=${pick(0.3, 1).toFixed(2)}dB`, '-map_metadata', '-1', '-metadata', `title=${Date.now().toString(36)}${i}`, '-metadata', `creation_time=${new Date().toISOString()}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-g', String(Math.round(rnd(1.5, 3) * fps)), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${[160, 192, 224][i % 3]}k`, '-movflags', '+faststart', out],
        'сделать копию'
      );
      const caption = `🧬 <b>Копия ${i} из ${n}</b> · ролик №${p.id}, вариант ${it.v}\nмасштаб ${num(z * 100)}%, поворот ${num(ang)}°, скорость ${num(sp, 2)}×, начало −${num(trim, 2)} с, сдвинуты яркость/контраст/цвет, другое сжатие и метаданные`;
      try {
        await sendVideoFile(chatId, out, { caption, width: W, height: H });
      } finally {
        await fsp.unlink(out).catch(() => {});
      }
    }
    await st.done(`🧬 Готово: ${n} ${plural(n, 'копия', 'копии', 'копий')} варианта ${it.v}.`);
  } catch (e) {
    await st.done(`⚠️ Уникализация прервалась: ${esc(e.message)}.`);
  }
}

/** Кнопки вида «действие:параметр» (под роликом, в истории, в замене) */
async function onCallbackArg(user, chatId, q, done, dropButtons) {
  const [cmd, a, b] = q.data.split(':');
  const p = user.project;
  const needIdle = ['r_alt', 'r_uniq', 'u_n', 'h_p', 'h_v', 'sw', 'add'];
  if (needIdle.includes(cmd) && busy(user)) return done('Подождите, я ещё занят');
  switch (cmd) {
    case 'r_fix': {
      const it = useVariant(user, a);
      if (!it) return done('Этого варианта уже нет');
      await done();
      await saveUser(user);
      return send(chatId, `✏️ Напишите одним сообщением, что поправить в варианте ${it.v}. Например:\n• «убери вторую фразу»\n• «субтитры крупнее и жёлтые»\n• «больше перебивок, начни с кадра с рыбой»`);
    }
    case 'r_alt': {
      if (!useVariant(user, a)) return done('Этого варианта уже нет');
      await done('Делаю другой вариант…');
      await saveUser(user);
      return enqueue(user, chatId, () => makeMontage(user, chatId, '', { variant: true }));
    }
    case 'r_ok': {
      const it = useVariant(user, a);
      if (!it) return done('Этого варианта уже нет');
      p.final = it.v;
      await saveUser(user);
      await done('Отмечено');
      return send(chatId, `✅ <b>Вариант ${it.v} ролика №${p.id} — финальный.</b> Он сохранён в истории (/history).\n\nМожно сделать уникальные копии для повторных публикаций или начать новый ролик.`, { reply_markup: kb([[['🧬 Уникализировать', `r_uniq:${it.v}`]], [['🆕 Новый ролик', 'm_new'], ['🗂 История', 'r_hist']]]) });
    }
    case 'r_uniq': {
      const it = useVariant(user, a);
      if (!it) return done('Этого варианта уже нет');
      await done();
      return send(chatId, `🧬 <b>Уникализация варианта ${it.v}</b>\n\nСделаю копии, у которых чуть-чуть отличаются кадрирование, наклон, скорость, цвет, длина, сжатие и метаданные — на глаз ролик тот же. ИИ не нужен, это бесплатно.\n\n⚠️ Гарантировать, что Instagram посчитает копии новыми, нельзя: его алгоритмы закрыты. И массовые повторы одного ролика могут нарушать правила Instagram.\n\nСколько копий сделать?`, { reply_markup: kb([[['3', `u_n:${it.v}:3`], ['5', `u_n:${it.v}:5`], ['10', `u_n:${it.v}:10`]]]) });
    }
    case 'u_n': {
      const it = useVariant(user, a);
      const n = clamp(Number(b) || 3, 1, 10);
      if (!it) return done('Этого варианта уже нет');
      await done(`Делаю ${n}…`);
      await dropButtons();
      return enqueue(user, chatId, () => uniqueize(user, chatId, it, n));
    }
    case 'h_p': {
      const np = await openProject(user, Number(a));
      if (!np) return done('Этого ролика уже нет в истории');
      await done();
      await saveUser(user);
      return showVariants(user, chatId);
    }
    case 'h_v': {
      const it = useVariant(user, a);
      if (!it) return done('Этого варианта уже нет');
      await done();
      p.stage = 'ready';
      p.open = false;
      await saveUser(user);
      return showVariant(user, chatId, it);
    }
    case 'sw': {
      const src = p && p.sources.find((x) => x.n === Number(a));
      if (!src) return done('Этого исходника уже нет');
      user.replace = { pid: p.id, n: src.n };
      p.stage = 'ready';
      await saveUser(user);
      await done();
      const what = { talk: 'видео, где вы говорите (или голосовое)', broll: 'видео для перебивки', voice: 'голосовое или аудиофайл (или видео с речью)' }[roleOf(src)];
      return send(chatId, `🔁 Пришлите новый файл вместо исходника ${src.n} (${ROLE_NAME[roleOf(src)]}): ${what}.\n\n⏳ Дождитесь, пока я его обработаю, — потом пришлю кнопку «▶️ Смонтировать».`);
    }
    case 'add': {
      if (!p) return done();
      await done();
      p.open = true;
      return setStage(user, chatId, a === 'broll' ? 'broll' : 'talk');
    }
  }
  return done();
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

  if (q.data.includes(':')) return onCallbackArg(user, chatId, q, done, dropButtons);
  switch (q.data) {
    case 'r_hist':
      await done();
      await showHistory(user, chatId);
      break;
    case 'r_swap':
      await done();
      await swapMenu(user, chatId);
      break;
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
      await startWizard(user, chatId);
      break;
    case 'fix':
      await done();
      user.awaitFix = true;
      await send(chatId, 'Напишите одним сообщением, что не так в паспорте. Например:\n• «субтитры у меня всегда жёлтые, внизу»\n• «музыку я ставлю тише»\n• «в начале всегда крупный план продукта»');
      break;
    case 'm_go':
      await done();
      await dropButtons();
      await setStage(user, chatId, 'ready');
      break;
    case 'm_run': {
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
    case 'm_cancel':
      await dropButtons();
      await done('Отменено');
      break;
    case 'st_talk':
    case 'st_broll':
    case 'st_brief':
    case 'st_ready':
      await done();
      await dropButtons();
      if (user.project && user.project.result && !user.project.open) {
        await send(chatId, 'Этот ролик уже смонтирован: правки пишите сообщением. Новый ролик — /new.');
        break;
      }
      user.mode = 'edit';
      await setStage(user, chatId, q.data.slice(3));
      break;
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
        await startWizard(user, chatId, q.data === 'm_clear' ? '🗑 Прежние исходники удалены.' : held.length ? '📥 Беру присланные файлы — они идут на этап 1.' : '');
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

/** После перезапуска сервера: честно отмечаем прерванное и продолжаем с того места, где остановились */
async function recover() {
  let ids = [];
  try {
    ids = await fsp.readdir(path.join(CFG.dataDir, 'users'));
  } catch (_) {
    return;
  }
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    const user = await getUser(id);
    const chatId = Number(id);
    const live = user.live || [];
    for (const l of live) await edit(l.chatId, l.id, `${esc(String(l.text || '').replace(/…$/, ''))} — ⚠️ прервалось: сервер перезапускался.`);
    const wasMontage = live.some((l) => /монтаж|правку/i.test(l.text || ''));
    user.live = [];
    const inbox = user.inbox || [];
    const p = user.project;
    const unfinished = p ? p.sources.filter((s) => needsAnalysis(user, s) && !(roleOf(s) === 'broll' && stageOf(p) === 'broll')) : [];
    await saveUser(user);
    if (!inbox.length && !unfinished.length && !wasMontage) {
      // ждал следующего этапа, а обрабатывать уже нечего — показываем этап
      if (p && p.nextStage) await afterSources(user, chatId).catch(() => {});
      continue;
    }
    const parts = ['♻️ Бот перезапускался.'];
    if (inbox.length) parts.push(`Продолжаю приём файлов: ${inbox.length}.`);
    if (unfinished.length) parts.push(`Доразбираю исходники: ${unfinished.length}.`);
    if (wasMontage) parts.push('Монтаж прервался — запустите его ещё раз.');
    await send(chatId, parts.join(' '), wasMontage ? { reply_markup: kb([[['🎬 Смонтировать', 'm_go']]]) } : {}).catch(() => {});
    log(`recover ${id}: файлов ${inbox.length}, разборов ${unfinished.length}, монтаж ${wasMontage}`);
    for (const x of inbox) (x.type === 'source' ? queueSource : queueExample)(user, chatId, x.m);
    for (const s of unfinished) {
      background(user, chatId, async () => {
        try {
          await analyzePatiently(user, s, async () => {});
        } catch (e) {
          s.aiError = e.message;
        }
      }).then(() => setTimeout(() => afterSources(user, chatId).catch(() => {}), 50));
    }
  }
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
  await recover().catch((e) => log('recover:', e.message));
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
