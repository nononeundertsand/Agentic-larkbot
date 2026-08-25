import { randomUUID } from 'node:crypto';
import {
  appendWorkflowProgress,
  createArtifact,
  createCitation,
  markWorkflowCanceled,
  markWorkflowRetry,
  normalizeWorkflow,
} from './workflow-schema.mjs';
import {
  isSuccessfulNodeResultStatus,
  reconcileNodeResult,
  recordNodeResult,
  setWorkflowControl,
} from './workflow-graph.mjs';
import { evaluateWorkflowCompletion } from './workflow-completion.mjs';

function nowIso() {
  return new Date().toISOString();
}

function resumeToken() {
  return randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
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

function stepIndex(workflow, stepRef = workflow.currentStep) {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const index = typeof stepRef === 'number'
    ? stepRef
    : steps.findIndex((step) => step.id === stepRef);
  if (index < 0 || index >= steps.length) throw new Error('workflow step 不存在');
  return index;
}

function updateStep(workflow, stepRef, patch = {}) {
  const index = stepIndex(workflow, stepRef);
  return {
    ...workflow,
    currentStep: index,
    steps: workflow.steps.map((step, idx) => (idx === index ? { ...step, ...patch, updatedAt: nowIso() } : step)),
    updatedAt: nowIso(),
  };
}

function mergeStepArtifacts(workflow, stepId, result = {}) {
  let next = workflow;
  const artifactIds = [];
  const citationIds = [];

  for (const citation of asArray(result.citations)) {
    const item = createCitation(citation);
    next = { ...next, citations: { ...next.citations, [item.id]: item } };
    citationIds.push(item.id);
  }

  for (const artifact of asArray(result.artifacts)) {
    const item = createArtifact({ createdByStepId: stepId, ...artifact });
    next = { ...next, artifacts: { ...next.artifacts, [item.id]: item } };
    artifactIds.push(item.id);
  }

  artifactIds.push(...asArray(result.artifactIds).map(String));
  citationIds.push(...asArray(result.citationIds).map(String));
  return { workflow: next, artifactIds: [...new Set(artifactIds)], citationIds: [...new Set(citationIds)] };
}

function nodeResultFromStepResult(step, result = {}, merged = {}) {
  const explicit = asObject(result.nodeResult || result.node_result);
  return {
    ...explicit,
    stepId: explicit.stepId || explicit.step_id || step.id,
    status: explicit.status || result.nodeStatus || result.node_status || 'DONE',
    summary: explicit.summary || result.summary || result.progressMessage || step.title,
    deliverables: explicit.deliverables ?? result.deliverables ?? [],
    findings: explicit.findings ?? result.findings ?? [],
    concerns: explicit.concerns ?? result.concerns ?? [],
    evidence: explicit.evidence ?? result.evidence ?? [],
    artifactIds: unique([
      ...asArray(merged.artifactIds),
      ...asArray(explicit.artifactIds || explicit.artifact_ids),
      ...asArray(result.artifactIds || result.artifact_ids),
    ]),
    citationIds: unique([
      ...asArray(merged.citationIds),
      ...asArray(explicit.citationIds || explicit.citation_ids),
      ...asArray(result.citationIds || result.citation_ids),
    ]),
    gateUpdates: explicit.gateUpdates || explicit.gate_updates || result.gateUpdates || result.gate_updates || [],
    requestedContext: explicit.requestedContext || explicit.requested_context || result.requestedContext || result.requested_context || [],
  };
}

function defaultStepHandler(type) {
  if (type === 'confirm') {
    return async ({ step }) => ({
      requiresConfirmation: true,
      confirmation: {
        reason: step.input?.reason || step.title || '需要确认后继续',
        actionId: step.input?.actionId || step.id,
        message: step.input?.message || step.title || '需要确认后继续',
      },
      output: { waiting: true },
    });
  }
  return async ({ step }) => ({ output: step.input ?? {} });
}

export class WorkflowRunner {
  constructor({ stateStore = null, handlers = {}, progressSink = null, logger = console } = {}) {
    this.stateStore = stateStore;
    this.handlers = { ...handlers };
    this.progressSink = progressSink;
    this.logger = logger;
  }

  save(workflow) {
    this.stateStore?.saveWorkflow?.(workflow);
    return workflow;
  }

  load(workflowOrId) {
    if (typeof workflowOrId === 'string') {
      const stored = this.stateStore?.getWorkflow?.(workflowOrId);
      if (!stored) throw new Error(`workflow 不存在：${workflowOrId}`);
      return normalizeWorkflow(stored);
    }
    return normalizeWorkflow(workflowOrId);
  }

  async emit(workflow, event) {
    const next = appendWorkflowProgress(workflow, event);
    this.save(next);
    if (typeof this.progressSink === 'function') {
      try {
        await this.progressSink(event, next);
      } catch (err) {
        this.logger.warn?.('[workflow-runner] progressSink 失败：', err.message);
      }
    }
    return next;
  }

  async fanoutGraphProgress(before, after) {
    if (typeof this.progressSink !== 'function') return;
    const previousCount = Array.isArray(before?.progressEvents) ? before.progressEvents.length : 0;
    const events = Array.isArray(after?.progressEvents) ? after.progressEvents.slice(previousCount) : [];
    for (const event of events) {
      try {
        await this.progressSink(event, after);
      } catch (err) {
        this.logger.warn?.('[workflow-runner] progressSink 失败：', err.message);
      }
    }
  }

  handlerFor(step) {
    return this.handlers[step.id] || this.handlers[step.type] || defaultStepHandler(step.type);
  }

  controlBlockedResult(workflow) {
    if (workflow.control?.dispatchState === 'awaiting_graph_reconcile') {
      return { status: 'awaiting_graph_reconcile', workflow, reason: workflow.control.reason || 'workflow 需要重新规划后继续' };
    }
    if (workflow.control?.dispatchState === 'awaiting_user_confirmation') {
      return { status: 'waiting_confirmation', workflow, reason: workflow.control.reason || 'workflow 等待确认' };
    }
    return null;
  }

  async run(workflowOrId) {
    let workflow = this.load(workflowOrId);
    if (['completed', 'canceled', 'failed'].includes(workflow.status)) {
      this.save(workflow);
      return { status: workflow.status, workflow };
    }
    if (workflow.status === 'waiting_confirmation' || workflow.requiresConfirmation) {
      this.save(workflow);
      return { status: 'waiting_confirmation', workflow };
    }
    const blocked = this.controlBlockedResult(workflow);
    if (blocked) {
      this.save(workflow);
      return blocked;
    }
    if (workflow.status === 'pending') {
      workflow = await this.emit({ ...workflow, status: 'running', updatedAt: nowIso() }, {
        type: 'started',
        message: workflow.title ? `开始执行：${workflow.title}` : 'workflow started',
      });
    }

    while (workflow.currentStep < workflow.steps.length) {
      const blockedInLoop = this.controlBlockedResult(workflow);
      if (blockedInLoop) {
        this.save(workflow);
        return blockedInLoop;
      }
      const step = workflow.steps[workflow.currentStep];
      if (step.status === 'completed' || step.status === 'skipped') {
        workflow = { ...workflow, currentStep: workflow.currentStep + 1, updatedAt: nowIso() };
        this.save(workflow);
        continue;
      }
      if (step.status === 'waiting_confirmation') {
        workflow = { ...workflow, status: 'waiting_confirmation', requiresConfirmation: true, updatedAt: nowIso() };
        this.save(workflow);
        return { status: 'waiting_confirmation', workflow };
      }

      workflow = updateStep(workflow, workflow.currentStep, {
        status: 'running',
        startedAt: step.startedAt || nowIso(),
        error: null,
      });
      workflow = await this.emit(workflow, {
        type: 'step_started',
        stepId: step.id,
        message: `开始：${step.title}`,
      });

      let result;
      try {
        result = await this.handlerFor(step)({ workflow, step: workflow.steps[workflow.currentStep], runner: this });
      } catch (err) {
        workflow = updateStep(workflow, workflow.currentStep, {
          status: 'failed',
          error: err.message || String(err),
          endedAt: nowIso(),
        });
        const beforeRecord = workflow;
        workflow = recordNodeResult(workflow, {
          stepId: workflow.steps[workflow.currentStep].id,
          status: 'FAILED',
          summary: err.message || String(err),
          concerns: [err.message || String(err)],
        }).workflow;
        await this.fanoutGraphProgress(beforeRecord, workflow);
        workflow = await this.emit({ ...workflow, status: 'failed', error: err.message || String(err), updatedAt: nowIso() }, {
          type: 'failed',
          stepId: step.id,
          message: err.message || String(err),
        });
        return { status: 'failed', workflow, error: workflow.error };
      }

      if (result?.requiresConfirmation) {
        const confirmation = result.confirmation || {};
        workflow = updateStep(workflow, workflow.currentStep, {
          status: 'waiting_confirmation',
          requiresConfirmation: true,
          output: result.output ?? null,
        });
        workflow = {
          ...workflow,
          status: 'waiting_confirmation',
          requiresConfirmation: true,
          control: {
            dispatchState: 'awaiting_user_confirmation',
            reason: String(confirmation.reason || '需要确认后继续'),
            confirmationConsumed: false,
          },
          resumeToken: resumeToken(),
          confirmation: {
            stepId: workflow.steps[workflow.currentStep].id,
            reason: String(confirmation.reason || '需要确认后继续'),
            actionId: String(confirmation.actionId || workflow.steps[workflow.currentStep].id),
            message: String(confirmation.message || confirmation.reason || '需要确认后继续'),
            requestedAt: nowIso(),
          },
          updatedAt: nowIso(),
        };
        workflow = await this.emit(workflow, {
          type: 'waiting_confirmation',
          stepId: workflow.steps[workflow.currentStep].id,
          message: workflow.confirmation.message,
        });
        return { status: 'waiting_confirmation', workflow, confirmation: workflow.confirmation };
      }

      const output = Object.prototype.hasOwnProperty.call(result || {}, 'output') ? result.output : result;
      const merged = mergeStepArtifacts(workflow, workflow.steps[workflow.currentStep].id, result || {});
      workflow = merged.workflow;
      const nodeResult = nodeResultFromStepResult(workflow.steps[workflow.currentStep], result || {}, merged);
      const stepStatus = isSuccessfulNodeResultStatus(nodeResult.status) ? 'completed' : 'failed';
      workflow = updateStep(workflow, workflow.currentStep, {
        status: stepStatus,
        output: output ?? null,
        artifactIds: [...new Set([...(workflow.steps[workflow.currentStep].artifactIds || []), ...merged.artifactIds])],
        citationIds: [...new Set([...(workflow.steps[workflow.currentStep].citationIds || []), ...merged.citationIds])],
        endedAt: nowIso(),
      });
      const beforeReconcile = workflow;
      const reconciled = reconcileNodeResult(workflow, nodeResult);
      workflow = reconciled.workflow;
      await this.fanoutGraphProgress(beforeReconcile, workflow);
      if (reconciled.graphReconcileRequired) {
        this.save(workflow);
        return {
          status: 'awaiting_graph_reconcile',
          workflow,
          nodeResult: reconciled.nodeResult,
          staleStepIds: reconciled.staleStepIds,
        };
      }
      workflow = await this.emit(workflow, {
        type: 'step_completed',
        stepId: workflow.steps[workflow.currentStep].id,
        message: result?.progressMessage || `完成：${workflow.steps[workflow.currentStep].title}`,
      });
      workflow = { ...workflow, currentStep: workflow.currentStep + 1, updatedAt: nowIso() };
      this.save(workflow);
    }

    const verdict = evaluateWorkflowCompletion(workflow);
    if (!verdict.canCompleteWorkflow) {
      const first = verdict.blockers[0];
      workflow = setWorkflowControl(workflow, {
        dispatchState: 'awaiting_graph_reconcile',
        reason: first?.message || 'workflow completion blocked',
        confirmationConsumed: true,
      });
      workflow = await this.emit(workflow, {
        type: 'completion_blocked',
        message: first?.message || 'workflow completion blocked',
        data: { blockers: verdict.blockers, warnings: verdict.warnings },
      });
      return { status: 'completion_blocked', workflow, verdict };
    }

    workflow = await this.emit({
      ...workflow,
      status: 'completed',
      requiresConfirmation: false,
      currentStep: Math.max(0, workflow.steps.length - 1),
      updatedAt: nowIso(),
    }, {
      type: 'completed',
      message: workflow.title ? `完成：${workflow.title}` : 'workflow completed',
    });
    return { status: 'completed', workflow };
  }

  async confirm(workflowOrId, { token = '' } = {}) {
    let workflow = this.load(workflowOrId);
    if (!workflow.requiresConfirmation || workflow.status !== 'waiting_confirmation') {
      return { ok: false, reason: 'workflow 当前不需要确认', workflow };
    }
    if (token && String(token).trim().toUpperCase() !== String(workflow.resumeToken || '').trim().toUpperCase()) {
      return { ok: false, reason: 'workflow resumeToken 不匹配', workflow };
    }
    const idx = stepIndex(workflow, workflow.confirmation?.stepId || workflow.currentStep);
    workflow = updateStep(workflow, idx, {
      status: 'completed',
      requiresConfirmation: false,
      output: { confirmed: true },
      endedAt: nowIso(),
    });
    workflow = {
      ...workflow,
      status: 'running',
      requiresConfirmation: false,
      confirmation: null,
      control: {
        dispatchState: 'ready',
        reason: '',
        confirmationConsumed: true,
      },
      currentStep: idx + 1,
      updatedAt: nowIso(),
    };
    const confirmResult = {
      stepId: workflow.steps[idx].id,
      status: 'DONE',
      summary: `确认完成：${workflow.steps[idx].title}`,
      gateUpdates: workflow.steps[idx].input?.gateUpdates || workflow.steps[idx].input?.gate_updates || [],
    };
    const beforeReconcile = workflow;
    workflow = reconcileNodeResult(workflow, confirmResult).workflow;
    await this.fanoutGraphProgress(beforeReconcile, workflow);
    workflow = await this.emit(workflow, {
      type: 'step_completed',
      stepId: workflow.steps[idx].id,
      message: `确认完成：${workflow.steps[idx].title}`,
    });
    return { ok: true, ...(await this.run(workflow)) };
  }

  async cancel(workflowOrId, reason = '用户取消') {
    let workflow = this.load(workflowOrId);
    workflow = markWorkflowCanceled(workflow, reason);
    this.save(workflow);
    return { status: 'canceled', workflow };
  }

  async retry(workflowOrId, stepRef, opts = {}) {
    const workflow = markWorkflowRetry(this.load(workflowOrId), stepRef, opts);
    this.save(workflow);
    return this.run(workflow);
  }
}

export function createWorkflowRunner(opts = {}) {
  return new WorkflowRunner(opts);
}
