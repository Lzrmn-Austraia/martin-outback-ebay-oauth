import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { handleAccessRequest } from "./access-handler";

const mcpApi = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "authorization, content-type, mcp-protocol-version",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "Martin Outback eBay API" });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Use /mcp", { status: 404 });
    }

    if (request.method === "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const message = await request.json();
    const id = message.id ?? null;

    if (message.method === "initialize") {
      return rpc(id, {
        protocolVersion: message.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Martin Outback eBay API", version: "2.0.0" },
      });
    }

    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/cancelled"
    ) {
      return new Response(null, { status: 202 });
    }

    if (message.method === "ping") return rpc(id, {});

    if (message.method === "tools/list") {
      return rpc(id, { tools: toolDefinitions() });
    }

    if (message.method === "tools/call") {
      if (!env.EBAY_USER_TOKEN) {
        return toolError(id, "EBAY_USER_TOKEN is missing from Worker secrets.");
      }

      const name = message.params?.name;
      const args = message.params?.arguments || {};

      try {
        if (name === "list_active_ebay_listings") {
          const limit = clampInteger(args.limit, 20, 1, 50);
          return toolSuccess(id, {
            listings: await getActiveListings(env.EBAY_USER_TOKEN, limit),
          });
        }

        if (name === "get_ebay_listing") {
          const itemId = requiredText(args.itemId, "itemId");
          return toolSuccess(id, {
            listing: await getListing(env.EBAY_USER_TOKEN, itemId),
          });
        }

        if (name === "revise_ebay_listing") {
          requireConfirmation(args);
          const itemId = requiredText(args.itemId, "itemId");
          const changes = normaliseChanges(args);
          if (Object.keys(changes).length === 0) {
            throw new Error("Provide at least one field to revise.");
          }

          await reviseListing(env.EBAY_USER_TOKEN, itemId, changes);
          return toolSuccess(id, {
            message: `Listing ${itemId} updated successfully.`,
            listing: await getListing(env.EBAY_USER_TOKEN, itemId),
          });
        }

        if (name === "upload_ebay_image_from_url") {
          const imageUrl = validatedPublicHttpsUrl(args.imageUrl, "imageUrl");
          return toolSuccess(id, {
            image: await uploadImageFromUrl(mediaToken(env), imageUrl),
          });
        }

        if (name === "add_ebay_images_to_listing") {
          requireConfirmation(args);
          const itemId = requiredText(args.itemId, "itemId");
          const uploaded = [];
          for (const imageUrl of normaliseUrlList(args.imageUrls, "imageUrls", 1, 24)) {
            uploaded.push(await uploadImageFromUrl(mediaToken(env), imageUrl));
          }
          const newUrls = uploaded.map((image) => image.imageUrl);
          const existing = args.replaceExisting
            ? []
            : (await getListing(env.EBAY_USER_TOKEN, itemId)).pictureUrls;
          const pictureUrls = [...existing, ...newUrls].slice(0, 24);
          await reviseListing(env.EBAY_USER_TOKEN, itemId, { pictureUrls });
          return toolSuccess(id, {
            message: `Uploaded and attached ${newUrls.length} image(s) to listing ${itemId}.`,
            uploaded,
            listing: await getListing(env.EBAY_USER_TOKEN, itemId),
          });
        }

        if (name === "upload_ebay_video_from_url") {
          const videoUrl = validatedPublicHttpsUrl(args.videoUrl, "videoUrl");
          const title = requiredText(args.title, "title");
          return toolSuccess(id, {
            video: await uploadVideoFromUrl(mediaToken(env), {
              videoUrl,
              title,
              description: args.description === undefined ? undefined : String(args.description),
            }),
          });
        }

        if (name === "get_ebay_video_status") {
          const videoId = requiredText(args.videoId, "videoId");
          return toolSuccess(id, { video: await getVideo(mediaToken(env), videoId) });
        }

        if (name === "attach_ebay_video_to_listing") {
          requireConfirmation(args);
          const itemId = requiredText(args.itemId, "itemId");
          const videoId = requiredText(args.videoId, "videoId");
          const video = await getVideo(mediaToken(env), videoId);
          if (video.status !== "LIVE") {
            throw new Error(`Video ${videoId} is ${video.status || "not ready"}; wait until its status is LIVE.`);
          }
          await reviseListing(env.EBAY_USER_TOKEN, itemId, { videoId });
          return toolSuccess(id, {
            message: `Video ${videoId} attached to listing ${itemId}.`,
            video,
            listing: await getListing(env.EBAY_USER_TOKEN, itemId),
          });
        }

        return rpcError(id, -32602, `Unknown tool: ${name || "(missing)"}`);
      } catch (error) {
        return toolError(id, error instanceof Error ? error.message : String(error));
      }
    }

    return rpcError(id, -32601, "Method not found");
  },
};

function toolDefinitions() {
  return [
    {
      name: "list_active_ebay_listings",
      title: "List active eBay listings",
      description: "Retrieve Martin Outback Australia's active eBay listings.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 20,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "get_ebay_listing",
      title: "Get eBay listing details",
      description: "Retrieve full details for one eBay listing by item number.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" } },
        required: ["itemId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "revise_ebay_listing",
      title: "Revise an eBay listing",
      description:
        "Update an active listing's title, HTML description, price, quantity, or picture URLs. Only supplied fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          title: { type: "string", maxLength: 80 },
          description: { type: "string" },
          price: { type: "number", minimum: 0.01 },
          quantity: { type: "integer", minimum: 0 },
          pictureUrls: {
            type: "array",
            items: { type: "string", format: "uri" },
            minItems: 1,
            maxItems: 24,
          },
          confirmed: confirmationSchema(),
        },
        required: ["itemId", "confirmed"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: "upload_ebay_image_from_url",
      title: "Upload an image to eBay",
      description: "Copy one public HTTPS image into eBay Picture Services. This does not alter a listing.",
      inputSchema: {
        type: "object",
        properties: { imageUrl: { type: "string", format: "uri" } },
        required: ["imageUrl"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "add_ebay_images_to_listing",
      title: "Upload and attach eBay listing images",
      description: "Upload public HTTPS images and attach them to a listing. Requires explicit confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          imageUrls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: 24 },
          replaceExisting: { type: "boolean", default: false },
          confirmed: confirmationSchema(),
        },
        required: ["itemId", "imageUrls", "confirmed"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: "upload_ebay_video_from_url",
      title: "Upload a video to eBay",
      description: "Upload one public HTTPS video to eBay for processing. This does not alter a listing.",
      inputSchema: {
        type: "object",
        properties: {
          videoUrl: { type: "string", format: "uri" },
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
        },
        required: ["videoUrl", "title"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "get_ebay_video_status",
      title: "Check an eBay video",
      description: "Check whether an uploaded eBay video is processing, live, blocked, or failed.",
      inputSchema: {
        type: "object",
        properties: { videoId: { type: "string" } },
        required: ["videoId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "attach_ebay_video_to_listing",
      title: "Attach a video to an eBay listing",
      description: "Attach a LIVE eBay video to a listing. Requires explicit confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          videoId: { type: "string" },
          confirmed: confirmationSchema(),
        },
        required: ["itemId", "videoId", "confirmed"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}

function confirmationSchema() {
  return {
    type: "boolean",
    const: true,
    description: "Set true only after the user explicitly approves this live listing change.",
  };
}

async function ebayCall(token, callName, body) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(token)}</eBayAuthToken></RequesterCredentials>
  ${body}
</${callName}Request>`;

  const response = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "15",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1423",
    },
    body: xml,
  });

  const text = await response.text();
  const ack = extractTag(text, "Ack");
  if (!response.ok || !["Success", "Warning"].includes(ack)) {
    const errors = extractTags(text, "LongMessage")
      .concat(extractTags(text, "ShortMessage"))
      .map(decodeXml)
      .filter(Boolean);
    throw new Error(errors.join(" | ") || `eBay ${callName} failed (${response.status}).`);
  }
  return text;
}

async function getActiveListings(token, limit) {
  const text = await ebayCall(
    token,
    "GetMyeBaySelling",
    `<DetailLevel>ReturnAll</DetailLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>${limit}</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
  </ActiveList>`
  );

  return extractBlocks(text, "Item").slice(0, limit).map(parseListingSummary);
}

async function getListing(token, itemId) {
  const text = await ebayCall(
    token,
    "GetItem",
    `<ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>`
  );
  const item = extractBlock(text, "Item");
  if (!item) throw new Error(`eBay did not return listing ${itemId}.`);
  return parseListingDetails(item);
}

async function reviseListing(token, itemId, changes) {
  const fields = [`<ItemID>${escapeXml(itemId)}</ItemID>`];
  if (changes.title !== undefined) fields.push(`<Title>${escapeXml(changes.title)}</Title>`);
  if (changes.description !== undefined) {
    fields.push(`<Description><![CDATA[${safeCdata(changes.description)}]]></Description>`);
  }
  if (changes.price !== undefined) {
    fields.push(`<StartPrice currencyID="AUD">${changes.price.toFixed(2)}</StartPrice>`);
  }
  if (changes.quantity !== undefined) fields.push(`<Quantity>${changes.quantity}</Quantity>`);
  if (changes.pictureUrls !== undefined) {
    fields.push(
      `<PictureDetails>${changes.pictureUrls
        .map((value) => `<PictureURL>${escapeXml(value)}</PictureURL>`)
        .join("")}</PictureDetails>`
    );
  }
  if (changes.videoId !== undefined) {
    fields.push(`<VideoDetails><VideoID>${escapeXml(changes.videoId)}</VideoID></VideoDetails>`);
  }
  await ebayCall(token, "ReviseItem", `<Item>${fields.join("")}</Item>`);
}

function mediaToken(env) {
  const token = env.EBAY_OAUTH_TOKEN || env.EBAY_USER_TOKEN;
  if (!token) throw new Error("EBAY_OAUTH_TOKEN is missing from Worker secrets.");
  return token;
}

async function mediaCall(token, path, init = {}) {
  const response = await fetch(`https://api.ebay.com/commerce/media/v1_beta${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
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
    const errors = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error.longMessage || error.message).filter(Boolean)
      : [];
    throw new Error(errors.join(" | ") || payload?.message || `eBay Media API failed (${response.status}).`);
  }
  return { response, payload };
}

async function uploadImageFromUrl(token, imageUrl) {
  const created = await mediaCall(token, "/image/create_image_from_url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl }),
  });
  const location = created.response.headers.get("Location") || "";
  const imageId = location.split("/").filter(Boolean).pop();
  if (!imageId) throw new Error("eBay uploaded the image but did not return an image ID.");
  const details = await mediaCall(token, `/image/${encodeURIComponent(imageId)}`);
  if (!details.payload?.imageUrl) throw new Error("eBay did not return an EPS image URL.");
  return { imageId, ...details.payload };
}

async function uploadVideoFromUrl(token, { videoUrl, title, description }) {
  const source = await fetch(videoUrl, { redirect: "follow" });
  if (!source.ok || !source.body) throw new Error(`Unable to download the video (${source.status}).`);
  const size = Number(source.headers.get("Content-Length"));
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("The video server must provide a valid Content-Length header.");
  }
  if (size > 157286400) throw new Error("The video exceeds eBay's 150 MB limit.");
  const metadata = { title, size, classification: ["ITEM"] };
  if (description !== undefined) metadata.description = description;
  const created = await mediaCall(token, "/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const location = created.response.headers.get("Location") || "";
  const videoId = location.split("/").filter(Boolean).pop();
  if (!videoId) throw new Error("eBay created the video but did not return a video ID.");
  await mediaCall(token, `/video/${encodeURIComponent(videoId)}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
    body: source.body,
  });
  return getVideo(token, videoId);
}

async function getVideo(token, videoId) {
  const result = await mediaCall(token, `/video/${encodeURIComponent(videoId)}`);
  return result.payload;
}

function requireConfirmation(args) {
  if (args.confirmed !== true) {
    throw new Error("Live listing change not made: ask the user for explicit approval, then call again with confirmed=true.");
  }
}

function normaliseUrlList(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${field} must contain between ${minimum} and ${maximum} URLs.`);
  }
  return value.map((url) => validatedPublicHttpsUrl(url, field));
}

function validatedPublicHttpsUrl(value, field) {
  const parsed = new URL(requiredText(value, field));
  if (parsed.protocol !== "https:") throw new Error(`${field} must use HTTPS.`);
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" ||
    hostname === "::1" || hostname.endsWith(".local") || /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error(`${field} must be a public URL.`);
  }
  return parsed.toString();
}

function normaliseChanges(args) {
  const changes = {};
  if (args.title !== undefined) {
    const title = requiredText(args.title, "title");
    if (title.length > 80) throw new Error("title must be 80 characters or fewer.");
    changes.title = title;
  }
  if (args.description !== undefined) changes.description = String(args.description);
  if (args.price !== undefined) {
    const price = Number(args.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("price must be greater than zero.");
    changes.price = price;
  }
  if (args.quantity !== undefined) {
    const quantity = Number(args.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) throw new Error("quantity must be a whole number of zero or more.");
    changes.quantity = quantity;
  }
  if (args.pictureUrls !== undefined) {
    if (!Array.isArray(args.pictureUrls) || args.pictureUrls.length < 1 || args.pictureUrls.length > 24) {
      throw new Error("pictureUrls must contain between 1 and 24 image URLs.");
    }
    changes.pictureUrls = args.pictureUrls.map((value) => {
      const parsed = new URL(String(value));
      if (parsed.protocol !== "https:") throw new Error("Every picture URL must use HTTPS.");
      return parsed.toString();
    });
  }
  return changes;
}

function parseListingSummary(item) {
  return {
    itemId: extractTag(item, "ItemID"),
    title: decodeXml(extractTag(item, "Title")),
    price: numberOrText(extractTag(item, "CurrentPrice")),
    currency: extractAttribute(item, "CurrentPrice", "currencyID"),
    quantityAvailable: numberOrText(extractTag(item, "QuantityAvailable")),
    quantitySold: numberOrText(extractTag(item, "QuantitySold")),
    watchCount: numberOrText(extractTag(item, "WatchCount")),
    viewUrl: decodeXml(extractTag(item, "ViewItemURL")),
  };
}

function parseListingDetails(item) {
  const summary = parseListingSummary(item);
  return {
    ...summary,
    description: decodeXml(extractTag(item, "Description")),
    quantity: numberOrText(extractTag(item, "Quantity")),
    condition: decodeXml(extractTag(item, "ConditionDisplayName") || extractTag(item, "ConditionID")),
    conditionDescription: decodeXml(extractTag(item, "ConditionDescription")),
    listingType: extractTag(item, "ListingType"),
    listingStatus: extractTag(item, "ListingStatus"),
    startTime: extractTag(item, "StartTime"),
    endTime: extractTag(item, "EndTime"),
    pictureUrls: extractTags(item, "PictureURL").map(decodeXml),
    videoIds: extractTags(extractBlock(item, "VideoDetails"), "VideoID").map(decodeXml),
    itemSpecifics: extractBlocks(item, "NameValueList").map((block) => ({
      name: decodeXml(extractTag(block, "Name")),
      values: extractTags(block, "Value").map(decodeXml),
    })),
    shippingService: decodeXml(extractTag(item, "ShippingService")),
    shippingCost: numberOrText(extractTag(item, "ShippingServiceCost")),
    returnsAccepted: decodeXml(extractTag(item, "ReturnsAcceptedOption")),
    returnPeriod: decodeXml(extractTag(item, "ReturnsWithinOption")),
    refund: decodeXml(extractTag(item, "RefundOption")),
    returnShippingPaidBy: decodeXml(extractTag(item, "ShippingCostPaidByOption")),
  };
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

function numberOrText(value) {
  if (value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function extractBlock(xml, tag) {
  return extractBlocks(xml, tag)[0] || "";
}

function extractBlocks(xml, tag) {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g")) || [];
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "") : "";
}

function extractTags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))]
    .map((match) => match[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, ""));
}

function extractAttribute(xml, tag, attribute) {
  const match = xml.match(new RegExp(`<${tag}[^>]*${attribute}="([^"]*)"`));
  return match ? match[1] : "";
}

function decodeXml(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeCdata(value) {
  return String(value).replaceAll("]]>", "]] ]]><![CDATA[>").replaceAll("]] ]]>" , "]]><![CDATA[>");
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

function rpcError(id, code, message) {
  return mcpResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function mcpResponse(payload) {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

const defaultHandler = {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") {
      return Response.json({ ok: true, service: "Martin Outback eBay OAuth MCP" });
    }
    if (pathname === "/") {
      return new Response("Martin Outback eBay OAuth MCP. Use /mcp");
    }
    return handleAccessRequest(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiHandler: mcpApi,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler,
  tokenEndpoint: "/token",
});
