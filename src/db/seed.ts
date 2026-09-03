import { and, eq } from "drizzle-orm";
import { db, sqlClient } from "./client";
import { merchants, offers } from "./schema";

const seedMerchants = [
  { name: "MissionPay Cakes", category: "CAKE" as const },
  { name: "MissionPay Flowers", category: "FLOWERS" as const },
  { name: "MissionPay Veg Kitchen", category: "RESTAURANT" as const },
] as const;

const seedOffers = {
  "MissionPay Cakes": [
    { code: "C1", name: "Chocolate Cake", amount: 125000, readyAt: "2030-01-01T18:00:00+05:30", vegetarian: true, servesPeople: 4 },
    { code: "C2", name: "Red Velvet", amount: 150000, readyAt: "2030-01-01T18:30:00+05:30", vegetarian: true, servesPeople: 4 },
    { code: "C3", name: "Premium Cake", amount: 220000, readyAt: "2030-01-01T19:00:00+05:30", vegetarian: true, servesPeople: 6 },
  ],
  "MissionPay Flowers": [
    { code: "F1", name: "Roses", amount: 85000, readyAt: "2030-01-01T17:00:00+05:30", vegetarian: null, servesPeople: null },
    { code: "F2", name: "Mixed Bouquet", amount: 70000, readyAt: "2030-01-01T19:30:00+05:30", vegetarian: null, servesPeople: null },
    { code: "F3", name: "Premium Bouquet", amount: 130000, readyAt: "2030-01-01T18:00:00+05:30", vegetarian: null, servesPeople: null },
  ],
  "MissionPay Veg Kitchen": [
    { code: "R1", name: "Veg Dinner x4 — 7:30 PM", amount: 555000, readyAt: "2030-01-01T19:30:00+05:30", vegetarian: true, servesPeople: 4 },
    { code: "R2", name: "Veg Dinner x4 — 7:45 PM", amount: 520000, readyAt: "2030-01-01T19:45:00+05:30", vegetarian: true, servesPeople: 4 },
    { code: "R3", name: "Veg Dinner x4 — 8:30 PM", amount: 490000, readyAt: "2030-01-01T20:30:00+05:30", vegetarian: true, servesPeople: 4 },
  ],
} as const;

async function seed(): Promise<void> {
  for (const merchantInput of seedMerchants) {
    const [merchant] = await db
      .insert(merchants)
      .values(merchantInput)
      .onConflictDoUpdate({
        target: merchants.name,
        set: { category: merchantInput.category, isSimulated: true, updatedAt: new Date() },
      })
      .returning();

    for (const offer of seedOffers[merchantInput.name]) {
      const [matching] = await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.merchantId, merchant.id), eq(offers.name, offer.name)));
      if (matching) {
        await db
          .update(offers)
          .set({
            amount: offer.amount,
            code: offer.code,
            readyAt: new Date(offer.readyAt),
            available: true,
            vegetarian: offer.vegetarian,
            servesPeople: offer.servesPeople,
            updatedAt: new Date(),
          })
          .where(eq(offers.id, matching.id));
      } else {
        await db.insert(offers).values({
          merchantId: merchant.id,
          name: offer.name,
          code: offer.code,
          amount: offer.amount,
          readyAt: new Date(offer.readyAt),
          vegetarian: offer.vegetarian,
          servesPeople: offer.servesPeople,
        });
      }
    }
  }
}

seed()
  .then(() => console.log("MissionPay mock merchants and offers seeded."))
  .finally(() => sqlClient.end());
