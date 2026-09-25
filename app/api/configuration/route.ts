import { saveDashboardConfig } from "../../lib/dashboard-config";
import { isElevated } from "../../lib/elevation";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  if (!isElevated(request)) return Response.json({ error: "Administrative elevation is required." }, { status: 403 });
  try {
    const configuration = await saveDashboardConfig(await request.json());
    return Response.json({ configuration }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Configuration could not be saved." }, { status: 400 });
  }
}
