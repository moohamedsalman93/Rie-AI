import { useState, useCallback } from 'react';
import { getThreadKnowledge } from '../services/knowledgeApi';

/**
 * Manages custom knowledge pack attachments in chat input.
 * Locked packs come from server thread state; pending packs are user-selected before send.
 */
export function useKnowledgeAttachment() {
  const [attachedKnowledge, setAttachedKnowledge] = useState([]);

  const loadThreadKnowledge = useCallback(async (threadId) => {
    if (!threadId) {
      setAttachedKnowledge([]);
      return;
    }
    try {
      const rows = await getThreadKnowledge(threadId);
      const locked = (rows || []).map((r) => ({
        id: r.knowledge_id,
        name: r.knowledge_name,
        locked: Boolean(r.is_locked),
      }));
      setAttachedKnowledge(locked);
    } catch (err) {
      console.error('Failed to load thread knowledge:', err);
      setAttachedKnowledge([]);
    }
  }, []);

  const attachKnowledge = useCallback((pack) => {
    if (!pack?.id) return;
    setAttachedKnowledge((prev) => {
      if (prev.some((k) => k.id === pack.id)) return prev;
      return [...prev, { id: pack.id, name: pack.name, locked: false }];
    });
  }, []);

  const detachKnowledge = useCallback((packId) => {
    setAttachedKnowledge((prev) => {
      const target = prev.find((k) => k.id === packId);
      if (!target || target.locked) return prev;
      return prev.filter((k) => k.id !== packId);
    });
  }, []);

  const getNewKnowledgeIds = useCallback(() => {
    return attachedKnowledge.filter((k) => !k.locked).map((k) => k.id);
  }, [attachedKnowledge]);

  const markAllLocked = useCallback(() => {
    setAttachedKnowledge((prev) =>
      prev.map((k) => ({ ...k, locked: true }))
    );
  }, []);

  return {
    attachedKnowledge,
    loadThreadKnowledge,
    attachKnowledge,
    detachKnowledge,
    getNewKnowledgeIds,
    markAllLocked,
  };
}
