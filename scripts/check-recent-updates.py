#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "gitpython>=3.1.40",
#     "requests>=2.31.0"
# ]
# ///
"""
Check if there have been tool updates in the last 24 hours.
If not, send an email notification via resend.
"""

import os
import sys
import git
import requests
import json
from datetime import datetime, timedelta


def get_recent_tool_updates(repo_path=".", hours_back=24):
    """
    Check if there have been any tool updates in the last N hours.
    
    Args:
        repo_path: Path to the git repository
        hours_back: Number of hours to look back
    
    Returns:
        tuple: (bool, list) - (has_updates, list_of_updated_tools)
    """
    repo = git.Repo(repo_path)
    
    # Calculate the time threshold
    since_time = datetime.now() - timedelta(hours=hours_back)
    
    # Get commits that modified files in docs/ directory
    commits = list(repo.iter_commits(
        since=since_time,
        paths="docs/"
    ))
    
    updated_tools = set()
    
    print(f"🔍 Checking for tool updates in the last {hours_back} hours...")
    print(f"📅 Looking for commits since: {since_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"📊 Found {len(commits)} commits to analyze")
    
    for commit in commits:
        print(f"   📝 Commit: {commit.hexsha[:8]} - {commit.summary}")
        
        # Get the files changed in this commit
        if commit.parents:  # Skip initial commit
            for item in commit.diff(commit.parents[0]):
                if item.a_path and item.a_path.startswith('docs/'):
                    # Extract tool name from path
                    path_parts = item.a_path.split('/')
                    if len(path_parts) >= 2:
                        tool_name = path_parts[1]
                        
                        # Skip excluded tools and subdirectories
                        if tool_name in ['aqua-registry'] or tool_name.startswith('python-precompiled'):
                            continue
                            
                        # Only count actual tool files (not subdirectories)
                        if not tool_name.endswith('/') and tool_name:
                            updated_tools.add(tool_name)
                            print(f"      🔧 Tool updated: {tool_name}")
    
    has_updates = len(updated_tools) > 0
    
    if has_updates:
        print(f"✅ Found {len(updated_tools)} tools updated in the last {hours_back} hours:")
        for tool in sorted(updated_tools):
            print(f"   - {tool}")
    else:
        print(f"⚠️  No tool updates found in the last {hours_back} hours")
    
    return has_updates, list(updated_tools)


def send_no_updates_email():
    """
    Send an email notification that there haven't been any tool updates.
    """
    url = "https://api.resend.com/emails"
    
    # Get the API key from environment variable for security
    api_key = os.environ['RESEND_API_KEY']
    
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }
    
    # Calculate when we last had updates (for context)
    repo = git.Repo(".")
    recent_commits = list(repo.iter_commits(
        since=datetime.now() - timedelta(days=7),
        paths="docs/"
    ))
    
    last_update = None
    if recent_commits:
        last_update = recent_commits[0].committed_datetime.strftime('%Y-%m-%d %H:%M UTC')
    
    # Create email content
    subject = "⚠️ No Tool Updates in 24 Hours - mise-versions"
    
    html_content = f"""
    <h2>🚨 Tool Update Alert</h2>
    <p>No tool updates have been detected in the <strong>mise-versions</strong> repository in the last 24 hours.</p>
    
    <h3>📊 Details:</h3>
    <ul>
        <li><strong>Time checked:</strong> {datetime.now().strftime('%Y-%m-%d %H:%M UTC')}</li>
        <li><strong>Period checked:</strong> Last 24 hours</li>
        <li><strong>Repository:</strong> mise-versions</li>
        {f'<li><strong>Last update detected:</strong> {last_update}</li>' if last_update else '<li><strong>Last update:</strong> No recent updates found</li>'}
    </ul>
    
    <p>This could indicate:</p>
    <ul>
        <li>The update workflow is not running properly</li>
        <li>No new tool versions have been released</li>
        <li>There are issues with the tool update process</li>
    </ul>
    
    <p>Please check the <a href="https://github.com/jdx/mise-versions/actions">GitHub Actions</a> to ensure the update workflow is running correctly.</p>
    
    <hr>
    <p><small>This alert is sent when no tool updates are detected in a 24-hour period.</small></p>
    """
    
    data = {
        "from": "mise-tools@mise.jdx.dev",
        "to": "mise-tools@mise.jdx.dev",
        "subject": subject,
        "html": html_content
    }
    
    try:
        print("📧 Sending no-updates email notification...")
        response = requests.post(url, headers=headers, json=data)
        
        if response.status_code == 200:
            print("✅ Email sent successfully!")
            print(f"📧 Email ID: {response.json().get('id', 'unknown')}")
            return True
        else:
            print(f"❌ Failed to send email: {response.status_code}")
            print(f"Response: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Error sending email: {e}")
        return False


def main():
    print("🔍 Checking for recent tool updates...")
    
    # Check if there have been updates in the last 24 hours
    has_updates, updated_tools = get_recent_tool_updates(hours_back=24)
    
    if not has_updates:
        print("\n⚠️  No tool updates in the last 24 hours - sending notification email")
        success = send_no_updates_email()
        
        if success:
            print("✅ Notification sent successfully")
        else:
            print("❌ Failed to send notification")
            sys.exit(1)
    else:
        print(f"\n✅ Tool updates are current - {len(updated_tools)} tools updated in the last 24 hours")
        print("📧 No notification email needed")


if __name__ == "__main__":
    main() 
