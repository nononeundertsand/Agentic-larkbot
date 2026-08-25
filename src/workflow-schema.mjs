import { randomUUID } from 'node:crypto';

export const WORKFLOW_SCHEMA_VERSION = 2;
export const WORKFLOW_TYPES = Object.freeze([
  'generic',
  'doc_report',
  'meeting_schedule',
  'data_analysis',
  'material_review',
]);
export const WORKFLOW_STATUSES = Object.freeze(['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'canceled']);
export const WORKFLOW_STEP_TYPES = Object.freeze(['plan', 'tool', 'transform', 'verify', 'confirm', 'send']);
export const WORKFLOW_STEP_STATUSES = Object.freeze(['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'skipped']);
export const WORKFLOW_GATE_STATUSES = Object.freeze(['pending', 'passed', 'failed', 'blocked']);
export const WORKFLOW_NODE_RESULT_STATUSES = Object.freeze(['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED', 'FAILED', 'CANCELED']);
export const WORKFLOW_DISPATCH_STATES = Object.freeze(['ready', 'awaiting_user_confirmation', 'awaiting_graph_reconcile']);
export const ARTIFACT_TYPES = Object.freeze(['text', 'json', 'report', 'table', 'chart', 'file', 'draft', 'lark_doc']);
export const CITATION_TYPES = Object.freeze(['doc', 'wiki', 'message', 'meeting', 'sheet', 'base', 'mail', 'web', 'memory', 'artifact']);
export const PROGRESS_EVENT_TYPES = Object.freeze([
  'created',
  'started',
  'step_started',
  'step_completed',
  'waiting_confirmation',
  'node_result_recorded',
  'gate_updated',
  'graph_reconcile_required',
  'completion_blocked',
  'failed',
  'retried',
  'canceled',
  'completed',
]);

const WORKFLOW_TYPE_SET = new Set(WORKFLOW_TYPES);
const STATUS_SET = new Set(WORKFLOW_STATUSES);
const STEP_TYPE_SET = new Set(WORKFLOW_STEP_TYPES);
const STEP_STATUS_SET = new Set(WORKFLOW_STEP_STATUSES);
const GATE_STATUS_SET = new Set(WORKFLOW_GATE_STATUSES);
const NODE_RESULT_STATUS_SET = new Set(WORKFLOW_NODE_RESULT_STATUSES);
const DISPATCH_STATE_SET = new Set(WORKFLOW_DISPATCH_STATES);
const ARTIFACT_TYPE_SET = new Set(ARTIFACT_TYPES);
const CITATION_TYPE_SET = new Set(CITATION_TYPES);
const PROGRESS_TYPE_SET = new Set(PROGRESS_EVENT_TYPES);

function nowIso() {
  return new Date().toISOString();
}

function token() {
  return randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return plainObject(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function assertKnown(value, set, label) {
  if (!set.has(value)) throw new Error(`${label} 不支持：${value}`);
}

function clampIndex(value, length) {
  if (length <= 0) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(n)));
}

export function normalizeWorkflowPlan(plan = {}) {
  const input = asObject(plan);
  return {
    summary: String(input.summary || ''),
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
    missingInputs: Array.isArray(input.missingInputs) ? input.missingInputs.map(String) : [],
  };
}

export function normalizeWorkflowStep(step = {}, index = 0) {
  const type = step.type || 'tool';
  assertKnown(type, STEP_TYPE_SET, 'workflow step type');
  const status = step.status || 'pending';
  assertKnown(status, STEP_STATUS_SET, 'workflow step status');
  return {
    id: String(step.id || `step_${index + 1}`),
    type,
    title: String(step.title || step.description || type),
    status,
    input: step.input ?? null,
    output: step.output ?? null,
    error: step.error ?? null,
    requiresConfirmation: Boolean(step.requiresConfirmation),
    depends: asStringArray(step.depends),
    gateIds: asStringArray(step.gateIds || step.gate_ids),
    acceptance: String(step.acceptance || ''),
    artifactIds: asStringArray(step.artifactIds),
    citationIds: asStringArray(step.citationIds),
    nodeResultIds: asStringArray(step.nodeResultIds || step.node_result_ids),
    retryCount: Math.max(0, Number(step.retryCount) || 0),
    timeoutMs: Number.isFinite(Number(step.timeoutMs)) ? Math.max(0, Number(step.timeoutMs)) : 0,
    startedAt: step.startedAt || '',
    endedAt: step.endedAt || '',
    updatedAt: step.updatedAt || '',
  };
}

export function createWorkflowGate({
  id = `gate_${randomUUID()}`,
  title = '',
  status = 'pending',
  acceptance = '',
  requiredEvidence = [],
  evidenceRefs = [],
  passedByNodeResultId = '',
  metadata = {},
  updatedAt = '',
} = {}) {
  assertKnown(status, GATE_STATUS_SET, 'workflow gate status');
  return {
    id: String(id),
    title: String(title || id || ''),
    status,
    acceptance: String(acceptance || ''),
    requiredEvidence: asStringArray(requiredEvidence),
    evidenceRefs: asStringArray(evidenceRefs),
    passedByNodeResultId: String(passedByNodeResultId || ''),
    metadata: asObject(metadata),
    updatedAt: String(updatedAt || ''),
  };
}

export function createNodeResult({
  id = `result_${randomUUID()}`,
  stepId = '',
  status = 'DONE',
  summary = '',
  deliverables = [],
  findings = [],
  concerns = [],
  evidence = [],
  artifactIds = [],
  citationIds = [],
  gateUpdates = [],
  requestedContext = [],
  metadata = {},
  completedAt = nowIso(),
} = {}) {
  assertKnown(status, NODE_RESULT_STATUS_SET, 'workflow nodeResult status');
  return {
    id: String(id),
    stepId: String(stepId || ''),
    status,
    summary: String(summary || ''),
    deliverables: asStringArray(deliverables),
    findings: asStringArray(findings),
    concerns: asStringArray(concerns),
    evidence: asStringArray(evidence),
    artifactIds: asStringArray(artifactIds),
    citationIds: asStringArray(citationIds),
    gateUpdates: Array.isArray(gateUpdates) ? gateUpdates.map((update) => asObject(update)) : [],
    requestedContext: asStringArray(requestedContext),
    metadata: asObject(metadata),
    completedAt: String(completedAt || nowIso()),
  };
}

export function createArtifact({
  id = `artifact_${randomUUID()}`,
  type = 'json',
  title = '',
  content = null,
  metadata = {},
  citationIds = [],
  createdByStepId = '',
  createdAt = nowIso(),
} = {}) {
  assertKnown(type, ARTIFACT_TYPE_SET, 'artifact type');
  return {
    id: String(id),
    type,
    title: String(title || ''),
    content,
    metadata: asObject(metadata),
    citationIds: Array.isArray(citationIds) ? citationIds.map(String) : [],
    createdByStepId: String(createdByStepId || ''),
    createdAt: String(createdAt || nowIso()),
  };
}

export function createCitation({
  id = `citation_${randomUUID()}`,
  type = 'artifact',
  title = '',
  sourceId = '',
  url = '',
  quote = '',
  location = '',
  metadata = {},
  createdAt = nowIso(),
} = {}) {
  assertKnown(type, CITATION_TYPE_SET, 'citation type');
  return {
    id: String(id),
    type,
    title: String(title || ''),
    sourceId: String(sourceId || ''),
    url: String(url || ''),
    quote: String(quote || '').slice(0, 2000),
    location: String(location || ''),
    metadata: asObject(metadata),
    createdAt: String(createdAt || nowIso()),
  };
}

export function createProgressEvent({
  type = 'created',
  message = '',
  stepId = '',
  at = nowIso(),
  data = {},
} = {}) {
  assertKnown(type, PROGRESS_TYPE_SET, 'progress event type');
  return {
    type,
    message: String(message || ''),
    stepId: String(stepId || ''),
    at: String(at || nowIso()),
    data: asObject(data),
  };
}

export function normalizeWorkflowControl(control = {}) {
  const input = asObject(control);
  const dispatchState = String(input.dispatchState || input.dispatch_state || 'ready');
  assertKnown(dispatchState, DISPATCH_STATE_SET, 'workflow dispatch state');
  return {
    dispatchState,
    reason: String(input.reason || ''),
    confirmationConsumed: input.confirmationConsumed === undefined
      ? dispatchState === 'ready'
      : Boolean(input.confirmationConsumed),
  };
}

function normalizeArtifactMap(raw) {
  const entries = plainObject(raw) ? Object.entries(raw) : [];
  return Object.fromEntries(entries.map(([id, artifact]) => {
    const normalized = createArtifact({ id, ...asObject(artifact) });
    return [normalized.id, normalized];
  }));
}

function normalizeCitationMap(raw) {
  const entries = plainObject(raw) ? Object.entries(raw) : [];
  return Object.fromEntries(entries.map(([id, citation]) => {
    const normalized = createCitation({ id, ...asObject(citation) });
    return [normalized.id, normalized];
  }));
}

function normalizeGateList(raw) {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((gate, index) => createWorkflowGate({ id: `gate_${index + 1}`, ...asObject(gate) }));
}

function normalizeNodeResultMap(raw) {
  const entries = plainObject(raw) ? Object.entries(raw) : [];
  return Object.fromEntries(entries.map(([id, result]) => {
    const normalized = createNodeResult({ id, ...asObject(result) });
    return [normalized.id, normalized];
  }));
}

export function normalizeWorkflow(raw = {}) {
  const input = asObject(raw);
  const schemaVersion = Number(input.schemaVersion) || 1;
  const status = input.status || 'pending';
  assertKnown(status, STATUS_SET, 'workflow status');
  const type = input.type || input.workflowType || 'generic';
  assertKnown(type, WORKFLOW_TYPE_SET, 'workflow type');
  const steps = Array.isArray(input.steps) ? input.steps.map(normalizeWorkflowStep) : [];
  const now = nowIso();
  const workflow = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId: String(input.workflowId || randomUUID()),
    type,
    title: String(input.title || ''),
    status,
    sessionKey: String(input.sessionKey || ''),
    ownerId: String(input.ownerId || ''),
    userGoal: String(input.userGoal || input.metadata?.userGoal || ''),
    plan: normalizeWorkflowPlan(input.plan),
    steps,
    gates: normalizeGateList(input.gates),
    nodeResults: normalizeNodeResultMap(input.nodeResults || input.node_results),
    control: normalizeWorkflowControl(input.control),
    artifacts: normalizeArtifactMap(input.artifacts),
    citations: normalizeCitationMap(input.citations),
    progressEvents: Array.isArray(input.progressEvents)
      ? input.progressEvents.map((event) => createProgressEvent(event))
      : [],
    currentStep: clampIndex(input.currentStep, steps.length),
    requiresConfirmation: Boolean(input.requiresConfirmation),
    resumeToken: String(input.resumeToken || token()),
    confirmation: input.confirmation ?? null,
    error: input.error ?? null,
    metadata: asObject(input.metadata),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now),
  };

  if (schemaVersion < WORKFLOW_SCHEMA_VERSION && !workflow.progressEvents.length) {
    workflow.progressEvents.push(createProgressEvent({ type: 'created', message: 'workflow v1 migrated to v2' }));
  }
  return workflow;
}

export function createWorkflowV2(input = {}) {
  return normalizeWorkflow({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId: input.workflowId || randomUUID(),
    type: input.type || input.workflowType || 'generic',
    title: input.title || '',
    status: input.status || 'pending',
    sessionKey: input.sessionKey || '',
    ownerId: input.ownerId || '',
    userGoal: input.userGoal || '',
    plan: input.plan || {},
    steps: input.steps || [],
    gates: input.gates || [],
    nodeResults: input.nodeResults || {},
    control: input.control || {},
    artifacts: input.artifacts || {},
    citations: input.citations || {},
    progressEvents: input.progressEvents || [createProgressEvent({ type: 'created', message: 'workflow created' })],
    currentStep: input.currentStep || 0,
    requiresConfirmation: input.requiresConfirmation || false,
    metadata: input.metadata || {},
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
  });
}

export function appendWorkflowProgress(workflow, event) {
  const normalized = normalizeWorkflow(workflow);
  return {
    ...normalized,
    progressEvents: [...normalized.progressEvents, createProgressEvent(event)].slice(-200),
    updatedAt: nowIso(),
  };
}

export function upsertWorkflowArtifact(workflow, artifact) {
  const normalized = normalizeWorkflow(workflow);
  const item = createArtifact(artifact);
  return {
    ...normalized,
    artifacts: { ...normalized.artifacts, [item.id]: item },
    updatedAt: nowIso(),
  };
}

export function upsertWorkflowCitation(workflow, citation) {
  const normalized = normalizeWorkflow(workflow);
  const item = createCitation(citation);
  return {
    ...normalized,
    citations: { ...normalized.citations, [item.id]: item },
    updatedAt: nowIso(),
  };
}

export function canTransitionWorkflow(from, to) {
  if (from === to) return true;
  if (['completed', 'canceled'].includes(from)) return false;
  if (from === 'failed') return ['running', 'canceled'].includes(to);
  if (from === 'waiting_confirmation') return ['running', 'failed', 'canceled'].includes(to);
  if (from === 'pending') return ['running', 'waiting_confirmation', 'failed', 'canceled'].includes(to);
  if (from === 'running') return ['waiting_confirmation', 'completed', 'failed', 'canceled'].includes(to);
  return false;
}

export function transitionWorkflowStatus(workflow, nextStatus, { message = '', stepId = '', data = {} } = {}) {
  assertKnown(nextStatus, STATUS_SET, 'workflow status');
  const current = normalizeWorkflow(workflow);
  if (!canTransitionWorkflow(current.status, nextStatus)) {
    throw new Error(`workflow status 不允许从 ${current.status} 转为 ${nextStatus}`);
  }
  const eventType = nextStatus === 'waiting_confirmation' ? 'waiting_confirmation' : nextStatus;
  return appendWorkflowProgress({
    ...current,
    status: nextStatus,
    updatedAt: nowIso(),
  }, {
    type: PROGRESS_TYPE_SET.has(eventType) ? eventType : 'started',
    message: message || `workflow status -> ${nextStatus}`,
    stepId,
    data,
  });
}

export function markWorkflowCanceled(workflow, reason = '') {
  return transitionWorkflowStatus(workflow, 'canceled', { message: reason || 'workflow canceled' });
}

export function markWorkflowRetry(workflow, stepRef, { reason = '' } = {}) {
  const current = normalizeWorkflow(workflow);
  const index = typeof stepRef === 'number' ? stepRef : current.steps.findIndex((step) => step.id === stepRef);
  if (index < 0 || index >= current.steps.length) throw new Error('workflow step 不存在');
  const steps = current.steps.map((step, idx) => idx === index
    ? {
      ...step,
      status: 'pending',
      error: null,
      retryCount: (Number(step.retryCount) || 0) + 1,
      updatedAt: nowIso(),
    }
    : step);
  return appendWorkflowProgress({
    ...current,
    status: 'running',
    control: normalizeWorkflowControl({ dispatchState: 'ready' }),
    steps,
    currentStep: index,
    updatedAt: nowIso(),
  }, {
    type: 'retried',
    stepId: steps[index].id,
    message: reason || 'workflow step retry requested',
  });
}
