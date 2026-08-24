import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkflow } from './workflow-schema.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_STATE_FILE = join(__dirname, '..', '.local', 'state', 'runtime-state.json');
const DEFAULT_EVENT_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_MAX_PROCESSED_EVENTS = 5000;
const DEFAULT_MAX_RUNS = 1000;
const DEFAULT_MAX_TOOL_CALLS = 5000;
const DEFAULT_MAX_WORKFLOWS = 200;

function nowMs() {
  return Date.now();
}

function defaultData() {
  return {
    schemaVersion: 1,
    processedEvents: {},
    approvals: {},
    agentRuns: [],
    toolCalls: [],
    memoryJobs: [],
    workflows: {},
    persona: {
      defaultPersonaId: '',
      defaultUpdatedAt: '',
      defaultUpdatedBy: '',
      chatPersonas: {},
      lastSelections: {},
    },
    updatedAt: new Date().toISOString(),
  };
}

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function normalizePersonaEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const personaId = entry.trim();
    return personaId ? { personaId, updatedAt: '', updatedBy: '' } : null;
  }
  if (typeof entry !== 'object' || Array.isArray(entry)) return null;
  const personaId = String(entry.personaId || '').trim();
  if (!personaId) return null;
  return {
    personaId,
    updatedAt: String(entry.updatedAt || ''),
    updatedBy: String(entry.updatedBy || ''),
  };
}

function normalizePersonaState(input = {}) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const chatPersonas = {};
  for (const [chatId, entry] of Object.entries(state.chatPersonas || {})) {
    const normalized = normalizePersonaEntry(entry);
    if (String(chatId || '').trim() && normalized) chatPersonas[chatId] = normalized;
  }
  const lastSelections = {};
  for (const [key, entry] of Object.entries(state.lastSelections || {})) {
    if (!String(key || '').trim() || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    lastSelections[key] = {
      personaId: String(entry.personaId || ''),
      source: String(entry.source || ''),
      reason: String(entry.reason || ''),
      answerMode: String(entry.answerMode || ''),
      selectedAt: String(entry.selectedAt || ''),
    };
  }
  return {
    defaultPersonaId: String(state.defaultPersonaId || ''),
    defaultUpdatedAt: String(state.defaultUpdatedAt || ''),
    defaultUpdatedBy: String(state.defaultUpdatedBy || ''),
    chatPersonas,
    lastSelections,
  };
}

export class RuntimeStateStore {
  constructor({
    file = process.env.AGENT_STATE_FILE || DEFAULT_STATE_FILE,
    enabled = (process.env.AGENT_STATE || 'on').toLowerCase() !== 'off',
    processedEventTtlMs = Number(process.env.AGENT_STATE_EVENT_TTL_MS || DEFAULT_EVENT_TTL_MS),
    maxProcessedEvents = Number(process.env.AGENT_STATE_MAX_EVENTS || DEFAULT_MAX_PROCESSED_EVENTS),
    maxAgentRuns = Number(process.env.AGENT_STATE_MAX_RUNS || DEFAULT_MAX_RUNS),
    maxToolCalls = Number(process.env.AGENT_STATE_MAX_TOOL_CALLS || DEFAULT_MAX_TOOL_CALLS),
    maxWorkflows = Number(process.env.AGENT_STATE_MAX_WORKFLOWS || DEFAULT_MAX_WORKFLOWS),
    logger = console,
  } = {}) {
    this.file = file;
    this.enabled = Boolean(enabled);
    this.processedEventTtlMs = Math.max(0, Number(processedEventTtlMs) || DEFAULT_EVENT_TTL_MS);
    this.maxProcessedEvents = Math.max(1, Number(maxProcessedEvents) || DEFAULT_MAX_PROCESSED_EVENTS);
    this.maxAgentRuns = Math.max(1, Number(maxAgentRuns) || DEFAULT_MAX_RUNS);
    this.maxToolCalls = Math.max(1, Number(maxToolCalls) || DEFAULT_MAX_TOOL_CALLS);
    this.maxWorkflows = Math.max(1, Number(maxWorkflows) || DEFAULT_MAX_WORKFLOWS);
    this.logger = logger;
    this.data = defaultData();
    if (this.enabled) this.load();
  }

  load() {
    if (!this.enabled || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('state 文件不是对象');
      this.data = {
        ...defaultData(),
        ...data,
        processedEvents: data.processedEvents && typeof data.processedEvents === 'object' ? data.processedEvents : {},
        approvals: data.approvals && typeof data.approvals === 'object' ? data.approvals : {},
        agentRuns: Array.isArray(data.agentRuns) ? data.agentRuns : [],
        toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : [],
        memoryJobs: Array.isArray(data.memoryJobs) ? data.memoryJobs : [],
        persona: normalizePersonaState(data.persona),
        workflows: data.workflows && typeof data.workflows === 'object' && !Array.isArray(data.workflows)
          ? Object.fromEntries(Object.entries(data.workflows).map(([id, workflow]) => {
            const normalized = normalizeWorkflow({ workflowId: id, ...workflow });
            return [normalized.workflowId, normalized];
          }))
          : {},
      };
      this.pruneAll({ save: false });
    } catch (err) {
      this.logger.warn?.('[state] 读取运行状态失败，使用空状态：', err.message);
      this.data = defaultData();
    }
  }

  save() {
    if (!this.enabled) return;
    this.data.updatedAt = new Date().toISOString();
    try {
      atomicWriteJson(this.file, this.data);
    } catch (err) {
      this.logger.warn?.('[state] 保存运行状态失败：', err.message);
    }
  }

  pruneAll({ save = true } = {}) {
    this.pruneProcessedEvents({ save: false });
    this.pruneAgentRuns({ save: false });
    this.pruneToolCalls({ save: false });
    this.pruneWorkflows({ save: false });
    if (save) this.save();
  }

  listProcessedEventIds() {
    this.pruneProcessedEvents({ save: false });
    return Object.keys(this.data.processedEvents || {});
  }

  rememberProcessedEvent(id, meta = {}) {
    const key = String(id || '').trim();
    if (!key) return false;
    if (!this.enabled) return false;
    this.pruneProcessedEvents({ save: false });
    if (this.data.processedEvents[key]) return true;
    this.data.processedEvents[key] = {
      id: key,
      at: nowMs(),
      eventTime: Number(meta.eventTime) || 0,
      chatId: meta.chatId || '',
      senderId: meta.senderId || '',
    };
    this.pruneProcessedEvents({ save: false });
    this.save();
    return false;
  }

  forgetProcessedEvent(id) {
    const key = String(id || '').trim();
    if (!key || !this.enabled) return;
    if (this.data.processedEvents[key]) {
      delete this.data.processedEvents[key];
      this.save();
    }
  }

  pruneProcessedEvents({ save = true } = {}) {
    const entries = Object.entries(this.data.processedEvents || {});
    const cutoff = this.processedEventTtlMs > 0 ? nowMs() - this.processedEventTtlMs : 0;
    const kept = entries
      .filter(([, value]) => !cutoff || Number(value?.at) >= cutoff)
      .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
      .slice(0, this.maxProcessedEvents);
    this.data.processedEvents = Object.fromEntries(kept);
    if (save) this.save();
  }

  loadApprovals({ ttlMs } = {}) {
    if (!this.enabled) return [];
    const ttl = Math.max(0, Number(ttlMs) || 0);
    const now = nowMs();
    const out = [];
    let changed = false;
    for (const [key, action] of Object.entries(this.data.approvals || {})) {
      if (!action || typeof action !== 'object') {
        delete this.data.approvals[key];
        changed = true;
        continue;
      }
      if (ttl > 0 && now - Number(action.at || 0) >= ttl) {
        delete this.data.approvals[key];
        changed = true;
        continue;
      }
      out.push(action);
    }
    if (changed) this.save();
    return out;
  }

  saveApproval(confirmationKey, action) {
    const key = String(confirmationKey || '').trim();
    if (!key || !this.enabled) return;
    const cloned = safeClone(action);
    if (!cloned) return;
    this.data.approvals[key] = cloned;
    this.save();
  }

  deleteApproval(confirmationKey) {
    const key = String(confirmationKey || '').trim();
    if (!key || !this.enabled) return;
    if (this.data.approvals[key]) {
      delete this.data.approvals[key];
      this.save();
    }
  }

  recordAgentRun(run) {
    if (!this.enabled) return;
    const cloned = safeClone(run);
    if (!cloned) return;
    this.data.agentRuns.push({ ...cloned, at: nowMs() });
    this.pruneAgentRuns({ save: false });
    this.save();
  }

  recordToolCall(call) {
    if (!this.enabled) return;
    const cloned = safeClone(call);
    if (!cloned) return;
    this.data.toolCalls.push({ ...cloned, at: nowMs() });
    this.pruneToolCalls({ save: false });
    this.save();
  }

  pruneAgentRuns({ save = true } = {}) {
    this.data.agentRuns = (this.data.agentRuns || []).slice(-this.maxAgentRuns);
    if (save) this.save();
  }

  pruneToolCalls({ save = true } = {}) {
    this.data.toolCalls = (this.data.toolCalls || []).slice(-this.maxToolCalls);
    if (save) this.save();
  }

  saveWorkflow(workflow) {
    if (!this.enabled) return false;
    const cloned = safeClone(workflow);
    const workflowId = String(cloned?.workflowId || '').trim();
    if (!cloned || !workflowId) return false;
    const now = new Date().toISOString();
    const normalized = normalizeWorkflow(cloned);
    this.data.workflows[workflowId] = {
      ...normalized,
      workflowId,
      createdAt: normalized.createdAt || now,
      updatedAt: now,
    };
    this.pruneWorkflows({ save: false });
    this.save();
    return true;
  }

  getWorkflow(workflowId) {
    const id = String(workflowId || '').trim();
    if (!id) return null;
    return safeClone(this.data.workflows?.[id] || null);
  }

  listWorkflows({ status, sessionKey } = {}) {
    const items = Object.values(this.data.workflows || {});
    return items
      .filter((workflow) => !status || workflow.status === status)
      .filter((workflow) => !sessionKey || workflow.sessionKey === sessionKey)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((workflow) => safeClone(workflow));
  }

  updateWorkflow(workflowId, patchOrUpdater) {
    if (!this.enabled) return null;
    const current = this.getWorkflow(workflowId);
    if (!current) return null;
    const patch = typeof patchOrUpdater === 'function'
      ? patchOrUpdater(safeClone(current))
      : patchOrUpdater;
    const next = {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      workflowId: current.workflowId,
    };
    return this.saveWorkflow(next) ? this.getWorkflow(current.workflowId) : null;
  }

  deleteWorkflow(workflowId) {
    const id = String(workflowId || '').trim();
    if (!id || !this.enabled) return false;
    if (!this.data.workflows?.[id]) return false;
    delete this.data.workflows[id];
    this.save();
    return true;
  }

  pruneWorkflows({ save = true } = {}) {
    const entries = Object.entries(this.data.workflows || {})
      .sort((a, b) => {
        const at = Date.parse(a[1]?.updatedAt || a[1]?.createdAt || 0) || 0;
        const bt = Date.parse(b[1]?.updatedAt || b[1]?.createdAt || 0) || 0;
        return bt - at;
      })
      .slice(0, this.maxWorkflows);
    this.data.workflows = Object.fromEntries(entries);
    if (save) this.save();
  }

  getPersonaState() {
    this.data.persona = normalizePersonaState(this.data.persona);
    return safeClone(this.data.persona);
  }

  setDefaultPersonaId(personaId, { updatedBy = '' } = {}) {
    const id = String(personaId || '').trim();
    if (!id || !this.enabled) return null;
    this.data.persona = normalizePersonaState(this.data.persona);
    this.data.persona.defaultPersonaId = id;
    this.data.persona.defaultUpdatedAt = new Date().toISOString();
    this.data.persona.defaultUpdatedBy = String(updatedBy || '');
    this.save();
    return this.getPersonaState();
  }

  setChatPersonaId(chatId, personaId, { updatedBy = '' } = {}) {
    const key = String(chatId || '').trim();
    const id = String(personaId || '').trim();
    if (!key || !id || !this.enabled) return null;
    this.data.persona = normalizePersonaState(this.data.persona);
    this.data.persona.chatPersonas[key] = {
      personaId: id,
      updatedAt: new Date().toISOString(),
      updatedBy: String(updatedBy || ''),
    };
    this.save();
    return this.getPersonaState();
  }

  clearChatPersonaId(chatId) {
    const key = String(chatId || '').trim();
    if (!key || !this.enabled) return null;
    this.data.persona = normalizePersonaState(this.data.persona);
    delete this.data.persona.chatPersonas[key];
    this.save();
    return this.getPersonaState();
  }

  recordPersonaSelection({ scopeKey = '', chatId = '', personaId = '', source = '', reason = '', answerMode = '' } = {}) {
    if (!this.enabled) return false;
    const key = String(scopeKey || (chatId ? `chat:${chatId}` : 'global')).trim();
    const id = String(personaId || '').trim();
    if (!key || !id) return false;
    this.data.persona = normalizePersonaState(this.data.persona);
    this.data.persona.lastSelections[key] = {
      personaId: id,
      source: String(source || ''),
      reason: String(reason || ''),
      answerMode: String(answerMode || ''),
      selectedAt: new Date().toISOString(),
    };
    this.save();
    return true;
  }
}
