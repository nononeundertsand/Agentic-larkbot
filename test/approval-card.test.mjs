import test from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalStore } from '../src/approval.mjs';
import {
  APPROVAL_CARD_ACTION,
  buildApprovalCard,
  buildApprovalStatusCard,
  buildWorkflowStatusCard,
  extractApprovalActionPayload,
  parseApprovalActionValue,
} from '../src/approval-card.mjs';

const action = {
  id: 'act_1',
  toolName: 'task_create',
  executor: 'lark',
  args: ['task', '+create', '--summary', '复盘'],
  preview: '将创建任务：「复盘」\n确认码：ABC123\n请回复「确认 ABC123」执行，或「取消」放弃。',
  confirmToken: 'ABC123',
  confirmationKey: 'p:owner',
  at: Date.now(),
};

test('确认卡片包含确认/取消按钮且 payload 不携带真实命令', () => {
  const card = buildApprovalCard(action, { ttlMs: 300000 });
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.enable_forward, false);
  const buttons = card.body.elements.filter((item) => item.tag === 'button');
  assert.equal(buttons.length, 2);

  const confirmValue = buttons[0].behaviors[0].value;
  assert.deepEqual(confirmValue, {
    source: APPROVAL_CARD_ACTION,
    version: 1,
    decision: 'confirm',
    confirmationKey: 'p:owner',
    actionId: 'act_1',
    confirmToken: 'ABC123',
  });
  assert.equal(JSON.stringify(confirmValue).includes('task'), false);
  assert.equal(buttons[1].behaviors[0].value.decision, 'cancel');
});

test('卡片 action_value 可解析并驱动审批状态机执行', () => {
  const store = new ApprovalStore({ ttlMs: 10000 });
  store.register('p:owner', action);
  const payload = parseApprovalActionValue(JSON.stringify({
    source: APPROVAL_CARD_ACTION,
    decision: 'confirm',
    confirmationKey: 'p:owner',
    actionId: 'act_1',
    confirmToken: 'ABC123',
  }));

  const denied = store.resolveAction('p:owner', payload, { isOwner: false });
  assert.equal(denied.kind, 'unauthorized');
  assert.equal(store.size(), 1);

  const accepted = store.resolveAction('p:owner', payload, { isOwner: true });
  assert.equal(accepted.kind, 'execute');
  assert.equal(accepted.action.id, 'act_1');
  assert.equal(store.size(), 0);
});

test('按钮取消会清理 pending action，错配 payload 不会执行', () => {
  const store = new ApprovalStore({ ttlMs: 10000 });
  store.register('p:owner', action);
  const mismatch = store.resolveAction('p:owner', {
    decision: 'confirm',
    actionId: 'other',
    confirmToken: 'ABC123',
  }, { isOwner: true });
  assert.equal(mismatch.kind, 'mismatch');
  assert.equal(store.size(), 1);

  const canceled = store.resolveAction('p:owner', {
    decision: 'cancel',
    actionId: 'act_1',
    confirmToken: 'ABC123',
  }, { isOwner: true });
  assert.equal(canceled.kind, 'cancel');
  assert.equal(store.size(), 0);
});

test('状态卡片会禁用交互并展示处理结果', () => {
  const card = buildApprovalStatusCard(action, { status: 'success', detail: '已执行。' });
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'green');
  assert.equal(card.body.elements.some((item) => JSON.stringify(item).includes('确认执行')), false);
  assert.match(JSON.stringify(card), /已执行/);
});

test('状态卡片支持执行中反馈', () => {
  const card = buildApprovalStatusCard(action, { status: 'running', detail: '已确认，正在执行该操作。' });
  assert.equal(card.header.template, 'blue');
  assert.match(JSON.stringify(card), /执行中/);
  assert.match(JSON.stringify(card), /正在执行/);
});

test('工作流状态卡片展示任务进度', () => {
  const card = buildWorkflowStatusCard({
    workflowId: 'wf_1',
    title: '文档报告',
    status: 'running',
    currentStep: 1,
    steps: [
      { id: 'read', title: '读取文档', status: 'completed' },
      { id: 'draft', title: '生成报告', status: 'running' },
    ],
    gates: [{ id: 'gate_doc', title: '文档已读取', status: 'passed' }],
  }, { event: { type: 'step_started', message: '开始：生成报告' } });

  const serialized = JSON.stringify(card);
  assert.equal(card.header.template, 'blue');
  assert.match(serialized, /工作流执行中/);
  assert.match(serialized, /步骤 1\/2/);
  assert.match(serialized, /生成报告/);
});

test('卡片事件 payload 支持多种嵌套形态', () => {
  const payload = extractApprovalActionPayload({
    data: {
      event: {
        action: {
          value: {
            source: APPROVAL_CARD_ACTION,
            decision: 'confirm',
            confirmationKey: 'p:owner',
            actionId: 'act_1',
            confirmToken: 'ABC123',
          },
        },
      },
    },
  });

  assert.deepEqual(payload, {
    decision: 'confirm',
    confirmationKey: 'p:owner',
    actionId: 'act_1',
    confirmToken: 'ABC123',
  });
});
