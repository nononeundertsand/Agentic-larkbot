import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ApprovalStore } from '../src/approval.mjs';
import { RuntimeStateStore } from '../src/state-store.mjs';
import { executeTool } from '../src/tools.mjs';
import {
  cancelWorkflowApproval,
  executeWorkflowApproval,
} from '../src/workflow-control.mjs';

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-workflow-tools-'));
  return { dir, file: join(dir, 'state.json') };
}

test('start_workflow 可创建并完成无确认的持久 workflow', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const result = await executeTool('start_workflow', {
      title: '整理资料',
      user_goal: '整理材料并输出结论',
      workflow_type: 'generic',
      steps: [
        { id: 'plan', type: 'plan', title: '拆步骤' },
        { id: 'verify', type: 'verify', title: '检查结果' },
      ],
    }, {
      isOwner: true,
      senderId: 'ou_owner',
      sessionKey: 'p:ou_owner',
      stateStore,
    });

    assert.equal(result.ok, true);
    assert.equal(result.workflow.status, 'completed');
    const stored = stateStore.getWorkflow(result.workflow.workflowId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.sessionKey, 'p:ou_owner');
    assert.ok(stored.progressEvents.some((event) => event.type === 'completed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start_workflow 遇到 confirm step 会登记 workflow 审批，确认后继续完成', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const approvals = new ApprovalStore({ ttlMs: 10000, stateStore });
    let pending = null;
    const result = await executeTool('start_workflow', {
      title: '确认后继续',
      user_goal: '生成草稿，确认后继续',
      steps: [
        { id: 'draft', type: 'transform', title: '生成草稿', input: { text: 'draft' } },
        { id: 'confirm', type: 'confirm', title: '确认继续', input: { message: '是否继续执行后续步骤' } },
        { id: 'verify', type: 'verify', title: '检查结果' },
      ],
    }, {
      isOwner: true,
      senderId: 'ou_owner',
      sessionKey: 'p:ou_owner',
      stateStore,
      registerPendingWrite(action) {
        pending = approvals.register('p:ou_owner', action);
      },
    });

    assert.equal(result.needConfirm, true);
    assert.equal(pending.executor, 'workflow');
    assert.equal(pending.workflow.workflowId, result.workflowId);
    assert.equal(stateStore.getWorkflow(result.workflowId).status, 'waiting_confirmation');

    const decision = approvals.resolve('p:ou_owner', `确认 ${pending.confirmToken}`, { isOwner: true });
    assert.equal(decision.kind, 'execute');
    const message = await executeWorkflowApproval(decision.action, { stateStore });
    assert.match(message, /工作流已完成/);
    const stored = stateStore.getWorkflow(result.workflowId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.steps[1].output.confirmed, true);
    assert.equal(stored.steps[2].status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow 审批取消会把等待中的 workflow 标记为 canceled', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const approvals = new ApprovalStore({ ttlMs: 10000, stateStore });
    let pending = null;
    const result = await executeTool('start_workflow', {
      title: '可取消任务',
      user_goal: '等待确认后继续',
      require_confirmation: true,
      confirmation_message: '是否继续',
    }, {
      isOwner: true,
      senderId: 'ou_owner',
      sessionKey: 'p:ou_owner',
      stateStore,
      registerPendingWrite(action) {
        pending = approvals.register('p:ou_owner', action);
      },
    });

    assert.equal(result.needConfirm, true);
    assert.equal(pending.executor, 'workflow');
    const decision = approvals.resolve('p:ou_owner', '取消', { isOwner: true });
    assert.equal(decision.kind, 'cancel');
    const message = await cancelWorkflowApproval(decision.action, { stateStore });
    assert.match(message, /工作流已取消/);
    assert.equal(stateStore.getWorkflow(result.workflowId).status, 'canceled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow_status 可按当前会话列出最近 workflow', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const ctx = {
      isOwner: true,
      senderId: 'ou_owner',
      sessionKey: 'p:ou_owner',
      stateStore,
    };
    const first = await executeTool('start_workflow', {
      title: '会话内任务',
      user_goal: '记录一个会话内任务',
    }, ctx);
    await executeTool('start_workflow', {
      title: '其它会话任务',
      user_goal: '记录一个其它会话任务',
    }, {
      ...ctx,
      sessionKey: 'p:other',
    });

    const listed = await executeTool('workflow_status', { limit: 10 }, ctx);
    assert.equal(listed.count, 1);
    assert.equal(listed.workflows[0].workflowId, first.workflow.workflowId);

    const single = await executeTool('workflow_status', { workflow_id: first.workflow.workflowId }, ctx);
    assert.match(single.detail, /会话内任务/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
