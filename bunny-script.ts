import * as BunnySDK from "https://esm.sh/@aspect-build/bunny-edge-scripting";

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Hello from Bunny Edge!", {
    headers: { "content-type": "text/plain" },
  });
});
