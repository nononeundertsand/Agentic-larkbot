export const DOC_REPORT_GATES = Object.freeze({
  sourcesIdentified: 'gate_sources_identified',
  documentsRead: 'gate_documents_read',
  reportCitations: 'gate_report_citations',
  reportDraftReady: 'gate_report_draft_ready',
  reportDocumentCreated: 'gate_report_document_created',
  deliveryConfirmed: 'gate_delivery_confirmed',
});

export function defaultDocReportGates() {
  return [
    {
      id: DOC_REPORT_GATES.sourcesIdentified,
      title: '来源已识别',
      acceptance: '至少识别到一个可读取来源；如果没有来源，必须明确请求用户补充链接。',
      requiredEvidence: ['artifact:doc_sources'],
    },
    {
      id: DOC_REPORT_GATES.documentsRead,
      title: '文档已读取',
      acceptance: '每个来源都读取成功，或读取失败已记录为结构化失败证据。',
      requiredEvidence: ['artifact:doc_contents'],
    },
    {
      id: DOC_REPORT_GATES.reportCitations,
      title: '报告引用完整',
      acceptance: '报告中的关键结论必须带 citation，引用缺失时不得完成。',
      requiredEvidence: ['artifact:citation_coverage'],
    },
    {
      id: DOC_REPORT_GATES.reportDraftReady,
      title: '报告草稿就绪',
      acceptance: '已生成可供用户确认的 Markdown 报告草稿。',
      requiredEvidence: ['artifact:report_draft'],
    },
    {
      id: DOC_REPORT_GATES.reportDocumentCreated,
      title: '飞书文档已生成',
      acceptance: '报告草稿已创建为飞书文档，并记录可访问的文档 URL。',
      requiredEvidence: ['artifact:report_document'],
    },
    {
      id: DOC_REPORT_GATES.deliveryConfirmed,
      title: '发送前已确认',
      acceptance: '向群聊或其它目标发送报告前必须获得主人确认。',
      requiredEvidence: ['user_confirmation'],
    },
  ];
}

export function defaultDocReportSteps({ confirmationMessage = '' } = {}) {
  return [
    {
      id: 'extract_sources',
      type: 'plan',
      title: '识别文档来源',
      gateIds: [DOC_REPORT_GATES.sourcesIdentified],
      acceptance: '从用户目标中提取文档 URL 或 token。',
    },
    {
      id: 'read_documents',
      type: 'tool',
      title: '读取文档内容',
      depends: ['extract_sources'],
      gateIds: [DOC_REPORT_GATES.documentsRead],
      acceptance: '读取所有已识别来源，失败来源必须记录原因。',
    },
    {
      id: 'chunk_documents',
      type: 'transform',
      title: '切分文档并建立引用',
      depends: ['read_documents'],
      acceptance: '按段落切分内容，给每个 chunk 建立 citation。',
    },
    {
      id: 'draft_report',
      type: 'transform',
      title: '生成报告草稿',
      depends: ['chunk_documents'],
      gateIds: [DOC_REPORT_GATES.reportDraftReady],
      acceptance: '生成结构化 Markdown 报告草稿。',
    },
    {
      id: 'verify_citations',
      type: 'verify',
      title: '检查引用覆盖',
      depends: ['draft_report'],
      gateIds: [DOC_REPORT_GATES.reportCitations],
      acceptance: '确认每个关键结论都带有 citation。',
    },
    {
      id: 'create_report_document',
      type: 'tool',
      title: '生成飞书文档',
      depends: ['verify_citations'],
      gateIds: [DOC_REPORT_GATES.reportDocumentCreated],
      acceptance: '将报告草稿创建为飞书文档并记录 URL。',
    },
    {
      id: 'confirm_delivery',
      type: 'confirm',
      title: '确认发送报告',
      depends: ['create_report_document'],
      gateIds: [DOC_REPORT_GATES.deliveryConfirmed],
      input: {
        reason: confirmationMessage || '报告文档已生成，发送前需要确认。',
        message: confirmationMessage || '报告文档已生成，是否发送链接到当前会话？',
        actionId: 'doc_report_confirm_delivery',
        gateUpdates: [{
          gateId: DOC_REPORT_GATES.deliveryConfirmed,
          status: 'passed',
          evidenceRefs: ['user_confirmation'],
        }],
      },
    },
    {
      id: 'send_or_save',
      type: 'send',
      title: '发送或保存报告',
      depends: ['confirm_delivery'],
      acceptance: '确认后发送到目标会话；若没有发送目标，则保留为 workflow artifact。',
    },
  ];
}
