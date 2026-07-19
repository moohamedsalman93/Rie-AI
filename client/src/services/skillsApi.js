/**
 * Skills API service — CRUD and thread-skill attachment
 */

import { getAppToken } from "./chatApi";

const BASE_URL = 'http://127.0.0.1:14300';

function getHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  try {
    const token = localStorage.getItem("rie_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  const appToken = getAppToken();
  if (appToken) {
    headers["X-Rie-App-Token"] = appToken;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Skills CRUD
// ---------------------------------------------------------------------------

export async function fetchSkills() {
  const res = await fetch(`${BASE_URL}/skills`, {
    headers: getHeaders()
  });
  if (!res.ok) throw new Error(`Failed to fetch skills: ${res.statusText}`);
  return res.json();
}

export async function fetchSkill(skillId) {
  const res = await fetch(`${BASE_URL}/skills/${skillId}`, {
    headers: getHeaders()
  });
  if (!res.ok) throw new Error(`Failed to fetch skill: ${res.statusText}`);
  return res.json();
}

export async function createSkill({ name, description = '', content, icon = '🧠', tool_ids = [] }) {
  const res = await fetch(`${BASE_URL}/skills`, {
    method: 'POST',
    headers: getHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, description, content, icon, tool_ids }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to create skill');
  }
  return res.json();
}

export async function updateSkill(skillId, updates) {
  const res = await fetch(`${BASE_URL}/skills/${skillId}`, {
    method: 'PUT',
    headers: getHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to update skill');
  }
  return res.json();
}

export async function deleteSkill(skillId) {
  const res = await fetch(`${BASE_URL}/skills/${skillId}`, {
    method: 'DELETE',
    headers: getHeaders()
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to delete skill');
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Thread ↔ Skill attachment
// ---------------------------------------------------------------------------

export async function fetchThreadSkills(threadId) {
  if (!threadId) return [];
  const res = await fetch(`${BASE_URL}/threads/${threadId}/skills`, {
    headers: getHeaders()
  });
  if (!res.ok) return [];
  return res.json();
}

export async function attachSkillToThread(threadId, skillId) {
  const res = await fetch(`${BASE_URL}/threads/${threadId}/skills/${skillId}`, {
    method: 'POST',
    headers: getHeaders()
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to attach skill');
  }
  return res.json();
}

export async function detachSkillFromThread(threadId, skillId) {
  const res = await fetch(`${BASE_URL}/threads/${threadId}/skills/${skillId}`, {
    method: 'DELETE',
    headers: getHeaders()
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to detach skill');
  }
  return res.json();
}

export async function fetchActiveSkills(threadId, projectRoot) {
  const url = new URL(`${BASE_URL}/skills/active`);
  if (threadId) url.searchParams.append('thread_id', threadId);
  if (projectRoot) url.searchParams.append('project_root', projectRoot);
  const res = await fetch(url, {
    headers: getHeaders()
  });
  if (!res.ok) return [];
  return res.json();
}
