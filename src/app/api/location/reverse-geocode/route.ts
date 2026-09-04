import { z } from "zod";

const schema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
}).strict();

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ label: "Current location", resolved: false });
  try {
    const endpoint = new URL(process.env.MISSIONPAY_REVERSE_GEOCODER_URL || "https://nominatim.openstreetmap.org/reverse");
    endpoint.searchParams.set("format", "jsonv2");
    endpoint.searchParams.set("addressdetails", "1");
    endpoint.searchParams.set("zoom", "10");
    endpoint.searchParams.set("lat", String(parsed.data.latitude));
    endpoint.searchParams.set("lon", String(parsed.data.longitude));
    const response = await fetch(endpoint, { headers: { "User-Agent": "MissionPay-Hackathon/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (!response.ok) return Response.json({ label: "Current location", resolved: false });
    const body = await response.json() as { address?: Record<string, string> };
    const address = body.address ?? {};
    const locality = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county;
    const state = address.state;
    const label = [locality, state].filter((part, index, values) => part && values.indexOf(part) === index).join(", ") || "Current location";
    return Response.json({ label, resolved: label !== "Current location" });
  } catch {
    return Response.json({ label: "Current location", resolved: false });
  }
}
