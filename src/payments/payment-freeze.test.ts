import { describe, expect, it } from "vitest";
import { isMissionPaymentFrozen } from "./payment-freeze";

describe("isMissionPaymentFrozen", () => {
  it("freezes only the exact PAYMENT_PENDING mission", () => {
    expect(isMissionPaymentFrozen({ status: "PAYMENT_PENDING" })).toBe(true);
    expect(isMissionPaymentFrozen({ status: "READY_TO_COMMIT" })).toBe(false);
    expect(isMissionPaymentFrozen({ status: "PAYMENT_FAILED" })).toBe(false);
    expect(isMissionPaymentFrozen({ status: "PAID" })).toBe(false);
  });
});
