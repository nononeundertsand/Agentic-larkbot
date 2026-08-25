export function artifactById(workflow = {}, artifactId = '') {
  return workflow.artifacts?.[String(artifactId || '')] || null;
}

export function latestArtifactByType(workflow = {}, type = '') {
  const artifacts = Object.values(workflow.artifacts || {})
    .filter((artifact) => artifact.type === type)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return artifacts[0] || null;
}

export function latestArtifactByIdOrType(workflow = {}, id = '', type = '') {
  return artifactById(workflow, id) || (type ? latestArtifactByType(workflow, type) : null);
}

export function artifactContent(workflow = {}, artifactId = '', fallbackType = '') {
  const artifact = latestArtifactByIdOrType(workflow, artifactId, fallbackType);
  return artifact?.content ?? null;
}
