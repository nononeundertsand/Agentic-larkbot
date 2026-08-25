const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]]{1,160})\]\((https?:\/\/[^)\s]+)\)/gi;
const KNOWN_DOC_TOKEN_RE = /\b(?:doxcn|doccn|docxcn)[A-Za-z0-9_-]{6,}\b/g;
const TRAILING_PUNCTUATION_RE = /[),.;:!?\]\}>"'`，。；：！？、]+$/;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanToken(value) {
  return String(value || '')
    .replace(/^#/, '')
    .replace(TRAILING_PUNCTUATION_RE, '')
    .replace(/(?:和|以及|及)?https?:\/\/.*$/i, '')
    .replace(/[\u4e00-\u9fa5].*$/g, '')
    .trim();
}

function cleanUrl(value) {
  let text = String(value || '').replace(TRAILING_PUNCTUATION_RE, '').trim();
  const duplicateScheme = text.slice(8).search(/https?:\/\//i);
  if (duplicateScheme >= 0) text = text.slice(0, duplicateScheme + 8);
  text = text.replace(/(?:和|以及|及)(?=https?:\/\/)/i, '');
  return text.replace(/[\u4e00-\u9fa5].*$/g, '').replace(TRAILING_PUNCTUATION_RE, '').trim();
}

function splitStickyUrls(value) {
  const raw = String(value || '').trim();
  const matches = [...raw.matchAll(/https?:\/\/[\s\S]*?(?=(?:和|以及|及)?https?:\/\/|$)/gi)]
    .map((match) => cleanUrl(match[0]))
    .filter(Boolean);
  return matches.length ? matches : [cleanUrl(raw)].filter(Boolean);
}

function sourceKey(source = {}) {
  if (source.token) return `${source.kind}:${source.token}`;
  if (source.url) return `${source.kind}:${source.url}`;
  return `${source.kind}:${source.title}`;
}

function stableSourceId(index) {
  return `source_${index + 1}`;
}

function larkKindFromToken(token = '', fallback = 'doc') {
  const t = String(token || '');
  if (/^(doxcn|doccn|docxcn)/i.test(t)) return 'doc';
  return fallback;
}

function sourceFromLarkUrl(parsed, originalUrl, title = '') {
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const kindIndex = parts.findIndex((part) => ['docx', 'docs', 'doc', 'wiki'].includes(part));
  if (kindIndex < 0) return null;
  const route = parts[kindIndex];
  const token = cleanToken(parts[kindIndex + 1] || '');
  if (!token) return null;
  return {
    kind: route === 'wiki' ? 'wiki' : 'doc',
    title: cleanText(title),
    token,
    url: originalUrl,
    reader: route === 'wiki' ? 'lark_wiki' : 'lark_doc',
  };
}

function sourceFromByteTechUrl(parsed, originalUrl, title = '') {
  const params = parsed.searchParams;
  const embeddedUrl = params.get('lark_doc_url') || params.get('doc_url') || params.get('url');
  if (embeddedUrl && /^https?:\/\//i.test(embeddedUrl)) {
    const nested = sourceFromUrl(embeddedUrl, title);
    if (nested) return { ...nested, originalUrl, metadata: { ...(nested.metadata || {}), via: 'bytetech' } };
  }

  const token = cleanToken(params.get('lark_doc_token') || params.get('doc_token') || params.get('token') || parsed.hash);
  if (token && /^(doxcn|doccn|docxcn)/i.test(token)) {
    return {
      kind: 'doc',
      title: cleanText(title),
      token,
      url: originalUrl,
      reader: 'lark_doc',
      metadata: { via: 'bytetech' },
    };
  }

  return {
    kind: 'web',
    title: cleanText(title),
    url: originalUrl,
    reader: 'web',
    metadata: { host: parsed.hostname },
  };
}

export function sourceFromUrl(rawUrl, title = '') {
  const originalUrl = cleanUrl(rawUrl);
  if (!originalUrl) return null;
  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith('larkoffice.com') || host.endsWith('feishu.cn') || host.endsWith('larksuite.com') || host.endsWith('doubao.com')) {
    const source = sourceFromLarkUrl(parsed, originalUrl, title);
    if (source) return source;
  }
  if (host === 'bytetech.info' || host.endsWith('.bytetech.info')) {
    return sourceFromByteTechUrl(parsed, originalUrl, title);
  }
  return {
    kind: 'web',
    title: cleanText(title),
    url: originalUrl,
    reader: 'web',
    metadata: { host },
  };
}

function sourceFromToken(token, title = '') {
  const cleaned = cleanToken(token);
  if (!cleaned) return null;
  const kind = larkKindFromToken(cleaned, 'doc');
  return {
    kind,
    title: cleanText(title),
    token: cleaned,
    url: '',
    reader: kind === 'wiki' ? 'lark_wiki' : 'lark_doc',
  };
}

function normalizeExplicitSource(source = {}) {
  if (!source || typeof source !== 'object') return null;
  const url = cleanUrl(source.url || source.href || '');
  if (url) {
    const parsed = sourceFromUrl(url, source.title || source.name || '');
    if (parsed) return { ...parsed, ...source, title: cleanText(source.title || source.name || parsed.title), url: parsed.url };
  }
  const token = cleanToken(source.token || source.docToken || source.doc_token || source.wikiToken || source.wiki_token || '');
  if (!token) return null;
  const kind = String(source.kind || source.type || larkKindFromToken(token)).trim();
  return {
    kind: kind === 'wiki' ? 'wiki' : 'doc',
    title: cleanText(source.title || source.name || ''),
    token,
    url: String(source.url || ''),
    reader: kind === 'wiki' ? 'lark_wiki' : 'lark_doc',
    metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : {},
  };
}

export function extractDocSources(text = '', { sources = [] } = {}) {
  const byKey = new Map();
  const add = (source) => {
    if (!source) return;
    const key = sourceKey(source);
    if (!key || byKey.has(key)) return;
    byKey.set(key, source);
  };

  for (const source of Array.isArray(sources) ? sources : []) {
    add(normalizeExplicitSource(source));
  }

  const markdownUrls = new Set();
  for (const match of String(text || '').matchAll(MARKDOWN_LINK_RE)) {
    for (const url of splitStickyUrls(match[2])) {
      markdownUrls.add(url);
      add(sourceFromUrl(url, match[1]));
    }
  }

  for (const match of String(text || '').matchAll(URL_RE)) {
    for (const url of splitStickyUrls(match[0])) {
      if (markdownUrls.has(url)) continue;
      add(sourceFromUrl(url));
    }
  }

  for (const match of String(text || '').matchAll(KNOWN_DOC_TOKEN_RE)) {
    add(sourceFromToken(match[0]));
  }

  return [...byKey.values()].map((source, index) => ({
    id: source.id ? String(source.id) : stableSourceId(index),
    kind: source.kind || 'doc',
    title: source.title || `来源 ${index + 1}`,
    token: source.token || '',
    url: source.url || '',
    reader: source.reader || (source.kind === 'web' ? 'web' : source.kind === 'wiki' ? 'lark_wiki' : 'lark_doc'),
    metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : {},
  }));
}
