/**
 * API service for custom knowledge packs
 */

import { getAppToken } from "./chatApi";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:14300";

function getHeaders() {
  const headers = { "Content-Type": "application/json" };
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

async function throwHttpError(response, fallback) {
  let detail = fallback;
  try {
    const body = await response.json();
    if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* ignore */
  }
  throw new Error(detail);
}

export async function listKnowledge() {
  const response = await fetch(`${API_BASE_URL}/knowledge`, { headers: getHeaders() });
  if (!response.ok) await throwHttpError(response, "Failed to list knowledge packs");
  return response.json();
}

export async function getKnowledge(packId) {
  const response = await fetch(`${API_BASE_URL}/knowledge/${encodeURIComponent(packId)}`, {
    headers: getHeaders(),
  });
  if (!response.ok) await throwHttpError(response, "Failed to load knowledge pack");
  return response.json();
}

export async function createKnowledge({ name, instructions = "" }) {
  const response = await fetch(`${API_BASE_URL}/knowledge`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ name, instructions }),
  });
  if (!response.ok) await throwHttpError(response, "Failed to create knowledge pack");
  return response.json();
}

export async function updateKnowledge(packId, { name, instructions }) {
  const response = await fetch(`${API_BASE_URL}/knowledge/${encodeURIComponent(packId)}`, {
    method: "PUT",
    headers: getHeaders(),
    body: JSON.stringify({ name, instructions }),
  });
  if (!response.ok) await throwHttpError(response, "Failed to update knowledge pack");
  return response.json();
}

export async function deleteKnowledge(packId) {
  const response = await fetch(`${API_BASE_URL}/knowledge/${encodeURIComponent(packId)}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  if (!response.ok) await throwHttpError(response, "Failed to delete knowledge pack");
  return response.json();
}

export async function uploadKnowledgeAsset(packId, file) {
  const form = new FormData();
  form.append("file", file);
  const headers = {};
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
  const response = await fetch(`${API_BASE_URL}/knowledge/${encodeURIComponent(packId)}/assets`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) await throwHttpError(response, "Failed to upload asset");
  return response.json();
}

export async function deleteKnowledgeAsset(packId, assetId) {
  const response = await fetch(
    `${API_BASE_URL}/knowledge/${encodeURIComponent(packId)}/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE", headers: getHeaders() }
  );
  if (!response.ok) await throwHttpError(response, "Failed to delete asset");
  return response.json();
}

export async function updateKnowledgeAsset(packId, assetId, { summary, filename }) {
  const response = await fetch(
    `${API_BASE_URL}/knowledge/${encodeURIComponent(packId)}/assets/${encodeURIComponent(assetId)}`,
    {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify({ summary, filename }),
    }
  );
  if (!response.ok) await throwHttpError(response, "Failed to update asset");
  return response.json();
}

export async function getThreadKnowledge(threadId) {
  const response = await fetch(`${API_BASE_URL}/threads/${encodeURIComponent(threadId)}/knowledge`, {
    headers: getHeaders(),
  });
  if (!response.ok) await throwHttpError(response, "Failed to load thread knowledge");
  return response.json();
}
