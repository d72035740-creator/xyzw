import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "./mission-state";

describe("mission state machine", () => {
  it("permits the normal payment lifecycle", () => {
    expect(canTransition("DRAFT", "PLANNING")).toBe(true);
    expect(canTransition("RESERVING", "READY_TO_COMMIT")).toBe(true);
    expect(canTransition("READY_TO_COMMIT", "PAYMENT_PENDING")).toBe(true);
  });

  it("permits only the explicit initial planning sequence", () => {
    expect(canTransition("DRAFT", "PLANNING")).toBe(true);
    expect(canTransition("PLANNING", "PROPOSED")).toBe(true);
    expect(canTransition("PROPOSED", "RESERVING")).toBe(true);
    expect(canTransition("RESERVING", "READY_TO_COMMIT")).toBe(true);
  });

  it("rejects arbitrary state jumps", () => {
    expect(() => assertTransition("DRAFT", "PAID")).toThrow(
      "INVALID_STATE_TRANSITION: DRAFT -> PAID",
    );
    expect(canTransition("COMPLETED", "PLANNING")).toBe(false);
    expect(canTransition("DRAFT", "READY_TO_COMMIT")).toBe(false);
    expect(canTransition("PLANNING", "READY_TO_COMMIT")).toBe(false);
  });
});
