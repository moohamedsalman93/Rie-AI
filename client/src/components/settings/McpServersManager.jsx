import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Plus, Shield, Wrench, ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { getMcpStatus } from '../../services/chatApi';
import { ConfirmationModal } from '../ConfirmationModal';

export function McpServersManager({ servers, onSave, isSaving }) {
  const createDefaultMcpServerJson = () => JSON.stringify({
    mcpServers: {
      browsermcp: {
        command: 'npx',
        args: ['@browsermcp/mcp@latest'],
      },
    },
  }, null, 2);

  const createMcpServerJsonFromServer = (server) => JSON.stringify({
    mcpServers: {
      server: server.url
        ? { url: server.url }
        : {
            command: server.command || '',
            args: Array.isArray(server.args) ? server.args : [],
            env: server.env && typeof server.env === 'object' ? server.env : {},
          },
    },
  }, null, 2);

  const [isAdding, setIsAdding] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [newServerJson, setNewServerJson] = useState(createDefaultMcpServerJson());
  const [error, setError] = useState(null);
  const [mcpStatus, setMcpStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState(null);
  const [expandedServers, setExpandedServers] = useState(new Set());
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [indexToDelete, setIndexToDelete] = useState(null);

  // Fetch MCP status on component mount
  useEffect(() => {
    fetchMcpStatus();
  }, []);

  const fetchMcpStatus = async () => {
    try {
      setLoadingStatus(true);
      setStatusError(null);
      const status = await getMcpStatus();
      setMcpStatus(status);
    } catch (err) {
      console.error('Failed to fetch MCP status:', err);
      setStatusError(err.message);
    } finally {
      setLoadingStatus(false);
    }
  };

  const toggleServerExpand = (index) => {
    const newExpanded = new Set(expandedServers);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedServers(newExpanded);
  };

  const handleEditClick = (index) => {
    const server = servers[index];
    setNewServerJson(createMcpServerJsonFromServer(server));
    
    setEditingIndex(index);
    setIsAdding(true);
    setError(null);
  };

  const handleSave = () => {
    try {
      const parsed = JSON.parse(newServerJson);
      let serverCandidate = parsed;

      if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const entries = Object.entries(parsed.mcpServers).filter(([, value]) => value && typeof value === 'object');
        if (entries.length !== 1) {
          setError('JSON must contain exactly one server inside "mcpServers"');
          return;
        }
        [, serverCandidate] = entries[0];
      }

      if (!serverCandidate || typeof serverCandidate !== 'object') {
        setError('Invalid server JSON object');
        return;
      }

      let server;
      if (serverCandidate.url) {
        server = {
          url: String(serverCandidate.url).trim(),
        };
        if (!server.url) {
          setError('URL is required');
          return;
        }
      } else {
        const command = typeof serverCandidate.command === 'string' ? serverCandidate.command.trim() : '';
        if (!command) {
          setError('Command is required');
          return;
        }

        server = {
          command,
          args: Array.isArray(serverCandidate.args)
            ? serverCandidate.args.map((arg) => String(arg))
            : [],
          env: serverCandidate.env && typeof serverCandidate.env === 'object' && !Array.isArray(serverCandidate.env)
            ? serverCandidate.env
            : {},
        };
      }

      let updatedServers;
      if (editingIndex !== null) {
        updatedServers = [...servers];
        updatedServers[editingIndex] = server;
      } else {
        updatedServers = [...servers, server];
      }
      
      onSave(updatedServers);
      setIsAdding(false);
      setEditingIndex(null);
      setNewServerJson(createDefaultMcpServerJson());
      setError(null);

      // Refresh status after adding
      setTimeout(fetchMcpStatus, 1000);
    } catch (e) {
      setError('Invalid JSON format');
    }
  };

  const handleDeleteClick = (index) => {
    setIndexToDelete(index);
    setIsConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (indexToDelete === null) return;
    const updatedServers = servers.filter((_, i) => i !== indexToDelete);
    onSave(updatedServers);
    setIndexToDelete(null);
    
    // If we were editing, cancel it to avoid index mismatches
    setIsAdding(false);
    setEditingIndex(null);
    setNewServerJson(createDefaultMcpServerJson());

    // Refresh status after deleting
    setTimeout(fetchMcpStatus, 500);
  };

  const getServerStatus = () => {
    if (!mcpStatus) return 'unknown';
    return mcpStatus.status === 'connected' ? 'connected' : 'error';
  };

  const getToolsCount = () => {
    return mcpStatus?.loaded_tools_count || 0;
  };

  return (
    <div className="space-y-4">
      {/* Header with Refresh Button */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-neutral-500">
          {servers.length === 0 ? (
            'No servers configured'
          ) : (
            <>
              {servers.length} server{servers.length !== 1 ? 's' : ''} configured
              {mcpStatus && (
                <span className="ml-2">
                  • {getToolsCount()} tool{getToolsCount() !== 1 ? 's' : ''} loaded
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchMcpStatus}
            disabled={loadingStatus}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loadingStatus ? "animate-spin" : ""} />
            {loadingStatus ? 'Checking...' : 'Refresh Status'}
          </button>
          {!isAdding && (
            <button
              onClick={() => {
                setIsAdding(true);
                setEditingIndex(null);
                setNewServerJson(createDefaultMcpServerJson());
                setError(null);
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-xs border border-dashed border-neutral-700 hover:border-emerald-500/50 hover:bg-emerald-500/5 text-neutral-400 hover:text-emerald-400 rounded-lg transition-all"
            >
              <Plus size={12} />
              Add MCP Server
            </button>
          )}
        </div>
      </div>

      {/* Status Error Message */}
      {statusError && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
          <div className="flex items-center gap-2">
            <Shield size={14} />
            {statusError}
          </div>
        </div>
      )}

      {/* Server List */}
      <div className="space-y-3">
        {servers.length === 0 ? (
          <div className="p-8  rounded-xl text-center">
            <p className="text-sm text-neutral-500">No MCP servers configured yet.</p>
          </div>
        ) : (
          servers.map((server, idx) => {
            const isExpanded = expandedServers.has(idx);
            const status = getServerStatus();
            const toolsCount = getToolsCount();

            return (
              <div key={idx} className="border border-neutral-700/50 rounded-xl overflow-hidden bg-neutral-800/20">
                {/* Server Header */}
                <div className="p-4 flex items-start justify-between group">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-neutral-200">{server.url || server.command}</span>

                      {/* Status Badge */}
                      {loadingStatus ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-500/10 text-neutral-500 border border-neutral-500/20">
                          Checking...
                        </span>
                      ) : status === 'connected' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          Connected
                        </span>
                      ) : status === 'error' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/20 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                          Error
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-500/10 text-neutral-500 border border-neutral-500/20">
                          Unknown
                        </span>
                      )}

                      {/* Tools Count Badge */}
                      {mcpStatus && toolsCount > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {toolsCount} tool{toolsCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>

                    {server.url && (
                      <p className="text-xs text-neutral-500 font-mono truncate max-w-md">
                        URL: {server.url}
                      </p>
                    )}
                    {server.args && server.args.length > 0 && (
                      <p className="text-xs text-neutral-500 font-mono truncate max-w-md">
                        Args: {server.args.join(' ')}
                      </p>
                    )}
                    {server.env && Object.keys(server.env).length > 0 && (
                      <p className="text-xs text-neutral-500 font-mono truncate max-w-md">
                        Env: {JSON.stringify(server.env)}
                      </p>
                    )}

                    {/* Tools Toggle Button */}
                    {mcpStatus && mcpStatus.available_tools && mcpStatus.available_tools.length > 0 && (
                      <button
                        onClick={() => toggleServerExpand(idx)}
                        className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
                      >
                        <ChevronDown
                          size={12}
                          className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        />
                        {isExpanded ? 'Hide' : 'Show'} available tools
                      </button>
                    )}
                  </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleEditClick(idx)}
                        className="p-2 text-neutral-500 hover:text-emerald-400 transition-colors"
                        title="Edit server"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteClick(idx)}
                        className="p-2 text-neutral-500 hover:text-red-400 transition-colors"
                        title="Remove server"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                {/* Expanded Tools List */}
                <AnimatePresence>
                  {isExpanded && mcpStatus && mcpStatus.available_tools && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="border-t border-neutral-700/50 bg-neutral-900/50"
                    >
                      <div className="p-4 space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
                        <div className="text-xs font-medium text-neutral-400 mb-2">Available Tools:</div>
                        {mcpStatus.available_tools.map((tool, toolIdx) => (
                          <div key={toolIdx} className="p-2 bg-neutral-800/50 rounded border border-neutral-700/30">
                            <div className="flex items-start gap-2">
                              <div className="mt-0.5 text-emerald-500">
                                <Wrench size={12} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-mono font-medium text-neutral-200 truncate">
                                  {tool.name}
                                </div>
                                <div className="text-[10px] text-neutral-500 mt-0.5">
                                  {tool.description}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        )}
      </div>

      {/* Add / Edit Form */}
      {isAdding && (
        <div className="p-6 bg-neutral-800/50 border border-neutral-700 rounded-xl space-y-4 animate-in slide-in-from-top-2">
          <h4 className="text-sm font-medium text-neutral-200">
            {editingIndex !== null ? 'Edit MCP Server' : 'New MCP Server'}
          </h4>

          <div className="space-y-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1 block">MCP Server JSON</label>
              <textarea
                value={newServerJson}
                onChange={(e) => setNewServerJson(e.target.value)}
                placeholder={`{\n  "mcpServers": {\n    "browsermcp": {\n      "command": "npx",\n      "args": ["@browsermcp/mcp@latest"]\n    }\n  }\n}`}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-72 font-mono"
              />
              <p className="text-[10px] text-neutral-500 mt-1">
                Paste one server in Cursor-style format. Supports either <code className="bg-neutral-800 px-1 rounded">{"{ mcpServers: { name: {...} } }"}</code> or a direct server object.
              </p>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving || !newServerJson.trim()}
              className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? "Saving..." : (editingIndex !== null ? "Update Server" : "Add Server")}
            </button>
            <button
              onClick={() => { 
                setIsAdding(false); 
                setEditingIndex(null);
                setNewServerJson(createDefaultMcpServerJson());
                setError(null); 
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
        title="Remove MCP Server?"
        message="This will disconnect the server and remove its tools from your assistant."
        confirmText="Remove"
      />
    </div>
  );
}

