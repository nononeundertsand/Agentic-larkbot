import { randomUUID } from 'node:crypto';
import { createWorkflow } from './workflow.mjs';
import { createWorkflowRunner } from './workflow-runner.mjs';

const MAX_START_STEPS = 12;
const WORKFLOW_STEP_TYPES = new Set(['plan', 'tool', 'transform', 'verify', 'confirm', 'send']);
const WORKFLOW_TYPES = new Set(['generic', 'doc_report', 'meeting_schedule', 'data_analysis', 'material_review']);

function nowMs() {
  return Date.now();
}

function confirmToken() {
  return randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
}

function cleanId(value, fallback) {
  const raw = String(value || '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeWorkflowType(value) {
  const type = String(value || 'generic').trim();
  return WORKFLOW_TYPES.has(type) ? type : 'generic';
}

function normalizeStartSteps(steps, { requireConfirmation = false, confirmationMessage = '' } = {}) {
  const raw = Array.isArray(steps) ? steps.slice(0, MAX_START_STEPS) : [];
  const normalized = raw.map((step, index) => {
    const input = asObject(step.input);
    const requestedType = String(step.type || '').trim();
    const type = WORKFLOW_STEP_TYPES.has(requestedType) ? requestedType : 'transform';
    const id = cleanId(step.id || `${type}_${index + 1}`, `step_${index + 1}`);
    const title = String(step.title || step.description || type).trim() || `步骤 ${index + 1}`;
    return {
      id,
      type,
      title,
      input: type === 'confirm'
        ? {
          ...input,
          reason: input.reason || confirmationMessage || title,
          message: input.message || confirmationMessage || title,
          actionId: input.actionId || id,
        }
        : input,
    };
  });

  const withDefaults = normalized.length
    ? normalized
    : [
      { id: 'plan', type: 'plan', title: '拆解目标', input: {} },
      { id: 'verify', type: 'verify', title: '检查执行条件', input: {} },
    ];

  if (requireConfirmation && !withDefaults.some((step) => step.type === 'confirm')) {
    withDefaults.push({
      id: 'confirm',
      type: 'confirm',
      title: '确认继续',
      input: {
        reason: confirmationMessage || '需要确认后继续 workflow',
        message: confirmationMessage || '需要确认后继续 workflow',
        actionId: 'workflow_confirm',
      },
    });
  }

  return withDefaults;
}

function workflowStepLine(step, index) {
  const mark = {
    pending: '待执行',
    running: '执行中',
    waiting_confirmation: '待确认',
    completed: '完成',
    failed: '失败',
    skipped: '跳过',
  }[step.status] || step.status;
  return `${index + 1}. ${step.title}：${mark}`;
}

export function createWorkflowFromRequest({
  title = '',
  userGoal = '',
  workflowType = 'generic',
  sessionKey = '',
  ownerId = '',
  steps = [],
  requireConfirmation = false,
  confirmationMessage = '',
  metadata = {},
} = {}) {
  const goal = String(userGoal || '').trim();
  const normalizedSteps = normalizeStartSteps(steps, { requireConfirmation, confirmationMessage });
  return createWorkflow({
    title: String(title || goal || '复杂任务工作流').trim(),
    type: normalizeWorkflowType(workflowType),
    userGoal: goal,
    sessionKey,
    ownerId,
    plan: {
      summary: goal,
      assumptions: [],
      missingInputs: [],
    },
    steps: normalizedSteps,
    metadata: {
      source: 'workflow_start_tool',
      ...asObject(metadata),
    },
  });
}

export function workflowSummary(workflow = {}) {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  return {
    workflowId: workflow.workflowId || '',
    title: workflow.title || '',
    type: workflow.type || 'generic',
    status: workflow.status || '',
    currentStep: workflow.currentStep || 0,
    stepCount: steps.length,
    completedSteps: steps.filter((step) => step.status === 'completed').length,
    failedSteps: steps.filter((step) => step.status === 'failed').length,
    waitingStep: steps.find((step) => step.status === 'waiting_confirmation')?.id || '',
    updatedAt: workflow.updatedAt || '',
  };
}

export function formatWorkflowForUser(workflow = {}) {
  const summary = workflowSummary(workflow);
  const lines = [
    `工作流：${summary.title || summary.workflowId}`,
    `ID：${summary.workflowId}`,
    `类型：${summary.type}`,
    `状态：${summary.status}`,
    `进度：${summary.completedSteps}/${summary.stepCount}`,
  ];
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length) lines.push('', ...steps.map(workflowStepLine));
  if (workflow.error) lines.push('', `失败原因：${workflow.error}`);
  return lines.join('\n');
}

export function formatWorkflowRunResult(result = {}) {
  const workflow = result.workflow || {};
  if (result.ok === false) return `执行失败：${result.reason || 'workflow 无法继续'}`;
  if (result.status === 'waiting_confirmation') {
    const step = workflow.steps?.[workflow.currentStep] || {};
    return [
      `工作流已暂停，等待确认：${workflow.title || workflow.workflowId}`,
      `ID：${workflow.workflowId}`,
      `当前步骤：${step.title || workflow.confirmation?.stepId || '确认步骤'}`,
      workflow.confirmation?.message ? `确认内容：${workflow.confirmation.message}` : '',
    ].filter(Boolean).join('\n');
  }
  if (result.status === 'failed') {
    return [
      `工作流执行失败：${workflow.title || workflow.workflowId}`,
      `ID：${workflow.workflowId}`,
      `失败原因：${result.error || workflow.error || '未知错误'}`,
    ].join('\n');
  }
  if (result.status === 'canceled') {
    return [
      `工作流已取消：${workflow.title || workflow.workflowId}`,
      `ID：${workflow.workflowId}`,
    ].join('\n');
  }
  return [
    `工作流已完成：${workflow.title || workflow.workflowId}`,
    `ID：${workflow.workflowId}`,
    `步骤：${workflow.steps?.filter((step) => step.status === 'completed').length || 0}/${workflow.steps?.length || 0}`,
  ].join('\n');
}

export function formatWorkflowProgressMessage(event = {}, workflow = {}) {
  if (event.type === 'started') {
    return `已启动工作流：${workflow.title || workflow.workflowId}`;
  }
  if (event.type === 'failed') {
    return `工作流执行失败：${event.message || workflow.error || '未知错误'}`;
  }
  return '';
}

export function buildWorkflowApprovalAction(workflow = {}, { confirmationKey = '' } = {}) {
  const token = confirmToken();
  const step = workflow.steps?.[workflow.currentStep] || {};
  const message = workflow.confirmation?.message || workflow.confirmation?.reason || step.title || '需要确认后继续 workflow';
  const preview = [
    `工作流「${workflow.title || workflow.workflowId}」需要确认后继续。`,
    `workflowId：${workflow.workflowId}`,
    `当前步骤：${step.title || workflow.confirmation?.stepId || '确认步骤'}`,
    `确认内容：${message}`,
    `确认码：${token}`,
    `请回复「确认 ${token}」执行，或「取消」放弃。`,
  ].join('\n');
  return {
    id: randomUUID(),
    toolName: 'workflow_confirm',
    executor: 'workflow',
    workflow: {
      workflowId: String(workflow.workflowId || ''),
      resumeToken: String(workflow.resumeToken || ''),
    },
    preview,
    confirmToken: token,
    confirmationKey,
    createdAt: nowMs(),
  };
}

export function createRuntimeWorkflowRunner({ stateStore, handlers = {}, progressSink = null, logger = console } = {}) {
  return createWorkflowRunner({ stateStore, handlers, progressSink, logger });
}

export async function executeWorkflowApproval(action = {}, { stateStore, handlers = {}, progressSink = null, logger = console } = {}) {
  const workflowId = String(action.workflow?.workflowId || '').trim();
  const token = String(action.workflow?.resumeToken || '').trim();
  if (!workflowId) return '执行失败：待确认 workflow 缺少 workflowId。';
  if (!stateStore?.getWorkflow || !stateStore?.saveWorkflow) return '执行失败：workflow 状态存储不可用。';
  const runner = createRuntimeWorkflowRunner({ stateStore, handlers, progressSink, logger });
  const result = await runner.confirm(workflowId, { token });
  return formatWorkflowRunResult(result);
}

export async function cancelWorkflowApproval(action = {}, { stateStore, logger = console } = {}) {
  const workflowId = String(action.workflow?.workflowId || '').trim();
  if (!workflowId) return '好的，已取消该操作。';
  if (!stateStore?.getWorkflow || !stateStore?.saveWorkflow) return '好的，已取消该操作。';
  const runner = createRuntimeWorkflowRunner({ stateStore, logger });
  const result = await runner.cancel(workflowId, '用户取消确认，workflow 已取消');
  return formatWorkflowRunResult(result);
}
