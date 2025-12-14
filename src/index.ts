import { drizzle } from 'drizzle-orm/d1';
import { GitHubAppManager, GitHubAppConfig } from './github.js';
import { setupDatabase } from './database.js';
import { getMigrationStatus, runMigrations } from './migrations.js';

export interface Env {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  API_SECRET: string;
}

interface TokenResponse {
  token: string;
  installation_id: number;
  token_id: number;
  expires_at: string | null;
}

// Singleton to ensure migrations run only once
let migrationsCompleted = false;

async function ensureMigrationsCompleted(db: ReturnType<typeof drizzle>) {
  if (!migrationsCompleted) {
    console.log('🚀 Running database migrations on server start...');
    await runMigrations(db);
    migrationsCompleted = true;
    console.log('✅ Migrations completed');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = drizzle(env.DB);
    const database = setupDatabase(db);
    
    // Run migrations only once on server start
    await ensureMigrationsCompleted(db);
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Initialize GitHub app manager (simplified for user tokens)
    const githubConfig: GitHubAppConfig = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
    
    const github = new GitHubAppManager(githubConfig);

    // CORS headers for browser requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // GitHub OAuth login - redirect to GitHub authorization
      if (path === '/auth/login') {
        const redirectUri = `${url.origin}/auth/callback`;
        const scope = 'public_repo'; // Minimal scope for API access
        const state = crypto.randomUUID(); // CSRF protection

        const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
        githubAuthUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        githubAuthUrl.searchParams.set('redirect_uri', redirectUri);
        githubAuthUrl.searchParams.set('scope', scope);
        githubAuthUrl.searchParams.set('state', state);

        return Response.redirect(githubAuthUrl.toString(), 302);
      }

      // GitHub App user authorization callback
      if (path === '/auth/callback') {
        const code = url.searchParams.get('code');
        
        if (!code) {
          return new Response('Missing authorization code', { 
            status: 400, 
            headers: corsHeaders 
          });
        }

        try {
          // Exchange code for authentication using @octokit/auth-oauth-user
          const authResult = await github.exchangeCodeForAuth(code);
          console.log('User authentication successful');
          console.log(`User: ${authResult.user.login}`);
          
          // Determine expiration - use provided expiration or default to 1 year from now
          const expiresAt = authResult.expiresAt ?? null;
          console.log(`Token expires at: ${expiresAt}`);
          
          if (authResult.refreshToken) {
            console.log(`Refresh token expires at: ${authResult.refreshTokenExpiresAt}`);
          }
          
          // Store the user token in the database
          const userToken = await database.storeToken(
            authResult.user.login,
            authResult.token,
            expiresAt,
            {
              userName: authResult.user.name,
              userEmail: authResult.user.email,
              refreshToken: authResult.refreshToken,
              refreshTokenExpiresAt: authResult.refreshTokenExpiresAt,
              scopes: authResult.scopes,
            }
          );
          
          console.log('User token stored successfully');

          // Redirect back to web UI with success
          const webUrl = new URL('https://mise-versions.jdx.dev/');
          webUrl.searchParams.set('login', 'success');
          webUrl.searchParams.set('user', authResult.user.login);
          return Response.redirect(webUrl.toString(), 302);
        } catch (error) {
          console.error('Authorization callback error:', error);
          // Redirect back to web UI with error
          const webUrl = new URL('https://mise-versions.jdx.dev/');
          webUrl.searchParams.set('login', 'error');
          return Response.redirect(webUrl.toString(), 302);
        }
      }

      // GitHub webhooks (simplified - just for logging)
      if (path === '/webhooks/github' && request.method === 'POST') {
        const payload = await request.text();
        const eventType = request.headers.get('x-github-event');

        console.log(`Webhook received: ${eventType} event (signature verification skipped for user token flow)`);
        
        return new Response('Webhook processed', { status: 200 });
      }

      // API endpoint for GitHub Actions to get tokens
      if (path === '/api/token' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Missing or invalid authorization header', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const apiSecret = authHeader.slice(7); // Remove 'Bearer '
        if (apiSecret !== env.API_SECRET) {
          return new Response('Invalid API secret', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        // Clean up expired tokens
        await database.deactivateExpiredTokens();

        // Get next available token
        const token = await database.getNextToken();
        if (!token) {
          return new Response('No available tokens', { 
            status: 503, 
            headers: corsHeaders,
          });
        }

        // Validate token if it hasn't been validated recently (optional)
        const lastValidated = token.last_validated ? new Date(token.last_validated) : null;
        const shouldValidate = !lastValidated || 
          (Date.now() - lastValidated.getTime()) > 24 * 60 * 60 * 1000; // 24 hours

        if (shouldValidate) {
          const isValid = await github.validateToken(token.token);
          if (isValid) {
            await database.updateTokenValidation(token.id);
          } else {
            // Token is invalid, deactivate it
            await database.deactivateExpiredTokens();
            console.log(`Deactivated invalid token for user ${token.user_id}`);
            
            // Try to get another token
            const nextToken = await database.getNextToken();
            if (!nextToken) {
              return new Response('No valid tokens available', { 
                status: 503, 
                headers: corsHeaders,
              });
            }
            // Use the next token instead
            Object.assign(token, nextToken);
          }
        }

        const response: TokenResponse = {
          token: token.token,
          installation_id: token.id, // Use token.id as a unique identifier
          token_id: token.id, // Add explicit token_id for rate limiting
          expires_at: token.expires_at,
        };

        return new Response(JSON.stringify(response), {
          headers: { 
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        });
      }

      // API endpoint to mark a token as rate-limited
      if (path === '/api/token/rate-limit' && request.method === 'POST') {
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Missing or invalid authorization header', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const apiSecret = authHeader.slice(7);
        if (apiSecret !== env.API_SECRET) {
          return new Response('Invalid API secret', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const rateLimitData = await request.json() as {
          token_id: number;
          reset_at: string;
        };

        // Mark token as rate-limited until reset_at
        await database.markTokenRateLimited(
          rateLimitData.token_id,
          rateLimitData.reset_at
        );

        return new Response('Token marked as rate-limited', { headers: corsHeaders });
      }

      // Token statistics endpoint
      if (path === '/api/stats' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Missing or invalid authorization header', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const apiSecret = authHeader.slice(7);
        if (apiSecret !== env.API_SECRET) {
          return new Response('Invalid API secret', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const stats = await database.getTokenStats();
        return new Response(JSON.stringify(stats), {
          headers: { 
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        });
      }

      // Migration status endpoint
      if (path === '/api/migrations' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Missing or invalid authorization header', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const apiSecret = authHeader.slice(7);
        if (apiSecret !== env.API_SECRET) {
          return new Response('Invalid API secret', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const migrationStatus = await getMigrationStatus(db);
        return new Response(JSON.stringify(migrationStatus), {
          headers: { 
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        });
      }

      // Rate limit information across all tokens
      if (path === '/api/rate-limits' && request.method === 'GET') {
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Missing or invalid authorization header', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        const apiSecret = authHeader.slice(7);
        if (apiSecret !== env.API_SECRET) {
          return new Response('Invalid API secret', { 
            status: 401, 
            headers: corsHeaders 
          });
        }

        try {
          // Get all active tokens
          const allTokens = await database.getAllTokens();
          const rateLimits = [];
          
          // Check rate limits for each token (limit to first 5 to avoid timeout)
          const tokensToCheck = allTokens.slice(0, 5);
          
          for (const token of tokensToCheck) {
            try {
              const rateLimit = await github.getRateLimit(token.token);
              if (rateLimit) {
                rateLimits.push({
                  userId: token.user_id,
                  userName: token.user_name,
                  core: rateLimit.resources.core,
                  search: rateLimit.resources.search,
                  graphql: rateLimit.resources.graphql,
                  lastUsed: token.last_used,
                  usageCount: token.usage_count,
                });
              }
            } catch (error) {
              console.log(`Failed to get rate limit for user ${token.user_id}:`, error);
            }
          }

          return new Response(JSON.stringify({
            totalTokens: allTokens.length,
            checkedTokens: tokensToCheck.length,
            rateLimits,
          }), {
            headers: { 
              ...corsHeaders,
              'Content-Type': 'application/json',
            },
          });
        } catch (error) {
          console.error('Rate limit check error:', error);
          return new Response('Failed to check rate limits', { 
            status: 500, 
            headers: corsHeaders 
          });
        }
      }

      // Health check endpoint
      if (path === '/health') {
        const stats = await database.getTokenStats();
        const expiringTokens = await database.getExpiringTokens();
        const migrationStatus = await getMigrationStatus(db);
        
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          tokens: stats,
          tokenTypes: {
            total: stats.total,
            active: stats.active,
          },
          expiringTokens: expiringTokens.length,
          migrations: migrationStatus,
        }), {
          headers: { 
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        });
      }

      // Default response
      return new Response(`GitHub Token Manager API

Powered by @octokit/auth-oauth-user and @octokit/rest

Endpoints:
- GET  /auth/login         - Start GitHub OAuth flow (redirects to GitHub)
- GET  /auth/callback      - OAuth callback (redirects to web UI)
- GET  /health             - Health check with token statistics
- POST /webhooks/github    - GitHub webhooks (optional)
- GET  /api/token          - Get next available token (round-robin)
- POST /api/token/rate-limit - Mark a token as rate-limited
- GET  /api/stats          - Token statistics
- GET  /api/migrations     - Database migration status
- GET  /api/rate-limits    - Rate limit status across tokens

Features:
- GitHub OAuth integration with web UI
- Automatic token validation
- Round-robin distribution
- Enhanced user information storage
- Rate limit monitoring
- Granular token rate limiting
- Database migrations
- Database auto-initialization

Authentication: All API endpoints require Bearer token with API_SECRET.
OAuth: Visit /auth/login to contribute your GitHub token.`, {
        headers: { 
          ...corsHeaders,
          'Content-Type': 'text/plain',
        },
      });

    } catch (error) {
      console.error('Request error:', error);
      return new Response('Internal server error', { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  },
};
