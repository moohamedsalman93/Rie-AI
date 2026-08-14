"""
GitHub Integration Plugin Handler.
"""
import httpx
from typing import Dict, Any
from app.plugins.base import BasePluginHandler

class GitHubPluginHandler(BasePluginHandler):
    async def execute_tool(self, tool_name: str, args: Dict[str, Any], access_token: str, creds: Dict[str, Any]) -> str:
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": "RIE-AI-Agent"
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            if tool_name == "github_list_repos":
                url = "https://api.github.com/user/repos?sort=updated"
                res = await client.get(url, headers=headers)
                if res.status_code == 200:
                    repos = res.json()
                    limit = args.get("limit", 10)
                    repo_names = [f"- {r['full_name']} (Stars: {r['stargazers_count']})" for r in repos[:limit]]
                    return "User Repositories:\n" + "\n".join(repo_names)
                return f"GitHub API Error ({res.status_code}): {res.text}"

            elif tool_name == "github_create_issue":
                repo = args.get("repo_full_name")
                url = f"https://api.github.com/repos/{repo}/issues"
                issue_body = {"title": args.get("title"), "body": args.get("body", "")}
                res = await client.post(url, json=issue_body, headers=headers)
                if res.status_code == 201:
                    data = res.json()
                    return f"Issue created successfully: {data.get('html_url')}"
                return f"Failed to create GitHub issue ({res.status_code}): {res.text}"

            return f"Unknown tool '{tool_name}' for GitHub plugin."
