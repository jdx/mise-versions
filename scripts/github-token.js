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

import https from 'https';
import http from 'http';
import fs from 'fs';

async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const req = client.request(url, {
      method: options.method || 'GET',
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
    
    if (options.body) {
      req.write(options.body);
    }
    
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

async function markRateLimited(baseUrl, secret, tokenId, resetTime) {
  const rateLimitUrl = `${baseUrl}/api/token/rate-limit`;

  const reset_at = resetTime
    ? new Date(resetTime).toISOString() // resetTime is in YYYY-MM-DD HH:MM:SS +timezone format
    : new Date(Date.now() + 10 * 60 * 1000).toISOString(); // Default to 10 minutes from now

  const payload = JSON.stringify({
    token_id: tokenId,
    reset_at: reset_at,
  });
  
  return makeRequest(rateLimitUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Length': Buffer.byteLength(payload),
    },
    body: payload
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
      const response = await makeRequest(`${baseUrl}/api/token`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      });

      if (response.status !== 200) {
        console.error(`❌ Failed to fetch token: ${response.status} ${response.data}`);
        process.exit(1);
      }

      const { token, installation_id, expires_at, token_id } = response.data;

      // Set GitHub Actions outputs
      if (process.env.GITHUB_ACTIONS === 'true') {
        // Mask the token in logs
        console.error(`::add-mask::${token}`);
      }

      // Return token and token_id
      console.log(`${token} ${token_id || installation_id}`);
      
    } else if (action === 'mark-rate-limited') {
      const tokenId = process.argv[3];
      const resetTime = process.argv[4]; // Optional reset time (e.g. 2025-07-28 04:18:45 +10:00)

      if (!tokenId) {
        console.error('❌ Usage: node github-token.js mark-rate-limited <token_id> [reset_time]');
        process.exit(1);
      }
      
      const response = await markRateLimited(baseUrl, secret, parseInt(tokenId), resetTime);

      if (response.status !== 200) {
        console.error(`❌ Failed to mark token ${tokenId} as rate-limited: ${response.status}`);
        process.exit(1);
      }
      
    } else if (action === 'stats') {
      console.error('📊 Fetching token statistics...');
      
      const response = await makeRequest(`${baseUrl}/api/stats`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      });
      
      if (response.status !== 200) {
        console.error(`❌ Failed to fetch stats: ${response.status} ${response.data}`);
        process.exit(1);
      }
      
      console.error('📈 Token Statistics:');
      console.error(`   Active tokens: ${response.data.active}`);
      console.error(`   Total tokens: ${response.data.total}`);
      
    } else {
      console.error('❌ Unknown action. Available actions: get-token, record-usage, mark-rate-limited, stats');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// ES module equivalent of require.main === module
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { makeRequest, recordUsage, markRateLimited }; 
