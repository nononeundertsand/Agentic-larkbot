import { randomUUID } from 'node:crypto';
import { createWorkflow } from './workflow.mjs';
import { createWorkflowRunner } from './workflow-runner.mjs';
import { createDocReportHandlers, defaultDocReportGates, defaultDocReportSteps } from './workflows/doc-report.mjs';

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
      depends: Array.isArray(step.depends) ? step.depends.map(String) : [],
      gateIds: Array.isArray(step.gateIds || step.gate_ids) ? (step.gateIds || step.gate_ids).map(String) : [],
      acceptance: String(step.acceptance || ''),
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

function normalizeStartGates(gates = []) {
  return (Array.isArray(gates) ? gates : []).map((gate, index) => {
    const input = asObject(gate);
    return {
      id: cleanId(input.id || input.gateId || input.gate_id || `gate_${index + 1}`, `gate_${index + 1}`),
      title: String(input.title || input.name || input.id || `Gate ${index + 1}`),
      status: String(input.status || 'pending'),
      acceptance: String(input.acceptance || ''),
      requiredEvidence: Array.isArray(input.requiredEvidence || input.required_evidence)
        ? (input.requiredEvidence || input.required_evidence).map(String)
        : [],
      evidenceRefs: Array.isArray(input.evidenceRefs || input.evidence_refs)
        ? (input.evidenceRefs || input.evidence_refs).map(String)
        : [],
      metadata: asObject(input.metadata),
    };
  });
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

function workflowStepLabel(workflow = {}, stepId = '') {
  const id = String(stepId || '');
  if (!id) return '';
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const index = steps.findIndex((step) => step.id === id);
  if (index < 0) return id;
  return `${index + 1}/${steps.length} ${steps[index].title || steps[index].id}`;
}

function workflowProgressRatio(workflow = {}) {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (!steps.length) return '';
  const completed = steps.filter((step) => step.status === 'completed').length;
  return `${completed}/${steps.length}`;
}

function workflowGateRatio(workflow = {}) {
  const gates = Array.isArray(workflow.gates) ? workflow.gates : [];
  if (!gates.length) return '';
  const passed = gates.filter((gate) => gate.status === 'passed').length;
  return `${passed}/${gates.length}`;
}

function workflowGateLine(gate, index) {
  const mark = {
    pending: '待验收',
    passed: '通过',
    failed: '失败',
    blocked: '阻塞',
  }[gate.status] || gate.status;
  return `${index + 1}. ${gate.title || gate.id}：${mark}`;
}

function workflowProgressEventLine(event = {}, workflow = {}) {
  const time = event.at ? new Date(event.at).toLocaleString('zh-CN', { hour12: false }) : '';
  const step = event.stepId ? workflowStepLabel(workflow, event.stepId) : '';
  const prefix = time ? `${time} ` : '';
  const target = step ? `${step} ` : '';
  return `${prefix}${target}${event.message || event.type || ''}`.trim();
}

function latestReportArtifact(workflow = {}) {
  const artifacts = Object.values(workflow.artifacts || {});
  return workflow.artifacts?.report_draft
    || artifacts.find((artifact) => artifact.type === 'report')
    || artifacts.find((artifact) => artifact.type === 'draft')
    || null;
}

function latestReportDocumentArtifact(workflow = {}) {
  const artifacts = Object.values(workflow.artifacts || {});
  return workflow.artifacts?.report_document
    || artifacts.find((artifact) => artifact.type === 'lark_doc')
    || null;
}

function workflowApprovalArtifactPreview(workflow = {}) {
  const report = latestReportArtifact(workflow);
  const doc = latestReportDocumentArtifact(workflow);
  const docUrl = String(doc?.content?.url || '').trim();
  if (!report?.content) return '';
  const content = String(report.content || '').trim();
  if (!content) return '';
  const citationCount = Array.isArray(report.citationIds) ? report.citationIds.length : 0;
  return [
    '',
    docUrl ? `飞书文档：[打开报告](${docUrl})\n${docUrl}` : '',
    '报告草稿预览：',
    content.length > 2200 ? `${content.slice(0, 2200)}\n\n...（报告较长，已截断预览）` : content,
    citationCount ? `引用数：${citationCount}` : '',
  ].filter(Boolean).join('\n');
}

export function createWorkflowFromRequest({
  title = '',
  userGoal = '',
  workflowType = 'generic',
  sessionKey = '',
  ownerId = '',
  steps = [],
  gates = [],
  requireConfirmation = false,
  confirmationMessage = '',
  metadata = {},
} = {}) {
  const goal = String(userGoal || '').trim();
  const normalizedType = normalizeWorkflowType(workflowType);
  const metadataObject = asObject(metadata);
  const forceDocReportDefaults = normalizedType === 'doc_report' && metadataObject.customSteps !== true;
  const defaultSteps = forceDocReportDefaults || (normalizedType === 'doc_report' && (!Array.isArray(steps) || steps.length === 0))
    ? defaultDocReportSteps({ confirmationMessage })
    : steps;
  const defaultGates = forceDocReportDefaults || (normalizedType === 'doc_report' && (!Array.isArray(gates) || gates.length === 0))
    ? defaultDocReportGates()
    : gates;
  const normalizedSteps = normalizeStartSteps(defaultSteps, { requireConfirmation, confirmationMessage });
  const normalizedGates = normalizeStartGates(defaultGates);
  return createWorkflow({
    title: String(title || goal || '复杂任务工作流').trim(),
    type: normalizedType,
    userGoal: goal,
    sessionKey,
    ownerId,
    plan: {
      summary: goal,
      assumptions: [],
      missingInputs: [],
    },
    steps: normalizedSteps,
    gates: normalizedGates,
    metadata: {
      source: 'workflow_start_tool',
      ...(normalizedType === 'doc_report' ? { workflowVersion: 'w2_doc_report_mvp' } : {}),
      ...metadataObject,
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
    dispatchState: workflow.control?.dispatchState || 'ready',
    currentStep: workflow.currentStep || 0,
    stepCount: steps.length,
    completedSteps: steps.filter((step) => step.status === 'completed').length,
    failedSteps: steps.filter((step) => step.status === 'failed').length,
    waitingStep: steps.find((step) => step.status === 'waiting_confirmation')?.id || '',
    gateCount: Array.isArray(workflow.gates) ? workflow.gates.length : 0,
    passedGates: Array.isArray(workflow.gates) ? workflow.gates.filter((gate) => gate.status === 'passed').length : 0,
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
    `调度：${summary.dispatchState}`,
    `进度：${summary.completedSteps}/${summary.stepCount}`,
  ];
  if (summary.gateCount) lines.push(`Gate：${summary.passedGates}/${summary.gateCount}`);
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length) lines.push('', ...steps.map(workflowStepLine));
  const gates = Array.isArray(workflow.gates) ? workflow.gates : [];
  if (gates.length) lines.push('', 'Gate 状态：', ...gates.map(workflowGateLine));
  const recentEvents = Array.isArray(workflow.progressEvents)
    ? workflow.progressEvents.slice(-5).map((event) => workflowProgressEventLine(event, workflow)).filter(Boolean)
    : [];
  if (recentEvents.length) lines.push('', '最近进度：', ...recentEvents);
  if (workflow.control?.dispatchState && workflow.control.dispatchState !== 'ready') {
    lines.push('', `阻塞原因：${workflow.control.reason || workflow.control.dispatchState}`);
  }
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
  if (result.status === 'awaiting_graph_reconcile' || result.status === 'completion_blocked') {
    return [
      `工作流需要重新规划后继续：${workflow.title || workflow.workflowId}`,
      `ID：${workflow.workflowId}`,
      `原因：${result.reason || workflow.control?.reason || result.verdict?.blockers?.[0]?.message || '当前结果未满足继续执行条件'}`,
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
  const title = workflow.title || workflow.workflowId || '工作流';
  const progress = workflowProgressRatio(workflow);
  const gateProgress = workflowGateRatio(workflow);
  const progressLine = progress ? `进度：${progress}` : '';
  const gateLine = gateProgress ? `Gate：${gateProgress}` : '';
  const step = workflowStepLabel(workflow, event.stepId);
  if (event.type === 'started') {
    return [`已启动工作流：${title}`, workflow.workflowId ? `ID：${workflow.workflowId}` : '', progressLine].filter(Boolean).join('\n');
  }
  if (event.type === 'step_started') {
    return [`工作流进度：${title}`, `正在执行：${step || event.message || '当前步骤'}`, progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'step_completed') {
    return [`工作流进度：${title}`, `已完成：${step || event.message || '当前步骤'}`, progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'waiting_confirmation') {
    return [`工作流已暂停，等待确认：${title}`, step ? `当前步骤：${step}` : '', event.message ? `确认内容：${event.message}` : '', progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'gate_updated') {
    return [`工作流验收更新：${title}`, event.message || '', gateLine, progressLine].filter(Boolean).join('\n');
  }
  if (event.type === 'graph_reconcile_required') {
    return [`工作流需要重新规划后继续：${title}`, step ? `触发步骤：${step}` : '', `原因：${event.message || workflow.control?.reason || '当前结果未满足继续执行条件'}`, progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'completion_blocked') {
    return [`工作流暂未完成：${title}`, `原因：${event.message || workflow.control?.reason || '完成条件未满足'}`, progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'failed') {
    return [`工作流执行失败：${title}`, step ? `失败步骤：${step}` : '', `原因：${event.message || workflow.error || '未知错误'}`, progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'retried') {
    return [`工作流已重试：${title}`, step ? `重试步骤：${step}` : '', event.message || '', progressLine, gateLine].filter(Boolean).join('\n');
  }
  if (event.type === 'canceled') {
    return [`工作流已取消：${title}`, event.message ? `原因：${event.message}` : '', progressLine].filter(Boolean).join('\n');
  }
  if (event.type === 'completed') {
    return [`工作流已完成：${title}`, workflow.workflowId ? `ID：${workflow.workflowId}` : '', progressLine, gateLine].filter(Boolean).join('\n');
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
    workflowApprovalArtifactPreview(workflow),
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

export function ensureWorkflowPlanCurrent(workflow = {}) {
  if (workflow?.type !== 'doc_report') return workflow;
  const existingSteps = new Map((workflow.steps || []).map((step) => [step.id, step]));
  const existingGates = new Map((workflow.gates || []).map((gate) => [gate.id, gate]));
  return {
    ...workflow,
    steps: defaultDocReportSteps().map((defaultStep) => {
      const existing = existingSteps.get(defaultStep.id) || {};
      return {
        ...defaultStep,
        ...existing,
        depends: defaultStep.depends || [],
        gateIds: defaultStep.gateIds || [],
        input: {
          ...(defaultStep.input || {}),
          ...(existing.input || {}),
        },
      };
    }),
    gates: defaultDocReportGates().map((defaultGate) => ({
      ...defaultGate,
      ...(existingGates.get(defaultGate.id) || {}),
      requiredEvidence: defaultGate.requiredEvidence || [],
    })),
  };
}

export function createWorkflowHandlers(workflow = {}, { ctx = {}, logger = console } = {}) {
  if (workflow?.type === 'doc_report') return createDocReportHandlers({ ctx, logger, ...asObject(ctx.docReportDeps) });
  return {};
}

export function createRuntimeWorkflowRunner({ stateStore, workflow = null, handlers = {}, progressSink = null, logger = console, ctx = {} } = {}) {
  const builtInHandlers = workflow ? createWorkflowHandlers(workflow, { ctx, logger }) : {};
  return createWorkflowRunner({
    stateStore,
    handlers: { ...builtInHandlers, ...asObject(ctx.workflowHandlers), ...handlers },
    progressSink,
    logger,
  });
}

export async function executeWorkflowApproval(action = {}, { stateStore, handlers = {}, progressSink = null, logger = console } = {}) {
  const workflowId = String(action.workflow?.workflowId || '').trim();
  const token = String(action.workflow?.resumeToken || '').trim();
  if (!workflowId) return '执行失败：待确认 workflow 缺少 workflowId。';
  if (!stateStore?.getWorkflow || !stateStore?.saveWorkflow) return '执行失败：workflow 状态存储不可用。';
  const workflow = stateStore.getWorkflow(workflowId);
  const runner = createRuntimeWorkflowRunner({ stateStore, workflow, handlers, progressSink, logger });
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
