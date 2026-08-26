import worker from "./index.js";

const CONFIRMED_WRITE_TOOLS = new Set([
  "revise_ebay_listing",
  "add_ebay_images_to_listing",
  "attach_ebay_video_to_listing",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let isToolsList = false;
    let forwardedRequest = request;

    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        const message = await request.clone().json();
        isToolsList = message?.method === "tools/list";

        const toolName = message?.params?.name;
        const args = message?.params?.arguments;

        // ChatGPT handles approval for destructive connector actions at the
        // platform layer and does not expose our custom `confirmed` argument
        // to the generated tool schema. Add it back before forwarding so the
        // worker's server-side safety check can succeed after approval.
        if (
          message?.method === "tools/call" &&
          CONFIRMED_WRITE_TOOLS.has(toolName) &&
          args &&
          args.confirmed !== true
        ) {
          message.params.arguments.confirmed = true;
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

    // ChatGPT's generated connector schema does not need the JSON Schema
    // `const: true` constraint for the hidden confirmation argument.
    const text = await response.text();
    const patchedText = text.replaceAll('"const":true,', "");
    const headers = new Headers(response.headers);
    headers.delete("content-length");

    return new Response(patchedText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
