import worker from "./index-mcp-compatible.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        const message = await request.clone().json();
        const toolName = message?.params?.name;
        const args = message?.params?.arguments || {};

        if (
          message?.method === "tools/call" &&
          toolName === "get_ebay_listing" &&
          args.itemId === "__MO_OAUTH_STATUS__"
        ) {
          return mcpResult(message.id ?? null, {
            ebayUserTokenPresent: Boolean(env.EBAY_USER_TOKEN),
            ebayOauthTokenPresent: Boolean(env.EBAY_OAUTH_TOKEN),
            ebayRefreshTokenPresent: Boolean(env.EBAY_REFRESH_TOKEN),
            ebayClientIdPresent: Boolean(env.EBAY_CLIENT_ID),
            ebayClientSecretPresent: Boolean(env.EBAY_CLIENT_SECRET),
            ebayRunamePresent: Boolean(env.EBAY_RUNAME),
          });
        }
      } catch {
        // Pass through ordinary MCP traffic.
      }
    }

    return worker.fetch(request, env, ctx);
  },
};

function mcpResult(id, structuredContent) {
  const payload = {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
      isError: false,
    },
  };

  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
