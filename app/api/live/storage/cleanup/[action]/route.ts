import { elevationClaims } from "../../../../../lib/elevation";

export const dynamic = "force-dynamic";
const dockerActions = new Set(["docker-containers", "docker-images", "docker-build-cache"]);
const hostActions = new Set(["cleanup-apt-cache", "cleanup-journals-30d", "cleanup-journals-1g", "cleanup-tempfiles"]);

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const claims = elevationClaims(request);
  if (!claims) return Response.json({ error: "Administrative elevation is required." }, { status: 403 });
  const { action } = await context.params;
  if (!dockerActions.has(action) && !hostActions.has(action)) return Response.json({ error: "Unsupported cleanup action." }, { status: 400 });
  const agentUrl = process.env.OPSDECK_AGENT_URL?.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) return Response.json({ error: "The live agent is not configured." }, { status: 503 });
  const path = dockerActions.has(action) ? `/v1/storage/cleanup/${action}` : `/v1/system/${action}`;
  try {
    const response = await fetch(`${agentUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-OpsDeck-Actor": claims.username }, signal: AbortSignal.timeout(15_000) });
    return Response.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "The cleanup action could not be started." }, { status: 502 }); }
}
