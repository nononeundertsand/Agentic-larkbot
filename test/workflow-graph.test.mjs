import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkflow } from '../src/workflow.mjs';
import {
  reconcileNodeResult,
  recordNodeResult,
  updateGraphPlan,
} from '../src/workflow-graph.mjs';

test('recordNodeResult 会追加节点结果并关联到 step，且不覆盖历史', () => {
  const workflow = createWorkflow({
    steps: [{ id: 'read', type: 'tool', title: '读取文档' }],
  });

  const recorded = recordNodeResult(workflow, {
    id: 'result_read_1',
    stepId: 'read',
    status: 'DONE',
    summary: '读取完成',
    artifactIds: ['artifact_1'],
    citationIds: ['citation_1'],
  });

  assert.equal(recorded.workflow.nodeResults.result_read_1.summary, '读取完成');
  assert.deepEqual(recorded.workflow.steps[0].nodeResultIds, ['result_read_1']);
  assert.deepEqual(recorded.workflow.steps[0].artifactIds, ['artifact_1']);
  assert.deepEqual(recorded.workflow.steps[0].citationIds, ['citation_1']);
  assert.throws(() => recordNodeResult(recorded.workflow, {
    id: 'result_read_1',
    stepId: 'read',
    status: 'DONE',
  }), /不能覆盖/);
});

test('reconcileNodeResult 会根据 gateUpdates 更新 Gate 证据', () => {
  const workflow = createWorkflow({
    steps: [{ id: 'verify', type: 'verify', title: '检查引用', gateIds: ['gate_citations'] }],
    gates: [{ id: 'gate_citations', title: '引用完整', requiredEvidence: ['citation_coverage'] }],
  });

  const reconciled = reconcileNodeResult(workflow, {
    id: 'result_verify',
    stepId: 'verify',
    status: 'DONE',
    citationIds: ['citation_1'],
    gateUpdates: [{ gateId: 'gate_citations', status: 'passed', evidenceRefs: ['citation:coverage'] }],
  });

  assert.equal(reconciled.graphReconcileRequired, false);
  assert.equal(reconciled.workflow.gates[0].status, 'passed');
  assert.equal(reconciled.workflow.gates[0].passedByNodeResultId, 'result_verify');
  assert.ok(reconciled.workflow.gates[0].evidenceRefs.includes('citation:coverage'));
  assert.ok(reconciled.workflow.gates[0].evidenceRefs.includes('citation:citation_1'));
});

test('失败 NodeResult 会识别依赖它的下游步骤并进入 awaiting_graph_reconcile', () => {
  const workflow = createWorkflow({
    steps: [
      { id: 'read', type: 'tool', title: '读取文档' },
      { id: 'write', type: 'transform', title: '写报告', depends: ['read'] },
      { id: 'send', type: 'send', title: '发送报告', depends: ['write'] },
    ],
  });

  const reconciled = reconcileNodeResult(workflow, {
    id: 'result_read_failed',
    stepId: 'read',
    status: 'FAILED',
    summary: '读取失败',
  });

  assert.equal(reconciled.graphReconcileRequired, true);
  assert.deepEqual(reconciled.staleStepIds, ['write', 'send']);
  assert.equal(reconciled.workflow.control.dispatchState, 'awaiting_graph_reconcile');
  assert.match(reconciled.workflow.control.reason, /write, send/);
});

test('updateGraphPlan 可清除 reconcile barrier 并保留历史 NodeResult', () => {
  const workflow = reconcileNodeResult(createWorkflow({
    steps: [
      { id: 'read', type: 'tool', title: '读取文档' },
      { id: 'write', type: 'transform', title: '写报告', depends: ['read'] },
    ],
  }), {
    id: 'result_read_blocked',
    stepId: 'read',
    status: 'BLOCKED',
    summary: '缺权限',
  }).workflow;

  const updated = updateGraphPlan(workflow, {
    steps: [
      { id: 'read', type: 'tool', title: '读取文档', status: 'failed', nodeResultIds: ['result_read_blocked'] },
      { id: 'ask_permission', type: 'confirm', title: '申请权限' },
    ],
  });

  assert.equal(updated.control.dispatchState, 'ready');
  assert.equal(updated.nodeResults.result_read_blocked.status, 'BLOCKED');
  assert.equal(updated.steps[1].id, 'ask_permission');
});

