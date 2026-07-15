import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Shield, Brain } from 'lucide-react';
import {
  fetchSkills,
  createSkill,
  updateSkill,
  deleteSkill,
} from '../../services/skillsApi';

const ICONS = ['🧠', '⚡', '🔧', '🎯', '🌐', '📝', '🔬', '💡', '🎨', '🛡️', '📊', '🚀'];

const EMPTY_FORM = {
  name: '',
  description: '',
  content: '',
  icon: '🧠',
  tool_ids: [],
};

export function SkillsManager() {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // null | 'create' | 'edit'
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchSkills();
      setSkills(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditTarget(null);
    setModal('create');
  }

  function openEdit(skill) {
    setForm({
      name: skill.name,
      description: skill.description || '',
      content: skill.content,
      icon: skill.icon || '🧠',
      tool_ids: skill.tool_ids || [],
    });
    setEditTarget(skill);
    setModal('edit');
  }

  function closeModal() {
    setModal(null);
    setEditTarget(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.content.trim()) return;
    setSaving(true);
    try {
      if (modal === 'create') {
        await createSkill(form);
      } else if (modal === 'edit' && editTarget) {
        await updateSkill(editTarget.id, form);
      }
      closeModal();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled(skill) {
    try {
      await updateSkill(skill.id, { enabled: !skill.enabled });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDelete(skillId) {
    try {
      await deleteSkill(skillId);
      setDeleteConfirm(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="space-y-4">
      {/* Action Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500 leading-relaxed max-w-md">
          Define global behavior instructions and rules. Click the enable toggle to activate them globally.
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 border border-emerald-500 hover:border-emerald-400 rounded-lg text-xs font-semibold text-white transition-all shadow-[0_0_12px_rgba(16,185,129,0.1)] shrink-0"
        >
          <Plus size={14} />
          Create Skill
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-950/20 border border-red-500/30 text-red-400 rounded-xl p-3 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center p-8 gap-2 text-xs text-neutral-500">
          <div className="w-5 h-5 border-2 border-white/10 border-t-emerald-500 rounded-full animate-spin" />
          <span>Loading skills library…</span>
        </div>
      )}

      {/* Empty State */}
      {!loading && skills.length === 0 && (
        <div className="border border-white/5 bg-white/[0.01] rounded-xl p-8 text-center space-y-3">
          <div className="text-3xl text-neutral-600">🧠</div>
          <h5 className="text-sm font-semibold text-neutral-300">No skills in library</h5>
          <p className="text-xs text-neutral-500 max-w-xs mx-auto">
            Skills are custom instruction lists (like CLAUDE.md guidelines) that the agent follows during conversations.
          </p>
          <button
            onClick={openCreate}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 hover:border-neutral-600 rounded-lg text-xs font-semibold text-neutral-300 transition-all"
          >
            Create First Skill
          </button>
        </div>
      )}

      {/* Skills Grid */}
      {!loading && skills.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className={`premium-card rounded-xl p-4 border border-white/5 flex flex-col justify-between gap-3 transition-all duration-200 ${
                skill.enabled ? 'bg-white/[0.01]' : 'opacity-50 hover:opacity-75'
              }`}
            >
              <div className="space-y-2">
                {/* Card Top */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="text-xl p-1.5 bg-white/5 rounded-lg border border-white/5">
                      {skill.icon || '🧠'}
                    </div>
                    <div>
                      <h5 className="text-xs font-bold text-neutral-200">{skill.name}</h5>
                      {skill.description && (
                        <p className="text-[10px] text-neutral-500">{skill.description}</p>
                      )}
                    </div>
                  </div>

                  {/* Toggle */}
                  <label className="skills-toggle" title={skill.enabled ? 'Enabled' : 'Disabled'}>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={() => handleToggleEnabled(skill)}
                    />
                    <span className="skills-toggle-slider" />
                  </label>
                </div>

                {/* Content preview */}
                <div className="text-[10px] font-mono text-neutral-400 bg-black/35 rounded-lg p-2.5 max-h-[80px] overflow-hidden text-ellipsis whitespace-pre-wrap leading-relaxed border border-white/5">
                  {skill.content}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between border-t border-white/5 pt-3">
                <span className={`text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${
                  skill.enabled ? 'bg-emerald-950/20 text-emerald-400 border border-emerald-500/15' : 'bg-neutral-800 text-neutral-400 border border-neutral-700/50'
                }`}>
                  {skill.enabled ? 'Enabled' : 'Disabled'}
                </span>
                
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => openEdit(skill)}
                    className="p-1.5 hover:bg-white/5 rounded-lg border border-transparent hover:border-white/5 text-neutral-400 hover:text-white transition-all"
                    title="Edit"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(skill.id)}
                    className="p-1.5 hover:bg-red-500/10 rounded-lg border border-transparent hover:border-red-500/10 text-neutral-400 hover:text-red-400 transition-all"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal overlay */}
      {modal && (
        <div className="skills-modal-backdrop" onClick={closeModal}>
          <div className="skills-modal" onClick={(e) => e.stopPropagation()}>
            <div className="skills-modal-header">
              <h3>{modal === 'create' ? 'Create Skill' : 'Edit Skill'}</h3>
              <button className="skills-btn-icon" onClick={closeModal}>✕</button>
            </div>
            
            <div className="skills-modal-body">
              {/* Icon selection */}
              <label className="skills-field-label">Choose Icon</label>
              <div className="skills-icon-picker">
                {ICONS.map((ic) => (
                  <button
                    key={ic}
                    className={`skills-icon-btn ${form.icon === ic ? 'selected' : ''}`}
                    onClick={() => setForm({ ...form, icon: ic })}
                  >
                    {ic}
                  </button>
                ))}
              </div>

              {/* Name input */}
              <label className="skills-field-label">Name <span className="skills-required">*</span></label>
              <input
                className="skills-input"
                placeholder="e.g. Python Expert"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />

              {/* Description input */}
              <label className="skills-field-label">Description</label>
              <input
                className="skills-input"
                placeholder="Brief summary of rule context"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />

              {/* Instructions input */}
              <label className="skills-field-label">Instructions <span className="skills-required">*</span></label>
              <p className="skills-field-hint">Markdown supported. Injected into system prompt.</p>
              <textarea
                className="skills-textarea"
                rows={8}
                placeholder="Always use descriptive naming for Python variables..."
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
            </div>

            <div className="skills-modal-footer">
              <button className="skills-btn-ghost" onClick={closeModal}>Cancel</button>
              <button
                className="skills-btn-primary"
                disabled={saving || !form.name.trim() || !form.content.trim()}
                onClick={handleSave}
              >
                {saving ? 'Saving…' : modal === 'create' ? 'Create Skill' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal overlay */}
      {deleteConfirm && (
        <div className="skills-modal-backdrop" onClick={() => setDeleteConfirm(null)}>
          <div className="skills-modal skills-modal--compact" onClick={(e) => e.stopPropagation()}>
            <div className="skills-modal-header">
              <h3>Delete Skill</h3>
              <button className="skills-btn-icon" onClick={() => setDeleteConfirm(null)}>✕</button>
            </div>
            <div className="skills-modal-body">
              <p className="text-xs text-neutral-400">Are you sure you want to permanently delete this skill?</p>
            </div>
            <div className="skills-modal-footer">
              <button className="skills-btn-ghost" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="skills-btn-danger"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default SkillsManager;
