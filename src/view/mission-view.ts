import "server-only";

import { desc, eq } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import {
  agentRuns,
  merchants,
  missionEvents,
  missionItems,
  missionRepairAttempts,
  missions,
  offers,
  reservations,
  missionPaymentOrders,
  paymentAttempts,
} from "@/db/schema";
import type { MissionStatus } from "@/domain/mission-state";
import { isDemoMutationEnabled } from "@/demo/demo-safety";
import { isMissionPaymentFrozen } from "@/payments/payment-freeze";

export type MissionView = Awaited<ReturnType<MissionViewService["get"]>>;

export interface MissionViewInput {
  mission: typeof missions.$inferSelect;
  items: Array<typeof missionItems.$inferSelect>;
  reservations: Array<{
    id: string;
    offerId: string;
    status: typeof reservations.$inferSelect.status;
    reservedAmount: number;
    snapshotReadyAt: Date | null;
    snapshotVegetarian: boolean | null;
    snapshotServesPeople: number | null;
    offerCode: string | null;
    offerName: string;
    currentAmount: number;
    currentReadyAt: Date;
    currentAvailable: boolean;
    currentVersion: number;
    currentVegetarian: boolean | null;
    currentServesPeople: number | null;
    merchantName: string;
    category: "CAKE" | "FLOWERS" | "RESTAURANT";
  }>;
  events: Array<typeof missionEvents.$inferSelect>;
  latestPlan: typeof agentRuns.$inferSelect | null;
  latestRepair: typeof missionRepairAttempts.$inferSelect | null;
  demoMutationsEnabled: boolean;
  payment?: { order: typeof missionPaymentOrders.$inferSelect | null; attempt: typeof paymentAttempts.$inferSelect | null };
}

const categoryLabels = { CAKE: "Cake", FLOWERS: "Flowers", RESTAURANT: "Dinner" } as const;

export function formatInr(amountPaise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: amountPaise % 100 === 0 ? 0 : 2,
  }).format(amountPaise / 100);
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventMessage(type: string, data: Record<string, unknown>): string {
  const messages: Record<string, string> = {
    MISSION_CREATED: "Mission created with bounded authority.",
    MISSION_PLANNING_STARTED: "AI planning started.",
    PLAN_PROPOSED: "A structured plan was proposed.",
    MISSION_RESERVING: "MissionPay began reserving merchant authority.",
    OFFER_RESERVED: "Merchant offer reserved.",
    MISSION_READY_TO_COMMIT: "The whole mission is feasible.",
    OFFER_PRICE_CHANGED: "Restaurant terms changed in the market.",
    RESERVATION_INVALIDATED: "A reservation no longer matches its snapshot.",
    MISSION_INVALIDATED: "Commit authority was blocked.",
    MISSION_REPAIR_STARTED: "Minimal repair started.",
    REPAIR_PLAN_PROPOSED: "A lowest-change repair was proposed.",
    REPAIR_PRESERVED_RESERVATION: "A valid reservation was preserved.",
    REPAIR_RELEASED_RESERVATION: "The broken reservation was released.",
    REPAIR_REPLACEMENT_RESERVED: "Replacement authority was reserved.",
    MISSION_REPAIR_SUCCEEDED: "Mission repair succeeded.",
  };
  if (type === "OFFER_PRICE_CHANGED") {
    const oldPrice = typeof data.oldPrice === "number" ? formatInr(data.oldPrice) : "the old price";
    const newPrice = typeof data.newPrice === "number" ? formatInr(data.newPrice) : "a new price";
    return `Restaurant price changed from ${oldPrice} to ${newPrice}.`;
  }
  return messages[type] ?? type.toLowerCase().replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

function statusCopy(status: MissionStatus): string {
  return {
    DRAFT: "Ready for AI planning.",
    PLANNING: "AI is constructing a feasible mission.",
    PROPOSED: "The structured plan is ready for validation.",
    RESERVING: "MissionPay is reserving authority.",
    READY_TO_COMMIT: "Entire mission is feasible. No money has moved.",
    INVALIDATED: "World state changed. Payment authority is blocked.",
    REPLANNING: "Repairing the smallest broken part.",
    PAYMENT_PENDING: "Payment is pending.",
    PAID: "Payment completed.",
    DISTRIBUTING: "Distribution is in progress.",
    COMPLETED: "Mission completed.",
    PAYMENT_FAILED: "Payment failed safely.",
    CANCELLED: "Mission cancelled.",
  }[status];
}

export function buildMissionView(input: MissionViewInput) {
  const { mission } = input;
  const remainingAmount = mission.budgetAmount - mission.reservedAmount - mission.committedAmount;
  const itemByReservation = new Map(input.items.map((item) => [item.reservationId, item]));
  const viewReservations = input.reservations.map((reservation) => ({
    id: reservation.id,
    offerId: reservation.offerId,
    offerCode: reservation.offerCode,
    offerName: reservation.offerName,
    merchantName: reservation.merchantName,
    category: reservation.category,
    categoryLabel: categoryLabels[reservation.category],
    status: reservation.status === "ACTIVE" ? "HELD" as const : reservation.status,
    reservedAmount: reservation.reservedAmount,
    reservedDisplay: formatInr(reservation.reservedAmount),
    currentAmount: reservation.currentAmount,
    currentDisplay: formatInr(reservation.currentAmount),
    priceDeltaAmount: reservation.currentAmount - reservation.reservedAmount,
    readyAt: reservation.currentReadyAt.toISOString(),
    readyTimeDisplay: new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(reservation.currentReadyAt),
    available: reservation.currentAvailable,
    offerVersion: reservation.currentVersion,
    vegetarian: reservation.currentVegetarian,
    servesPeople: reservation.currentServesPeople,
    isCurrent: itemByReservation.has(reservation.id),
  }));
  const currentReservations = viewReservations.filter((reservation) => reservation.isCurrent);
  const potentialAmount = currentReservations.reduce((sum, reservation) => sum + reservation.currentAmount, 0);
  const restaurant = currentReservations.find((reservation) => reservation.category === "RESTAURANT");
  const requiredCategories = input.items.filter((item) => item.required).map((item) => item.category);
  const allReadyByDeadline = currentReservations.length === requiredCategories.length && currentReservations.every(
    (reservation) => new Date(reservation.readyAt) <= mission.deadline,
  );
  const latestPlanData = safeRecord(input.latestPlan?.validatedProposal);
  const selectedOffers = Array.isArray(latestPlanData?.selectedOffers) ? latestPlanData.selectedOffers : [];
  const reasonByOffer = new Map(
    selectedOffers.flatMap((selection) => {
      const record = safeRecord(selection);
      return record && typeof record.offerId === "string" && typeof record.reason === "string"
        ? [[record.offerId, record.reason] as const]
        : [];
    }),
  );
  const latestRepairData = safeRecord(input.latestRepair?.validatedRepair);
  const broken = currentReservations.filter((reservation) => reservation.status === "INVALID");
  const changedItems = typeof latestRepairData?.changedItemCount === "number" ? latestRepairData.changedItemCount : 0;
  const planFailed = input.latestPlan?.status === "FAILED" || input.latestPlan?.status === "REJECTED";
  const repairFailed = input.latestRepair?.status === "FAILED" || input.latestRepair?.status === "REJECTED";
  const operationErrorCode = repairFailed ? input.latestRepair?.errorCode : planFailed ? input.latestPlan?.errorCode : null;
  const paymentOrder = input.payment?.order ?? null;
  const paymentAttempt = input.payment?.attempt ?? null;

  return {
    mission: {
      id: mission.id,
      goal: mission.goal,
      title: mission.goal.toLowerCase().includes("birthday") ? "Birthday Evening" : "Authorized Mission",
      status: mission.status,
      statusCopy: statusCopy(mission.status),
      version: mission.version,
      deadline: mission.deadline.toISOString(),
      isProcessing: ["PLANNING", "PROPOSED", "RESERVING", "REPLANNING"].includes(mission.status) && !planFailed && !repairFailed,
    },
    financialAuthority: {
      authorized: { amountPaise: mission.budgetAmount, display: formatInr(mission.budgetAmount) },
      reserved: { amountPaise: mission.reservedAmount, display: formatInr(mission.reservedAmount) },
      remaining: { amountPaise: remainingAmount, display: formatInr(remainingAmount) },
      committed: { amountPaise: mission.committedAmount, display: formatInr(mission.committedAmount) },
      potential: { amountPaise: potentialAmount, display: formatInr(potentialAmount) },
      overAuthority: { amountPaise: Math.max(0, potentialAmount - mission.budgetAmount), display: formatInr(Math.max(0, potentialAmount - mission.budgetAmount)) },
    },
    constraints: [
      ...requiredCategories.map((category) => ({
        key: category.toLowerCase(),
        label: `${categoryLabels[category]} required`,
        satisfied: currentReservations.some((reservation) => reservation.category === category && reservation.status === "HELD"),
      })),
      ...(mission.constraints.vegetarian ? [{ key: "vegetarian", label: "Vegetarian dinner", satisfied: restaurant?.vegetarian === true }] : []),
      ...(mission.constraints.people ? [{ key: "people", label: `Serves ${mission.constraints.people}`, satisfied: (restaurant?.servesPeople ?? 0) >= mission.constraints.people }] : []),
      { key: "deadline", label: `Ready before ${new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(mission.deadline)}`, satisfied: allReadyByDeadline },
      { key: "budget", label: `Total ≤ ${formatInr(mission.budgetAmount)}`, satisfied: potentialAmount <= mission.budgetAmount },
    ],
    items: requiredCategories.map((category) => ({
      category,
      label: categoryLabels[category],
      reservation: currentReservations.find((reservation) => reservation.category === category) ?? null,
    })),
    reservations: viewReservations,
    worldChange: broken.length > 0 ? {
      title: "World state changed",
      message: `${broken[0].categoryLabel} price increased by ${formatInr(broken[0].priceDeltaAmount)}. This mission can no longer be committed safely.`,
    } : null,
    operationIssue: operationErrorCode ? {
      code: operationErrorCode,
      message: operationErrorCode === "PLANNER_CONFIGURATION_MISSING"
        ? "The planner is not configured. Mission authority remains unchanged."
        : "The operation stopped safely. Refresh persisted state before retrying.",
    } : null,
    latestPlan: input.latestPlan ? {
      status: input.latestPlan.status,
      plannerId: input.latestPlan.plannerId,
      rationale: typeof latestPlanData?.rationale === "string" ? latestPlanData.rationale : null,
      reasons: currentReservations.flatMap((reservation) => {
        const reason = reasonByOffer.get(reservation.offerId);
        return reason ? [{ category: reservation.categoryLabel, reason }] : [];
      }),
    } : null,
    latestRepair: input.latestRepair ? {
      status: input.latestRepair.status,
      rationale: typeof latestRepairData?.rationale === "string" ? latestRepairData.rationale : null,
      changedItems,
      preservedReservationIds: input.latestRepair.preservedReservationIds,
      releasedReservationIds: input.latestRepair.releasedReservationIds,
      replacementReservationIds: input.latestRepair.replacementReservationIds,
    } : null,
    timeline: input.events.map((event) => ({
      id: event.id,
      type: event.type,
      missionVersion: event.missionVersion,
      at: event.createdAt.toISOString(),
      message: eventMessage(event.type, event.data),
    })),
    availableActions: {
      canPlan: mission.status === "DRAFT",
      canRepair: mission.status === "INVALIDATED",
      canSimulateMarketChange: input.demoMutationsEnabled && !isMissionPaymentFrozen(mission) && mission.status === "READY_TO_COMMIT" && currentReservations.some((reservation) => reservation.offerCode === "R1"),
      canResetDemo: input.demoMutationsEnabled,
      canProceedToPayment: mission.status === "READY_TO_COMMIT" && mission.committedAmount === 0 && Boolean(process.env.RAZORPAY_KEY_ID),
      canRetryPayment: mission.status === "PAYMENT_FAILED",
    },
    payment: paymentOrder ? {
      status: paymentOrder.status,
      paymentOrderId: paymentOrder.id,
      providerOrderId: paymentOrder.providerOrderId,
      amount: { amountPaise: paymentOrder.amount, display: formatInr(paymentOrder.amount) },
      currency: paymentOrder.currency,
      providerPaymentId: paymentAttempt?.providerPaymentId ?? null,
      providerStatus: paymentAttempt?.providerStatus ?? null,
    } : null,
  };
}

export class MissionViewService {
  constructor(private readonly database: Database = db) {}

  async get(missionId: string) {
    const [mission] = await this.database.select().from(missions).where(eq(missions.id, missionId));
    if (!mission) return null;
    const [items, reservationRows, events, [latestPlan], [latestRepair], [latestPaymentOrder], [latestPaymentAttempt]] = await Promise.all([
      this.database.select().from(missionItems).where(eq(missionItems.missionId, missionId)),
      this.database.select({
        id: reservations.id, offerId: reservations.offerId, status: reservations.status,
        reservedAmount: reservations.amount, snapshotReadyAt: reservations.readyAt,
        snapshotVegetarian: reservations.offerVegetarian, snapshotServesPeople: reservations.offerServesPeople,
        offerCode: offers.code, offerName: offers.name, currentAmount: offers.amount,
        currentReadyAt: offers.readyAt, currentAvailable: offers.available,
        currentVersion: offers.version, currentVegetarian: offers.vegetarian,
        currentServesPeople: offers.servesPeople, merchantName: merchants.name, category: merchants.category,
      }).from(reservations).innerJoin(offers, eq(reservations.offerId, offers.id))
        .innerJoin(merchants, eq(offers.merchantId, merchants.id)).where(eq(reservations.missionId, missionId)),
      this.database.select().from(missionEvents).where(eq(missionEvents.missionId, missionId)).orderBy(missionEvents.createdAt),
      this.database.select().from(agentRuns).where(eq(agentRuns.missionId, missionId)).orderBy(desc(agentRuns.startedAt)).limit(1),
      this.database.select().from(missionRepairAttempts).where(eq(missionRepairAttempts.missionId, missionId)).orderBy(desc(missionRepairAttempts.startedAt)).limit(1),
      this.database.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.missionId, missionId)).orderBy(desc(missionPaymentOrders.createdAt)).limit(1),
      this.database.select().from(paymentAttempts).where(eq(paymentAttempts.missionId, missionId)).orderBy(desc(paymentAttempts.createdAt)).limit(1),
    ]);
    return buildMissionView({ mission, items, reservations: reservationRows, events, latestPlan: latestPlan ?? null, latestRepair: latestRepair ?? null, demoMutationsEnabled: isDemoMutationEnabled(), payment: { order: latestPaymentOrder ?? null, attempt: latestPaymentAttempt ?? null } });
  }
}

export const missionViewService = new MissionViewService();
