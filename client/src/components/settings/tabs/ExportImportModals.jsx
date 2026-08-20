import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, FileText } from 'lucide-react';
import { exportBackup, importBackup } from '../../../services/chatApi';

export function ExportImportModals({
  isExportOpen,
  onCloseExport,
  isImportOpen,
  onCloseImport,
  onImportSuccess
}) {
  // Export state
  const [exportOptions, setExportOptions] = useState({
    settings: true,
    apis: true,
    tools: true,
    conversations: true,
    knowledge: true,
  });
  const [isExporting, setIsExporting] = useState(false);

  // Import state
  const [importOptions, setImportOptions] = useState({
    settings: true,
    apis: true,
    tools: true,
    conversations: true,
    knowledge: true,
  });
  const [importData, setImportData] = useState(null);
  const [importFileName, setImportFileName] = useState('');
  const [importStatusMsg, setImportStatusMsg] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef(null);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const data = await exportBackup(exportOptions);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `rie_backup_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onCloseExport();
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        setImportData(json);
        setImportStatusMsg('');
      } catch (err) {
        setImportStatusMsg(`Invalid JSON file: ${err.message}`);
        setImportData(null);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!importData) return;
    setIsImporting(true);
    try {
      const payload = {
        data: importData,
        options: importOptions,
      };
      const res = await importBackup(payload);
      setImportStatusMsg(`Import successful: ${JSON.stringify(res.summary || res)}`);
      if (onImportSuccess) onImportSuccess();
      setTimeout(() => {
        onCloseImport();
        setImportData(null);
        setImportFileName('');
        setImportStatusMsg('');
      }, 1200);
    } catch (e) {
      setImportStatusMsg(`Import error: ${e.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      {/* EXPORT MODAL */}
      <AnimatePresence>
        {isExportOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="flex max-h-[min(90vh,600px)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl"
            >
              <div className="shrink-0 border-b border-neutral-800 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-white">Export Backup</h4>
                    <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                      Select what configuration and history you would like to export.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onCloseExport}
                    className="shrink-0 text-neutral-400 hover:text-white text-xs cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 mb-2">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-200/90 leading-normal">
                      <strong>Security Warning:</strong> Exported backups contain raw API keys and credentials. Store this backup file in a secure location.
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  {Object.entries({
                    settings: { label: 'General Settings', desc: 'API keys, LLM providers, model preferences' },
                    apis: { label: 'External APIs', desc: 'Custom web tools and endpoint integrations' },
                    tools: { label: 'Skills & MCP Tools', desc: 'Custom skill guidelines & MCP configurations' },
                    conversations: { label: 'Conversations & History', desc: 'Chat threads, messages, and snapshots' },
                    knowledge: { label: 'Knowledge Packs', desc: 'Custom knowledge documents and uploaded assets' },
                  }).map(([key, item]) => (
                    <label key={key} className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-neutral-700 bg-neutral-900/40 px-4 py-3">
                      <div className="space-y-0.5">
                        <span className="text-xs font-semibold text-neutral-200">{item.label}</span>
                        <span className="block text-[10px] text-neutral-500">{item.desc}</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={exportOptions[key]}
                        onChange={(e) => setExportOptions((prev) => ({ ...prev, [key]: e.target.checked }))}
                        className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500 cursor-pointer"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-neutral-800 px-5 py-4">
                <button
                  type="button"
                  onClick={onCloseExport}
                  className="rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 cursor-pointer hover:bg-neutral-900"
                >
                  Cancel
                </button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={handleExport}
                  disabled={isExporting}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-medium text-white transition-colors disabled:opacity-60 cursor-pointer"
                >
                  {isExporting ? 'Exporting...' : 'Export'}
                </motion.button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* IMPORT MODAL */}
      <AnimatePresence>
        {isImportOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="flex max-h-[min(90vh,600px)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl"
            >
              <div className="shrink-0 border-b border-neutral-800 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-white">Import Backup</h4>
                    <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                      Upload a previous backup file and choose what to restore.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onCloseImport}
                    className="shrink-0 text-neutral-400 hover:text-white text-xs cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                {!importData ? (
                  <div
                    className="flex flex-col items-center justify-center border-2 border-dashed border-neutral-700 hover:border-neutral-500 rounded-xl p-8 cursor-pointer transition-colors bg-neutral-900/10"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <FileText className="w-8 h-8 text-neutral-500 mb-2" />
                    <span className="text-xs font-semibold text-neutral-300">Click to select backup JSON</span>
                    <span className="text-[10px] text-neutral-500 mt-1">Format: rie_backup_*.json</span>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      accept=".json"
                      className="hidden"
                    />
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-3 rounded-xl border border-neutral-800 bg-neutral-900/40">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs font-semibold text-neutral-200 truncate max-w-[200px]">
                          {importFileName}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setImportData(null);
                          setImportFileName('');
                          setImportStatusMsg('');
                        }}
                        className="text-[10px] text-red-400 hover:text-red-300 font-medium cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>

                    <div className="space-y-3">
                      {Object.entries({
                        settings: { label: 'General Settings', desc: 'Override API keys and preferences' },
                        apis: { label: 'External APIs', desc: 'Custom web tools' },
                        tools: { label: 'Skills & MCP Tools', desc: 'Restore skills and MCP configurations' },
                        conversations: { label: 'Conversations & History', desc: 'Import chat threads & messages' },
                        knowledge: { label: 'Knowledge Packs', desc: 'Restore folders and documents' },
                      }).map(([key, item]) => (
                        <label key={key} className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-neutral-700 bg-neutral-900/40 px-4 py-3">
                          <div className="space-y-0.5">
                            <span className="text-xs font-semibold text-neutral-200">{item.label}</span>
                            <span className="block text-[10px] text-neutral-500">{item.desc}</span>
                          </div>
                          <input
                            type="checkbox"
                            checked={importOptions[key]}
                            onChange={(e) => setImportOptions((prev) => ({ ...prev, [key]: e.target.checked }))}
                            className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500 cursor-pointer"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {importStatusMsg && (
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3 mt-2 whitespace-pre-line text-[11px] text-neutral-300 leading-normal">
                    {importStatusMsg}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-neutral-800 px-5 py-4">
                <button
                  type="button"
                  onClick={onCloseImport}
                  className="rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 cursor-pointer hover:bg-neutral-900"
                >
                  Cancel
                </button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={handleImport}
                  disabled={isImporting || !importData}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-medium text-white transition-colors disabled:opacity-60 cursor-pointer"
                >
                  {isImporting ? 'Importing...' : 'Import'}
                </motion.button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

export default ExportImportModals;
