"""
OAuth callback HTML response templates - Simple, clean landing page aesthetic using Tailwind CSS CDN and official RIE AI logo.
"""
from typing import Optional, Dict, Any
import html
import base64
from pathlib import Path
from functools import lru_cache


@lru_cache(maxsize=1)
def get_rie_logo_src() -> str:
    """Retrieve official RIE AI logo encoded as base64 data URI."""
    candidates = [
        Path(__file__).resolve().parent.parent.parent / "client" / "src" / "assets" / "logo.png",
        Path(__file__).resolve().parent.parent / "client" / "src" / "assets" / "logo.png",
        Path(__file__).resolve().parent / "static" / "logo.png",
        Path(__file__).resolve().parent.parent.parent / "web" / "rie-landing-page" / "public" / "logo.png",
    ]
    for c in candidates:
        if c.exists():
            try:
                with open(c, "rb") as f:
                    encoded = base64.b64encode(f.read()).decode("utf-8")
                    return f"data:image/png;base64,{encoded}"
            except Exception:
                pass
    return "https://rie-ai.in/logo.png"


def render_oauth_success_html(
    provider_id: str,
    provider_name: str,
    account_info: Optional[Dict[str, Any]] = None
) -> str:
    """Render a clean, minimal, modern landing page style OAuth success screen with RIE AI branding."""
    account_info = account_info or {}
    email = account_info.get("email") or ""
    display_user = account_info.get("name") or email or "Account Linked"
    
    # Safe HTML escaping
    safe_provider_name = html.escape(provider_name)
    safe_provider_id = html.escape(provider_id)
    safe_email = html.escape(email)
    safe_display_user = html.escape(display_user)
    rie_logo_src = get_rie_logo_src()

    # Provider brand SVGs
    logos = {
        "gmail": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-gmail.svg",
        "google": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-gmail.svg",
        "github": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/github-icon.svg",
        "jira": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/jira.svg",
        "slack": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/slack-icon.svg",
        "notion": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/notion-icon.svg",
        "calendar": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-calendar.svg",
        "google_calendar": "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-calendar.svg",
    }
    provider_logo = logos.get(provider_id.lower(), "https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-gmail.svg")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connected to {safe_provider_name} — RIE AI</title>
    <link rel="icon" type="image/png" href="{rie_logo_src}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {{
            theme: {{
                extend: {{
                    fontFamily: {{
                        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
                    }}
                }}
            }}
        }}
    </script>
</head>
<body class="bg-neutral-950 font-sans text-neutral-100 min-h-screen flex flex-col justify-between antialiased selection:bg-emerald-500 selection:text-white">

    <!-- Top Navigation with Official RIE Logo -->
    <header class="w-full max-w-4xl mx-auto px-6 py-6 flex items-center justify-between">
        <div class="flex items-center gap-3">
            <img src="{rie_logo_src}" alt="RIE AI Logo" class="w-8 h-8 object-contain rounded-lg shadow-sm" />
            <span class="font-bold text-base text-white tracking-tight">RIE AI</span>
        </div>
        <span class="text-xs text-neutral-500 font-medium">Authorization Service</span>
    </header>

    <!-- Main Content Landing Box -->
    <main class="w-full max-w-md mx-auto px-6 py-8">
        <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 shadow-xl text-center">
            
            <!-- Provider Icon with Checkmark -->
            <div class="relative w-16 h-16 mx-auto mb-6 flex items-center justify-center bg-neutral-800 border border-neutral-700/80 rounded-2xl">
                <img src="{provider_logo}" alt="{safe_provider_name}" class="w-8 h-8 object-contain" onerror="this.src='https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-gmail.svg'" />
                <div class="absolute -bottom-1 -right-1 w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center text-neutral-950 border-2 border-neutral-900 shadow-sm">
                    <svg class="w-3.5 h-3.5 stroke-[3]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
            </div>

            <!-- Header Text -->
            <h1 class="text-xl font-bold text-white mb-2">Connected to {safe_provider_name}</h1>
            <p class="text-sm text-neutral-400 mb-6">
                Your account is linked and ready to use in RIE AI Assistant.
            </p>

            <!-- Account Details Table/Box -->
            <div class="bg-neutral-950/60 border border-neutral-800/80 rounded-xl p-4 mb-6 text-left text-xs space-y-2.5">
                <div class="flex items-center justify-between text-neutral-400">
                    <span>Account</span>
                    <span class="font-medium text-neutral-200">{safe_display_user}</span>
                </div>
                {f'''<div class="flex items-center justify-between text-neutral-400">
                    <span>Email</span>
                    <span class="font-medium text-neutral-200">{safe_email}</span>
                </div>''' if safe_email and safe_email != safe_display_user else ''}
                <div class="flex items-center justify-between text-neutral-400 pt-2 border-t border-neutral-800/60">
                    <span>Status</span>
                    <span class="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        Active & Encrypted
                    </span>
                </div>
            </div>

            <!-- Action Buttons -->
            <div class="space-y-3">
                <button onclick="closeAndReturn()" class="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition shadow-sm">
                    Return to RIE Desktop
                </button>
                <button onclick="window.close()" class="w-full py-2.5 px-4 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-medium text-xs transition border border-neutral-700/60">
                    Close Tab
                </button>
            </div>

            <!-- Hint -->
            <p id="close-hint" class="text-xs text-neutral-500 mt-4">
                You can safely close this browser window at any time.
            </p>
        </div>
    </main>

    <!-- Simple Footer -->
    <footer class="w-full max-w-4xl mx-auto px-6 py-6 text-center text-xs text-neutral-600 flex items-center justify-center gap-2">
        <img src="{rie_logo_src}" alt="RIE AI" class="w-4 h-4 object-contain opacity-60" />
        <span>RIE AI Desktop Assistant • Secure Local Storage</span>
    </footer>

    <script>
        // Notify parent window (RIE Desktop App)
        if (window.opener) {{
            window.opener.postMessage({{ type: 'PLUGIN_CONNECTED', provider: '{safe_provider_id}' }}, '*');
        }}

        function closeAndReturn() {{
            if (window.opener) {{
                window.opener.focus();
            }}
            window.close();
            setTimeout(() => {{
                const hint = document.getElementById('close-hint');
                if (hint) hint.textContent = 'Please switch back to your RIE Desktop app window.';
            }}, 300);
        }}

        // Auto close after 3 seconds
        setTimeout(() => {{
            closeAndReturn();
        }}, 3000);
    </script>
</body>
</html>
"""


def render_oauth_error_html(
    error_message: str,
    provider_name: Optional[str] = None
) -> str:
    """Render a clean, minimal error screen with RIE AI branding."""
    safe_error = html.escape(error_message or "An unexpected authorization error occurred.")
    safe_name = html.escape(provider_name or "Service")
    rie_logo_src = get_rie_logo_src()

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connection Failed — RIE AI</title>
    <link rel="icon" type="image/png" href="{rie_logo_src}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {{
            theme: {{
                extend: {{
                    fontFamily: {{
                        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
                    }}
                }}
            }}
        }}
    </script>
</head>
<body class="bg-neutral-950 font-sans text-neutral-100 min-h-screen flex flex-col justify-between antialiased">

    <!-- Top Minimal Navigation -->
    <header class="w-full max-w-4xl mx-auto px-6 py-6 flex items-center justify-between">
        <div class="flex items-center gap-3">
            <img src="{rie_logo_src}" alt="RIE AI Logo" class="w-8 h-8 object-contain rounded-lg shadow-sm" />
            <span class="font-bold text-base text-white tracking-tight">RIE AI</span>
        </div>
        <span class="text-xs text-neutral-500 font-medium">Authorization Service</span>
    </header>

    <!-- Main Card -->
    <main class="w-full max-w-md mx-auto px-6 py-8">
        <div class="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 shadow-xl text-center">
            <div class="w-14 h-14 mx-auto mb-5 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
                <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
            </div>
            
            <h1 class="text-xl font-bold text-white mb-2">Connection Failed</h1>
            <p class="text-sm text-neutral-400 mb-5">
                Could not connect to {safe_name}. Please try again from RIE Settings.
            </p>

            <div class="bg-neutral-950 border border-neutral-800 rounded-xl p-3.5 text-xs text-rose-400 text-left mb-6 font-mono break-words">
                {safe_error}
            </div>

            <button onclick="window.close()" class="w-full py-2.5 px-4 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-semibold text-sm transition border border-neutral-700">
                Close Window
            </button>
        </div>
    </main>

    <footer class="w-full max-w-4xl mx-auto px-6 py-6 text-center text-xs text-neutral-600 flex items-center justify-center gap-2">
        <img src="{rie_logo_src}" alt="RIE AI" class="w-4 h-4 object-contain opacity-60" />
        <span>RIE AI Desktop Assistant</span>
    </footer>
</body>
</html>
"""
