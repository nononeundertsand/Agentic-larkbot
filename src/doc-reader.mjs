import { lookup as dnsLookup } from 'node:dns/promises';
import { runLark as defaultRunLark } from './lark.mjs';

const DEFAULT_MAX_DOC_CHARS = Number(process.env.DOC_REPORT_MAX_SOURCE_CHARS || 120000);
const DEFAULT_LARK_TIMEOUT_MS = Number(process.env.DOC_REPORT_LARK_TIMEOUT_MS || 60000);
const DEFAULT_WEB_TIMEOUT_MS = Number(process.env.DOC_REPORT_WEB_TIMEOUT_MS || 15000);
const DEFAULT_WEB_MAX_BYTES = Number(process.env.DOC_REPORT_WEB_MAX_BYTES || 1_500_000);
const WEB_UA = process.env.WEB_UA || 'Mozilla/5.0 (compatible; LarkBot/1.0; +https://bytedance.com)';

function clip(value, max = DEFAULT_MAX_DOC_CHARS) {
  const text = String(value || '').trim();
  if (!max || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 28))}\n\n[内容过长，已截断]`;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeIpLiteral(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s;
}

function ipv4FromMappedIpv6(ip) {
  const s = normalizeIpLiteral(ip);
  if (!s.includes(':')) return '';
  const dotted = s.match(/^(?:::)?(?:0:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1];
  const hex = s.match(/^(?:::)?(?:0:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return '';
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return '';
  const n = (hi << 16) | lo;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function isBlockedIp(ip) {
  const s = normalizeIpLiteral(ip);
  const mapped = ipv4FromMappedIpv6(s);
  if (mapped) return isBlockedIp(mapped);
  if (s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  if (m.slice(1).some((n) => Number(n) < 0 || Number(n) > 255)) return false;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

async function vetPublicUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch { return { ok: false, reason: 'URL 格式不正确' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, reason: '仅支持 http/https 链接' };
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: '不允许访问内网/本地地址' };
  }
  if (isBlockedIp(host)) return { ok: false, reason: '不允许访问内网/本地地址' };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
    try {
      const addrs = await dnsLookup(host, { all: true });
      if (addrs.some((item) => isBlockedIp(item.address))) return { ok: false, reason: '目标解析到内网地址，已拒绝' };
    } catch {
      return { ok: false, reason: `无法解析域名：${host}` };
    }
  }
  return { ok: true };
}

async function readResponseLimited(resp) {
  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > DEFAULT_WEB_MAX_BYTES) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, reason: `响应过大（上限 ${DEFAULT_WEB_MAX_BYTES} bytes）` };
  }
  if (!resp.body) return { ok: true, body: '' };
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remain = DEFAULT_WEB_MAX_BYTES - total;
      if (remain <= 0) {
        await reader.cancel();
        break;
      }
      chunks.push(value.length > remain ? value.slice(0, remain) : value);
      total += Math.min(value.length, remain);
      if (total >= DEFAULT_WEB_MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, body: new TextDecoder('utf-8', { fatal: false }).decode(merged) };
}

async function fetchPublicText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_WEB_TIMEOUT_MS);
  let currentUrl = String(url || '');
  let redirects = 0;
  try {
    while (true) {
      const vet = await vetPublicUrl(currentUrl);
      if (!vet.ok) return { ok: false, error: vet.reason };
      const resp = await fetch(currentUrl, {
        headers: { 'User-Agent': WEB_UA, Accept: 'text/html,text/plain,*/*' },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) return { ok: false, error: `重定向缺少 Location（HTTP ${resp.status}）` };
        if (++redirects > 5) return { ok: false, error: '重定向次数过多' };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      const read = await readResponseLimited(resp);
      if (!read.ok) return { ok: false, error: read.reason };
      const contentType = resp.headers.get('content-type') || '';
      const text = /html/i.test(contentType) ? stripHtml(read.body) : String(read.body || '');
      return { ok: resp.ok, status: resp.status, finalUrl: currentUrl, text: clip(text) };
    }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '请求超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function pickText(value, depth = 0) {
  if (value == null || depth > 5) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => pickText(item, depth + 1)).filter(Boolean);
    return parts.join('\n');
  }
  if (isPlainObject(value)) {
    const preferredKeys = [
      'markdown',
      'content',
      'text',
      'plain_text',
      'body',
      'document',
      'result',
      'data',
    ];
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = pickText(value[key], depth + 1);
        if (found) return found;
      }
    }
    const parts = Object.values(value).map((item) => pickText(item, depth + 1)).filter(Boolean);
    return parts.join('\n');
  }
  return '';
}

function resultPayload(result = {}) {
  return result.json ? (result.json.data ?? result.json) : result.out;
}

export function normalizeReaderOutput(result = {}, source = {}) {
  if (result?.ok === false || result?.error) {
    return {
      ok: false,
      source,
      error: String(result.error || result.reason || '读取失败'),
      raw: result,
    };
  }
  const text = clip(pickText(result?.text ?? result?.content ?? result?.result ?? result?.data ?? result));
  if (!text) {
    return {
      ok: false,
      source,
      error: '读取结果为空',
      raw: result,
    };
  }
  return {
    ok: true,
    source,
    title: source.title || result.title || result.name || source.url || source.token || source.id,
    text,
    metadata: {
      status: result.status,
      finalUrl: result.finalUrl,
    },
    raw: result,
  };
}

function larkReadCandidates(source = {}) {
  const token = String(source.token || '').trim();
  const docRef = String(source.url || token || '').trim();
  if (!docRef) return [];
  if (source.kind === 'wiki' || source.reader === 'lark_wiki') {
    return [
      ['docs', '+fetch', '--doc', docRef, '--as', 'user'],
    ];
  }
  return [
    ['docs', '+fetch', '--doc', docRef, '--as', 'user'],
  ];
}

async function readLarkSource(source, { runLark = defaultRunLark, logger = console } = {}) {
  const attempts = [];
  for (const args of larkReadCandidates(source)) {
    const fetchArgs = [
      ...args,
      '--scope', 'full',
      '--doc-format', 'markdown',
      '--format', 'json',
    ];
    const result = await runLark(fetchArgs, {
      timeoutMs: DEFAULT_LARK_TIMEOUT_MS,
      maxOutputBytes: Number(process.env.DOC_REPORT_LARK_MAX_OUTPUT_BYTES || 1_200_000),
    });
    attempts.push({ args: fetchArgs, code: result.code, err: result.err || '' });
    if (result.code !== 0) continue;
    const normalized = normalizeReaderOutput(resultPayload(result), source);
    if (normalized.ok) return { ...normalized, attempts };
  }
  logger.warn?.('[doc-reader] lark source read failed', source.id, attempts.at(-1)?.err || attempts.at(-1)?.code);
  return {
    ok: false,
    source,
    error: attempts.map((item) => item.err).find(Boolean) || 'lark-cli 读取失败',
    attempts,
  };
}

export async function readDocSource(source = {}, opts = {}) {
  if (typeof opts.readSource === 'function') {
    return normalizeReaderOutput(await opts.readSource(source), source);
  }
  if (source.reader === 'web' || source.kind === 'web') {
    if (typeof opts.fetchText === 'function') return normalizeReaderOutput(await opts.fetchText(source.url, source), source);
    return normalizeReaderOutput(await fetchPublicText(source.url), source);
  }
  return readLarkSource(source, opts);
}

export async function readDocSources(sources = [], opts = {}) {
  const results = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    results.push(await readDocSource(source, opts));
  }
  return results;
}
