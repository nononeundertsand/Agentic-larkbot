import { normalizeWorkflow } from './workflow-schema.mjs';
import { isSuccessfulNodeResultStatus } from './workflow-graph.mjs';

const BLOCKING_STEP_STATUSES = new Set(['pending', 'running', 'waiting_confirmation', 'failed']);
const REPORT_WORKFLOW_TYPES = new Set(['doc_report', 'material_review', 'data_analysis']);

function blocker(code, message, extra = {}) {
  return { code, message, ...extra };
}

function warning(code, message, extra = {}) {
  return { code, message, ...extra };
}

function gateRequired(gate) {
  return gate?.metadata?.required !== false;
}

function latestNodeResultForStep(workflow, step) {
  const ids = Array.isArray(step.nodeResultIds) ? step.nodeResultIds : [];
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const result = workflow.nodeResults[ids[index]];
    if (result) return result;
  }
  return null;
}

function stepBlockers(workflow) {
  const blockers = [];
  for (const step of workflow.steps) {
    if (BLOCKING_STEP_STATUSES.has(step.status)) {
      blockers.push(blocker('step_not_terminal', `步骤未完成：${step.id} (${step.status})`, { stepIds: [step.id] }));
      continue;
    }
    const latest = latestNodeResultForStep(workflow, step);
    if (latest && !isSuccessfulNodeResultStatus(latest.status)) {
      blockers.push(blocker(
        'node_result_unresolved',
        `步骤 ${step.id} 的最新节点结果未解决：${latest.status}`,
        { stepIds: [step.id], nodeResultIds: [latest.id] },
      ));
    }
  }
  return blockers;
}

function controlBlockers(workflow) {
  const state = workflow.control?.dispatchState || 'ready';
  if (state === 'ready') return [];
  const code = state === 'awaiting_user_confirmation'
    ? 'awaiting_user_confirmation'
    : state === 'awaiting_graph_reconcile'
      ? 'awaiting_graph_reconcile'
      : 'control_not_ready';
  return [blocker(code, workflow.control?.reason || `workflow control is ${state}`)];
}

function gateBlockers(workflow) {
  const blockers = [];
  for (const gate of workflow.gates) {
    if (!gateRequired(gate)) continue;
    if (gate.status !== 'passed') {
      blockers.push(blocker('gate_not_passed', `Gate 未通过：${gate.id} (${gate.status})`, { gateIds: [gate.id] }));
      continue;
    }
    if (gate.requiredEvidence.length > 0 && gate.evidenceRefs.length === 0) {
      blockers.push(blocker('gate_missing_evidence', `Gate 缺少证据：${gate.id}`, { gateIds: [gate.id] }));
    }
  }
  return blockers;
}

function reportArtifactBlockers(workflow) {
  if (!REPORT_WORKFLOW_TYPES.has(workflow.type)) return [];
  const blockers = [];
  for (const artifact of Object.values(workflow.artifacts || {})) {
    if (!['report', 'draft'].includes(artifact.type)) continue;
    if (artifact.metadata?.allowUncited === true) continue;
    if ((artifact.citationIds || []).length === 0 && Object.keys(workflow.citations || {}).length === 0) {
      blockers.push(blocker(
        'report_artifact_missing_citations',
        `报告产物缺少 citation：${artifact.id}`,
        { artifactIds: [artifact.id] },
      ));
    }
  }
  return blockers;
}

function completionWarnings(workflow) {
  const warnings = [];
  if (!workflow.gates.length) {
    warnings.push(warning('no_gates', 'workflow 未定义 Gate，completion 只能按步骤状态判断'));
  }
  return warnings;
}

function nextActionFor(blockers) {
  const codes = new Set(blockers.map((item) => item.code));
  if (codes.has('awaiting_user_confirmation')) return 'ask_user';
  if (codes.has('awaiting_graph_reconcile') || codes.has('gate_not_passed') || codes.has('gate_missing_evidence')) return 'reconcile';
  if (codes.has('step_not_terminal')) return 'continue';
  if (codes.has('node_result_unresolved')) return 'repair';
  if (codes.has('report_artifact_missing_citations')) return 'add_evidence';
  if (codes.has('workflow_terminal_failure')) return 'report_blocker';
  return 'complete';
}

export function evaluateWorkflowCompletion(workflow = {}) {
  const current = normalizeWorkflow(workflow);
  const blockers = [];
  if (current.status === 'canceled') {
    blockers.push(blocker('workflow_canceled', 'workflow 已取消'));
  }
  if (current.status === 'failed') {
    blockers.push(blocker('workflow_terminal_failure', current.error || 'workflow 已失败'));
  }
  blockers.push(...controlBlockers(current));
  blockers.push(...stepBlockers(current));
  blockers.push(...gateBlockers(current));
  blockers.push(...reportArtifactBlockers(current));

  const warnings = completionWarnings(current);
  const canCompleteWorkflow = blockers.length === 0;
  return {
    canClaimComplete: canCompleteWorkflow,
    canCompleteWorkflow,
    blockers,
    warnings,
    nextAction: nextActionFor(blockers),
  };
}

export function assertWorkflowCompletionAllowed(workflow = {}) {
  const verdict = evaluateWorkflowCompletion(workflow);
  if (!verdict.canCompleteWorkflow) {
    const first = verdict.blockers[0];
    throw new Error(first?.message || 'workflow completion blocked');
  }
  return verdict;
}

