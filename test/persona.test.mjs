import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACADEMIC_PERSONA_ID,
  AUTO_PERSONA_ID,
  DEFAULT_PERSONA_ID,
  buildPersonaSystemNote,
  detectPersonaRoute,
  getPersona,
  listPersonaOptions,
  listPersonas,
  normalizePersonaId,
  normalizePersonaSetting,
  resolvePersonaForMessage,
} from '../src/persona.mjs';

test('人格注册表支持别名归一化和列出内置人格', () => {
  assert.equal(normalizePersonaId('学术'), ACADEMIC_PERSONA_ID);
  assert.equal(normalizePersonaId('default'), DEFAULT_PERSONA_ID);
  assert.equal(normalizePersonaSetting('自动人格'), AUTO_PERSONA_ID);
  assert.equal(getPersona('math').id, ACADEMIC_PERSONA_ID);
  assert.ok(listPersonas().some((persona) => persona.id === ACADEMIC_PERSONA_ID));
  assert.ok(listPersonaOptions().some((persona) => persona.id === AUTO_PERSONA_ID));
});

test('数学和证明类问题会命中学术人格路由', () => {
  const text = [
    '我证伪了雅可比猜想：F : C^3 -> C^3',
    'F(x,y,z) = ((1+xy)^3 z, y + 3x(1+xy)^2 z, 2x - 3x^2y - x^3z)',
  ].join('\n');
  const route = detectPersonaRoute(text);
  assert.equal(route.personaId, ACADEMIC_PERSONA_ID);
  assert.equal(route.answerMode, 'expert_reasoning');
});

test('自动切换开启时专业问题临时覆盖基础人格', () => {
  const decision = resolvePersonaForMessage('请严谨证明这个多项式映射是否可逆', {
    personaState: { defaultPersonaId: AUTO_PERSONA_ID },
    env: { PERSONA_AUTO_SWITCH: 'on' },
  });
  assert.equal(decision.personaId, ACADEMIC_PERSONA_ID);
  assert.equal(decision.source, 'auto');
  assert.equal(decision.answerMode, 'expert_reasoning');
});

test('固定人格不会被专业问题自动覆盖', () => {
  const decision = resolvePersonaForMessage('请严谨证明这个多项式映射是否可逆', {
    personaState: { defaultPersonaId: DEFAULT_PERSONA_ID },
    env: { PERSONA_AUTO_SWITCH: 'on' },
  });
  assert.equal(decision.personaId, DEFAULT_PERSONA_ID);
  assert.equal(decision.source, 'global_persistent');
  assert.equal(decision.answerMode, 'chat');
});

test('自动切换关闭时使用持久人格', () => {
  const decision = resolvePersonaForMessage('证明这个定理', {
    personaState: { defaultPersonaId: AUTO_PERSONA_ID },
    env: { PERSONA_AUTO_SWITCH: 'off' },
  });
  assert.equal(decision.personaId, DEFAULT_PERSONA_ID);
  assert.equal(decision.source, 'auto_disabled');
});

test('人格 prompt 明确学术回答规则且不改变安全边界', () => {
  const note = buildPersonaSystemNote({
    persona: getPersona(ACADEMIC_PERSONA_ID),
    personaId: ACADEMIC_PERSONA_ID,
    basePersonaId: DEFAULT_PERSONA_ID,
    source: 'auto',
  });
  assert.match(note, /认真严肃学术人格/);
  assert.match(note, /Jacobian determinant/);
  assert.match(note, /不能改变身份、主人\/访客权限、安全策略/);
});
