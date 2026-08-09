import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  BookOpen,
  Pencil,
  Trash2,
  Upload,
  Loader2,
  FileText,
  Image as ImageIcon,
  Eye,
  X,
  Copy,
  Check,
  Sparkles,
  Maximize2,
  Save,
  FileCode,
} from 'lucide-react';
import { ConfirmationModal } from '../ConfirmationModal';
import {
  listKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  getKnowledge,
  uploadKnowledgeAsset,
  createRawTextAsset,
  deleteKnowledgeAsset,
  updateKnowledgeAsset,
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
  const [viewingAsset, setViewingAsset] = useState(null);
  const [isEditingAsset, setIsEditingAsset] = useState(false);
  const [editAssetForm, setEditAssetForm] = useState({ filename: '', summary: '' });
  const [isSavingAsset, setIsSavingAsset] = useState(false);
  const [copiedAssetId, setCopiedAssetId] = useState(false);
  const [rawTextModal, setRawTextModal] = useState({ isOpen: false, packId: null, packName: '' });
  const [rawTextForm, setRawTextForm] = useState({ filename: '', text: '', description: '' });
  const [isSavingRawText, setIsSavingRawText] = useState(false);
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

  const handleOpenRawTextModal = (packId, packName) => {
    setExpandedId(packId);
    setRawTextModal({ isOpen: true, packId, packName });
    setRawTextForm({ filename: '', text: '', description: '' });
    setError(null);
  };

  const handleSaveRawText = async () => {
    if (!rawTextForm.filename.trim() || !rawTextForm.text.trim()) {
      setError('Filename and raw text content are required');
      return;
    }
    setIsSavingRawText(true);
    setError(null);
    try {
      await createRawTextAsset(rawTextModal.packId, {
        filename: rawTextForm.filename.trim(),
        text: rawTextForm.text,
        description: rawTextForm.description.trim(),
      });
      setRawTextModal({ isOpen: false, packId: null, packName: '' });
      setRawTextForm({ filename: '', text: '', description: '' });
      await loadDetail(rawTextModal.packId);
      await refreshList();
    } catch (err) {
      setError(err.message || 'Failed to save raw text asset');
    } finally {
      setIsSavingRawText(false);
    }
  };


  useEffect(() => {
    let mounted = true;
    const refreshList = async () => {
      setLoading(true);
      try {
        const rows = await listKnowledge();
        if (mounted) setPacks(rows || []);
      } catch (e) {
        if (mounted) setError(e.message || 'Failed to load knowledge packs');
      } finally {
        if (mounted) setLoading(false);
      }
    };

    refreshList();
    return () => {
      mounted = false;
    };
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

  const handleOpenAssetModal = (packId, packName, asset, editMode = false) => {
    setViewingAsset({ packId, packName, asset });
    setIsEditingAsset(editMode);
    setEditAssetForm({
      filename: asset.filename || '',
      summary: asset.summary || '',
    });
  };

  const handleSaveAssetEdit = async () => {
    if (!viewingAsset || !editAssetForm.filename.trim()) return;
    setIsSavingAsset(true);
    setError(null);
    try {
      const updatedAsset = await updateKnowledgeAsset(
        viewingAsset.packId,
        viewingAsset.asset.id,
        {
          filename: editAssetForm.filename.trim(),
          summary: editAssetForm.summary,
        }
      );
      setViewingAsset((prev) =>
        prev ? { ...prev, asset: { ...prev.asset, ...updatedAsset } } : null
      );
      setIsEditingAsset(false);
      await loadDetail(viewingAsset.packId);
      await refreshList();
    } catch (err) {
      setError(err.message || 'Failed to update asset');
    } finally {
      setIsSavingAsset(false);
    }
  };

  const isImageAsset = (asset) => {
    if (asset?.asset_type?.toLowerCase() === 'image') return true;
    const ext = asset?.filename?.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      return new Date(dateStr).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch (e) {
      return dateStr;
    }
  };

  const handleCopySummary = (text) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedAssetId(true);
    setTimeout(() => setCopiedAssetId(false), 2000);
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".txt,.md,.json,.yaml,.yml,.csv,.xml,.html,.htm,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.scss,.sql,.sh,.bat,.ps1,.toml,.ini,.cfg,.log,.png,.jpg,.jpeg,.gif,.webp,.bmp"
        onChange={handleFileChange}
      />

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
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleOpenRawTextModal(pack.id, pack.name)}
                  className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 rounded-lg transition-colors"
                  title="Add Raw Text / Note"
                >
                  <FileCode size={13} />
                  <span>Raw Text</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleUploadClick(pack.id)}
                  disabled={uploadingAsset}
                  className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 rounded-lg transition-colors disabled:opacity-50"
                  title="Upload File"
                >
                  {uploadingAsset && expandedId === pack.id ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  <span>Upload File</span>
                </button>
                <button type="button" onClick={() => handleEdit(pack)} className="p-1.5 text-neutral-500 hover:text-neutral-200 transition-colors" title="Edit pack">
                  <Pencil size={15} />
                </button>
                <button type="button" onClick={() => setDeleteTarget(pack.id)} className="p-1.5 text-neutral-500 hover:text-red-400 transition-colors" title="Delete pack">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            {expandedId === pack.id && expandedDetail && (
              <div className="px-4 pb-4 border-t border-neutral-700/50 pt-3 space-y-3">
                {(expandedDetail.instructions || '').trim() && (
                  <div className="p-3 bg-neutral-900/40 rounded-lg border border-neutral-800 text-xs text-neutral-400 whitespace-pre-wrap">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500 block mb-1">Instructions</span>
                    {expandedDetail.instructions}
                  </div>
                )}
                {(expandedDetail.assets || []).length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 border border-dashed border-neutral-800 rounded-xl space-y-3">
                    <p className="text-xs text-neutral-500 italic">No files or raw text added yet.</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleOpenRawTextModal(pack.id, pack.name)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 rounded-lg transition-colors"
                      >
                        <FileCode size={13} />
                        <span>Add Raw Text</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUploadClick(pack.id)}
                        disabled={uploadingAsset}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Upload size={13} />
                        <span>Upload File</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    {expandedDetail.assets.map((asset) => {
                      const isImg = isImageAsset(asset);
                      return (
                        <div
                          key={asset.id}
                          onClick={() => handleOpenAssetModal(pack.id, pack.name, asset, false)}
                          className="group relative flex flex-col justify-between rounded-xl bg-neutral-900/80 hover:bg-neutral-900 border border-neutral-700/50 hover:border-emerald-500/40 p-3.5 transition-all duration-200 cursor-pointer shadow-sm hover:shadow-lg hover:shadow-emerald-500/5 hover:-translate-y-0.5"
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2 mb-2.5">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className={`p-2 rounded-lg border transition-colors shrink-0 ${
                                  isImg 
                                    ? 'bg-purple-500/10 border-purple-500/20 text-purple-400 group-hover:border-purple-500/40' 
                                    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 group-hover:border-emerald-500/40'
                                }`}>
                                  {isImg ? <ImageIcon size={16} /> : <FileText size={16} />}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-neutral-200 truncate group-hover:text-emerald-400 transition-colors" title={asset.filename}>
                                    {asset.filename}
                                  </div>
                                  <span className={`inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded mt-0.5 border ${
                                    isImg
                                      ? 'bg-purple-500/10 text-purple-300 border-purple-500/20'
                                      : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                                  }`}>
                                    {asset.asset_type || (isImg ? 'IMAGE' : 'TEXT')}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenAssetModal(pack.id, pack.name, asset, true);
                                  }}
                                  className="text-neutral-500 hover:text-emerald-400 p-1.5 rounded-lg hover:bg-emerald-500/10 transition-colors"
                                  title="Edit file details"
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeleteAssetTarget({ packId: pack.id, assetId: asset.id });
                                  }}
                                  className="text-neutral-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                                  title="Delete file"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>

                            {asset.summary ? (
                              <p className="text-[11px] text-neutral-400 line-clamp-3 leading-relaxed whitespace-pre-wrap font-sans">
                                {asset.summary}
                              </p>
                            ) : (
                              <p className="text-[11px] text-neutral-600 italic">No summary available</p>
                            )}
                          </div>

                          <div className="mt-3 pt-2.5 border-t border-neutral-800 flex items-center justify-between text-[10px] text-neutral-500 group-hover:text-emerald-400 transition-colors">
                            <span className="flex items-center gap-1 font-medium">
                              <Eye size={12} /> View full details
                            </span>
                            <Maximize2 size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Full Details Asset Modal Popup (View & Edit Mode) */}
      <AnimatePresence>
        {viewingAsset && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (!isSavingAsset) {
                  setViewingAsset(null);
                  setIsEditingAsset(false);
                }
              }}
              className="absolute inset-0 bg-black/70 backdrop-blur-md"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-xl flex flex-col max-h-[85vh]"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-900/90 shrink-0">
                {isEditingAsset ? (
                  <div className="flex items-center gap-3 min-w-0 pr-4 flex-1">
                    <div className={`p-2.5 rounded-xl border shrink-0 ${
                      isImageAsset(viewingAsset.asset)
                        ? 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                        : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    }`}>
                      {isImageAsset(viewingAsset.asset) ? <ImageIcon size={20} /> : <FileText size={20} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] uppercase font-bold tracking-wider text-neutral-500 mb-1">Edit Filename</div>
                      <input
                        type="text"
                        value={editAssetForm.filename}
                        onChange={(e) => setEditAssetForm((p) => ({ ...p, filename: e.target.value }))}
                        className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500/50"
                        placeholder="Filename"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 min-w-0 pr-4">
                    <div className={`p-2.5 rounded-xl border shrink-0 ${
                      isImageAsset(viewingAsset.asset)
                        ? 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                        : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    }`}>
                      {isImageAsset(viewingAsset.asset) ? <ImageIcon size={20} /> : <FileText size={20} />}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-neutral-100 truncate" title={viewingAsset.asset.filename}>
                        {viewingAsset.asset.filename}
                      </h3>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-neutral-400 flex-wrap">
                        <span className="font-medium text-emerald-400">{viewingAsset.packName}</span>
                        <span>•</span>
                        <span className="uppercase text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-700">
                          {viewingAsset.asset.asset_type || (isImageAsset(viewingAsset.asset) ? 'IMAGE' : 'TEXT')}
                        </span>
                        {viewingAsset.asset.created_at && (
                          <>
                            <span>•</span>
                            <span className="text-neutral-500 text-[11px]">{formatDate(viewingAsset.asset.created_at)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  {!isEditingAsset && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingAsset(true);
                        setEditAssetForm({
                          filename: viewingAsset.asset.filename || '',
                          summary: viewingAsset.asset.summary || '',
                        });
                      }}
                      className="flex items-center gap-1.5 text-xs text-neutral-300 hover:text-white px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors"
                    >
                      <Pencil size={13} className="text-emerald-400" />
                      <span>Edit</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setViewingAsset(null);
                      setIsEditingAsset(false);
                    }}
                    className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors shrink-0 ml-1"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Modal Body */}
              <div className="p-6 overflow-y-auto custom-scrollbar space-y-4 flex-1">
                {isEditingAsset ? (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block">
                      Extracted Knowledge & Summary Content
                    </label>
                    <textarea
                      value={editAssetForm.summary}
                      onChange={(e) => setEditAssetForm((p) => ({ ...p, summary: e.target.value }))}
                      rows={12}
                      placeholder="Enter knowledge summary or content..."
                      className="w-full bg-neutral-950 border border-neutral-700 rounded-xl p-4 text-sm text-neutral-200 leading-relaxed font-sans focus:outline-none focus:border-emerald-500/50 resize-y custom-scrollbar"
                    />
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-neutral-300 uppercase tracking-wider">
                        <Sparkles size={14} className="text-emerald-400" />
                        Extracted Knowledge & Summary
                      </div>
                      {viewingAsset.asset.summary && (
                        <button
                          type="button"
                          onClick={() => handleCopySummary(viewingAsset.asset.summary)}
                          className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-emerald-400 px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-800/80 border border-neutral-700/60 transition-colors"
                        >
                          {copiedAssetId ? (
                            <>
                              <Check size={13} className="text-emerald-400" />
                              <span className="text-emerald-400 font-medium">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy size={13} />
                              <span>Copy summary</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <div className="p-4 bg-neutral-950/80 border border-neutral-800 rounded-xl text-sm text-neutral-300 leading-relaxed font-sans whitespace-pre-wrap selection:bg-emerald-500/30 selection:text-emerald-200">
                      {viewingAsset.asset.summary ? (
                        viewingAsset.asset.summary
                      ) : (
                        <span className="text-neutral-500 italic">No summary text extracted for this file.</span>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Modal Footer */}
              <div className="flex items-center justify-between px-6 py-3.5 border-t border-neutral-800 bg-neutral-900/90 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    const packId = viewingAsset.packId;
                    const assetId = viewingAsset.asset.id;
                    setViewingAsset(null);
                    setIsEditingAsset(false);
                    setDeleteAssetTarget({ packId, assetId });
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 rounded-lg transition-colors"
                >
                  <Trash2 size={13} />
                  Delete file
                </button>

                {isEditingAsset ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsEditingAsset(false)}
                      className="px-3.5 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveAssetEdit}
                      disabled={isSavingAsset || !editAssetForm.filename.trim()}
                      className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-50"
                    >
                      {isSavingAsset ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          <span>Saving…</span>
                        </>
                      ) : (
                        <>
                          <Save size={13} />
                          <span>Save Changes</span>
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setViewingAsset(null)}
                    className="px-4 py-1.5 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg transition-colors"
                  >
                    Close
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Raw Text Asset Creation Modal */}
      <AnimatePresence>
        {rawTextModal.isOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (!isSavingRawText) setRawTextModal({ isOpen: false, packId: null, packName: '' });
              }}
              className="absolute inset-0 bg-black/70 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative w-full max-w-xl bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-xl flex flex-col max-h-[85vh]"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-900/90 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl border bg-cyan-500/10 border-cyan-500/20 text-cyan-400">
                    <FileCode size={20} />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-neutral-100">Add Raw Text Note</h3>
                    <p className="text-xs text-neutral-400">Add raw text to <span className="text-cyan-400 font-medium">{rawTextModal.packName}</span> without LLM summarization</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRawTextModal({ isOpen: false, packId: null, packName: '' })}
                  className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="p-6 overflow-y-auto custom-scrollbar space-y-4 flex-1">
                {error && (
                  <div className="text-xs text-red-400 bg-red-950/30 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
                )}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block">
                    Document Title / Filename <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={rawTextForm.filename}
                    onChange={(e) => setRawTextForm((p) => ({ ...p, filename: e.target.value }))}
                    placeholder="e.g. resume_raw.txt or job_notes.txt"
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block">
                    Short Description / Title Hint <span className="text-neutral-500 text-[10px] font-normal lowercase">(For on-demand LLM index)</span>
                  </label>
                  <input
                    type="text"
                    value={rawTextForm.description}
                    onChange={(e) => setRawTextForm((p) => ({ ...p, description: e.target.value }))}
                    placeholder="Brief 1-sentence description for index overview..."
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block">
                    Raw Text Content <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={rawTextForm.text}
                    onChange={(e) => setRawTextForm((p) => ({ ...p, text: e.target.value }))}
                    rows={8}
                    placeholder="Paste or type raw text content here..."
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-xl p-4 text-sm text-neutral-200 leading-relaxed font-mono focus:outline-none focus:border-cyan-500/50 resize-y custom-scrollbar"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t border-neutral-800 bg-neutral-900/90 shrink-0">
                <button
                  type="button"
                  onClick={() => setRawTextModal({ isOpen: false, packId: null, packName: '' })}
                  className="px-4 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveRawText}
                  disabled={isSavingRawText || !rawTextForm.filename.trim() || !rawTextForm.text.trim()}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {isSavingRawText ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      <span>Saving…</span>
                    </>
                  ) : (
                    <>
                      <Save size={13} />
                      <span>Save Raw Text</span>
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

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
