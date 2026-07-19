import { useState, useEffect, useRef } from 'react';
import { Plus, BookOpen, Pencil, Trash2, Upload, Loader2 } from 'lucide-react';
import { ConfirmationModal } from '../ConfirmationModal';
import {
  listKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  getKnowledge,
  uploadKnowledgeAsset,
  deleteKnowledgeAsset,
} from '../../services/knowledgeApi';

export function KnowledgeManager() {
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedDetail, setExpandedDetail] = useState(null);
  const [form, setForm] = useState({ name: '', instructions: '' });
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteAssetTarget, setDeleteAssetTarget] = useState(null);
  const fileInputRef = useRef(null);

  const refreshList = async () => {
    setLoading(true);
    try {
      const rows = await listKnowledge();
      setPacks(rows || []);
    } catch (e) {
      setError(e.message || 'Failed to load knowledge packs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshList();
  }, []);

  const loadDetail = async (packId) => {
    try {
      const detail = await getKnowledge(packId);
      setExpandedDetail(detail);
    } catch (e) {
      setError(e.message || 'Failed to load pack detail');
    }
  };

  const handleToggleExpand = async (packId) => {
    if (expandedId === packId) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(packId);
    await loadDetail(packId);
  };

  const handleSavePack = async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      if (editingId) {
        await updateKnowledge(editingId, { name: form.name.trim(), instructions: form.instructions });
      } else {
        await createKnowledge({ name: form.name.trim(), instructions: form.instructions });
      }
      setIsAdding(false);
      setEditingId(null);
      setForm({ name: '', instructions: '' });
      await refreshList();
    } catch (e) {
      setError(e.message || 'Failed to save knowledge pack');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (pack) => {
    setEditingId(pack.id);
    setIsAdding(true);
    setForm({ name: pack.name || '', instructions: pack.instructions || '' });
    setError(null);
  };

  const handleDeletePack = async () => {
    if (!deleteTarget) return;
    setIsSaving(true);
    try {
      await deleteKnowledge(deleteTarget);
      setDeleteTarget(null);
      if (expandedId === deleteTarget) {
        setExpandedId(null);
        setExpandedDetail(null);
      }
      await refreshList();
    } catch (e) {
      setError(e.message || 'Failed to delete pack');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUploadClick = (packId) => {
    setExpandedId(packId);
    fileInputRef.current?.setAttribute('data-pack-id', packId);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    const packId = e.target.getAttribute('data-pack-id') || expandedId;
    e.target.value = '';
    if (!file || !packId) return;
    setUploadingAsset(true);
    setError(null);
    try {
      await uploadKnowledgeAsset(packId, file);
      await loadDetail(packId);
      await refreshList();
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploadingAsset(false);
    }
  };

  const handleDeleteAsset = async () => {
    if (!deleteAssetTarget) return;
    const { packId, assetId } = deleteAssetTarget;
    setIsSaving(true);
    try {
      await deleteKnowledgeAsset(packId, assetId);
      setDeleteAssetTarget(null);
      await loadDetail(packId);
      await refreshList();
    } catch (e) {
      setError(e.message || 'Failed to delete asset');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <input ref={fileInputRef} type="file" className="hidden" accept=".txt,.md,.json,.yaml,.yml,.csv,.xml,.html,.htm,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.scss,.sql,.sh,.bat,.ps1,.toml,.ini,.cfg,.log,.png,.jpg,.jpeg,.gif,.webp,.bmp" onChange={handleFileChange} />

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-neutral-500">
          {loading ? 'Loading…' : packs.length === 0 ? 'No knowledge packs yet' : `${packs.length} pack${packs.length !== 1 ? 's' : ''}`}
        </div>
        {!isAdding && (
          <button
            type="button"
            onClick={() => {
              setIsAdding(true);
              setEditingId(null);
              setForm({ name: '', instructions: '' });
              setError(null);
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs border border-dashed border-neutral-700 hover:border-emerald-500/50 hover:bg-emerald-500/5 text-neutral-400 hover:text-emerald-400 rounded-lg transition-all"
          >
            <Plus size={12} />
            Add Knowledge
          </button>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
      )}

      {isAdding && (
        <div className="p-5 bg-neutral-800/50 border border-neutral-700 rounded-xl space-y-4">
          <h4 className="text-sm font-medium text-neutral-200">{editingId ? 'Edit Knowledge Pack' : 'New Knowledge Pack'}</h4>
          <div className="space-y-1.5">
            <label className="text-[10px] tracking-wider text-neutral-500 font-medium">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Project docs"
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] tracking-wider text-neutral-500 font-medium">Custom instructions</label>
            <textarea
              value={form.instructions}
              onChange={(e) => setForm((p) => ({ ...p, instructions: e.target.value }))}
              rows={4}
              placeholder="How should the assistant use this knowledge?"
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 resize-y"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setIsAdding(false); setEditingId(null); setError(null); }} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200">Cancel</button>
            <button type="button" onClick={handleSavePack} disabled={isSaving} className="px-4 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50">
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {packs.map((pack) => (
          <div key={pack.id} className="bg-neutral-800/30 border border-neutral-700/50 rounded-xl overflow-hidden hover:border-neutral-600 transition-all">
            <div className="p-4 flex items-center justify-between gap-2">
              <button type="button" onClick={() => handleToggleExpand(pack.id)} className="flex items-center gap-3 text-left flex-1 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300">
                  <BookOpen size={16} />
                </div>
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-neutral-100 truncate">{pack.name}</h4>
                  <p className="text-[11px] text-neutral-500">{pack.asset_count || 0} file{(pack.asset_count || 0) !== 1 ? 's' : ''}</p>
                </div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" onClick={() => handleUploadClick(pack.id)} disabled={uploadingAsset} className="p-2 text-neutral-500 hover:text-emerald-400 transition-colors disabled:opacity-50" title="Upload file">
                  {uploadingAsset && expandedId === pack.id ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                </button>
                <button type="button" onClick={() => handleEdit(pack)} className="p-2 text-neutral-500 hover:text-neutral-200 transition-colors" title="Edit">
                  <Pencil size={15} />
                </button>
                <button type="button" onClick={() => setDeleteTarget(pack.id)} className="p-2 text-neutral-500 hover:text-red-400 transition-colors" title="Delete">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            {expandedId === pack.id && expandedDetail && (
              <div className="px-4 pb-4 border-t border-neutral-700/50 pt-3 space-y-2">
                {(expandedDetail.instructions || '').trim() && (
                  <p className="text-xs text-neutral-400 whitespace-pre-wrap">{expandedDetail.instructions}</p>
                )}
                {(expandedDetail.assets || []).length === 0 ? (
                  <p className="text-xs text-neutral-600 italic">No files uploaded yet.</p>
                ) : (
                  expandedDetail.assets.map((asset) => (
                    <div key={asset.id} className="rounded-lg bg-neutral-900/60 border border-neutral-700/40 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-neutral-200 truncate">{asset.filename}</div>
                          <div className="text-[10px] text-neutral-600 uppercase mt-0.5">{asset.asset_type}</div>
                        </div>
                        <button type="button" onClick={() => setDeleteAssetTarget({ packId: pack.id, assetId: asset.id })} className="text-neutral-500 hover:text-red-400 p-1">
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {asset.summary && (
                        <p className="text-[11px] text-neutral-400 mt-2 line-clamp-4 whitespace-pre-wrap">{asset.summary}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmationModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeletePack}
        title="Delete knowledge pack?"
        message="This removes the pack and all uploaded files. Locked conversations keep their snapshot."
        confirmText="Delete"
      />
      <ConfirmationModal
        isOpen={Boolean(deleteAssetTarget)}
        onClose={() => setDeleteAssetTarget(null)}
        onConfirm={handleDeleteAsset}
        title="Delete file?"
        message="Remove this file and its summary from the knowledge pack."
        confirmText="Delete"
      />
    </div>
  );
}
