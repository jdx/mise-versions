# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "matplotlib>=3.8.0",
#     "gitpython>=3.1.40"
# ]
# ///
"""
Generate a timeline chart showing the number of tool updates per day over the last 30 days.
Analyzes git history for the docs/ directory, excluding aqua-registry and python-precompiled.
"""

import os
import git
import matplotlib.pyplot as plt
from datetime import datetime, timedelta
import argparse


def get_daily_tool_updates(repo_path=".", days_back=30):
    """
    Analyze git history to count tool updates per day in docs/ directory.
    
    Args:
        repo_path: Path to the git repository
        days_back: Number of days to look back in history
    
    Returns:
        dict: date -> set of tool names updated that day
    """
    repo = git.Repo(repo_path)
    
    # Calculate the date threshold
    since_date = datetime.now() - timedelta(days=days_back)
    
    # Get commits that modified files in docs/ directory
    commits = list(repo.iter_commits(
        since=since_date,
        paths="docs/"
    ))
    
    daily_updates = {}
    
    print(f"Analyzing {len(commits)} commits in the last {days_back} days...")
    
    for commit in commits:
        # Get the date for this commit (date only, no time)
        commit_date = commit.committed_datetime.date()
        
        if commit_date not in daily_updates:
            daily_updates[commit_date] = set()
        
        # Get the files changed in this commit
        if commit.parents:  # Skip initial commit
            for item in commit.diff(commit.parents[0]):
                if item.a_path and item.a_path.startswith('docs/'):
                    # Extract tool name from path
                    path_parts = item.a_path.split('/')
                    if len(path_parts) >= 2:
                        tool_name = path_parts[1]
                        
                        # Skip excluded tools
                        if tool_name in ['aqua-registry'] or tool_name.startswith('python-precompiled'):
                            continue
                            
                        # Only count actual tool files (not subdirectories)
                        if not tool_name.endswith('/') and tool_name:
                            daily_updates[commit_date].add(tool_name)
    
    return daily_updates


def create_chart(daily_updates, days_back, output_dir="charts"):
    """
    Create a timeline chart showing tool updates per day.
    
    Args:
        daily_updates: dict of date -> set of tool names updated that day
        days_back: number of days analyzed
        output_dir: Directory to save chart
    """
    os.makedirs(output_dir, exist_ok=True)
    
    if not daily_updates:
        print("No tool updates found in the specified time period.")
        return
    
    # Create a complete date range for the last N days
    end_date = datetime.now().date()
    start_date = end_date - timedelta(days=days_back-1)
    
    dates = []
    counts = []
    
    current_date = start_date
    while current_date <= end_date:
        dates.append(current_date)
        # Count unique tools updated on this date
        tool_count = len(daily_updates.get(current_date, set()))
        counts.append(tool_count)
        current_date += timedelta(days=1)
    
    # Create timeline chart
    plt.figure(figsize=(14, 6))
    
    plt.plot(dates, counts, marker='o', linewidth=2, markersize=4, color='steelblue')
    plt.fill_between(dates, counts, alpha=0.3, color='steelblue')
    
    # Add text annotations for non-zero values
    for i, (date, count) in enumerate(zip(dates, counts)):
        if count > 0:
            plt.annotate(str(count), (date, count), 
                        textcoords="offset points", xytext=(0,8), 
                        ha='center', va='bottom', fontsize=9, 
                        bbox=dict(boxstyle='round,pad=0.3', facecolor='white', alpha=0.8, edgecolor='none'))
    
    plt.title(f'Tool Updates Per Day (Last {days_back} Days)')
    plt.xlabel('Date')
    plt.ylabel('Number of Tools Updated')
    
    # Move y-axis label to the right
    ax = plt.gca()
    ax.yaxis.set_label_position("right")
    ax.yaxis.tick_right()
    
    plt.grid(True, alpha=0.3)
    plt.xticks(rotation=45)
    
    # Add some stats
    total_tools = sum(len(tools) for tools in daily_updates.values())
    unique_tools = len(set().union(*daily_updates.values()))
    avg_per_day = sum(counts) / len(counts)
    
    plt.text(0.02, 0.98, f'Total tool updates: {total_tools}\nUnique tools: {unique_tools}\nAvg per day: {avg_per_day:.1f}', 
             transform=plt.gca().transAxes, verticalalignment='top', 
             bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))
    
    plt.tight_layout()
    plt.savefig(f'{output_dir}/tools_updated.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    print(f"Chart saved to {output_dir}/tools_updated.png")
    print(f"📊 Daily tool updates over {days_back} days (unique tools: {unique_tools})")
    return output_dir





def main():
    parser = argparse.ArgumentParser(description='Generate chart showing daily tool updates in git history')
    parser.add_argument('--days', type=int, default=30, 
                       help='Number of days to look back (default: 30)')
    parser.add_argument('--output-dir', default='charts',
                       help='Directory to save chart (default: charts)')
    
    args = parser.parse_args()
    
    print("🔍 Analyzing git history for daily tool updates...")
    
    # Get daily tool updates from git history
    daily_updates = get_daily_tool_updates(days_back=args.days)
    
    if not daily_updates:
        print("❌ No tool updates found in the specified time period.")
        return
    
    total_unique_tools = len(set().union(*daily_updates.values()))
    print(f"📈 Found updates across {len(daily_updates)} days affecting {total_unique_tools} unique tools")
    
    # Create chart
    output_dir = create_chart(daily_updates, args.days, args.output_dir)
    
    print("✅ Analysis complete!")


if __name__ == "__main__":
    main() 
