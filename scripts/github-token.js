#!/usr/bin/env node

/**
 * GitHub Token Manager Helper for GitHub Actions
 * 
 * This script fetches a GitHub token from the token manager API
 * and can optionally record usage for rate limit tracking.
 * 
 * Usage in GitHub Actions:
 * 
 * - name: Get GitHub Token
 *   id: github-token
 *   run: node scripts/github-token.js
 *   env:
 *     TOKEN_MANAGER_URL: ${{ secrets.TOKEN_MANAGER_URL }}
 *     TOKEN_MANAGER_SECRET: ${{ secrets.TOKEN_MANAGER_SECRET }}
 * 
 * - name: Use Token
 *   run: |
 *     echo "Token: ${{ steps.github-token.outputs.token }}"
 *     # Use the token for GitHub API calls
 *   env:
 *     GITHUB_TOKEN: ${{ steps.github-token.outputs.token }}
 */

const https = require('https');
const http = require('http');

async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const req = client.request(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

async function recordUsage(baseUrl, secret, tokenId, endpoint, rateLimitInfo) {
  const usageUrl = `${baseUrl}/api/token/usage`;
  
  return new Promise((resolve, reject) => {
    const urlObj = new URL(usageUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const payload = JSON.stringify({
      token_id: tokenId,
      endpoint,
      remaining_requests: rateLimitInfo?.remaining,
      reset_at: rateLimitInfo?.reset ? new Date(rateLimitInfo.reset * 1000).toISOString() : undefined,
    });
    
    const req = client.request(usageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
        'Content-Length': Buffer.byteLength(payload),
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const baseUrl = process.env.TOKEN_MANAGER_URL;
  const secret = process.env.TOKEN_MANAGER_SECRET;
  const action = process.argv[2] || 'get-token';
  
  if (!baseUrl || !secret) {
    console.error('❌ Missing required environment variables: TOKEN_MANAGER_URL, TOKEN_MANAGER_SECRET');
    process.exit(1);
  }

  try {
    if (action === 'get-token') {
      console.log('🔄 Fetching GitHub token...');
      
      const response = await makeRequest(`${baseUrl}/api/token`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      });
      
      if (response.status !== 200) {
        console.error(`❌ Failed to fetch token: ${response.status} ${response.data}`);
        process.exit(1);
      }
      
      const { token, installation_id, expires_at } = response.data;
      
      console.log('✅ Token fetched successfully');
      console.log(`📊 Installation ID: ${installation_id}`);
      console.log(`⏰ Expires at: ${expires_at}`);
      
      // Set GitHub Actions outputs
      if (process.env.GITHUB_ACTIONS === 'true') {
        const fs = require('fs');
        const outputFile = process.env.GITHUB_OUTPUT;
        if (outputFile) {
          fs.appendFileSync(outputFile, `token=${token}\n`);
          fs.appendFileSync(outputFile, `installation_id=${installation_id}\n`);
          fs.appendFileSync(outputFile, `expires_at=${expires_at}\n`);
        }
        
        // Mask the token in logs
        console.log(`::add-mask::${token}`);
        console.log(`::set-output name=token::${token}`);
        console.log(`::set-output name=installation_id::${installation_id}`);
        console.log(`::set-output name=expires_at::${expires_at}`);
      }
      
    } else if (action === 'record-usage') {
      const tokenId = process.argv[3];
      const endpoint = process.argv[4];
      const remaining = process.argv[5];
      const reset = process.argv[6];
      
      if (!tokenId || !endpoint) {
        console.error('❌ Usage: node github-token.js record-usage <token_id> <endpoint> [remaining] [reset]');
        process.exit(1);
      }
      
      console.log(`📝 Recording usage for token ${tokenId} on ${endpoint}...`);
      
      const rateLimitInfo = remaining ? {
        remaining: parseInt(remaining),
        reset: reset ? parseInt(reset) : undefined,
      } : undefined;
      
      const response = await recordUsage(baseUrl, secret, parseInt(tokenId), endpoint, rateLimitInfo);
      
      if (response.status !== 200) {
        console.error(`❌ Failed to record usage: ${response.status} ${response.data}`);
        process.exit(1);
      }
      
      console.log('✅ Usage recorded successfully');
      
    } else if (action === 'stats') {
      console.log('📊 Fetching token statistics...');
      
      const response = await makeRequest(`${baseUrl}/api/stats`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      });
      
      if (response.status !== 200) {
        console.error(`❌ Failed to fetch stats: ${response.status} ${response.data}`);
        process.exit(1);
      }
      
      console.log('📈 Token Statistics:');
      console.log(`   Active tokens: ${response.data.active}`);
      console.log(`   Total tokens: ${response.data.total}`);
      
    } else {
      console.error('❌ Unknown action. Available actions: get-token, record-usage, stats');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { makeRequest, recordUsage }; 
