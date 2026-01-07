#!/usr/bin/env node

/**
 * Database Migration CLI
 * 
 * Usage:
 *   node scripts/migrate.js status    - Check migration status
 * 
 * Note: Migrations run automatically on server start.
 * This script is mainly for checking status and monitoring.
 * 
 * Environment Variables:
 *   API_URL      - URL of the API (e.g. https://mise-tools.jdx.dev)
 *   API_SECRET   - API secret for authentication
 */

import https from 'https';
import http from 'http';

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
    req.end();
  });
}

async function getMigrationStatus(baseUrl, secret) {
  const response = await makeRequest(`${baseUrl}/api/migrations`, {
    headers: {
      'Authorization': `Bearer ${secret}`
    }
  });

  if (response.status !== 200) {
    throw new Error(`Failed to get migration status: ${response.status} ${response.data}`);
  }

  return response.data;
}

async function main() {
  const baseUrl = process.env.API_URL;
  const secret = process.env.API_SECRET;
  const action = process.argv[2] || 'status';

  if (!baseUrl || !secret) {
    console.error('❌ Missing required environment variables: API_URL, API_SECRET');
    process.exit(1);
  }

  try {
    if (action === 'status') {
      console.log('📊 Checking migration status...');

      const status = await getMigrationStatus(baseUrl, secret);

      console.log('\n📈 Migration Status:');
      console.log(`   Total migrations: ${status.total}`);
      console.log(`   Applied: ${status.applied}`);
      console.log(`   Pending: ${status.pending}`);

      if (status.appliedMigrations.length > 0) {
        console.log('\n✅ Applied Migrations:');
        status.appliedMigrations.forEach(migration => {
          console.log(`   ${migration.id}: ${migration.name} (${migration.applied_at})`);
        });
      }

      if (status.pending > 0) {
        console.log('\n⏳ Pending migrations will be applied automatically on next server start');
        console.log('   Or restart the Worker to trigger migrations immediately');
      } else {
        console.log('\n✅ All migrations are up to date!');
      }

    } else {
      console.error('❌ Unknown action. Available actions: status');
      console.error('   Note: Migrations run automatically on server start');
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
