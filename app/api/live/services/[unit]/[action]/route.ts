import { elevationClaims } from "../../../../../lib/elevation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ unit: string; action: string }> }) {
  const claims = elevationClaims(request);
  if (!claims) return Response.json({ error: "Administrative elevation is required." }, { status: 403 });
  const { unit, action } = await context.params;
  if (!/^[a-zA-Z0-9@_.-]{1,180}\.service$/.test(unit) || !["start", "stop", "restart"].includes(action)) return Response.json({ error: "Unsupported service action." }, { status: 400 });
  const agentUrl = process.env.OPSDECK_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) return Response.json({ error: "The live agent is not configured." }, { status: 503 });
  try {
    const response = await fetch(`${agentUrl}/v1/services/${encodeURIComponent(unit)}/${action}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-OpsDeck-Actor": claims.username }, signal: AbortSignal.timeout(95_000) });
    return Response.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "The service action could not be completed." }, { status: 502 }); }
}
