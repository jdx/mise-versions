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

async function markRateLimited(baseUrl, secret, tokenId, retryAfter, remainingRequests, resetTime) {
  const rateLimitUrl = `${baseUrl}/api/token/rate-limit`;

  let reset_at = new Date(Date.now() + 3600000).toISOString(); // Default to 1 hour from now
  if (remainingRequests === 0 && resetTime) {
    // resetTime is in epoch seconds
    reset_at = new Date(resetTime * 1000).toISOString();
  } else if (retryAfter) {
    // retryAfter is in minutes
    reset_at = new Date(Date.now() + retryAfter * 60 * 1000).toISOString();
  }

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
      console.error('🔄 Fetching GitHub token...');
      
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
      
      console.error('✅ Token fetched successfully');
      console.error(`📊 Token ID: ${token_id || installation_id}`);
      console.error(`📊 Installation ID: ${installation_id}`);
      console.error(`⏰ Expires at: ${expires_at}`);
      
      // Set GitHub Actions outputs
      if (process.env.GITHUB_ACTIONS === 'true') {
        // Mask the token in logs
        console.error(`::add-mask::${token}`);
      }
      
      // Return token and token_id
      console.log(`${token} ${token_id || installation_id}`);
      
    } else if (action === 'mark-rate-limited') {
      const tokenId = process.argv[3];
      const retryAfter = process.argv[4]; // Optional retry after time (minutes)
      const remainingRequests = process.argv[5]; // Optional remaining requests
      const resetTime = process.argv[6]; // Optional reset time (unix timestamp)

      if (!tokenId) {
        console.error('❌ Usage: node github-token.js mark-rate-limited <token_id> [reset_time]');
        process.exit(1);
      }
      
      console.error(`🚫 Marking token ${tokenId} as rate-limited...`);

      const response = await markRateLimited(baseUrl, secret, parseInt(tokenId), parseInt(retryAfter), parseInt(remainingRequests), parseInt(resetTime));

      if (response.status !== 200) {
        console.error(`❌ Failed to mark token as rate-limited: ${response.status} ${response.data}`);
        process.exit(1);
      }
      
      console.error('✅ Token marked as rate-limited successfully');
      
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
