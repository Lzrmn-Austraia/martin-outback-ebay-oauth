# Martin Outback eBay OAuth MCP

OAuth 2.1 protected Cloudflare Worker for ChatGPT. It exposes three eBay tools:

- List active listings
- Retrieve one listing's complete details
- Revise selected fields of an active listing

The existing `EBAY_USER_TOKEN` remains the credential used between this Worker and eBay. Cloudflare Access supplies the separate OAuth login between ChatGPT and this Worker.

## Deployment prerequisites

1. Create a Cloudflare Access for SaaS generic OIDC application.
2. Use `https://martin-outback-ebay-oauth.<your-workers-subdomain>.workers.dev/callback` as its callback URL.
3. Create a Workers KV namespace named `OAUTH_KV` and place its ID in `wrangler.jsonc`.
4. Add these Worker secrets: `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`, `COOKIE_ENCRYPTION_KEY`, and `EBAY_USER_TOKEN`.
5. Run `npm install`, followed by `npm run deploy`.
6. Create the ChatGPT plugin using the deployed `/mcp` URL and choose OAuth.

This project is based on Cloudflare's official `remote-mcp-cf-access` OAuth example and retains Martin Outback's existing eBay Trading API implementation.
