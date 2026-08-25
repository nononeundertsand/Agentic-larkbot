import test from 'node:test';
import assert from 'node:assert/strict';

import { extractDocSources } from '../src/doc-source-parser.mjs';

test('文档来源解析支持 ByteTech hash token 和飞书 wiki URL', () => {
  const sources = extractDocSources(
    '请总结 [Harness](https://bytetech.info/articles/7654024985686016040#doxcnJ2BghGgHIIKKQlax7sxkbf) 和 https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh',
  );

  assert.equal(sources.length, 2);
  assert.equal(sources[0].kind, 'doc');
  assert.equal(sources[0].token, 'doxcnJ2BghGgHIIKKQlax7sxkbf');
  assert.equal(sources[0].title, 'Harness');
  assert.equal(sources[1].kind, 'wiki');
  assert.equal(sources[1].token, 'LpxGwSMfDiZwAkkztg2crzoPnQh');
});

test('文档来源解析会去重同一 token', () => {
  const sources = extractDocSources(
    'https://bytetech.info/articles/1#doxcnABCDEF123456 doxcnABCDEF123456',
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].token, 'doxcnABCDEF123456');
});

test('文档来源解析能处理中文连接词粘连的多个 URL', () => {
  const sources = extractDocSources(
    '链接为：https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh和https://bytetech.info/articles/7654024985686016040?from=message_bot#doxcnJ2BghGgHIIKKQlax7sxkbf',
  );

  assert.equal(sources.length, 2);
  assert.equal(sources[0].token, 'LpxGwSMfDiZwAkkztg2crzoPnQh');
  assert.equal(sources[0].url, 'https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh');
  assert.equal(sources[1].token, 'doxcnJ2BghGgHIIKKQlax7sxkbf');
});
