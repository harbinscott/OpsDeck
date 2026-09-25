import { isElevated } from "../../../../../lib/elevation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  if (!isElevated(request)) return Response.json({ error: "Administrative elevation is required." }, { status: 403 });
  const { id, action } = await context.params;
  if (!/^[a-f0-9]{12,64}$/.test(id) || !["start", "stop", "restart"].includes(action)) {
    return Response.json({ error: "Unsupported container action." }, { status: 400 });
  }
  const agentUrl = process.env.OPSDECK_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) return Response.json({ error: "The live agent is not configured." }, { status: 503 });
  try {
    const response = await fetch(`${agentUrl}/v1/containers/${id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The agent could not complete the container action." }, { status: 502 });
  }
}
