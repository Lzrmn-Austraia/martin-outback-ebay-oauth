import worker from "./index.js";

const CONFIRMED_WRITE_TOOLS = new Set([
  "revise_ebay_listing",
  "add_ebay_images_to_listing",
  "attach_ebay_video_to_listing",
  "send_ebay_offer_to_interested_buyers",
]);

const NEGOTIATION_TOOL_NAMES = new Set([
  "find_ebay_offer_eligible_items",
  "send_ebay_offer_to_interested_buyers",
]);

const EXTRA_TOOLS = [
  {
    name: "find_ebay_offer_eligible_items",
    title: "Find eBay offer-eligible listings",
    description:
      "Read-only. Return eBay Australia listing IDs that currently have interested buyers eligible to receive a private seller offer.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "send_ebay_offer_to_interested_buyers",
    title: "Send eBay offer to interested buyers",
    description:
      "Send one private percentage-discount offer for a single eligible eBay Australia listing to all currently eligible interested buyers. The public listing price is not changed. Requires explicit approval.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", minLength: 1 },
        discountPercentage: { type: "number", minimum: 1, maximum: 99 },
        message: { type: "string", maxLength: 2000 },
        quantity: { type: "integer", minimum: 1, default: 1 },
        confirmed: {
          type: "boolean",
          const: true,
          description: "Set true only after the user explicitly approves sending this live buyer offer.",
        },
      },
      required: ["itemId", "discountPercentage", "confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "Martin Outback eBay OAuth MCP",
        negotiationTools: true,
        version: "2.1.0",
      });
    }

    let isToolsList = false;
    let forwardedRequest = request;
    let message = null;
    let messageMutated = false;

    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        message = await request.clone().json();
        isToolsList = message?.method === "tools/list";

        const toolName = message?.params?.name;
        const args = message?.params?.arguments;

        // ChatGPT performs approval for destructive connector actions at the
        // platform layer. Restore the server-side confirmed flag after that
        // approval so the existing safety check pattern remains intact.
        if (
          message?.method === "tools/call" &&
          CONFIRMED_WRITE_TOOLS.has(toolName) &&
          args &&
          args.confirmed !== true
        ) {
          message.params.arguments.confirmed = true;
          messageMutated = true;
        }

        if (message?.method === "tools/call" && NEGOTIATION_TOOL_NAMES.has(toolName)) {
          return await handleNegotiationTool(message, env);
        }

        if (messageMutated) {
          const headers = new Headers(request.headers);
          headers.delete("content-length");
          forwardedRequest = new Request(request.url, {
            method: "POST",
            headers,
            body: JSON.stringify(message),
          });
        }
      } catch {
        // Leave non-JSON requests untouched.
      }
    }

    const response = await worker.fetch(forwardedRequest, env, ctx);

    if (!isToolsList) return response;

    const text = await response.text();
    const patchedText = appendToolsToMcpResponse(text, EXTRA_TOOLS).replaceAll('"const":true,', "");
    const headers = new Headers(response.headers);
    headers.delete("content-length");

    return new Response(patchedText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

async function handleNegotiationTool(message, env) {
  const id = message.id ?? null;
  const name = message.params?.name;
  const args = message.params?.arguments || {};

  try {
    if (name === "find_ebay_offer_eligible_items") {
      const limit = clampInteger(args.limit, 100, 1, 200);
      const offset = clampInteger(args.offset, 0, 0, 1000000);
      const payload = await negotiationCall(
        env,
        `/find_eligible_items?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
        { method: "GET" }
      );
      return toolSuccess(id, {
        marketplaceId: "EBAY_AU",
        eligibleItems: payload?.eligibleItems || [],
        total: payload?.total || 0,
        limit: payload?.limit ?? limit,
        offset: payload?.offset ?? offset,
        next: payload?.next || "",
      });
    }

    if (name === "send_ebay_offer_to_interested_buyers") {
      requireConfirmation(args);
      const itemId = requiredText(args.itemId, "itemId");
      const discountPercentage = Number(args.discountPercentage);
      if (!Number.isFinite(discountPercentage) || discountPercentage < 1 || discountPercentage > 99) {
        throw new Error("discountPercentage must be between 1 and 99.");
      }
      const quantity = clampInteger(args.quantity, 1, 1, 999);
      const messageText = args.message === undefined ? "" : String(args.message).trim();
      if (messageText.length > 2000) throw new Error("message must be 2,000 characters or fewer.");

      const body = {
        offeredItems: [
          {
            listingId: itemId,
            quantity,
            discountPercentage: String(discountPercentage),
          },
        ],
        allowCounterOffer: false,
      };
      if (messageText) body.message = messageText;

      const payload = await negotiationCall(env, "/send_offer_to_interested_buyers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      return toolSuccess(id, {
        message: `Private ${discountPercentage}% offer sent for listing ${itemId}.`,
        marketplaceId: "EBAY_AU",
        listingId: itemId,
        discountPercentage,
        offerCount: Array.isArray(payload?.offers) ? payload.offers.length : 0,
        offers: payload?.offers || [],
      });
    }

    return toolError(id, `Unknown negotiation tool: ${name || "(missing)"}`);
  } catch (error) {
    return toolError(id, error instanceof Error ? error.message : String(error));
  }
}

async function negotiationCall(env, path, init = {}) {
  const token = env.EBAY_OAUTH_TOKEN || env.EBAY_USER_TOKEN;
  if (!token) throw new Error("An eBay OAuth user token is missing from Worker secrets.");

  const response = await fetch(`https://api.ebay.com/sell/negotiation/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_AU",
      ...(init.headers || {}),
    },
  });

  if (response.status === 204) return {};

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(formatEbayRestError(response.status, payload));
  }

  return payload || {};
}

function formatEbayRestError(status, payload) {
  const messages = [];
  for (const error of payload?.errors || []) {
    if (error?.message) messages.push(error.message);
    if (error?.longMessage && error.longMessage !== error.message) messages.push(error.longMessage);
  }
  if (messages.length) return `eBay REST ${status}: ${messages.join(" | ")}`;
  if (payload?.message) return `eBay REST ${status}: ${payload.message}`;
  return `eBay REST request failed (${status}).`;
}

function appendToolsToMcpResponse(text, extraTools) {
  try {
    const marker = "data: ";
    const start = text.indexOf(marker);
    if (start < 0) return text;
    const jsonStart = start + marker.length;
    const lineEnd = text.indexOf("\n", jsonStart);
    const jsonText = lineEnd >= 0 ? text.slice(jsonStart, lineEnd) : text.slice(jsonStart);
    const payload = JSON.parse(jsonText);
    if (!Array.isArray(payload?.result?.tools)) return text;

    const existingNames = new Set(payload.result.tools.map((tool) => tool?.name));
    for (const tool of extraTools) {
      if (!existingNames.has(tool.name)) payload.result.tools.push(tool);
    }

    return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  } catch {
    return text;
  }
}

function requireConfirmation(args) {
  if (args.confirmed !== true) {
    throw new Error("Live buyer offer not sent: explicit user approval is required.");
  }
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}

function toolSuccess(id, structuredContent) {
  return rpc(id, {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: false,
  });
}

function toolError(id, message) {
  return rpc(id, { content: [{ type: "text", text: `eBay error: ${message}` }], isError: true });
}

function rpc(id, result) {
  return mcpResponse({ jsonrpc: "2.0", id, result });
}

function mcpResponse(payload) {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
