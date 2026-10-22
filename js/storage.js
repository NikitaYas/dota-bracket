/**
 * storage.js — загрузка и сохранение данных сетки.
 * Чтение: GitHub API (сразу видно после сохранения) -> запасной вариант: файл сайта data/bracket.json.
 * Запись: GitHub Contents API с токеном администратора.
 */
import { normalizeState } from './engine.js';

export const CONFIG = {
  owner: 'NikitaYas',
  repo: 'dota-bracket',
  branch: 'main',
  path: 'data/bracket.json',
};

const API = 'https://api.github.com';
const TOKEN_KEY = 'dotaBracket.ghToken';
const BLOCK_KEY = 'dotaBracket.apiBlockedUntil';
const API_VERSION = '2022-11-28';
/** Без токена лимит GitHub — 60 запросов в час на IP (общий для всех вкладок); оставляем запас. */
const RATE_RESERVE = 5;

let memoryToken = '';
let authBlockedUntil = 0; // блокировка запросов с токеном (только в памяти)
let anonBlockedMemory = 0; // запасной вариант, если localStorage недоступен

/* ---------------- блокировка API (лимит, 404 до первого деплоя, сеть) ---------------- */

function anonBlockedUntil() {
  let v = 0;
  try { v = Number(window.localStorage.getItem(BLOCK_KEY)) || 0; } catch { /* ignore */ }
  return Math.max(v, anonBlockedMemory);
}

function blockApi(authed, until) {
  if (authed) {
    authBlockedUntil = Math.max(authBlockedUntil, until);
    return;
  }
  anonBlockedMemory = Math.max(anonBlockedMemory, until);
  // В localStorage, чтобы перезагрузка страницы и другие вкладки не тратили лимит IP впустую.
  try { window.localStorage.setItem(BLOCK_KEY, String(anonBlockedMemory)); } catch { /* ignore */ }
}

export const repoLabel = () => `${CONFIG.owner}/${CONFIG.repo}`;
export const repoUrl = () => `https://github.com/${CONFIG.owner}/${CONFIG.repo}`;
const contentsUrl = () =>
  `${API}/repos/${encodeURIComponent(CONFIG.owner)}/${encodeURIComponent(CONFIG.repo)}/contents/${CONFIG.path
    .split('/').map(encodeURIComponent).join('/')}`;

/** Локальная разработка: читаем локальный файл, а не (ещё не существующий) репозиторий. */
function isLocalDev() {
  if (typeof location === 'undefined') return false;
  if (/[?&]api=1\b/.test(location.search)) return false;
  const h = location.hostname;
  return location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
}

/* ---------------- токен ---------------- */

function safeGet(storage) {
  try { return storage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function getToken() {
  if (typeof window === 'undefined') return '';
  return safeGet(window.sessionStorage) || safeGet(window.localStorage);
}

export function isTokenRemembered() {
  return typeof window !== 'undefined' && !!safeGet(window.localStorage);
}

export function storeToken(token, remember) {
  clearToken();
  try {
    (remember ? window.localStorage : window.sessionStorage).setItem(TOKEN_KEY, token);
  } catch { /* приватный режим — токен будет жить только до перезагрузки */ }
  memoryToken = token;
}

export function currentToken() {
  return getToken() || memoryToken;
}

export function clearToken() {
  memoryToken = '';
  try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  try { window.sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

function authHeaders(token, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': API_VERSION };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/* ---------------- base64 (UTF-8 safe) ---------------- */

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------------- ошибки ---------------- */

export class StorageError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

function friendlyError(status, action = 'сохранить') {
  switch (status) {
    case 401: return new StorageError('Токен недействителен или истёк. Войдите заново с новым токеном.', 401);
    case 403: return new StorageError(`Нет прав, чтобы ${action}: у токена должно быть право «Contents: Read and write» для ${repoLabel()}. Также возможно превышение лимита запросов GitHub — попробуйте через минуту.`, 403);
    case 404: return new StorageError(`Репозиторий ${repoLabel()} не найден или у токена нет к нему доступа.`, 404);
    case 409:
    case 422: return new StorageError('Конфликт версий файла на GitHub. Обновите страницу и попробуйте ещё раз.', status);
    default: return new StorageError(`GitHub ответил ошибкой ${status}. Попробуйте ещё раз.`, status);
  }
}

async function ghFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new StorageError('Нет связи с GitHub. Проверьте интернет и попробуйте снова.', 0);
  }
}

/**
 * Разбирает JSON. normalizeState сама отбрасывает только испорченные поля и не падает;
 * если же файл вообще не JSON — бросаем ошибку (а не подменяем сетку пустой, чтобы её случайно не опубликовать).
 */
function parseText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StorageError('Файл данных повреждён (некорректный JSON).', 0);
  }
  try {
    return normalizeState(data);
  } catch {
    throw new StorageError('Не удалось разобрать данные сетки.', 0);
  }
}

/* ---------------- загрузка ---------------- */

function apiGet(token, etag) {
  const headers = { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;
  return fetch(`${contentsUrl()}?ref=${encodeURIComponent(CONFIG.branch)}`, { headers, cache: 'no-store' });
}

/**
 * Загружает данные.
 * useApi=false — сразу читать файл сайта (для частого автообновления: не тратит лимит GitHub API).
 * fresh=true — с токеном не учитывать временную блокировку API (вход в режим админа).
 * Без токена 304 тоже расходует лимит (60/час на IP), поэтому при остатке <= RATE_RESERVE API
 * откладывается до сброса лимита (отметка хранится в localStorage — общая для вкладок и перезагрузок).
 * @returns {Promise<{state, text, source:'api'|'static', etag?:string, tokenRejected?:boolean} | {notModified:true, source:'api'}>}
 */
export async function load({ token = currentToken(), etag = null, useApi = true, fresh = false } = {}) {
  let tokenRejected = false;
  if (useApi && !isLocalDev()) {
    // fresh: вход админа — с токеном пробуем API даже после недавней сетевой ошибки
    let authed = !!token && (fresh || Date.now() >= authBlockedUntil);
    if (authed || Date.now() >= anonBlockedUntil()) {
      try {
        let res = await apiGet(authed ? token : '', authed ? etag : null);
        if (res.status === 401 && authed) {
          // Сохранённый токен отозван или истёк — забываем его и повторяем запрос без авторизации.
          tokenRejected = true;
          clearToken();
          authed = false;
          res = Date.now() >= anonBlockedUntil() ? await apiGet('', null) : null;
        }
        if (res) {
          if (!authed && res.headers.has('X-RateLimit-Remaining')) {
            const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
            const reset = Number(res.headers.get('X-RateLimit-Reset'));
            if (remaining <= RATE_RESERVE) blockApi(false, reset > 0 ? reset * 1000 : Date.now() + 15 * 60 * 1000);
          }
          if (res.status === 304) return { notModified: true, source: 'api', etag, tokenRejected };
          if (res.ok) {
            const text = await res.text();
            try {
              return { state: parseText(text), text, source: 'api', etag: authed ? res.headers.get('ETag') : null, tokenRejected };
            } catch { /* испорченный JSON — попробуем файл сайта */ }
          } else if (res.status === 403 || res.status === 429) {
            const reset = Number(res.headers.get('X-RateLimit-Reset'));
            blockApi(authed, reset > 0 ? reset * 1000 : Date.now() + 5 * 60 * 1000);
          } else {
            // 404 (ещё нет репозитория/файла) и т.п. — какое-то время читаем файл сайта
            blockApi(authed, Date.now() + 10 * 60 * 1000);
          }
        }
      } catch {
        blockApi(authed, Date.now() + 60 * 1000);
      }
    }
  }
  const res = await fetch(`data/bracket.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new StorageError(`Не удалось загрузить data/bracket.json (${res.status})`, res.status);
  const text = await res.text();
  return { state: parseText(text), text, source: 'static', tokenRejected };
}

/* ---------------- вход администратора ---------------- */

/** Проверяет токен: доступ к репозиторию и право записи. */
export async function verifyToken(token) {
  if (!token || !/^[A-Za-z0-9_]{20,255}$/.test(token)) {
    return { ok: false, error: 'Это не похоже на токен GitHub. Скопируйте его целиком (начинается с github_pat_ или ghp_).' };
  }
  let res;
  try {
    res = await fetch(`${API}/repos/${encodeURIComponent(CONFIG.owner)}/${encodeURIComponent(CONFIG.repo)}`, {
      headers: authHeaders(token),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, error: 'Нет связи с GitHub. Проверьте интернет.' };
  }
  if (res.status === 401) return { ok: false, status: 401, error: 'Токен недействителен или истёк.' };
  if (res.status === 404) return { ok: false, status: 404, error: `Репозиторий ${repoLabel()} не найден или токен не даёт к нему доступа (выберите его в «Repository access»).` };
  if (res.status === 403) return { ok: false, status: 403, error: 'GitHub отклонил запрос (403). Возможно, превышен лимит запросов или токен ограничен организацией.' };
  if (!res.ok) return { ok: false, status: res.status, error: `GitHub ответил ошибкой ${res.status}.` };
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!data || !data.permissions || data.permissions.push !== true) {
    return { ok: false, status: 200, error: 'У токена нет права записи. Нужно «Contents: Read and write» для этого репозитория.' };
  }
  return { ok: true };
}

/* ---------------- сохранение ---------------- */

async function getRemote(token) {
  const res = await ghFetch(`${contentsUrl()}?ref=${encodeURIComponent(CONFIG.branch)}`, {
    headers: authHeaders(token),
    cache: 'no-store',
  });
  if (res.status === 404) return { sha: null, text: null };
  if (!res.ok) throw friendlyError(res.status, 'прочитать файл');
  const data = await res.json();
  let text = null;
  if (data && typeof data.content === 'string' && data.encoding === 'base64') {
    try { text = base64ToUtf8(data.content); } catch { text = null; }
  }
  return { sha: data && data.sha ? data.sha : null, text };
}

function putFile(token, text, sha, message) {
  const body = { message, content: utf8ToBase64(text), branch: CONFIG.branch };
  if (sha) body.sha = sha;
  return ghFetch(contentsUrl(), {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const sameText = (a, b) => String(a).replace(/\r\n/g, '\n').trim() === String(b).replace(/\r\n/g, '\n').trim();

/** Совпадает ли содержимое на GitHub с тем, от которого отталкивался админ (null = файла нет / не загружен). */
function sameRemote(remoteText, baselineText) {
  if (remoteText == null || baselineText == null) return remoteText == null && baselineText == null;
  return sameText(remoteText, baselineText);
}

/**
 * Публикует text в репозиторий.
 * Если файл на GitHub отличается от baselineText (то, что админ загрузил; null — ничего не загрузилось)
 * и force=false — возвращает {conflict:true, remoteText}. Так же — при гонке (409/422) с чужим коммитом.
 */
export async function save(text, { token = currentToken(), baselineText = null, force = false, message } = {}) {
  if (!token) throw new StorageError('Нужно войти с токеном GitHub.', 401);
  const msg = message || `Обновление сетки: ${new Date().toLocaleString('ru-RU')}`;
  const remote = await getRemote(token);
  if (!force && !sameRemote(remote.text, baselineText)) {
    return { conflict: true, remoteText: remote.text };
  }
  let res = await putFile(token, text, remote.sha, msg);
  if (res.status === 409 || res.status === 422) {
    // Между чтением и записью кто-то сохранил. Молча повторяем, только если содержимое не изменилось.
    const again = await getRemote(token);
    if (!force && !sameRemote(again.text, remote.text)) return { conflict: true, remoteText: again.text };
    res = await putFile(token, text, again.sha, msg);
  }
  if (!res.ok) throw friendlyError(res.status);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return {
    ok: true,
    sha: data && data.content ? data.content.sha : null,
    commitUrl: data && data.commit ? data.commit.html_url : null,
  };
}
