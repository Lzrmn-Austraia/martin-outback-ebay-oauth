import worker from "./index.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let isToolsList = false;

    if (request.method === "POST" && url.pathname === "/mcp") {
      try {
        const message = await request.clone().json();
        isToolsList = message?.method === "tools/list";
      } catch {
        // Leave non-JSON requests untouched.
      }
    }

    const response = await worker.fetch(request, env, ctx);
    if (!isToolsList) return response;

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
