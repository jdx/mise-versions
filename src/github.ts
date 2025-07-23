import { createOAuthUserAuth } from '@octokit/auth-oauth-user';
import { Octokit } from '@octokit/rest';

export interface GitHubAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface GitHubAuthResult {
  token: string;
  user: {
    login: string;
    id: number;
    email?: string;
    name?: string;
  };
  expiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  scopes?: string[];
}

export class GitHubAppManager {
  constructor(private config: GitHubAppConfig) {}

  // Handle OAuth callback and exchange code for authentication
  async exchangeCodeForAuth(code: string): Promise<GitHubAuthResult> {
    console.log('Creating OAuth user auth with code...');
    
    const auth = createOAuthUserAuth({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      code,
    });

    // Get the authentication object which includes token and expiration info
    const authResult = await auth();
    console.log('Auth result type:', authResult.type);
    console.log('Auth result clientType:', authResult.clientType);
    
    // Create Octokit instance with the token
    const octokit = new Octokit({
      auth: authResult.token,
    });
    
    // Get user information using Octokit
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`Retrieved user info for: ${user.login}`);
    
    return {
      token: authResult.token,
      user: {
        login: user.login,
        id: user.id,
        email: user.email || undefined,
        name: user.name || undefined,
      },
      expiresAt: 'expiresAt' in authResult ? authResult.expiresAt as string : undefined,
      refreshToken: 'refreshToken' in authResult ? authResult.refreshToken as string : undefined,
      refreshTokenExpiresAt: 'refreshTokenExpiresAt' in authResult ? authResult.refreshTokenExpiresAt as string : undefined,
      scopes: 'scopes' in authResult ? authResult.scopes as string[] : undefined,
    };
  }

  // Create authenticated Octokit instance
  createOctokit(token: string): Octokit {
    return new Octokit({
      auth: token,
    });
  }

  // Validate a token by making a test API call
  async validateToken(token: string): Promise<boolean> {
    try {
      const octokit = this.createOctokit(token);
      await octokit.rest.users.getAuthenticated();
      return true;
    } catch (error) {
      console.log('Token validation failed:', error);
      return false;
    }
  }

  // Get rate limit information for a token
  async getRateLimit(token: string) {
    try {
      const octokit = this.createOctokit(token);
      const { data } = await octokit.rest.rateLimit.get();
      return data;
    } catch (error) {
      console.log('Failed to get rate limit:', error);
      return null;
    }
  }

  // Get default expiration for tokens without explicit expiration
  getDefaultExpiration(): string {
    // For tokens without explicit expiration (like OAuth app tokens), set to 1 year
    // They typically don't expire but we want to refresh them periodically
    const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    return oneYearFromNow.toISOString();
  }
}

// No webhook events needed for user token flow

// Rate limit information from GitHub API responses
export interface RateLimitInfo {
  remaining: number;
  reset: number;
  used: number;
  limit: number;
}

export function extractRateLimitInfo(headers: Headers): RateLimitInfo | null {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const used = headers.get('x-ratelimit-used');
  const limit = headers.get('x-ratelimit-limit');
  
  if (remaining && reset && used && limit) {
    return {
      remaining: parseInt(remaining),
      reset: parseInt(reset),
      used: parseInt(used),
      limit: parseInt(limit),
    };
  }
  
  return null;
} 
