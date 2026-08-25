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
  formatWorkflowProgressMessage,
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
    const progressMessages = [];
    const message = await executeWorkflowApproval(decision.action, {
      stateStore,
      progressSink: (event, workflow) => {
        const text = formatWorkflowProgressMessage(event, workflow);
        if (text) progressMessages.push(text);
      },
    });
    assert.match(message, /工作流已完成/);
    assert.ok(progressMessages.some((text) => text.includes('已完成：2/3 确认继续')));
    assert.ok(progressMessages.some((text) => text.includes('正在执行：3/3 检查结果')));
    assert.ok(progressMessages.some((text) => text.includes('工作流已完成：确认后继续')));
    const stored = stateStore.getWorkflow(result.workflowId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.steps[1].output.confirmed, true);
    assert.equal(stored.steps[2].status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start_workflow 的 doc_report 类型会自动使用 W2 默认 worker', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    let pending = null;
    const result = await executeTool('start_workflow', {
      title: '文档报告',
      user_goal: '请总结 https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh 并生成带引用报告',
      workflow_type: 'doc_report',
      target_chars: 800,
    }, {
      isOwner: true,
      senderId: 'ou_owner',
      chatId: 'oc_group',
      sessionKey: 'g:oc_group:ou_owner',
      stateStore,
      docReportDeps: {
        readSource: async () => ({ ok: true, text: '文档说明复杂任务需要 workflow、Gate、NodeResult、引用和确认。' }),
        generateReport: async ({ chunks }) => ({
          content: `# 文档报告\n\n## 摘要\n- 复杂任务需要 workflow、Gate、NodeResult、引用和确认。 [${chunks[0].citationId}]\n\n## 引用来源\n- [${chunks[0].citationId}] ${chunks[0].sourceTitle}`,
          claims: [{ text: '复杂任务需要 workflow', citationIds: [chunks[0].citationId] }],
          citationIds: [chunks[0].citationId],
        }),
        createDocument: async () => ({
          ok: true,
          url: 'https://bytedance.larkoffice.com/docx/docx_report',
          token: 'docx_report',
        }),
      },
      registerPendingWrite(action) {
        pending = action;
      },
    });

    assert.equal(result.needConfirm, true);
    assert.equal(pending.executor, 'workflow');
    assert.match(pending.preview, /报告草稿预览/);
    assert.match(pending.preview, /https:\/\/bytedance\.larkoffice\.com\/docx\/docx_report/);
    assert.match(pending.preview, /复杂任务需要 workflow/);
    const stored = stateStore.getWorkflow(result.workflowId);
    assert.equal(stored.type, 'doc_report');
    assert.equal(stored.steps.map((step) => step.id).join('>'), 'extract_sources>read_documents>chunk_documents>draft_report>verify_citations>create_report_document>confirm_delivery>send_or_save');
    assert.equal(stored.gates.length, 6);
    assert.equal(stored.metadata.deliveryChatId, 'oc_group');
    assert.ok(stored.artifacts.report_draft);
    assert.equal(stored.artifacts.report_document.content.url, 'https://bytedance.larkoffice.com/docx/docx_report');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow 进度事件会格式化为可观察状态', () => {
  const workflow = {
    workflowId: 'wf_1',
    title: '整理资料',
    steps: [
      { id: 'read', title: '读取文档', status: 'running' },
      { id: 'write', title: '生成报告', status: 'pending' },
    ],
    gates: [{ id: 'gate_citations', title: '引用完整', status: 'pending' }],
  };

  assert.match(
    formatWorkflowProgressMessage({ type: 'step_started', stepId: 'read', message: '开始：读取文档' }, workflow),
    /正在执行：1\/2 读取文档/,
  );
  assert.match(
    formatWorkflowProgressMessage({ type: 'completion_blocked', message: 'Gate 未通过' }, workflow),
    /工作流暂未完成/,
  );
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

test('doc_report 默认重试会从 extract_sources 重新开始', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const ctx = {
      isOwner: true,
      senderId: 'ou_owner',
      chatId: 'oc_group',
      sessionKey: 'g:oc_group:ou_owner',
      stateStore,
      docReportDeps: {
        readSource: async () => ({ ok: false, error: '临时读取失败' }),
      },
    };
    const started = await executeTool('start_workflow', {
      title: '文档报告',
      user_goal: '请总结 https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh',
      workflow_type: 'doc_report',
    }, ctx);
    assert.equal(started.ok, false);
    const blocked = stateStore.getWorkflow(started.workflow.workflowId);
    assert.equal(blocked.steps.find((step) => step.id === 'read_documents').status, 'failed');

    let retryPending = null;
    const retried = await executeTool('workflow_retry', {
      workflow_id: blocked.workflowId,
      reason: '重新解析来源后重试',
    }, {
      ...ctx,
      docReportDeps: {
        readSource: async () => ({ ok: true, text: '重试后读取成功，报告需要引用和确认。' }),
        generateReport: async ({ chunks }) => ({
          content: `# 报告\n\n- 重试后读取成功。 [${chunks[0].citationId}]\n\n## 引用来源\n- [${chunks[0].citationId}] ${chunks[0].sourceTitle}`,
          claims: [{ text: '重试后读取成功', citationIds: [chunks[0].citationId] }],
          citationIds: [chunks[0].citationId],
        }),
        createDocument: async () => ({
          ok: true,
          url: 'https://bytedance.larkoffice.com/docx/docx_retry',
          token: 'docx_retry',
        }),
      },
      registerPendingWrite(action) {
        retryPending = action;
      },
    });

    assert.equal(retried.needConfirm, true);
    assert.equal(retryPending.executor, 'workflow');
    assert.match(retried.message, /报告草稿预览/);
    assert.match(retried.message, /https:\/\/bytedance\.larkoffice\.com\/docx\/docx_retry/);
    const stored = stateStore.getWorkflow(blocked.workflowId);
    assert.equal(stored.steps.find((step) => step.id === 'extract_sources').retryCount, 1);
    assert.equal(stored.steps.find((step) => step.id === 'read_documents').status, 'completed');
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
