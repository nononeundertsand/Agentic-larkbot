import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RuntimeStateStore } from '../src/state-store.mjs';
import { createWorkflow } from '../src/workflow.mjs';
import { createWorkflowRunner } from '../src/workflow-runner.mjs';
import {
  DOC_REPORT_GATES,
  REPORT_DRAFT_ARTIFACT_ID,
  REPORT_DOCUMENT_ARTIFACT_ID,
  createDocReportHandlers,
  defaultDocReportGates,
  defaultDocReportSteps,
} from '../src/workflows/doc-report.mjs';

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-doc-report-'));
  return { dir, file: join(dir, 'state.json') };
}

function createDocReportWorkflow(overrides = {}) {
  return createWorkflow({
    title: '复杂任务资料总结',
    type: 'doc_report',
    userGoal:
      '帮我总结这几个飞书文档，生成带引用报告并发群里：' +
      'https://bytetech.info/articles/7654024985686016040#doxcnJ2BghGgHIIKKQlax7sxkbf ' +
      'https://bytedance.larkoffice.com/wiki/LpxGwSMfDiZwAkkztg2crzoPnQh',
    steps: defaultDocReportSteps(),
    gates: defaultDocReportGates(),
    metadata: { deliveryChatId: 'oc_group', ...overrides.metadata },
    ...overrides,
  });
}

test('doc_report workflow 可读取、生成带引用报告、确认后发送', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const sent = [];
    const workflow = createDocReportWorkflow();
    stateStore.saveWorkflow(workflow);
    const handlers = createDocReportHandlers({
      readSource: async (source) => ({
        ok: true,
        title: source.title || source.token,
        text:
          `${sourceLabelForTest(source)} 提出 Agent Harness 需要 durable workflow、任务图、Gate、NodeResult 和人工确认。` +
          '系统应先收集证据，再输出报告，并且在发送前等待确认。' +
          '长任务需要可恢复状态、进度反馈、失败记录和引用追踪。',
      }),
      generateReport: async ({ chunks }) => ({
        content: [
          '# 复杂任务资料总结',
          '',
          '## 摘要',
          `- 两份材料都强调复杂任务不能只依赖单轮聊天，需要把执行过程落成可恢复状态。 [${chunks[0].citationId}]`,
          `- 报告型任务必须把结论绑定到来源引用，防止生成不可审计的短摘要。 [${chunks[1].citationId}]`,
          '',
          '## 关键结论',
          `- 应优先建设 durable workflow、Gate 和 NodeResult，再接入具体业务 worker。 [${chunks[0].citationId}]`,
          `- 用户确认、进度反馈和引用覆盖检查是长任务可用性的必要条件。 [${chunks[1].citationId}]`,
          '',
          '## 风险与待跟进',
          `- 如果只截取前几千字，报告会过度凝练并漏掉上下文。 [${chunks[0].citationId}]`,
          '',
          '## 引用来源',
          `- [${chunks[0].citationId}] ${chunks[0].sourceTitle}`,
          `- [${chunks[1].citationId}] ${chunks[1].sourceTitle}`,
        ].join('\n'),
        claims: [
          { text: '复杂任务需要可恢复状态', citationIds: [chunks[0].citationId] },
          { text: '报告型任务必须引用覆盖', citationIds: [chunks[1].citationId] },
        ],
        citationIds: [chunks[0].citationId, chunks[1].citationId],
      }),
      createDocument: async ({ report }) => ({
        ok: true,
        title: '复杂任务资料总结',
        url: 'https://bytedance.larkoffice.com/docx/docx_report_token',
        token: 'docx_report_token',
        revisionId: 1,
        raw: { chars: report.content.length },
      }),
      sendMarkdown: async ({ chatId, markdown }) => {
        sent.push({ chatId, markdown });
        return { ok: true };
      },
    });
    const runner = createWorkflowRunner({ stateStore, handlers });

    const waiting = await runner.run(workflow.workflowId);
    assert.equal(waiting.status, 'waiting_confirmation');
    assert.equal(sent.length, 0);
    assert.equal(waiting.workflow.artifacts[REPORT_DRAFT_ARTIFACT_ID].type, 'report');
    assert.equal(waiting.workflow.artifacts[REPORT_DOCUMENT_ARTIFACT_ID].type, 'lark_doc');
    assert.equal(waiting.workflow.artifacts[REPORT_DOCUMENT_ARTIFACT_ID].content.url, 'https://bytedance.larkoffice.com/docx/docx_report_token');
    assert.match(waiting.workflow.artifacts[REPORT_DRAFT_ARTIFACT_ID].content, /\[cite_source_1_1\]/);
    assert.equal(waiting.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.sourcesIdentified).status, 'passed');
    assert.equal(waiting.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.documentsRead).status, 'passed');
    assert.equal(waiting.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.reportCitations).status, 'passed');
    assert.equal(waiting.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.reportDocumentCreated).status, 'passed');
    assert.equal(waiting.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.deliveryConfirmed).status, 'pending');

    const completed = await runner.confirm(workflow.workflowId, { token: waiting.workflow.resumeToken });
    assert.equal(completed.status, 'completed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 'oc_group');
    assert.match(sent[0].markdown, /https:\/\/bytedance\.larkoffice\.com\/docx\/docx_report_token/);
    assert.equal(completed.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.deliveryConfirmed).status, 'passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc_report 缺链接时进入 graph reconcile，不会误报完成', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const workflow = createDocReportWorkflow({ userGoal: '帮我总结这几份文档，但暂时没有链接' });
    stateStore.saveWorkflow(workflow);
    const runner = createWorkflowRunner({
      stateStore,
      handlers: createDocReportHandlers({ readSource: async () => ({ ok: true, text: '不应读取' }) }),
    });

    const result = await runner.run(workflow.workflowId);

    assert.equal(result.status, 'awaiting_graph_reconcile');
    assert.equal(result.workflow.steps[0].status, 'failed');
    assert.equal(result.workflow.control.dispatchState, 'awaiting_graph_reconcile');
    assert.match(result.workflow.control.reason, /NEEDS_CONTEXT/);
    assert.equal(result.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.sourcesIdentified).status, 'blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc_report 部分来源读取失败会记录失败证据并继续生成草稿', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const workflow = createDocReportWorkflow();
    stateStore.saveWorkflow(workflow);
    const runner = createWorkflowRunner({
      stateStore,
      handlers: createDocReportHandlers({
        readSource: async (source) => (source.id === 'source_1'
          ? { ok: true, text: '第一份文档说明 W2 要保留 citation 并在发送前确认。' }
          : { ok: false, error: '无权限' }),
        createDocument: async () => ({
          ok: true,
          url: 'https://bytedance.larkoffice.com/docx/docx_partial',
          token: 'docx_partial',
        }),
        sendMarkdown: async () => ({ ok: true }),
      }),
    });

    const result = await runner.run(workflow.workflowId);

    assert.equal(result.status, 'waiting_confirmation');
    assert.ok(result.workflow.artifacts.doc_read_failures);
    assert.equal(result.workflow.artifacts.doc_read_failures.content.failures[0].error, '无权限');
    const readStep = result.workflow.steps.find((step) => step.id === 'read_documents');
    const readResult = result.workflow.nodeResults[readStep.nodeResultIds.at(-1)];
    assert.equal(readResult.status, 'DONE_WITH_CONCERNS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc_report 引用缺失会被 Gate 阻止完成', async () => {
  const { dir, file } = tempState();
  try {
    const stateStore = new RuntimeStateStore({ file });
    const workflow = createDocReportWorkflow();
    stateStore.saveWorkflow(workflow);
    const runner = createWorkflowRunner({
      stateStore,
      handlers: createDocReportHandlers({
        readSource: async () => ({
          ok: true,
          text: '文档说明复杂长任务要有分块、引用和确认。',
        }),
        generateReport: async () => ({
          content: '# 报告\n\n- 这里是一条没有引用的关键结论。',
          claims: [{ text: '没有引用的关键结论', citationIds: [] }],
          citationIds: [],
        }),
      }),
    });

    const result = await runner.run(workflow.workflowId);

    assert.equal(result.status, 'awaiting_graph_reconcile');
    assert.equal(result.workflow.gates.find((gate) => gate.id === DOC_REPORT_GATES.reportCitations).status, 'failed');
    assert.equal(result.workflow.steps.find((step) => step.id === 'verify_citations').status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sourceLabelForTest(source = {}) {
  return source.title || source.token || source.url || source.id;
}
