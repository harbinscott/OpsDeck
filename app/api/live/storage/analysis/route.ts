export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const agentUrl = process.env.OPSDECK_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) return Response.json({ error: "The live agent is not configured." }, { status: 503 });
  const mount = new URL(request.url).searchParams.get("mount") ?? "";
  if (!mount.startsWith("/") || mount.length > 4096) return Response.json({ error: "A valid filesystem mount is required." }, { status: 400 });
  try {
    const response = await fetch(`${agentUrl}/v1/storage/analysis?mount=${encodeURIComponent(mount)}`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(55_000) });
    return Response.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "The storage scan did not complete." }, { status: 502 }); }
}
