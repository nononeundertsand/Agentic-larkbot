import test from 'node:test';
import assert from 'node:assert/strict';

import { readDocSource } from '../src/doc-reader.mjs';

test('doc-reader 拒绝读取本地地址', async () => {
  const result = await readDocSource({
    id: 'source_1',
    kind: 'web',
    reader: 'web',
    url: 'http://127.0.0.1/latest',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /内网|本地/);
});

test('doc-reader 可通过注入 reader 读取测试文档', async () => {
  const result = await readDocSource({
    id: 'source_1',
    kind: 'doc',
    token: 'doxcnABCDEF123456',
  }, {
    readSource: async () => ({ ok: true, text: '这是一份测试文档正文。', title: '测试文档' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.title, '测试文档');
  assert.match(result.text, /测试文档正文/);
});

test('doc-reader 读取 wiki 链接时使用 docs +fetch 和原始 URL', async () => {
  const calls = [];
  const wikiUrl = 'https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh';
  const result = await readDocSource({
    id: 'source_1',
    kind: 'wiki',
    reader: 'lark_wiki',
    token: 'LpxGwSMfDiZwAkkztg2crzoPnQh',
    url: wikiUrl,
  }, {
    runLark: async (args) => {
      calls.push(args);
      return { code: 0, json: { data: { markdown: 'wiki 文档正文' } }, out: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['docs', '+fetch', '--doc', wikiUrl, '--as', 'user', '--scope', 'full', '--doc-format', 'markdown', '--format', 'json']);
  assert.match(result.text, /wiki 文档正文/);
});

test('doc-reader 使用 docs +fetch v2 参数读取完整文档', async () => {
  const calls = [];
  const result = await readDocSource({
    id: 'source_1',
    kind: 'doc',
    token: 'doxcnABCDEF123456',
  }, {
    runLark: async (args) => {
      calls.push(args);
      return { code: 0, json: { data: { markdown: '完整文档内容' } }, out: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['docs', '+fetch', '--doc', 'doxcnABCDEF123456', '--as', 'user', '--scope', 'full', '--doc-format', 'markdown', '--format', 'json']);
  assert.match(result.text, /完整文档内容/);
});

test('doc-reader 读取已知 ByteTech 文章失败时使用本地脱敏笔记兜底', async () => {
  const result = await readDocSource({
    id: 'source_1',
    kind: 'web',
    reader: 'web',
    url: 'https://bytetech.info/articles/7654024985686016040?from=message_bot',
  }, {
    fetchText: async () => ({ ok: false, error: '重定向次数过多' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.fallback, 'local_redacted_notes');
  assert.match(result.title, /ByteTech/);
  assert.match(result.text, /Agent Harness/);
});
