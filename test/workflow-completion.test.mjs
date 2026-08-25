import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkflow } from '../src/workflow.mjs';
import { evaluateWorkflowCompletion } from '../src/workflow-completion.mjs';
import { reconcileNodeResult } from '../src/workflow-graph.mjs';

test('Gate 未通过时 completion evaluation 会阻止完成', () => {
  const workflow = createWorkflow({
    steps: [{ id: 'verify', type: 'verify', title: '检查引用', status: 'completed' }],
    gates: [{ id: 'gate_citations', title: '引用完整', status: 'pending', requiredEvidence: ['citation_coverage'] }],
  });

  const verdict = evaluateWorkflowCompletion(workflow);
  assert.equal(verdict.canCompleteWorkflow, false);
  assert.equal(verdict.nextAction, 'reconcile');
  assert.equal(verdict.blockers.some((item) => item.code === 'gate_not_passed'), true);
});

test('Gate 已通过但缺 required evidence 时仍不能完成', () => {
  const workflow = createWorkflow({
    steps: [{ id: 'verify', type: 'verify', title: '检查引用', status: 'completed' }],
    gates: [{ id: 'gate_citations', title: '引用完整', status: 'passed', requiredEvidence: ['citation_coverage'] }],
  });

  const verdict = evaluateWorkflowCompletion(workflow);
  assert.equal(verdict.canClaimComplete, false);
  assert.equal(verdict.blockers.some((item) => item.code === 'gate_missing_evidence'), true);
});

test('步骤完成、Gate 通过且证据存在时允许完成', () => {
  const base = createWorkflow({
    type: 'doc_report',
    steps: [{ id: 'verify', type: 'verify', title: '检查引用', status: 'completed' }],
    gates: [{ id: 'gate_citations', title: '引用完整', status: 'pending', requiredEvidence: ['citation_coverage'] }],
    citations: {
      c1: { id: 'c1', type: 'doc', title: '文档', sourceId: 'doc', quote: '证据' },
    },
    artifacts: {
      report: { id: 'report', type: 'report', title: '报告', content: '结论', citationIds: ['c1'], metadata: {}, createdByStepId: 'verify', createdAt: 'now' },
    },
  });
  const workflow = reconcileNodeResult(base, {
    id: 'result_verify',
    stepId: 'verify',
    status: 'DONE',
    citationIds: ['c1'],
    gateUpdates: [{ gateId: 'gate_citations', status: 'passed', evidenceRefs: ['citation:c1'] }],
  }).workflow;

  const verdict = evaluateWorkflowCompletion(workflow);
  assert.equal(verdict.canCompleteWorkflow, true);
  assert.deepEqual(verdict.blockers, []);
});

test('报告型 workflow 的 report artifact 缺 citation 会阻止完成', () => {
  const workflow = createWorkflow({
    type: 'doc_report',
    steps: [{ id: 'write', type: 'transform', title: '写报告', status: 'completed' }],
    gates: [{ id: 'gate_report', title: '报告完成', status: 'passed', evidenceRefs: ['artifact:report'] }],
    artifacts: {
      report: { id: 'report', type: 'report', title: '报告', content: '结论', citationIds: [], metadata: {}, createdByStepId: 'write', createdAt: 'now' },
    },
  });

  const verdict = evaluateWorkflowCompletion(workflow);
  assert.equal(verdict.canCompleteWorkflow, false);
  assert.equal(verdict.blockers.some((item) => item.code === 'report_artifact_missing_citations'), true);
});

