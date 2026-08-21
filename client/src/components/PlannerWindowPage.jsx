import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Crown,
  Plus,
  Trash2,
  Save,
  ArrowRight,
  UserRound,
  ImagePlus,
  Sparkles,
  Search,
  X,
  SlidersHorizontal,
  Layers,
  ShieldCheck,
  Lock,
} from "lucide-react";
import {
  getMcpStatus,
  getSettings,
  updateSetting,
  generatePlannerInstruction,
  getPlannerTools,
} from "../services/chatApi";
import rieLogo from "../assets/logo.png";

const MAIN_NODE_ID = "main_agent";
const PROTECTED_MEMBER_NAMES = new Set([
  "coding_specialist",
  "web_researcher",
  "desktop_controller",
  "mcp_registry",
]);

const PROTECTED_MEMBERS_MAP = {
  coding_specialist: {
    name: "coding_specialist",
    label: "Coding Specialist",
    description:
      "Expert at reading, modifying, creating, and debugging code in the workspace and running system terminal commands.",
    system_prompt:
      "You are an expert coding specialist. You have direct access to project files and terminal tools. Always select the most specific dedicated tools for viewing, editing, or searching files over writing raw scripts. When running terminal commands on the host OS (Windows), you MUST use native PowerShell/Windows commands rather than Linux commands (e.g. use type/Get-Content instead of cat, echo/New-Item instead of touch, and proper path formats). Write clean, bug-free, well-documented code adhering to the project's existing conventions and run tests to verify your work.",
    tool_ids: ["run_terminal_command"],
    capabilities_summary:
      "Equipped with Filesystem Middleware (direct workspace file editing, search, and syntax inspection) + System Terminal execution.",
  },
  web_researcher: {
    name: "web_researcher",
    label: "Web Researcher",
    description:
      "Expert at web research, searching the internet, scraping websites, extracting documentation, and browser automation.",
    system_prompt:
      "You are a web research and browser automation specialist. Use your internet search and browser tools to navigate websites, extract accurate information, scrape articles, and synthesize research findings concisely for the user.",
    tool_ids: [
      "internet_search",
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_navigate",
      "browser_scroll",
      "browser_tabs",
      "browser_extract",
      "browser_close",
    ],
    capabilities_summary:
      "Equipped with live Google search and full CamoFox browser automation (DOM snapshots, clicking, typing, scrolling, text extraction).",
  },
  desktop_controller: {
    name: "desktop_controller",
    label: "Desktop Controller",
    description:
      "Expert at automating Windows desktop applications, inspecting active GUI states, and simulating mouse and keyboard actions.",
    system_prompt:
      "You are a Windows desktop automation specialist. Use your desktop inspection, application control, mouse, and keyboard tools to interact with native Windows software, manage active windows, and automate user interface workflows.",
    tool_ids: [
      "get_desktop_state",
      "app_control",
      "mouse_click",
      "keyboard_type",
      "move_mouse",
      "scroll_mouse",
      "drag_mouse",
      "press_keys",
      "wait",
    ],
    capabilities_summary:
      "Equipped with Windows OS GUI automation: window focus, mouse clicks/movement, keyboard typing, and UI inspection.",
  },
  mcp_registry: {
    name: "mcp_registry",
    label: "MCP Registry",
    description:
      "Expert at managing MCP (Model Context Protocol) server connections, configurations, and registry.",
    system_prompt:
      "You are an MCP registry specialist. You can list, add, update, and delete MCP server configurations and inspect MCP capabilities. Use your dedicated MCP tools to manage external server connections, tools, and integrations for Rie.",
    tool_ids: [
      "list_mcp_servers",
      "add_mcp_server",
      "update_mcp_server",
      "delete_mcp_server",
    ],
    capabilities_summary:
      "Equipped with dynamic MCP server lifecycle tools: list, register, update, and remove MCP server endpoints.",
  },
};

const TONE_OPTIONS = [
  { id: "professional", label: "Professional" },
  { id: "strict", label: "Strict & Precise" },
  { id: "concise", label: "Ultra Concise" },
  { id: "explanatory", label: "Explanatory" },
  { id: "creative", label: "Creative" },
];

const STYLE_OPTIONS = [
  { id: "clear and practical", label: "Clear & Practical" },
  { id: "step-by-step", label: "Step-by-step Plan" },
  { id: "direct action", label: "Direct Action" },
  { id: "code-focused", label: "Code & Implementation" },
  { id: "advisory", label: "Advisory / Review" },
];

const CATEGORY_TABS = [
  { id: "all", label: "All" },
  { id: "built-in", label: "System" },
  { id: "browser", label: "Browser" },
  { id: "mcp", label: "MCP" },
  { id: "plugin", label: "Plugins" },
  { id: "external", label: "APIs" },
];

function defaultGraphFromSubagents(subagents = []) {
  const spacing = 130;
  const canonicalList = [
    {
      id: "subagent_1",
      name: "coding_specialist",
      description: PROTECTED_MEMBERS_MAP.coding_specialist.description,
      system_prompt: PROTECTED_MEMBERS_MAP.coding_specialist.system_prompt,
      tool_ids: PROTECTED_MEMBERS_MAP.coding_specialist.tool_ids,
      enabled: true,
      logo_url: null,
      position: { x: 360, y: 50 },
    },
    {
      id: "subagent_2",
      name: "web_researcher",
      description: PROTECTED_MEMBERS_MAP.web_researcher.description,
      system_prompt: PROTECTED_MEMBERS_MAP.web_researcher.system_prompt,
      tool_ids: PROTECTED_MEMBERS_MAP.web_researcher.tool_ids,
      enabled: true,
      logo_url: null,
      position: { x: 360, y: 50 + spacing },
    },
    {
      id: "subagent_3",
      name: "desktop_controller",
      description: PROTECTED_MEMBERS_MAP.desktop_controller.description,
      system_prompt: PROTECTED_MEMBERS_MAP.desktop_controller.system_prompt,
      tool_ids: PROTECTED_MEMBERS_MAP.desktop_controller.tool_ids,
      enabled: true,
      logo_url: null,
      position: { x: 360, y: 50 + spacing * 2 },
    },
    {
      id: "subagent_4",
      name: "mcp_registry",
      description: PROTECTED_MEMBERS_MAP.mcp_registry.description,
      system_prompt: PROTECTED_MEMBERS_MAP.mcp_registry.system_prompt,
      tool_ids: PROTECTED_MEMBERS_MAP.mcp_registry.tool_ids,
      enabled: true,
      logo_url: null,
      position: { x: 360, y: 50 + spacing * 3 },
    },
  ];

  const customNodes = (subagents || [])
    .filter(
      (s) =>
        !PROTECTED_MEMBER_NAMES.has((s.name || "").trim().toLowerCase())
    )
    .map((sub, idx) => ({
      id: `subagent_${idx + 5}`,
      name: sub.name || `member_${idx + 5}`,
      description: sub.description || "",
      system_prompt: sub.system_prompt || "",
      tool_ids: sub.tool_ids || [],
      enabled: sub.enabled !== false,
      logo_url: null,
      position: { x: 360, y: 50 + (idx + 4) * spacing },
    }));

  const nodes = [...canonicalList, ...customNodes];
  const edges = nodes.map((n) => ({ source: MAIN_NODE_ID, target: n.id }));
  return {
    main_node_id: MAIN_NODE_ID,
    main_label: "Rie",
    main_logo_url: null,
    main_tool_ids: [],
    main_instruction:
      "You are Rie, the main coordinator. Delegate tasks to the right specialized team members and ensure high-quality results.",
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
  const [dynamicTools, setDynamicTools] = useState([]);
  const [graph, setGraph] = useState({
    main_node_id: MAIN_NODE_ID,
    main_label: "Rie",
    main_logo_url: null,
    main_tool_ids: [],
    main_instruction:
      "You are Rie, the main coordinator. Delegate tasks to the right team members and ensure high-quality results.",
    nodes: [],
    edges: [],
  });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [mcpToolsCatalog, setMcpToolsCatalog] = useState([]);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);

  // Filter & Search states
  const [toolSearch, setToolSearch] = useState("");
  const [toolCategory, setToolCategory] = useState("all");

  // AI Prompt generation options
  const [aiTone, setAiTone] = useState("professional");
  const [aiStyle, setAiStyle] = useState("clear and practical");
  const [showAiOptions, setShowAiOptions] = useState(false);

  const canvasRef = useRef(null);

  // Smooth window-level mouse drag listener
  useEffect(() => {
    if (!draggingNodeId) return;

    const handleMouseMove = (e) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = Math.max(
        220,
        Math.min(rect.width - 160, e.clientX - rect.left - 60)
      );
      const y = Math.max(
        20,
        Math.min(rect.height - 80, e.clientY - rect.top - 20)
      );
      updateNode(draggingNodeId, { position: { x, y } });
    };

    const handleMouseUp = () => {
      setDraggingNodeId(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingNodeId]);

  const availableTools = useMemo(() => {
    if (dynamicTools && dynamicTools.length > 0) {
      return dynamicTools;
    }

    // Fallback static list
    const builtIns = [
      { id: "internet_search", label: "Internet Search", source: "built-in", description: "Search the web" },
      { id: "ask_question", label: "Ask Question", source: "built-in", description: "Interactive clarification" },
      { id: "browser_open", label: "Browser Open", source: "browser", description: "Open browser" },
      { id: "browser_snapshot", label: "Browser Snapshot", source: "browser", description: "Capture accessibility snapshot" },
      { id: "browser_click", label: "Browser Click", source: "browser", description: "Click web element" },
      { id: "browser_type", label: "Browser Type", source: "browser", description: "Type into input" },
      { id: "browser_navigate", label: "Browser Navigate", source: "browser", description: "Navigate URL" },
      { id: "browser_scroll", label: "Browser Scroll", source: "browser", description: "Scroll page" },
      { id: "browser_tabs", label: "Browser Tabs", source: "browser", description: "Manage tabs" },
      { id: "browser_extract", label: "Browser Extract", source: "browser", description: "Extract text" },
      { id: "browser_close", label: "Browser Close", source: "browser", description: "Close browser" },
      { id: "run_terminal_command", label: "System Terminal", source: "built-in", description: "Run system terminal command" },
      { id: "get_desktop_state", label: "Desktop State", source: "built-in", description: "Inspect active desktop" },
      { id: "app_control", label: "App Control", source: "built-in", description: "Launch or switch apps" },
      { id: "mouse_click", label: "Mouse Click", source: "built-in", description: "Click desktop coordinates" },
      { id: "keyboard_type", label: "Keyboard Type", source: "built-in", description: "Type text into app" },
      { id: "move_mouse", label: "Move Mouse", source: "built-in", description: "Move mouse cursor" },
      { id: "scroll_mouse", label: "Scroll Mouse", source: "built-in", description: "Scroll mouse wheel" },
      { id: "drag_mouse", label: "Drag Mouse", source: "built-in", description: "Drag mouse" },
      { id: "press_keys", label: "Press Keys", source: "built-in", description: "Press key combination" },
      { id: "wait", label: "Wait", source: "built-in", description: "Pause execution" },
    ];
    const external = (settings.external_apis || []).map((api) => ({
      id: api.name,
      label: api.name,
      source: "external",
      description: api.description || "External API",
    }));
    const mcp = mcpToolsCatalog.map((tool) => ({
      id: tool.name,
      label: tool.name,
      source: "mcp",
      description: tool.description || "MCP tool",
    }));
    const sourceOrder = { "built-in": 0, browser: 1, plugin: 2, mcp: 3, external: 4 };
    return [...builtIns, ...external, ...mcp].sort((a, b) => {
      const sourceDelta =
        (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99);
      if (sourceDelta !== 0) return sourceDelta;
      return String(a.label).localeCompare(String(b.label));
    });
  }, [dynamicTools, settings.external_apis, mcpToolsCatalog]);

  const filteredTools = useMemo(() => {
    return availableTools.filter((t) => {
      if (toolCategory !== "all" && t.source !== toolCategory) {
        return false;
      }
      if (toolSearch.trim()) {
        const query = toolSearch.toLowerCase().trim();
        const matchLabel = (t.label || "").toLowerCase().includes(query);
        const matchId = (t.id || "").toLowerCase().includes(query);
        const matchDesc = (t.description || "").toLowerCase().includes(query);
        return matchLabel || matchId || matchDesc;
      }
      return true;
    });
  }, [availableTools, toolCategory, toolSearch]);

  const sourceBadgeClass = (source) => {
    if (source === "browser") return "border-cyan-500/30 text-cyan-300 bg-cyan-500/10";
    if (source === "mcp") return "border-blue-500/30 text-blue-300 bg-blue-500/10";
    if (source === "plugin") return "border-emerald-500/30 text-emerald-300 bg-emerald-500/10";
    if (source === "external") return "border-amber-500/30 text-amber-300 bg-amber-500/10";
    return "border-neutral-600 text-neutral-400 bg-neutral-900";
  };

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [data, toolsRes] = await Promise.all([
          getSettings(),
          getPlannerTools().catch(() => null),
        ]);
        setSettings(data);
        if (toolsRes?.tools?.length) {
          setDynamicTools(toolsRes.tools);
        }
        const rawPlanner =
          data.subagent_planner_graph ||
          defaultGraphFromSubagents(data.subagents_config || []);

        const existingNodeNames = new Set();
        const sanitizedNodes = (rawPlanner.nodes || []).map((node) => {
          const lowerName = (node.name || "").trim().toLowerCase();
          existingNodeNames.add(lowerName);
          if (PROTECTED_MEMBERS_MAP[lowerName]) {
            const canonical = PROTECTED_MEMBERS_MAP[lowerName];
            return {
              ...node,
              name: canonical.name,
              description: canonical.description,
              system_prompt: canonical.system_prompt,
              tool_ids: canonical.tool_ids,
            };
          }
          return node;
        });

        // Auto-inject missing canonical protected specialists
        const spacing = 130;
        let nextY = 50;
        if (sanitizedNodes.length > 0) {
          const maxY = Math.max(...sanitizedNodes.map((n) => n.position?.y || 0));
          nextY = maxY + spacing;
        }

        const canonicalKeys = Object.keys(PROTECTED_MEMBERS_MAP);
        canonicalKeys.forEach((key, idx) => {
          if (!existingNodeNames.has(key)) {
            const canonical = PROTECTED_MEMBERS_MAP[key];
            const newNodeId = `subagent_core_${key}`;
            sanitizedNodes.push({
              id: newNodeId,
              name: canonical.name,
              description: canonical.description,
              system_prompt: canonical.system_prompt,
              tool_ids: canonical.tool_ids,
              enabled: true,
              logo_url: null,
              position: { x: 360, y: nextY + idx * spacing },
            });
          }
        });

        const existingEdges = rawPlanner.edges || [];
        const connectedTargets = new Set(existingEdges.map((e) => e.target));
        const updatedEdges = [...existingEdges];
        sanitizedNodes.forEach((node) => {
          if (!connectedTargets.has(node.id)) {
            updatedEdges.push({ source: MAIN_NODE_ID, target: node.id });
          }
        });

        setGraph({
          ...rawPlanner,
          main_tool_ids: Array.isArray(rawPlanner.main_tool_ids)
            ? rawPlanner.main_tool_ids
            : [],
          nodes: sanitizedNodes,
          edges: updatedEdges,
        });

        if (sanitizedNodes.length) {
          setSelectedNodeId(sanitizedNodes[0].id);
        }
        const mcpStatus = await getMcpStatus().catch(() => ({
          available_tools: [],
        }));
        setMcpToolsCatalog(mcpStatus.available_tools || []);
      } catch (err) {
        setError(err.message || "Failed to load planner settings");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const selectedNode =
    graph.nodes.find((n) => n.id === selectedNodeId) || null;
  const isMainSelected = selectedNodeId === MAIN_NODE_ID;

  // Fixed coordinator position
  const mainPosition = { x: 80, y: 220 };

  const isProtectedMember = (member) =>
    !!member &&
    PROTECTED_MEMBER_NAMES.has((member.name || "").trim().toLowerCase());

  const addSubAgentNode = () => {
    const customCount =
      graph.nodes.filter((n) => !isProtectedMember(n)).length + 1;
    const member = {
      id: `subagent_${Date.now()}`,
      name: `member_${customCount}`,
      description: "Custom team specialist",
      system_prompt: "Describe this member's behavior and role.",
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
      nodes: prev.nodes.map((n) =>
        n.id === nodeId ? { ...n, ...patch } : n
      ),
    }));
  };

  const deleteNode = (nodeId) => {
    const targetNode = graph.nodes.find((n) => n.id === nodeId);
    if (isProtectedMember(targetNode)) {
      setError(`'${targetNode.name}' is a protected core agent and cannot be deleted.`);
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
      const result = await updateSetting(
        "SUBAGENT_PLANNER_GRAPH",
        JSON.stringify(graph)
      );
      setSaveMessage(result?.message || "Planner saved and runtime synced.");
    } catch (err) {
      setError(err.message || "Failed to save planner graph");
    } finally {
      setSaving(false);
    }
  };

  const generateInstructionForSelected = async () => {
    if (!selectedNode || isProtectedMember(selectedNode)) return;
    if ((selectedNode.system_prompt || "").trim()) {
      const confirmed = window.confirm(
        "Overwrite current instruction with AI-generated text?"
      );
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
        tone: aiTone,
        style: aiStyle,
      });
      updateNode(selectedNode.id, {
        system_prompt: result.instruction_text || "",
      });
    } catch (err) {
      setGenerateError(err.message || "Failed to generate instruction");
    } finally {
      setGenerating(false);
    }
  };

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

  if (loading) {
    return (
      <div
        data-tauri-drag-region
        className="h-screen w-screen bg-neutral-950 text-neutral-300 p-6 flex items-center justify-center"
      >
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
          <span className="text-xs">Loading team planner...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-neutral-950 text-neutral-200 flex flex-col select-none">
      {/* Header Bar */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 shrink-0"
      >
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold tracking-wide flex items-center gap-1.5">
            <Layers size={15} className="text-emerald-400" />
            Planner
          </h1>
          <span className="text-[10px] px-2 py-0.5 rounded border border-emerald-700/60 text-emerald-300 bg-emerald-950/40">
            Runtime-Active Team
          </span>
        </div>
        <div className="flex items-center gap-2 cursor-default">
          <button
            type="button"
            onClick={addSubAgentNode}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs flex items-center gap-1 transition-colors"
          >
            <Plus size={13} /> Add Custom Member
          </button>
          <button
            type="button"
            onClick={saveGraph}
            disabled={saving}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium flex items-center gap-1 transition-colors disabled:opacity-50"
          >
            <Save size={13} /> {saving ? "Saving..." : "Save Changes"}
          </button>
          <button
            type="button"
            onClick={() => onClose()}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {saveMessage && (
        <div className="mx-4 mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {saveMessage}
        </div>
      )}

      <div className="flex-1 grid grid-cols-[1fr_390px] overflow-hidden">
        {/* Visual Canvas */}
        <div
          ref={canvasRef}
          className="relative border-r border-neutral-800 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.06)_1px,transparent_0)] [background-size:24px_24px] overflow-hidden"
        >
          {/* Connection Bezier Curves */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {graph.edges.map((edge) => {
              const target = graph.nodes.find((n) => n.id === edge.target);
              if (!target) return null;
              const x1 = mainPosition.x + 48;
              const y1 = mainPosition.y + 24;
              const x2 = target.position.x;
              const y2 = target.position.y + 24;
              const midX = x1 + (x2 - x1) * 0.45;
              const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
              const isTargetSelected = selectedNodeId === target.id;
              return (
                <g key={`${edge.source}-${edge.target}`}>
                  <path
                    d={path}
                    fill="none"
                    stroke={
                      isTargetSelected
                        ? "rgba(52, 211, 153, 0.7)"
                        : "rgba(148, 163, 184, 0.35)"
                    }
                    strokeWidth={isTargetSelected ? "2.5" : "1.8"}
                    strokeLinecap="round"
                  />
                  <circle
                    cx={x2}
                    cy={y2}
                    r="3.5"
                    fill={isTargetSelected ? "#34d399" : "#94a3b8"}
                  />
                </g>
              );
            })}
          </svg>

          {/* Coordinator Node */}
          <div
            className="absolute flex flex-col items-center gap-1 cursor-pointer transition-transform duration-150"
            style={{ left: `${mainPosition.x}px`, top: `${mainPosition.y}px` }}
            onMouseDown={() => setSelectedNodeId(MAIN_NODE_ID)}
          >
            <div
              className={`w-12 h-12 min-w-[48px] min-h-[48px] max-w-[48px] max-h-[48px] rounded-full overflow-hidden shrink-0 bg-neutral-900 flex items-center justify-center transition-all ${
                isMainSelected
                  ? "border-2 border-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.5)] scale-105"
                  : "border border-emerald-500/60 shadow-[0_0_12px_rgba(16,185,129,0.25)] hover:border-emerald-400"
              }`}
            >
              <img
                src={graph.main_logo_url || rieLogo}
                alt="rie-logo"
                className="w-full h-full object-cover block"
              />
            </div>
            <div className="flex items-center gap-1">
              <Crown size={11} className="text-amber-400" />
              <span
                className={`text-xs font-semibold ${
                  isMainSelected ? "text-emerald-300" : "text-neutral-300"
                }`}
              >
                {graph.main_label || "Rie"}
              </span>
            </div>
          </div>

          {/* Team Member Nodes */}
          {graph.nodes.map((node) => {
            const isProtected = isProtectedMember(node);
            const isSelected = selectedNodeId === node.id;
            return (
              <div
                key={node.id}
                className="absolute cursor-move"
                style={{
                  left: `${node.position.x}px`,
                  top: `${node.position.y}px`,
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setDraggingNodeId(node.id);
                  setSelectedNodeId(node.id);
                }}
              >
                <div
                  className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl bg-neutral-900/95 backdrop-blur border transition-all ${
                    isSelected
                      ? isProtected
                        ? "border-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.35)] scale-[1.02]"
                        : "border-emerald-400 shadow-[0_0_18px_rgba(16,185,129,0.35)] scale-[1.02]"
                      : "border-neutral-700 hover:border-neutral-500"
                  }`}
                >
                  <div
                    className={`w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] rounded-full overflow-hidden shrink-0 bg-neutral-950 flex items-center justify-center ${
                      isSelected
                        ? isProtected
                          ? "border border-amber-400"
                          : "border border-emerald-400"
                        : "border border-neutral-700"
                    }`}
                  >
                    {node.logo_url ? (
                      <img
                        src={node.logo_url}
                        alt={`${node.name}-logo`}
                        className="w-full h-full object-cover block"
                      />
                    ) : (
                      <UserRound className="w-4 h-4 text-neutral-400" />
                    )}
                  </div>
                  <div className="flex flex-col min-w-[90px] max-w-[150px]">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-xs font-semibold truncate ${
                          isSelected
                            ? isProtected
                              ? "text-amber-300"
                              : "text-emerald-300"
                            : "text-neutral-200"
                        }`}
                      >
                        {node.name}
                      </span>
                      {isProtected ? (
                        <ShieldCheck
                          size={12}
                          className="text-amber-400 shrink-0"
                          title="Protected Core Agent"
                        />
                      ) : (
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            node.enabled ? "bg-emerald-400" : "bg-red-400"
                          }`}
                          title={node.enabled ? "Active" : "Paused"}
                        />
                      )}
                    </div>
                    <span className="text-[10px] text-neutral-400 truncate">
                      {isProtected
                        ? "Core Specialist"
                        : `${node.tool_ids?.length || 0} tools`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Sidebar / Properties Panel */}
        <div className="p-4 overflow-y-auto custom-scrollbar space-y-4 bg-neutral-950/80">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-400">
              {isMainSelected ? "Coordinator Settings" : "Member Settings"}
            </h2>
            {selectedNode && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-400">
                ID: {selectedNode.id}
              </span>
            )}
          </div>

          {/* Main Coordinator Settings */}
          {isMainSelected && (
            <div className="space-y-3 rounded-xl border border-neutral-800 p-3.5 bg-neutral-900/40">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Coordinator Name
                </label>
                <input
                  value={graph.main_label || ""}
                  onChange={(e) =>
                    setGraph((prev) => ({
                      ...prev,
                      main_label: e.target.value,
                    }))
                  }
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Coordinator Logo
                </label>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 min-w-[28px] min-h-[28px] max-w-[28px] max-h-[28px] rounded-full overflow-hidden shrink-0 bg-neutral-900 border border-neutral-700 flex items-center justify-center">
                    <img
                      src={graph.main_logo_url || rieLogo}
                      alt="preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <label className="px-2.5 py-1.5 text-[11px] rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 cursor-pointer flex items-center gap-1.5 transition-colors">
                    <ImagePlus size={13} /> Upload Image
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => uploadBossLogo(e.target.files?.[0])}
                    />
                  </label>
                  {graph.main_logo_url && (
                    <button
                      type="button"
                      onClick={() =>
                        setGraph((prev) => ({ ...prev, main_logo_url: null }))
                      }
                      className="px-2.5 py-1.5 text-[11px] rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-400 transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Delegation Instruction
                </label>
                <textarea
                  value={graph.main_instruction || ""}
                  onChange={(e) =>
                    setGraph((prev) => ({
                      ...prev,
                      main_instruction: e.target.value,
                    }))
                  }
                  rows={4}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2.5 text-xs focus:outline-none focus:border-emerald-500 custom-scrollbar"
                />
              </div>

              {/* Tool Selection for Coordinator */}
              <div className="space-y-2 pt-2 border-t border-neutral-800">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                    Coordinator Tools
                  </label>
                  <span className="text-[10px] text-neutral-500">
                    {graph.main_tool_ids?.length || 0} selected
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="relative">
                    <Search
                      size={12}
                      className="absolute left-2.5 top-2.5 text-neutral-500"
                    />
                    <input
                      type="text"
                      placeholder="Search tools..."
                      value={toolSearch}
                      onChange={(e) => setToolSearch(e.target.value)}
                      className="w-full bg-neutral-900/90 border border-neutral-700/80 rounded-lg pl-8 pr-7 py-1.5 text-xs focus:outline-none focus:border-emerald-500"
                    />
                    {toolSearch && (
                      <button
                        type="button"
                        onClick={() => setToolSearch("")}
                        className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar pb-1">
                    {CATEGORY_TABS.map((tab) => (
                      <button
                        key={`main-tab-${tab.id}`}
                        type="button"
                        onClick={() => setToolCategory(tab.id)}
                        className={`px-2 py-1 rounded text-[10px] whitespace-nowrap transition-colors ${
                          toolCategory === tab.id
                            ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-medium"
                            : "bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 max-h-[160px] overflow-y-auto custom-scrollbar rounded-lg border border-neutral-800 p-2 bg-neutral-900/60">
                  {filteredTools.map((tool) => {
                    const selected = (graph.main_tool_ids || []).includes(
                      tool.id
                    );
                    const nextTools = selected
                      ? (graph.main_tool_ids || []).filter(
                          (id) => id !== tool.id
                        )
                      : [...(graph.main_tool_ids || []), tool.id];
                    return (
                      <button
                        type="button"
                        key={`main-${tool.id}`}
                        title={tool.description || tool.label}
                        onClick={() =>
                          setGraph((prev) => ({
                            ...prev,
                            main_tool_ids: nextTools,
                          }))
                        }
                        className={`px-2 py-1 rounded-md border text-[10px] flex items-center gap-1.5 transition-colors ${
                          selected
                            ? "bg-purple-500/15 border-purple-500/40 text-purple-300 font-medium"
                            : "bg-neutral-900 border-neutral-700/80 text-neutral-400 hover:border-neutral-600"
                        }`}
                      >
                        <span>{tool.label}</span>
                        <span
                          className={`px-1 py-0.2 rounded border text-[9px] uppercase ${sourceBadgeClass(
                            tool.source
                          )}`}
                        >
                          {tool.source}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {!selectedNode && !isMainSelected && (
            <div className="p-6 text-center border border-dashed border-neutral-800 rounded-xl">
              <p className="text-xs text-neutral-500">
                Select a team member node on the canvas to configure roles and tools.
              </p>
            </div>
          )}

          {/* Protected Predefined Member Settings (Read-Only & Canonical) */}
          {selectedNode && !isMainSelected && isProtectedMember(selectedNode) && (
            <div className="space-y-3.5">
              {/* Protected Banner */}
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <div className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                    <span>Protected Core Specialist</span>
                    <Lock size={11} className="text-amber-400/80" />
                  </div>
                  <p className="text-[11px] text-amber-200/80 leading-relaxed">
                    This is a built-in system agent. System instructions, filesystem middleware, and tool bindings are pre-configured and managed by the runtime engine.
                  </p>
                </div>
              </div>

              {/* Name (Locked) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                    Specialist Identifier
                  </label>
                  <span className="text-[10px] text-amber-400/80 flex items-center gap-1">
                    <Lock size={10} /> Locked
                  </span>
                </div>
                <input
                  value={selectedNode.name}
                  disabled
                  className="w-full bg-neutral-900/60 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-400 cursor-not-allowed"
                />
              </div>

              {/* Description (Locked) */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Role Description
                </label>
                <input
                  value={selectedNode.description}
                  disabled
                  className="w-full bg-neutral-900/60 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-400 cursor-not-allowed"
                />
              </div>

              {/* System Instruction (Locked) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                    Dedicated System Instruction
                  </label>
                  <span className="text-[10px] text-neutral-500">Pre-configured</span>
                </div>
                <textarea
                  value={selectedNode.system_prompt}
                  disabled
                  rows={5}
                  className="w-full bg-neutral-900/60 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-400 font-mono leading-relaxed cursor-not-allowed custom-scrollbar"
                />
              </div>

              {/* Dedicated Tools (Locked Badges) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                    Dedicated Tool Bindings
                  </label>
                  <span className="text-[10px] text-emerald-400">Runtime Managed</span>
                </div>
                <div className="flex flex-wrap gap-1.5 p-2.5 rounded-lg bg-neutral-900/60 border border-neutral-800">
                  {(selectedNode.tool_ids || []).map((tid) => {
                    const toolObj = availableTools.find((t) => t.id === tid);
                    return (
                      <div
                        key={tid}
                        className="px-2 py-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[10px] flex items-center gap-1.5"
                      >
                        <Lock size={10} className="text-emerald-400/70" />
                        <span>{toolObj?.label || tid}</span>
                      </div>
                    );
                  })}
                </div>
                {PROTECTED_MEMBERS_MAP[selectedNode.name]?.capabilities_summary && (
                  <p className="text-[10px] text-neutral-500 px-0.5">
                    {PROTECTED_MEMBERS_MAP[selectedNode.name].capabilities_summary}
                  </p>
                )}
              </div>

              {/* Member Avatar */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Member Avatar
                </label>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 min-w-[28px] min-h-[28px] max-w-[28px] max-h-[28px] rounded-full overflow-hidden shrink-0 bg-neutral-900 border border-neutral-700 flex items-center justify-center">
                    {selectedNode.logo_url ? (
                      <img
                        src={selectedNode.logo_url}
                        alt="preview"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <UserRound className="w-3.5 h-3.5 text-neutral-500" />
                    )}
                  </div>
                  <label className="px-2.5 py-1.5 text-[11px] rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 cursor-pointer flex items-center gap-1.5 transition-colors">
                    <ImagePlus size={13} /> Upload Avatar
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        uploadMemberLogo(e.target.files?.[0], selectedNode.id)
                      }
                    />
                  </label>
                  {selectedNode.logo_url && (
                    <button
                      type="button"
                      onClick={() =>
                        updateNode(selectedNode.id, { logo_url: null })
                      }
                      className="px-2.5 py-1.5 text-[11px] rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-400 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Status Toggle */}
              <div className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5">
                <span className="text-xs text-neutral-300">Specialist Status</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span
                    className={`text-[10px] font-medium ${
                      selectedNode.enabled !== false
                        ? "text-emerald-400"
                        : "text-neutral-500"
                    }`}
                  >
                    {selectedNode.enabled !== false ? "Active" : "Paused"}
                  </span>
                  <input
                    type="checkbox"
                    checked={selectedNode.enabled !== false}
                    onChange={(e) =>
                      updateNode(selectedNode.id, { enabled: e.target.checked })
                    }
                    className="accent-emerald-500 w-4 h-4 cursor-pointer"
                  />
                </label>
              </div>

              {/* Delete Button (Disabled) */}
              <button
                type="button"
                disabled
                className="w-full py-2 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-500 text-xs flex items-center justify-center gap-1.5 cursor-not-allowed opacity-50"
              >
                <Lock size={13} /> Protected Core Member (Cannot Delete)
              </button>
            </div>
          )}

          {/* Custom Editable Member Settings */}
          {selectedNode && !isMainSelected && !isProtectedMember(selectedNode) && (
            <div className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Member Name
                </label>
                <input
                  value={selectedNode.name}
                  onChange={(e) =>
                    updateNode(selectedNode.id, { name: e.target.value })
                  }
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Role Description
                </label>
                <input
                  value={selectedNode.description}
                  onChange={(e) =>
                    updateNode(selectedNode.id, { description: e.target.value })
                  }
                  placeholder="e.g. Scrapes websites and extracts articles"
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* AI Instruction Generator */}
              <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                    System Instruction
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowAiOptions(!showAiOptions)}
                    className="text-[10px] text-purple-400 hover:text-purple-300 flex items-center gap-1"
                  >
                    <SlidersHorizontal size={11} />
                    {showAiOptions ? "Hide Options" : "Prompt Options"}
                  </button>
                </div>

                {showAiOptions && (
                  <div className="grid grid-cols-2 gap-2 p-2 rounded-lg bg-neutral-950 border border-neutral-800">
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase tracking-wider text-neutral-500">
                        Tone
                      </label>
                      <select
                        value={aiTone}
                        onChange={(e) => setAiTone(e.target.value)}
                        className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[11px] focus:outline-none"
                      >
                        {TONE_OPTIONS.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] uppercase tracking-wider text-neutral-500">
                        Style
                      </label>
                      <select
                        value={aiStyle}
                        onChange={(e) => setAiStyle(e.target.value)}
                        className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[11px] focus:outline-none"
                      >
                        {STYLE_OPTIONS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <textarea
                  value={selectedNode.system_prompt}
                  onChange={(e) =>
                    updateNode(selectedNode.id, {
                      system_prompt: e.target.value,
                    })
                  }
                  rows={4}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2.5 text-xs focus:outline-none focus:border-emerald-500 custom-scrollbar"
                />

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={generateInstructionForSelected}
                    disabled={generating}
                    className="px-3 py-1.5 text-[11px] font-medium rounded-lg border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                  >
                    <Sparkles size={13} />
                    {generating
                      ? "Generating Prompt..."
                      : selectedNode.system_prompt?.trim()
                      ? "Regenerate with AI"
                      : "Generate with AI"}
                  </button>
                  <span className="text-[10px] text-neutral-500">
                    Backend LLM
                  </span>
                </div>

                {generateError && (
                  <div className="text-[10px] text-red-300 border border-red-500/30 rounded-md bg-red-500/10 px-2 py-1">
                    {generateError}
                  </div>
                )}
              </div>

              {/* Member Avatar */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                  Member Avatar
                </label>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 min-w-[28px] min-h-[28px] max-w-[28px] max-h-[28px] rounded-full overflow-hidden shrink-0 bg-neutral-900 border border-neutral-700 flex items-center justify-center">
                    {selectedNode.logo_url ? (
                      <img
                        src={selectedNode.logo_url}
                        alt="preview"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <UserRound className="w-3.5 h-3.5 text-neutral-500" />
                    )}
                  </div>
                  <label className="px-2.5 py-1.5 text-[11px] rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 cursor-pointer flex items-center gap-1.5 transition-colors">
                    <ImagePlus size={13} /> Upload Avatar
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        uploadMemberLogo(
                          e.target.files?.[0],
                          selectedNode.id
                        )
                      }
                    />
                  </label>
                  {selectedNode.logo_url && (
                    <button
                      type="button"
                      onClick={() =>
                        updateNode(selectedNode.id, { logo_url: null })
                      }
                      className="px-2.5 py-1.5 text-[11px] rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-400 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Tools selection with search and categories */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-medium tracking-wider text-neutral-500">
                    Assigned Tools
                  </label>
                  <span className="text-[10px] text-neutral-500">
                    {selectedNode.tool_ids?.length || 0} selected
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="relative">
                    <Search
                      size={12}
                      className="absolute left-2.5 top-2.5 text-neutral-500"
                    />
                    <input
                      type="text"
                      placeholder="Search tools..."
                      value={toolSearch}
                      onChange={(e) => setToolSearch(e.target.value)}
                      className="w-full bg-neutral-900/90 border border-neutral-700/80 rounded-lg pl-8 pr-7 py-1.5 text-xs focus:outline-none focus:border-emerald-500"
                    />
                    {toolSearch && (
                      <button
                        type="button"
                        onClick={() => setToolSearch("")}
                        className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar pb-1">
                    {CATEGORY_TABS.map((tab) => (
                      <button
                        key={`member-tab-${tab.id}`}
                        type="button"
                        onClick={() => setToolCategory(tab.id)}
                        className={`px-2 py-1 rounded text-[10px] whitespace-nowrap transition-colors ${
                          toolCategory === tab.id
                            ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-medium"
                            : "bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 max-h-[170px] overflow-y-auto custom-scrollbar rounded-lg border border-neutral-800 p-2 bg-neutral-900/60">
                  {filteredTools.map((tool) => {
                    const selected = (selectedNode.tool_ids || []).includes(
                      tool.id
                    );
                    const nextTools = selected
                      ? (selectedNode.tool_ids || []).filter(
                          (id) => id !== tool.id
                        )
                      : [...(selectedNode.tool_ids || []), tool.id];
                    return (
                      <button
                        type="button"
                        key={`member-${tool.id}`}
                        title={tool.description || tool.label}
                        onClick={() =>
                          updateNode(selectedNode.id, {
                            tool_ids: nextTools,
                          })
                        }
                        className={`px-2 py-1 rounded-md border text-[10px] flex items-center gap-1.5 transition-colors ${
                          selected
                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 font-medium"
                            : "bg-neutral-900 border-neutral-700/80 text-neutral-400 hover:border-neutral-600"
                        }`}
                      >
                        <span>{tool.label}</span>
                        <span
                          className={`px-1 py-0.2 rounded border text-[9px] uppercase ${sourceBadgeClass(
                            tool.source
                          )}`}
                        >
                          {tool.source}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Status Toggle */}
              <div className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5">
                <span className="text-xs text-neutral-300">Member Status</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span
                    className={`text-[10px] font-medium ${
                      selectedNode.enabled !== false
                        ? "text-emerald-400"
                        : "text-neutral-500"
                    }`}
                  >
                    {selectedNode.enabled !== false ? "Active" : "Paused"}
                  </span>
                  <input
                    type="checkbox"
                    checked={selectedNode.enabled !== false}
                    onChange={(e) =>
                      updateNode(selectedNode.id, { enabled: e.target.checked })
                    }
                    className="accent-emerald-500 w-4 h-4 cursor-pointer"
                  />
                </label>
              </div>

              {/* Delete Button */}
              <button
                type="button"
                onClick={() => deleteNode(selectedNode.id)}
                className="w-full py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-xs flex items-center justify-center gap-1.5 hover:bg-red-500/20 transition-colors"
              >
                <Trash2 size={13} /> Delete Member
              </button>
            </div>
          )}

          <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3 text-[11px] text-neutral-500">
            <div className="flex items-center gap-1.5 mb-1 text-neutral-400 font-medium">
              <ArrowRight size={12} className="text-emerald-400" />
              Runtime Sync
            </div>
            Saving this planner immediately updates the multi-agent execution
            engine and synchronizes member prompts and tools.
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
