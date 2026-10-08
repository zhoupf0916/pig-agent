/** OAuth 2.1 client_credentials for remote MCP — shared implementation lives in contracts. */
export { credentialSecrets, discoverTokenEndpoint, invalidateToken, isUnauthorizedError, parseOAuthSecret, redactCredential, resetOAuthCacheForTests, resolveBearer, type OAuthClientCredentials } from "@pig-agent/contracts/mcp-oauth";
