import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crown, Plus, Trash2, Save, ArrowRight, UserRound, ImagePlus, Sparkles } from "lucide-react";
import { getMcpStatus, getSettings, updateSetting, generatePlannerInstruction } from "../services/chatApi";
import rieLogo from "../assets/logo.png";

const MAIN_NODE_ID = "main_agent";
const PROTECTED_MEMBER_NAMES = new Set(["coding_specialist", "mcp_registry"]);

function defaultGraphFromSubagents(subagents = []) {
  const spacing = 170;
  const nodes = (subagents || []).map((sub, idx) => ({
    id: `subagent_${idx + 1}`,
    name: sub.name || `sub_agent_${idx + 1}`,
    description: sub.description || "",
    system_prompt: sub.system_prompt || "",
    tool_ids: sub.tool_ids || [],
    enabled: sub.enabled !== false,
    logo_url: null,
    position: { x: 360, y: 120 + idx * spacing },
  }));
  const edges = nodes.map((n) => ({ source: MAIN_NODE_ID, target: n.id }));
  return {
    main_node_id: MAIN_NODE_ID,
    main_label: "Rie",
    main_logo_url: null,
    main_tool_ids: [],
    main_instruction: "You are Rie, the main coordinator. Delegate tasks to the right team members and ensure high-quality results.",
    nodes,
    edges,
  };
}

export function PlannerWindowPage({ onClose = () => {} }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  const [settings, setSettings] = useState({});
  const [graph, setGraph] = useState({
    main_node_id: MAIN_NODE_ID,
    main_label: "Rie",
    main_logo_url: null,
    main_tool_ids: [],
    main_instruction: "You are Rie, the main coordinator. Delegate tasks to the right team members and ensure high-quality results.",
    nodes: [],
    edges: [],
  });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [mcpToolsCatalog, setMcpToolsCatalog] = useState([]);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);

  const availableTools = useMemo(() => {
    const builtIns = [
      { id: "internet_search", label: "Internet Search", source: "built-in" },
      { id: "run_terminal_command", label: "System Terminal", source: "built-in" },
      { id: "get_desktop_state", label: "Desktop State", source: "built-in" },
      { id: "app_control", label: "App Control", source: "built-in" },
      { id: "mouse_click", label: "Mouse Click", source: "built-in" },
      { id: "keyboard_type", label: "Keyboard Type", source: "built-in" },
      { id: "move_mouse", label: "Move Mouse", source: "built-in" },
      { id: "scroll_mouse", label: "Scroll Mouse", source: "built-in" },
      { id: "drag_mouse", label: "Drag Mouse", source: "built-in" },
      { id: "press_keys", label: "Press Keys", source: "built-in" },
      { id: "scrape_web", label: "Scrape Web", source: "built-in" },
      { id: "wait", label: "Wait", source: "built-in" },
    ];
    const external = (settings.external_apis || []).map((api) => ({
      id: api.name,
      label: api.name,
      source: "external",
    }));
    const mcp = mcpToolsCatalog.map((tool) => ({
      id: tool.name,
      label: tool.name,
      source: "mcp",
    }));
    const sourceOrder = { "built-in": 0, external: 1, mcp: 2 };
    return [...builtIns, ...external, ...mcp].sort((a, b) => {
      const sourceDelta = (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99);
      if (sourceDelta !== 0) return sourceDelta;
      return String(a.label).localeCompare(String(b.label));
    });
  }, [settings.external_apis, mcpToolsCatalog]);

  const sourceBadgeClass = (source) => {
    if (source === "mcp") return "border-blue-500/30 text-blue-300 bg-blue-500/10";
    if (source === "external") return "border-amber-500/30 text-amber-300 bg-amber-500/10";
    return "border-neutral-600 text-neutral-400 bg-neutral-900";
  };

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const data = await getSettings();
        setSettings(data);
        const planner = data.subagent_planner_graph || defaultGraphFromSubagents(data.subagents_config || []);
        setGraph({
          ...planner,
          main_tool_ids: Array.isArray(planner.main_tool_ids) ? planner.main_tool_ids : [],
        });
        if (planner.nodes?.length) {
          setSelectedNodeId(planner.nodes[0].id);
        }
        const mcpStatus = await getMcpStatus().catch(() => ({ available_tools: [] }));
        setMcpToolsCatalog(mcpStatus.available_tools || []);
      } catch (err) {
        setError(err.message || "Failed to load planner settings");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) || null;
  const isMainSelected = selectedNodeId === MAIN_NODE_ID;
  const mainPosition = { x: 80, y: 240 };

  const addSubAgentNode = () => {
    const idx = graph.nodes.length + 1;
    const member = {
      id: `subagent_${Date.now()}`,
      name: `member_${idx}`,
      description: "New team member",
      system_prompt: "Describe this member behavior.",
      tool_ids: [],
      enabled: true,
      logo_url: null,
      position: { x: 360, y: 120 + graph.nodes.length * 170 },
    };
    const nodes = [...graph.nodes, member];
    const edges = [...graph.edges, { source: MAIN_NODE_ID, target: member.id }];
    setGraph({ ...graph, nodes, edges });
    setSelectedNodeId(member.id);
  };

  const updateNode = (nodeId, patch) => {
    setGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
    }));
  };

  const deleteNode = (nodeId) => {
    const targetNode = graph.nodes.find((n) => n.id === nodeId);
    if (targetNode && PROTECTED_MEMBER_NAMES.has((targetNode.name || "").trim().toLowerCase())) {
      setError(`'${targetNode.name}' is protected and cannot be deleted.`);
      return;
    }
    const nodes = graph.nodes.filter((n) => n.id !== nodeId);
    const edges = graph.edges.filter((e) => e.target !== nodeId);
    setGraph({ ...graph, nodes, edges });
    if (selectedNodeId === nodeId) setSelectedNodeId(nodes[0]?.id || null);
  };

  const saveGraph = async () => {
    try {
      setSaving(true);
      setError(null);
      setSaveMessage(null);
      const result = await updateSetting("SUBAGENT_PLANNER_GRAPH", JSON.stringify(graph));
      setSaveMessage(result?.message || "Planner saved and runtime synced.");
    } catch (err) {
      setError(err.message || "Failed to save planner graph");
    } finally {
      setSaving(false);
    }
  };

  const generateInstructionForSelected = async () => {
    if (!selectedNode) return;
    if ((selectedNode.system_prompt || "").trim()) {
      const confirmed = window.confirm("Overwrite current instruction with AI-generated text?");
      if (!confirmed) return;
    }
    try {
      setGenerating(true);
      setGenerateError(null);
      const result = await generatePlannerInstruction({
        boss_name: graph.main_label || "Rie",
        member_name: selectedNode.name || "member",
        member_description: selectedNode.description || "",
        selected_tools: selectedNode.tool_ids || [],
      });
      updateNode(selectedNode.id, { system_prompt: result.instruction_text || "" });
    } catch (err) {
      setGenerateError(err.message || "Failed to generate instruction");
    } finally {
      setGenerating(false);
    }
  };

  const isProtectedMember = (member) =>
    !!member && PROTECTED_MEMBER_NAMES.has((member.name || "").trim().toLowerCase());

  const fileToDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const uploadBossLogo = async (file) => {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setGraph((prev) => ({ ...prev, main_logo_url: String(dataUrl) }));
  };

  const uploadMemberLogo = async (file, memberId) => {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    updateNode(memberId, { logo_url: String(dataUrl) });
  };

  const onCanvasMouseMove = (e) => {
    if (!draggingNodeId) return;
    const canvas = e.currentTarget.getBoundingClientRect();
    const x = Math.max(230, e.clientX - canvas.left - 70);
    const y = Math.max(20, e.clientY - canvas.top - 30);
    updateNode(draggingNodeId, { position: { x, y } });
  };

  if (loading) {
    return (
      <div
        data-tauri-drag-region
        className="h-screen w-screen bg-neutral-950 text-neutral-300 p-6 cursor-move"
      >
        Loading team planner...
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-neutral-950 text-neutral-200 flex flex-col">
      <div
        data-tauri-drag-region
        className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 cursor-move shrink-0"
      >
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold tracking-wide">Planner</h1>
          <span className="text-[10px] px-2 py-0.5 rounded border border-emerald-700/60 text-emerald-300">Runtime-active</span>
        </div>
        <div className="flex items-center gap-2 cursor-default">
          <button
            type="button"
            onClick={addSubAgentNode}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs flex items-center gap-1"
          >
            <Plus size={12} /> Add Member
          </button>
          <button
            type="button"
            onClick={saveGraph}
            disabled={saving}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs flex items-center gap-1 disabled:opacity-50"
          >
            <Save size={12} /> {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => onClose()}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs"
          >
            Close
          </button>
        </div>
      </div>

      {error && <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {saveMessage && <div className="mx-4 mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{saveMessage}</div>}

      <div className="flex-1 grid grid-cols-[1fr_360px] overflow-hidden">
        <div
          className="relative border-r border-neutral-800 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.07)_1px,transparent_0)] [background-size:24px_24px]"
          onMouseMove={onCanvasMouseMove}
          onMouseUp={() => setDraggingNodeId(null)}
          onMouseLeave={() => setDraggingNodeId(null)}
        >
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {graph.edges.map((edge) => {
              const target = graph.nodes.find((n) => n.id === edge.target);
              if (!target) return null;
              const x1 = mainPosition.x + 48;
              const y1 = mainPosition.y + 24;
              const x2 = target.position.x + 18;
              const y2 = target.position.y + 22;
              const midX = x1 + (x2 - x1) * 0.45;
              const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
              return (
                <path
                  key={`${edge.source}-${edge.target}`}
                  d={path}
                  fill="none"
                  stroke="rgba(148,163,184,0.55)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              );
            })}
          </svg>

          <div
            className="absolute left-[80px] top-[240px] flex flex-col items-center gap-1 cursor-pointer"
            onMouseDown={() => setSelectedNodeId(MAIN_NODE_ID)}
          >
            <div
              className={`w-12 h-12 rounded-full overflow-hidden bg-neutral-900 flex items-center justify-center transition-all ${
                isMainSelected
                  ? "border-2 border-green-300 shadow-[0_0_22px_rgba(47,129,8,0.6)]"
                  : "border border-green-400/60 shadow-[0_0_18px_rgba(47,129,8,0.35)]"
              }`}
            >
              <img src={graph.main_logo_url || rieLogo} alt="rie-logo" className="w-full h-full object-cover" />
            </div>
            <span className={`text-sm font-semibold ${isMainSelected ? "text-green-200" : "text-green-300"}`}>
              {graph.main_label || "Rie"}
            </span>
          </div>

          {graph.nodes.map((node) => (
            <div
              key={node.id}
              className="absolute cursor-move"
              style={{ left: `${node.position.x}px`, top: `${node.position.y}px` }}
              onMouseDown={() => {
                setDraggingNodeId(node.id);
                setSelectedNodeId(node.id);
              }}
            >
              <div className="flex items-center gap-2 px-1 py-1 rounded-md">
                <div
                  className={`w-11 h-11 rounded-full overflow-hidden bg-neutral-950 flex items-center justify-center transition-all ${
                    selectedNodeId === node.id
                      ? "border-2 border-emerald-400 shadow-[0_0_16px_rgba(16,185,129,0.45)]"
                      : "border border-neutral-600"
                  }`}
                >
                  {node.logo_url ? (
                    <img src={node.logo_url} alt={`${node.name}-logo`} className="w-full h-full object-cover" />
                  ) : (
                    <UserRound className="w-5 h-5 text-neutral-400" />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold truncate transition-colors ${selectedNodeId === node.id ? "text-emerald-300" : "text-neutral-200"}`}>
                    {node.name}
                  </span>
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${node.enabled ? "bg-emerald-400" : "bg-red-400"}`}
                    title={node.enabled ? "Active" : "Paused"}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 overflow-y-auto custom-scrollbar space-y-4">
          <h2 className="text-sm font-semibold">{isMainSelected ? "Main Agent Properties" : "Member Properties"}</h2>
          {isMainSelected && (
            <div className="space-y-1.5 rounded-lg border border-neutral-800 p-3 bg-neutral-900/60">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">Main Name</label>
              <input
                value={graph.main_label || ""}
                onChange={(e) => setGraph((prev) => ({ ...prev, main_label: e.target.value }))}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs"
              />
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">Main Logo</label>
              <div className="flex items-center gap-2">
                <label className="px-2 py-1 text-[10px] rounded-md border border-neutral-700 bg-neutral-900 cursor-pointer flex items-center gap-1">
                  <ImagePlus size={12} /> Upload
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadBossLogo(e.target.files?.[0])} />
                </label>
                <button
                  type="button"
                  onClick={() => setGraph((prev) => ({ ...prev, main_logo_url: null }))}
                  className="px-2 py-1 text-[10px] rounded-md border border-neutral-700 bg-neutral-900"
                >
                  Clear
                </button>
              </div>
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 mt-2">Main Instruction</label>
              <textarea
                value={graph.main_instruction || ""}
                onChange={(e) => setGraph((prev) => ({ ...prev, main_instruction: e.target.value }))}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs min-h-[100px]"
              />
              <div className="space-y-2 mt-2">
                <label className="text-[10px] uppercase tracking-wider text-neutral-500">Main Tools (Team Mode)</label>
                <div className="flex flex-wrap gap-2 max-h-[140px] overflow-y-auto rounded-lg border border-neutral-700 p-2">
                  {availableTools.map((tool) => {
                    const selected = (graph.main_tool_ids || []).includes(tool.id);
                    const nextTools = selected
                      ? (graph.main_tool_ids || []).filter((id) => id !== tool.id)
                      : [...(graph.main_tool_ids || []), tool.id];
                    return (
                      <button
                        type="button"
                        key={`main-${tool.id}`}
                        onClick={() => setGraph((prev) => ({ ...prev, main_tool_ids: nextTools }))}
                        className={`px-2 py-1 rounded-md border text-[10px] ${selected ? "bg-purple-500/15 border-purple-500/40 text-purple-300" : "bg-neutral-900 border-neutral-700 text-neutral-400"}`}
                      >
                        <span>{tool.label}</span>
                        <span className={`ml-1.5 px-1 py-0.5 rounded border text-[9px] uppercase ${sourceBadgeClass(tool.source)}`}>
                          {tool.source}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {!selectedNode ? (
            <p className="text-xs text-neutral-500">Select a member card to edit.</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-neutral-500">Member Name</label>
                <input
                  value={selectedNode.name}
                  onChange={(e) => updateNode(selectedNode.id, { name: e.target.value })}
                  disabled={isProtectedMember(selectedNode)}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs disabled:opacity-60"
                />
                {isProtectedMember(selectedNode) && (
                  <div className="text-[10px] text-amber-300">Protected member name cannot be changed.</div>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-neutral-500">Description</label>
                <input
                  value={selectedNode.description}
                  onChange={(e) => updateNode(selectedNode.id, { description: e.target.value })}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-neutral-500">Member Instruction</label>
                <textarea
                  value={selectedNode.system_prompt}
                  onChange={(e) => updateNode(selectedNode.id, { system_prompt: e.target.value })}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs min-h-[110px]"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={generateInstructionForSelected}
                    disabled={generating}
                    className="px-2.5 py-1.5 text-[10px] rounded-md border border-purple-500/40 bg-purple-500/10 text-purple-300 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Sparkles size={12} />
                    {generating ? "Generating..." : (selectedNode.system_prompt?.trim() ? "Regenerate with AI" : "Generate with AI")}
                  </button>
                  <span className="text-[10px] text-neutral-500">Uses configured backend LLM</span>
                </div>
                {generateError && (
                  <div className="text-[10px] text-red-300 border border-red-500/30 rounded-md bg-red-500/10 px-2 py-1">
                    {generateError}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-neutral-500">Member Logo</label>
                <div className="flex items-center gap-2">
                  <label className="px-2 py-1 text-[10px] rounded-md border border-neutral-700 bg-neutral-900 cursor-pointer flex items-center gap-1">
                    <ImagePlus size={12} /> Upload
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadMemberLogo(e.target.files?.[0], selectedNode.id)} />
                  </label>
                  <button
                    type="button"
                    onClick={() => updateNode(selectedNode.id, { logo_url: null })}
                    className="px-2 py-1 text-[10px] rounded-md border border-neutral-700 bg-neutral-900"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-wider text-neutral-500">Tools</label>
                <div className="flex flex-wrap gap-2 max-h-[180px] overflow-y-auto rounded-lg border border-neutral-700 p-2">
                  {availableTools.map((tool) => {
                    const selected = (selectedNode.tool_ids || []).includes(tool.id);
                    const nextTools = selected
                      ? selectedNode.tool_ids.filter((id) => id !== tool.id)
                      : [...(selectedNode.tool_ids || []), tool.id];
                    return (
                      <button
                        type="button"
                        key={tool.id}
                        onClick={() => updateNode(selectedNode.id, { tool_ids: nextTools })}
                        className={`px-2 py-1 rounded-md border text-[10px] ${selected ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "bg-neutral-900 border-neutral-700 text-neutral-400"}`}
                      >
                        <span>{tool.label}</span>
                        <span className={`ml-1.5 px-1 py-0.5 rounded border text-[9px] uppercase ${sourceBadgeClass(tool.source)}`}>
                          {tool.source}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-neutral-700 bg-neutral-900 p-2">
                <span className="text-xs text-neutral-400">Enabled</span>
                <input
                  type="checkbox"
                  checked={selectedNode.enabled !== false}
                  onChange={(e) => updateNode(selectedNode.id, { enabled: e.target.checked })}
                />
              </div>
              <button
                onClick={() => deleteNode(selectedNode.id)}
                disabled={isProtectedMember(selectedNode)}
                className="w-full py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-xs flex items-center justify-center gap-1"
              >
                <Trash2 size={12} /> {isProtectedMember(selectedNode) ? "Protected Member" : "Delete Member"}
              </button>
            </>
          )}

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 text-[11px] text-neutral-500">
            <div className="flex items-center gap-1 mb-1 text-neutral-400"><ArrowRight size={12} /> Flow Rule</div>
            Saving this planner immediately syncs runtime main/member instructions.
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlannerWindowStandalone() {
  const closePlannerWindow = async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await getCurrentWindow().close();
        return;
      }
      window.close();
    } catch (err) {
      console.error("Failed to close planner window:", err);
    }
  };
  return <PlannerWindowPage onClose={closePlannerWindow} />;
}
