"""
Pydantic models for request/response schemas
"""
from datetime import datetime
from typing import Literal, Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    """Request model for chat endpoint"""
    message: str
    user_id: Optional[str] = None
    # Optional conversation/thread identifier.
    # The frontend should generate a new thread_id whenever the user
    # clears the chat history, and reuse the same id for subsequent
    # messages in that thread.
    thread_id: Optional[str] = None
    image_url: Optional[str] = None
    is_voice: Optional[bool] = False
    conversation_history: Optional[List[Dict[str, Any]]] = None
    messages: Optional[List[Dict[ Any, Any]]] = None
    project_root: Optional[str] = None
    token: Optional[str] = None
    clipboard_text: Optional[str] = None
    chat_mode: Optional[str] = None  # "agent" or "chat"
    speed_mode: Optional[str] = None  # "thinking" or "flash"
    friend_target_id: Optional[str] = None
    friend_target_name: Optional[str] = None
    # Client device clock — used so the model does not guess wrong year/day for scheduling
    client_timezone: Optional[str] = Field(
        default=None,
        description="IANA timezone from the user's device, e.g. America/New_York",
    )
    client_local_datetime_iso: Optional[str] = Field(
        default=None,
        description="User's local date and time as ISO 8601 with numeric offset (from browser)",
    )


class CancelRequest(BaseModel):
    """Request model for cancelling a running chat stream"""
    thread_id: str = Field(..., description="The thread ID of the stream to cancel")


class SpeakRequest(BaseModel):
    """Request model for text-to-speech"""
    text: str
    voice: Optional[str] = None
    provider: Optional[str] = "edge-tts"





class CustomAPIConfig(BaseModel):
    """Configuration for a custom external API tool"""
    name: str = Field(..., description="Unique name of the tool")
    description: str = Field(..., description="Description of what the tool does for the AI")
    url: str = Field(..., description="API URL (supports {param} syntax)")
    method: str = Field("GET", description="HTTP method (GET, POST, PUT, PATCH, DELETE)")
    headers: Optional[Dict[str, str]] = Field(default_factory=dict, description="HTTP headers")
    body: Optional[str] = Field(None, description="Request body as JSON string for POST/PUT/PATCH. Use {param_name} for values the AI will fill. Omit to send tool parameters as JSON body.")
    parameters_schema: Optional[Dict[str, Any]] = Field(None, description="JSON schema for tool parameters (optional)")
    enabled: bool = Field(True, description="Whether this custom API tool is enabled for runtime registration")

class SubAgentConfig(BaseModel):
    """Configuration for a user-defined sub-agent."""
    name: str = Field(..., description="Unique sub-agent name used for routing")
    description: str = Field(..., description="Short description of the sub-agent responsibilities")
    system_prompt: str = Field(..., description="Sub-agent instruction prompt")
    tool_ids: List[str] = Field(default_factory=list, description="Tool IDs assigned to this sub-agent")
    enabled: bool = Field(True, description="Whether this sub-agent is enabled")

class PlannerNodePosition(BaseModel):
    x: float = Field(..., description="Canvas X coordinate")
    y: float = Field(..., description="Canvas Y coordinate")

class PlannerSubAgentNode(BaseModel):
    id: str = Field(..., description="Unique node id")
    name: str = Field(..., description="Unique sub-agent name")
    description: str = Field(..., description="Short node description")
    system_prompt: str = Field(..., description="Sub-agent instruction prompt")
    tool_ids: List[str] = Field(default_factory=list, description="Assigned tool IDs")
    enabled: bool = Field(True, description="Whether node is enabled")
    logo_url: Optional[str] = Field(None, description="Optional custom logo URL/data URL")
    position: PlannerNodePosition

class PlannerEdge(BaseModel):
    source: str = Field(..., description="Source node id")
    target: str = Field(..., description="Target node id")

class PlannerGraphConfig(BaseModel):
    main_node_id: str = Field("main_agent", description="Root node id for the main agent")
    main_label: str = Field("Rie", description="Display label for the main role")
    main_logo_url: Optional[str] = Field(None, description="Optional custom logo for the main role")
    main_tool_ids: List[str] = Field(default_factory=list, description="Tool IDs assigned to the main agent")
    main_instruction: str = Field(
        "You are Rie, the main coordinator. Delegate tasks to the right team members and ensure high-quality results.",
        description="Instruction text for the main role",
    )
    nodes: List[PlannerSubAgentNode] = Field(default_factory=list, description="Sub-agent nodes")
    edges: List[PlannerEdge] = Field(default_factory=list, description="Main-to-sub-agent edges")

class PlannerInstructionGenerateRequest(BaseModel):
    boss_name: str = Field(..., description="Display name of the boss role")
    member_name: str = Field(..., description="Name of the member to generate instruction for")
    member_description: Optional[str] = Field("", description="Short role description of the member")
    selected_tools: List[str] = Field(default_factory=list, description="Tools assigned to this member")
    style: Optional[str] = Field(None, description="Optional writing style hint")
    tone: Optional[str] = Field(None, description="Optional tone hint")

class PlannerInstructionGenerateResponse(BaseModel):
    instruction_text: str = Field(..., description="Generated plain-text instruction for the member")
    reasoning_summary: Optional[str] = Field(None, description="Optional short explanation for the generated instruction")

class HealthResponse(BaseModel):
    """Response model for health check endpoint"""
    message: str
    agent_configured: bool
    tavily_configured: bool

class SettingsUpdate(BaseModel):
    """Request model for updating settings"""
    key: str
    value: str

class SettingsResponse(BaseModel):
    """Response model for settings endpoint"""
    groq_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    tavily_api_key: Optional[str] = None
    
    # Advanced Settings
    llm_provider: Optional[str] = None
    vertex_project: Optional[str] = None
    vertex_location: Optional[str] = None
    vertex_credentials_path: Optional[str] = None
    
    groq_model: str = "moonshotai/kimi-k2-instruct-0905"
    gemini_model: str = "gemini-1.5-pro"
    vertex_model: str = "gemini-1.5-pro"
    openai_model: str = "glm-4.5-flash"
    openai_base_url: str = "https://api.z.ai/api/paas/v4/"
    
    # Rie Settings
    rie_access_token: Optional[str] = None
    
    enabled_tools: Optional[List[str]] = None
    terminal_restrictions: Optional[str] = None
    mcp_servers: Optional[List[Dict[str, Any]]] = None
    window_mode: str = "floating"
    chat_mode: str = "agent"
    speed_mode: str = "thinking"
    hitl_enabled: bool = True
    hitl_mode: str = "always"

    # Ollama Settings
    ollama_model: Optional[str] = None
    ollama_api_url: Optional[str] = None
    ollama_api_key: Optional[str] = None

    # Embedding / LTM Settings
    embedding_source: str = "bundled"
    embedding_model_path: Optional[str] = None

    # LangSmith Settings
    langsmith_tracing: bool = False
    langsmith_api_key: Optional[str] = None
    langsmith_project: str = "Rie-AI"
    langsmith_endpoint: str = "https://api.smith.langchain.com"
    voice_reply: bool = True
    
    # TTS Settings
    tts_provider: str = "edge-tts"
    tts_voice: str = "en-US-EmmaNeural"

    # Custom External APIs
    external_apis: Optional[List[CustomAPIConfig]] = None
    subagents_config: Optional[List[SubAgentConfig]] = None
    subagent_planner_graph: Optional[PlannerGraphConfig] = None
    agent_orchestration_mode: str = "team"
    connectivity_ngrok_enabled: bool = False
    connectivity_public_url: Optional[str] = None
    connectivity_device_name: Optional[str] = None
    connectivity_ngrok_install_path: Optional[str] = None
    connectivity_ngrok_domain: Optional[str] = None


class ActionRequest(BaseModel):
    name: str
    args: Dict[str, Any]
    description: Optional[str] = None

class ReviewConfig(BaseModel):
    action_name: str
    allowed_decisions: List[str]
    args_schema: Optional[Dict[str, Any]] = None

class HITLRequestModel(BaseModel):
    action_requests: List[ActionRequest]
    review_configs: List[ReviewConfig]

class ResumeChatRequest(BaseModel):
    thread_id: str
    decisions: List[Dict[str, Any]] # List of Decision objects (type, message, edited_action)
    project_root: Optional[str] = None
    is_voice: Optional[bool] = False
    token: Optional[str] = None
    chat_mode: Optional[str] = None  # "agent" or "chat"
    speed_mode: Optional[str] = None  # "thinking" or "flash"
    client_timezone: Optional[str] = None
    client_local_datetime_iso: Optional[str] = None
 
 
class ScheduleTaskRequest(BaseModel):
    """Request model for scheduling a chat message"""
    text: str
    run_at: datetime = Field(..., description="ISO 8601 timestamp for when to run the task")
    thread_id: Optional[str] = None
    chat_mode: Optional[str] = "agent"
    speed_mode: Optional[str] = "thinking"
    # reminder: notify (OS + in-app); analysis_silent: run only, chat history only;
    # analysis_inform: run + notify with summary
    intent: str = Field(
        default="reminder",
        description="reminder | analysis_silent | analysis_inform",
    )
    title: Optional[str] = Field(
        default=None,
        description="Short label for UI and notifications (e.g. Meeting)",
    )

class ScheduledTaskResponse(BaseModel):
    """Response model for a scheduled task"""
    id: str
    text: str
    run_at: datetime
    thread_id: Optional[str]
    status: str
    intent: str = "reminder"
    title: Optional[str] = None


class ScheduleNotificationItem(BaseModel):
    """Unread notification from a completed scheduled task (reminder / analysis_inform)."""
    id: str
    thread_id: Optional[str] = None
    task_id: Optional[str] = None
    intent: str
    title: str
    body: str
    created_at: str


class DeviceIdentity(BaseModel):
    device_id: str
    name: str
    public_key: str
    fingerprint: str
    public_url: Optional[str] = None


class FriendPeerAccessPolicy(BaseModel):
    """Effective inbound peer policy (merged defaults)."""

    receive_profile: Literal["chat", "agent"] = "chat"
    allowed_tool_ids: Optional[List[str]] = Field(
        default=None,
        description="Subset of runtime tools; None means allow full profile default set.",
    )
    memory_enabled: bool = True


class FriendPeerAccessPatch(BaseModel):
    receive_profile: Literal["chat", "agent"] = "chat"
    allowed_tool_ids: Optional[List[str]] = Field(
        default=None,
        description="Omit or null to mean 'all tools allowed for this profile' when saved.",
    )
    memory_enabled: bool = True


class PeerAccessCatalogResponse(BaseModel):
    chat_eligible: List[str]
    agent_eligible: List[str]


class FriendRecord(BaseModel):
    id: str
    name: str
    device_id: str
    fingerprint: str
    public_key: str
    public_url: Optional[str] = None
    created_at: str
    updated_at: str
    peer_access: Optional[FriendPeerAccessPolicy] = None


class PairingRequest(BaseModel):
    name: Optional[str] = None


class PairingInitResponse(BaseModel):
    pairing_token: str
    identity: DeviceIdentity


class PairingConfirmRequest(BaseModel):
    pairing_token: str
    peer_name: str
    peer_device_id: str
    peer_fingerprint: str
    peer_public_key: str
    peer_public_url: Optional[str] = None


class PairingFinalizeRequest(BaseModel):
    peer_name: str
    peer_device_id: str
    peer_fingerprint: str
    peer_public_key: str
    peer_public_url: Optional[str] = None


class PairingConfirmResponse(BaseModel):
    friend: FriendRecord
    reciprocal_synced: bool = False
    reciprocal_status: str = "not_attempted"
    reciprocal_code: Optional[str] = None
    reciprocal_message: Optional[str] = None
    finalize_endpoint: Optional[str] = None
    finalize_payload: Optional[PairingFinalizeRequest] = None


class PeerAskRequest(BaseModel):
    friend_id: str
    query: str
    thread_id: Optional[str] = None


class PeerReceiveRequest(BaseModel):
    from_device_id: str
    from_fingerprint: str
    query: str
    thread_id: Optional[str] = None


class PeerAskResponse(BaseModel):
    status: str
    message: str
    thread_id: Optional[str] = None
    responder_device_id: Optional[str] = None
    responder_public_url: Optional[str] = None


class FriendStatusResponse(BaseModel):
    friend_id: str
    reachable: bool
    status: str
    latency_ms: Optional[int] = None
    message: str
    checked_at: str
    failure_code: Optional[str] = None
    failure_stage: Optional[str] = None


class PeerQueryEventItem(BaseModel):
    id: str
    direction: Literal["inbound", "outbound"]
    friend_id: Optional[str] = None
    friend_name: Optional[str] = None
    query_text: str
    status: Literal["ok", "error"]
    response_preview: Optional[str] = None
    error_detail: Optional[str] = None
    created_at: str


class FriendApprovalRequest(BaseModel):
    thread_id: str


class FriendEndpointUpdateRequest(BaseModel):
    public_url: str


class NgrokInstallRequest(BaseModel):
    confirmed: bool = False
    auth_token: Optional[str] = None
    domain: Optional[str] = None


class NgrokInstallResponse(BaseModel):
    ok: bool
    installed: bool
    path: Optional[str] = None
    version: Optional[str] = None
    enabled: bool = False
    public_url: Optional[str] = None
    tunnel_running: bool = False
    tunnel_pid: Optional[int] = None
    domain: Optional[str] = None
    ready_state: str = "failed"
    steps: List[Dict[str, Any]] = Field(default_factory=list)


class NgrokStatusResponse(BaseModel):
    installed: bool
    path: Optional[str] = None
    version: Optional[str] = None
    enabled: bool = False
    public_url: Optional[str] = None
    tunnel_running: bool = False
    tunnel_pid: Optional[int] = None
    domain: Optional[str] = None
    ready_state: str = "not_ready"


