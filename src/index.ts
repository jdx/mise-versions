import { drizzle } from 'drizzle-orm/d1';
import { setupDatabase } from './database.js';
import { 
  GitHubAppManager, 
  GitHubAppConfig,
  extractRateLimitInfo 
} from './github.js';

export interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  API_SECRET: string; // Secret for GitHub Actions to authenticate
}

interface TokenResponse {
  token: string;
  installation_id: number;
  expires_at: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = drizzle(env.DB);
    const database = setupDatabase(db);
    
    // Auto-setup database on first access
    try {
      await database.setup();
    } catch (error) {
      // Database setup failed - this might be a real issue
      console.error('Database setup error:', error);
      // Continue anyway - tables might already exist
    }
    
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
          
          // Determine expiration - use provided expiration or default
          const expiresAt = authResult.expiresAt || github.getDefaultExpiration();
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
          
          return new Response(`Authorization successful! Token stored for user ${authResult.user.login}.`, { 
            headers: corsHeaders 
          });
        } catch (error) {
          console.error('Authorization callback error:', error);
          return new Response('Authorization failed', { 
            status: 500, 
            headers: corsHeaders 
          });
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
          expires_at: token.expires_at,
        };

        return new Response(JSON.stringify(response), {
          headers: { 
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        });
      }

      // API endpoint to record token usage (for rate limit tracking)
      if (path === '/api/token/usage' && request.method === 'POST') {
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

        const usage = await request.json() as {
          token_id: number;
          endpoint: string;
          remaining_requests?: number;
          reset_at?: string;
        };

        await database.recordTokenUsage(
          usage.token_id,
          usage.endpoint,
          usage.remaining_requests,
          usage.reset_at
        );

        return new Response('Usage recorded', { headers: corsHeaders });
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
        
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          tokens: stats,
          tokenTypes: {
            total: stats.total,
            active: stats.active,
          },
          expiringTokens: expiringTokens.length,
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
- GET  /health              - Health check with token statistics
- POST /auth/callback       - User authorization callback  
- POST /webhooks/github     - GitHub webhooks (optional)
- GET  /api/token          - Get next available token (round-robin)
- POST /api/token/usage    - Record token usage for monitoring
- GET  /api/stats          - Token statistics
- GET  /api/rate-limits    - Rate limit status across tokens

Features:
- Automatic token validation
- Round-robin distribution  
- Enhanced user information storage
- Rate limit monitoring
- Database auto-initialization

Authentication: All API endpoints require Bearer token with API_SECRET.`, {
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
