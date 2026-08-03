import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Shield, Brain, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  fetchSkills,
  createSkill,
  updateSkill,
  deleteSkill,
} from '../../services/skillsApi';

const ICONS = ['🧠', '⚡', '🔧', '🎯', '🌐', '📝', '🔬', '💡', '🎨', '🛡️', '📊', '🚀'];

const SYSTEM_SKILL_NAMES = [
  'File & Directory Operations',
  'Network & Downloads',
  'Windows System Tasks',
  'PowerShell Style & Scripting',
  'Computer Use Guide',
  'PDF Generation Expert',
  'CamoFox Browser',
  'Job Application Assistant',
];

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
  const [expandedSkills, setExpandedSkills] = useState({});

  const toggleExpand = (id) => {
    setExpandedSkills((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

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

      {/* Skills List */}
      {!loading && skills.length > 0 && (() => {
        const currentBrowserEngine = localStorage.getItem("rie_browser_engine") || "default";
        const visibleSkills = skills.filter((skill) => {
          if (currentBrowserEngine === "default") {
            const lowerName = (skill.name || "").toLowerCase();
            if (lowerName.includes("camofox") || lowerName.includes("camoufox") || lowerName.includes("job application")) {
              return false;
            }
          }
          return true;
        });

        if (visibleSkills.length === 0) {
          return (
            <div className="border border-white/5 bg-white/[0.01] rounded-xl p-8 text-center space-y-2">
              <p className="text-xs text-neutral-500">No active skills available for default browser mode.</p>
            </div>
          );
        }

        return (
          <div className="flex flex-col gap-3">
            {visibleSkills.map((skill) => (
            <div
              key={skill.id}
              className={`premium-card rounded-xl border border-white/5 flex flex-col transition-all duration-200 ${
                skill.enabled ? 'bg-white/[0.01]' : 'opacity-60 hover:opacity-85'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4">
                {/* Left side: Icon, Name, Description */}
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="text-xl p-2 bg-white/5 rounded-lg border border-white/5 shrink-0 select-none">
                    {skill.icon || '🧠'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h5 className="text-xs font-bold text-neutral-200 truncate">{skill.name}</h5>
                      {(skill.is_system || SYSTEM_SKILL_NAMES.includes(skill.name)) && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700/60 flex items-center gap-1 shrink-0">
                          <Shield size={9} /> System
                        </span>
                      )}
                      <span className={`text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                        skill.enabled ? 'bg-emerald-950/20 text-emerald-400 border border-emerald-500/15' : 'bg-neutral-800 text-neutral-400 border border-neutral-700/50'
                      }`}>
                        {skill.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    {skill.description && (
                      <p className="text-[10px] text-neutral-500 truncate mt-1">{skill.description}</p>
                    )}
                  </div>
                </div>

                {/* Right side: Toggle, Chevron, Actions */}
                <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 border-t sm:border-t-0 border-white/5 pt-3 sm:pt-0">
                  {/* Toggle */}
                  <label className="skills-toggle" title={skill.enabled ? 'Enabled' : 'Disabled'}>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={() => handleToggleEnabled(skill)}
                    />
                    <span className="skills-toggle-slider" />
                  </label>

                  {/* Vertical divider */}
                  <div className="hidden sm:block h-6 w-px bg-white/5" />

                  {/* Action Buttons */}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => toggleExpand(skill.id)}
                      className="p-1.5 hover:bg-white/5 rounded-lg border border-transparent hover:border-white/5 text-neutral-400 hover:text-white transition-all"
                      title={expandedSkills[skill.id] ? "Hide Instructions" : "Show Instructions"}
                    >
                      <ChevronDown
                        size={12}
                        className={`transition-transform duration-200 ${expandedSkills[skill.id] ? 'rotate-180' : ''}`}
                      />
                    </button>
                    <button
                      onClick={() => openEdit(skill)}
                      className="p-1.5 hover:bg-white/5 rounded-lg border border-transparent hover:border-white/5 text-neutral-400 hover:text-white transition-all"
                      title="Edit"
                    >
                      <Pencil size={12} />
                    </button>

                    {skill.is_system || SYSTEM_SKILL_NAMES.includes(skill.name) ? (
                      <span className="p-1.5 text-neutral-600 cursor-not-allowed" title="System skill (Protected)">
                        <Shield size={12} className="text-neutral-500" />
                      </span>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(skill.id)}
                        className="p-1.5 hover:bg-red-500/10 rounded-lg border border-transparent hover:border-red-500/10 text-neutral-400 hover:text-red-400 transition-all"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Collapsible Content preview */}
              <AnimatePresence initial={false}>
                {expandedSkills[skill.id] && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden border-t border-white/5"
                  >
                    <div className="p-4 bg-black/25">
                      <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold mb-2">Instructions</div>
                      <div className="text-[10px] font-mono text-neutral-400 bg-black/35 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed border border-white/5 custom-scrollbar max-h-[160px]">
                        {skill.content}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
        );
      })()}

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
