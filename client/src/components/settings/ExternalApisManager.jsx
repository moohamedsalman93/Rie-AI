import { useState } from 'react';
import { Plus, Link, Pencil, Trash2 } from 'lucide-react';
import { ConfirmationModal } from '../ConfirmationModal';

export function ExternalApisManager({ apis, onSave, isSaving }) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [newApi, setNewApi] = useState({
    name: '',
    description: '',
    url: '',
    method: 'GET',
    headers: '{}',
    body: '',
    enabled: true,
  });
  const [error, setError] = useState(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [indexToDelete, setIndexToDelete] = useState(null);

  const handleSaveApi = () => {
    if (!newApi.name.trim() || !newApi.description.trim() || !newApi.url.trim()) {
      setError("Name, description, and URL are required");
      return;
    }

    try {
      const headers = JSON.parse(newApi.headers || '{}');
      const payload = { ...newApi, headers };
      if (newApi.body?.trim()) {
        JSON.parse(newApi.body.trim()); // validate JSON
        payload.body = newApi.body.trim();
      }
      const updatedApis = [...apis];
      if (editingIndex !== null) {
        updatedApis[editingIndex] = payload;
      } else {
        updatedApis.push(payload);
      }
      onSave(updatedApis);
      setIsAdding(false);
      setEditingIndex(null);
      setNewApi({ name: '', description: '', url: '', method: 'GET', headers: '{}', body: '', enabled: true });
      setError(null);
    } catch (e) {
      setError(newApi.body?.trim() && e instanceof SyntaxError ? "Invalid JSON for body" : "Invalid JSON for headers");
    }
  };

  const handleEditClick = (api, index) => {
    setEditingIndex(index);
    setIsAdding(true);
    setError(null);
    setNewApi({
      name: api.name || '',
      description: api.description || '',
      url: api.url || '',
      method: api.method || 'GET',
      headers: JSON.stringify(api.headers || {}, null, 2),
      body: typeof api.body === 'string' ? api.body : '',
      enabled: api.enabled !== false,
    });
  };

  const handleDeleteClick = (index) => {
    setIndexToDelete(index);
    setIsConfirmOpen(true);
  };

  const handleToggleApi = (index) => {
    const updatedApis = apis.map((api, idx) => (
      idx === index ? { ...api, enabled: api.enabled !== false ? false : true } : api
    ));
    onSave(updatedApis);
  };

  const confirmDelete = () => {
    if (indexToDelete === null) return;
    const updatedApis = apis.filter((_, i) => i !== indexToDelete);
    onSave(updatedApis);
    setIndexToDelete(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-neutral-500">
          {apis.length === 0
            ? 'No external APIs configured'
            : `${apis.length} API tool${apis.length !== 1 ? 's' : ''} configured`}
        </div>
        {!isAdding && (
          <button
            onClick={() => {
              setIsAdding(true);
              setEditingIndex(null);
              setError(null);
              setNewApi({ name: '', description: '', url: '', method: 'GET', headers: '{}', body: '', enabled: true });
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs border border-dashed border-neutral-700 hover:border-emerald-500/50 hover:bg-emerald-500/5 text-neutral-400 hover:text-emerald-400 rounded-lg transition-all"
          >
            <Plus size={12} />
            Add API Tool
          </button>
        )}
      </div>

      <div className="space-y-3">
        {apis.length === 0 && !isAdding ? (
          <div className="text-center py-10 rounded-xl">
            <Link size={32} className="mx-auto text-neutral-600 mb-3 opacity-20" />
            <p className="text-sm text-neutral-500">No external APIs configured yet.</p>
          </div>
        ) : (
          apis.map((api, idx) => (
            <div key={idx} className="group bg-neutral-800/30 border border-neutral-700/50 rounded-xl overflow-hidden hover:border-neutral-600 transition-all">
              <div className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-neutral-100">{api.name}</h4>
                    <p className="text-[11px] text-neutral-500 line-clamp-1">{api.description}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400 border border-neutral-700 font-mono">{api.method}</span>
                      <span className="text-[10px] text-neutral-600 font-mono truncate max-w-[200px]">{api.url}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleEditClick(api, idx)}
                    disabled={isSaving}
                    className="p-2 text-neutral-500 hover:text-neutral-200 transition-colors disabled:opacity-50"
                    title="Edit API"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => handleDeleteClick(idx)}
                    className="p-2 text-neutral-500 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    onClick={() => handleToggleApi(idx)}
                    disabled={isSaving}
                    role="switch"
                    aria-checked={api.enabled !== false}
                    aria-label={`${api.enabled !== false ? 'Disable' : 'Enable'} ${api.name}`}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors disabled:opacity-50 ${
                      api.enabled !== false
                        ? 'border-emerald-500/40 bg-emerald-500/20'
                        : 'border-white/10 bg-neutral-900'
                    }`}
                    title={api.enabled !== false ? 'Disable' : 'Enable'}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
                        api.enabled !== false
                          ? 'translate-x-6 bg-emerald-300'
                          : 'translate-x-1 bg-neutral-400'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {isAdding && (
        <div className="p-6 bg-neutral-800/50 border border-neutral-700 rounded-xl space-y-4 animate-in slide-in-from-top-2">
          <h4 className="text-sm font-medium text-neutral-200">
            {editingIndex !== null ? 'Edit API Tool' : 'New API Tool'}
          </h4>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Tool Name</label>
              <input
                type="text"
                value={newApi.name}
                onChange={(e) => setNewApi(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. get_weather"
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">HTTP Method</label>
              <select
                value={newApi.method}
                onChange={(e) => setNewApi(prev => ({ ...prev, method: e.target.value }))}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 appearance-none cursor-pointer"
              >
                <option value="GET">GET (query params)</option>
                <option value="POST">POST (body)</option>
                <option value="PUT">PUT (body)</option>
                <option value="PATCH">PATCH (body)</option>
                <option value="DELETE">DELETE (query params)</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Description (For AI context)</label>
            <input
              type="text"
              value={newApi.description}
              onChange={(e) => setNewApi(prev => ({ ...prev, description: e.target.value }))}
              placeholder="e.g. Use this tool to get current weather for a city."
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">API URL (Supports {'{param}'} placeholders)</label>
            <input
              type="text"
              value={newApi.url}
              onChange={(e) => setNewApi(prev => ({ ...prev, url: e.target.value }))}
              placeholder="https://api.example.com/weather?q={city}"
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          {(newApi.method === 'POST' || newApi.method === 'PUT' || newApi.method === 'PATCH') && (
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Request body (JSON)</label>
              <textarea
                value={newApi.body}
                onChange={(e) => setNewApi(prev => ({ ...prev, body: e.target.value }))}
                placeholder='{"key": "value"} or use {param_name} for values the AI will fill. Leave empty to send tool parameters as JSON.'
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-24 font-mono"
              />
              <p className="text-[10px] text-neutral-500">Optional. Use <code className="bg-neutral-800 px-1 rounded">{'{param}'}</code> placeholders; the AI will pass those as tool arguments.</p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Headers (JSON)</label>
            <textarea
              value={newApi.headers}
              onChange={(e) => setNewApi(prev => ({ ...prev, headers: e.target.value }))}
              placeholder='{"Authorization": "Bearer secret_key"}'
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-20 font-mono"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleSaveApi}
              disabled={isSaving}
              className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? "Saving..." : (editingIndex !== null ? "Update API Tool" : "Add API Tool")}
            </button>
            <button
              onClick={() => {
                setIsAdding(false);
                setEditingIndex(null);
                setError(null);
                setNewApi({ name: '', description: '', url: '', method: 'GET', headers: '{}', body: '', enabled: true });
              }}
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={confirmDelete}
        title="Remove API Tool?"
        message="This will remove the tool and it will no longer be available for the AI."
        confirmText="Remove"
      />
    </div>
  );
}