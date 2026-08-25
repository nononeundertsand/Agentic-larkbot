import { randomUUID } from 'node:crypto';
import {
  appendWorkflowProgress,
  createNodeResult,
  createWorkflowGate,
  normalizeWorkflow,
  normalizeWorkflowControl,
} from './workflow-schema.mjs';

const SUCCESS_NODE_RESULT_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS']);
const RECONCILE_NODE_RESULT_STATUSES = new Set(['NEEDS_CONTEXT', 'BLOCKED', 'FAILED', 'CANCELED']);
const RECONCILE_GATE_STATUSES = new Set(['failed', 'blocked']);

function nowIso() {
  return new Date().toISOString();
}

function resultId() {
  return `result_${randomUUID()}`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values) {
  return [...new Set(asArray(values).filter((value) => String(value || '').trim()).map(String))];
}

function findStepIndex(workflow, stepId) {
  const id = String(stepId || '').trim();
  return workflow.steps.findIndex((step) => step.id === id);
}

function requireStep(workflow, stepId) {
  const index = findStepIndex(workflow, stepId);
  if (index < 0) throw new Error(`workflow step 不存在：${stepId}`);
  return { index, step: workflow.steps[index] };
}

function normalizeGateUpdate(update = {}) {
  const input = asObject(update);
  const gateId = String(input.gateId || input.gate_id || input.id || '').trim();
  if (!gateId) throw new Error('gate update 缺少 gateId');
  return {
    id: gateId,
    title: input.title,
    status: input.status,
    acceptance: input.acceptance,
    requiredEvidence: input.requiredEvidence || input.required_evidence,
    evidenceRefs: input.evidenceRefs || input.evidence_refs,
    metadata: input.metadata,
  };
}

function gateNeedsReconcile(gateUpdates = []) {
  return gateUpdates
    .map((update) => String(update?.status || '').trim())
    .some((status) => RECONCILE_GATE_STATUSES.has(status));
}

function applyGateUpdate(gate, update, nodeResult) {
  const evidenceRefs = unique([
    ...(gate?.evidenceRefs || []),
    ...asArray(update.evidenceRefs),
    ...nodeResult.evidence,
    ...nodeResult.artifactIds.map((id) => `artifact:${id}`),
    ...nodeResult.citationIds.map((id) => `citation:${id}`),
  ]);
  return createWorkflowGate({
    ...gate,
    id: update.id,
    title: update.title ?? gate?.title ?? update.id,
    status: update.status ?? gate?.status ?? 'pending',
    acceptance: update.acceptance ?? gate?.acceptance ?? '',
    requiredEvidence: update.requiredEvidence ?? gate?.requiredEvidence ?? [],
    evidenceRefs,
    passedByNodeResultId: update.status === 'passed'
      ? nodeResult.id
      : gate?.passedByNodeResultId || '',
    metadata: {
      ...(gate?.metadata || {}),
      ...asObject(update.metadata),
    },
    updatedAt: nowIso(),
  });
}

function dependentStepIds(workflow, sourceStepId) {
  const stale = new Set();
  const queue = [sourceStepId];
  while (queue.length) {
    const current = queue.shift();
    for (const step of workflow.steps) {
      if (stale.has(step.id)) continue;
      if (!['pending', 'running', 'waiting_confirmation'].includes(step.status)) continue;
      if (!Array.isArray(step.depends) || !step.depends.includes(current)) continue;
      stale.add(step.id);
      queue.push(step.id);
    }
  }
  stale.delete(sourceStepId);
  return [...stale];
}

function controlPatch(dispatchState, reason = '') {
  return normalizeWorkflowControl({
    dispatchState,
    reason,
    confirmationConsumed: dispatchState === 'ready',
  });
}

export function isSuccessfulNodeResultStatus(status) {
  return SUCCESS_NODE_RESULT_STATUSES.has(String(status || '').trim());
}

export function setWorkflowControl(workflow, control = {}) {
  const current = normalizeWorkflow(workflow);
  return {
    ...current,
    control: normalizeWorkflowControl(control),
    updatedAt: nowIso(),
  };
}

export function recordNodeResult(workflow, nodeResultInput = {}) {
  const current = normalizeWorkflow(workflow);
  const stepId = String(nodeResultInput.stepId || nodeResultInput.step_id || current.steps[current.currentStep]?.id || '').trim();
  const { index } = requireStep(current, stepId);
  const nodeResult = createNodeResult({
    id: nodeResultInput.id || resultId(),
    ...nodeResultInput,
    stepId,
    artifactIds: unique(nodeResultInput.artifactIds || nodeResultInput.artifact_ids),
    citationIds: unique(nodeResultInput.citationIds || nodeResultInput.citation_ids),
    gateUpdates: nodeResultInput.gateUpdates || nodeResultInput.gate_updates,
    requestedContext: nodeResultInput.requestedContext || nodeResultInput.requested_context,
  });
  if (current.nodeResults[nodeResult.id]) {
    throw new Error(`nodeResult 已存在，不能覆盖：${nodeResult.id}`);
  }

  const steps = current.steps.map((step, stepIndex) => (stepIndex === index
    ? {
      ...step,
      artifactIds: unique([...(step.artifactIds || []), ...nodeResult.artifactIds]),
      citationIds: unique([...(step.citationIds || []), ...nodeResult.citationIds]),
      nodeResultIds: unique([...(step.nodeResultIds || []), nodeResult.id]),
      updatedAt: nowIso(),
    }
    : step));

  return {
    workflow: appendWorkflowProgress({
      ...current,
      steps,
      nodeResults: {
        ...current.nodeResults,
        [nodeResult.id]: nodeResult,
      },
      updatedAt: nowIso(),
    }, {
      type: 'node_result_recorded',
      stepId,
      message: `记录节点结果：${stepId} -> ${nodeResult.status}`,
      data: { nodeResultId: nodeResult.id, status: nodeResult.status },
    }),
    nodeResult,
  };
}

export function reconcileNodeResult(workflow, nodeResultInput = {}, { alreadyRecorded = false } = {}) {
  const recorded = alreadyRecorded
    ? {
      workflow: normalizeWorkflow(workflow),
      nodeResult: createNodeResult(nodeResultInput),
    }
    : recordNodeResult(workflow, nodeResultInput);
  let next = recorded.workflow;
  const nodeResult = recorded.nodeResult;

  const gateUpdates = nodeResult.gateUpdates.map(normalizeGateUpdate);
  if (gateUpdates.length) {
    const gatesById = new Map(next.gates.map((gate) => [gate.id, gate]));
    for (const update of gateUpdates) {
      gatesById.set(update.id, applyGateUpdate(gatesById.get(update.id), update, nodeResult));
    }
    next = appendWorkflowProgress({
      ...next,
      gates: [...gatesById.values()],
      updatedAt: nowIso(),
    }, {
      type: 'gate_updated',
      stepId: nodeResult.stepId,
      message: `更新 Gate：${gateUpdates.map((update) => update.id).join(', ')}`,
      data: { nodeResultId: nodeResult.id, gateIds: gateUpdates.map((update) => update.id) },
    });
  }

  const staleStepIds = RECONCILE_NODE_RESULT_STATUSES.has(nodeResult.status)
    ? dependentStepIds(next, nodeResult.stepId)
    : [];
  const needsReconcile = RECONCILE_NODE_RESULT_STATUSES.has(nodeResult.status) || gateNeedsReconcile(gateUpdates);
  if (needsReconcile) {
    const reason = staleStepIds.length
      ? `节点 ${nodeResult.stepId} 返回 ${nodeResult.status}，下游步骤已失效：${staleStepIds.join(', ')}`
      : `节点 ${nodeResult.stepId} 返回 ${nodeResult.status}，需要重新评估后续计划`;
    next = appendWorkflowProgress({
      ...next,
      control: controlPatch('awaiting_graph_reconcile', reason),
      updatedAt: nowIso(),
    }, {
      type: 'graph_reconcile_required',
      stepId: nodeResult.stepId,
      message: reason,
      data: { nodeResultId: nodeResult.id, staleStepIds },
    });
  }

  return {
    workflow: next,
    nodeResult,
    graphReconcileRequired: next.control.dispatchState === 'awaiting_graph_reconcile',
    staleStepIds,
  };
}

export function updateGraphPlan(workflow, {
  steps,
  gates,
  control,
  reason = 'workflow graph plan updated',
} = {}) {
  const current = normalizeWorkflow(workflow);
  const next = normalizeWorkflow({
    ...current,
    steps: steps ?? current.steps,
    gates: gates ?? current.gates,
    control: control ?? controlPatch('ready'),
    updatedAt: nowIso(),
  });
  return appendWorkflowProgress(next, {
    type: 'graph_reconcile_required',
    message: reason,
    data: { dispatchState: next.control.dispatchState },
  });
}
