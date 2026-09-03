import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { merchants, offers } from "@/db/schema";
import { errorResponse } from "@/domain/errors";

const categories = ["CAKE", "FLOWERS", "RESTAURANT"] as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const category = new URL(request.url).searchParams.get("category");
    if (category && !categories.includes(category as (typeof categories)[number])) {
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "Unknown merchant category" } },
        { status: 400 },
      );
    }

    const query = db
      .select({
        id: offers.id,
        name: offers.name,
        amount: offers.amount,
        readyAt: offers.readyAt,
        available: offers.available,
        version: offers.version,
        merchant: { id: merchants.id, name: merchants.name, category: merchants.category },
      })
      .from(offers)
      .innerJoin(merchants, eq(offers.merchantId, merchants.id));
    const rows = category
      ? await query.where(eq(merchants.category, category as (typeof categories)[number]))
      : await query;
    return Response.json({ offers: rows });
  } catch (error) {
    return errorResponse(error);
  }
}
