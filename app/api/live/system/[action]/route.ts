import { isElevated } from "../../../../lib/elevation";

export const dynamic = "force-dynamic";

const allowed = new Set(["refresh-repositories", "install-updates", "reboot", "poweroff"]);

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  if (!isElevated(request)) return Response.json({ error: "Administrative elevation is required." }, { status: 403 });
  const { action } = await context.params;
  if (!allowed.has(action)) return Response.json({ error: "Unsupported system action." }, { status: 400 });
  const agentUrl = process.env.OPSDECK_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) return Response.json({ error: "The live agent is not configured." }, { status: 503 });
  try {
    const response = await fetch(`${agentUrl}/v1/system/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The agent could not start the system action." }, { status: 502 });
  }
}
