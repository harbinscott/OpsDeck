import { isElevated } from "../../../../../lib/elevation";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isElevated(request)) return Response.json({ error: "Administrative elevation is required." }, { status: 403 });
  const { id } = await context.params;
  if (!/^[a-f0-9]{12,32}$/.test(id)) return Response.json({ error: "Invalid system action identifier." }, { status: 400 });
  const agentUrl = process.env.OPSDECK_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) return Response.json({ error: "The live agent is not configured." }, { status: 503 });
  try {
    const response = await fetch(`${agentUrl}/v1/system/jobs/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The agent could not report the system action." }, { status: 502 });
  }
}
