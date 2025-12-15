#!/bin/bash

# GitHub Token Manager Deployment Script
# This script helps you deploy the GitHub Token Manager to Cloudflare Workers

set -e

echo "🚀 GitHub Token Manager Deployment Script"
echo "=========================================="

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI is not installed. Please install it first:"
    echo "   npm install -g wrangler"
    exit 1
fi

# Check if user is logged in to Wrangler
if ! wrangler whoami &> /dev/null; then
    echo "🔐 Please log in to Wrangler first:"
    echo "   wrangler login"
    exit 1
fi

echo "✅ Wrangler is installed and you're logged in"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Function to prompt for secret
prompt_for_secret() {
    local secret_name=$1
    local description=$2
    
    echo ""
    echo "🔑 Setting up $secret_name"
    echo "   Description: $description"
    
    if wrangler secret list | grep -q "$secret_name"; then
        echo "   ✅ $secret_name already exists"
    else
        echo "   Please enter the value:"
        wrangler secret put "$secret_name"
    fi
}

echo ""
echo "🔐 Setting up secrets..."
echo "You'll need the following information from your GitHub App:"

prompt_for_secret "GITHUB_APP_ID" "Your GitHub App ID (numeric)"
prompt_for_secret "GITHUB_PRIVATE_KEY" "Your GitHub App private key (PEM format, including -----BEGIN/END----- lines)"
prompt_for_secret "GITHUB_CLIENT_ID" "Your GitHub App client ID"
prompt_for_secret "GITHUB_CLIENT_SECRET" "Your GitHub App client secret"
prompt_for_secret "GITHUB_WEBHOOK_SECRET" "Your GitHub App webhook secret"
prompt_for_secret "API_SECRET" "A secure random string for API authentication (generate one with: openssl rand -hex 32)"

echo ""
echo "🏗️  Deploying to Cloudflare Workers..."
wrangler deploy

# Get the deployment URL
WORKER_URL=$(wrangler deployments list --name mise-versions --json | jq -r '.[0].url' 2>/dev/null || echo "")

if [ -z "$WORKER_URL" ]; then
    echo "⚠️  Could not automatically detect worker URL. Please check your deployment manually."
    echo "   Run: wrangler deployments list"
else
    echo ""
    echo "🎉 Deployment successful!"
    echo "📍 Worker URL: $WORKER_URL"
    echo ""
    echo "✅ Database will auto-initialize on first request"
    
    echo ""
    echo "📝 Next steps:"
    echo "1. Update your GitHub App settings:"
    echo "   - Webhook URL: $WORKER_URL/webhooks/github"
    echo "   - Homepage URL: $WORKER_URL"
    echo ""
    echo "2. Install your GitHub App on the repositories you want to manage"
    echo ""
    echo "3. Add these secrets to your GitHub repository for Actions:"
    echo "   - TOKEN_MANAGER_URL: $WORKER_URL"
    echo "   - TOKEN_MANAGER_SECRET: (the API_SECRET you set above)"
    echo ""
    echo "4. Test the deployment:"
    echo "   curl $WORKER_URL/health"
    echo ""
    echo "📖 See README.md for usage instructions and examples."
fi

echo ""
echo "🎯 Deployment complete! Happy coding!" 
