import type { ContinuityService } from "@/continuity/continuity-service";
import type { MissionPaymentService } from "./mission-payment-service";

export class PaymentOrderCoordinator {
  constructor(private readonly payments: MissionPaymentService, private readonly continuity: ContinuityService) {}

  async createOrder(input: { missionId: string; expectedVersion: number; requestKey?: string }) {
    const preparation = await this.continuity.prepareForPayment(input.missionId, input.expectedVersion);
    console.info("PAYMENT_PREPARATION", { clientVersion: input.expectedVersion, serverVersionAfterRevalidation: preparation.missionVersion, versionUsedForOrderCreation: preparation.missionVersion, marketRevalidated: preparation.marketRevalidated });
    const order = await this.payments.createOrder({ ...input, expectedVersion: preparation.missionVersion });
    return { ...order, marketRevalidated: preparation.marketRevalidated, view: await this.continuity.getWithRepairs(input.missionId) };
  }
}
