import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { missionStatuses } from "@/domain/mission-state";

export const merchantCategoryEnum = pgEnum("merchant_category", [
  "CAKE",
  "FLOWERS",
  "RESTAURANT",
]);
export const missionStatusEnum = pgEnum("mission_status", missionStatuses);
export const reservationStatusEnum = pgEnum("reservation_status", [
  "ACTIVE",
  "RELEASED",
  "INVALID",
  "COMMITTED",
  "EXPIRED",
]);
export const missionItemStatusEnum = pgEnum("mission_item_status", [
  "REQUIRED",
  "RESERVED",
  "VALID",
  "INVALID",
]);
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "STARTED",
  "SUCCEEDED",
  "REJECTED",
  "FAILED",
]);
export const repairAttemptStatusEnum = pgEnum("repair_attempt_status", [
  "STARTED",
  "SUCCEEDED",
  "REJECTED",
  "FAILED",
]);
export const missionPaymentOrderStatusEnum = pgEnum("mission_payment_order_status", [
  "ACTIVE", "CAPTURED", "FAILED", "EXPIRED", "CANCELLED",
]);
export const paymentAttemptStatusEnum = pgEnum("payment_attempt_status", [
  "RECEIVED", "VERIFIED", "CAPTURED", "FAILED", "REJECTED",
]);
export const webhookProcessingStatusEnum = pgEnum("webhook_processing_status", [
  "RECEIVED", "PROCESSED", "IGNORED", "FAILED",
]);

export interface MissionConstraints {
  people?: number;
  vegetarian?: boolean;
}

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const missions = pgTable(
  "missions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goal: text("goal").notNull(),
    budgetAmount: integer("budget_amount").notNull(),
    reservedAmount: integer("reserved_amount").notNull().default(0),
    committedAmount: integer("committed_amount").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    constraints: jsonb("constraints").$type<MissionConstraints>().notNull().default({}),
    status: missionStatusEnum("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    check("missions_budget_positive", sql`${table.budgetAmount} > 0`),
    check("missions_reserved_nonnegative", sql`${table.reservedAmount} >= 0`),
    check("missions_committed_nonnegative", sql`${table.committedAmount} >= 0`),
    check(
      "missions_authority_within_budget",
      sql`${table.reservedAmount} + ${table.committedAmount} <= ${table.budgetAmount}`,
    ),
    check("missions_version_positive", sql`${table.version} > 0`),
  ],
);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    category: merchantCategoryEnum("category").notNull(),
    isSimulated: boolean("is_simulated").notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("merchants_name_uidx").on(table.name)],
);

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
    code: varchar("code", { length: 8 }),
    name: text("name").notNull(),
    description: text("description"),
    vegetarian: boolean("vegetarian"),
    servesPeople: integer("serves_people"),
    amount: integer("amount").notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull(),
    available: boolean("available").notNull().default(true),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("offers_merchant_id_idx").on(table.merchantId),
    uniqueIndex("offers_merchant_name_uidx").on(table.merchantId, table.name),
    uniqueIndex("offers_code_uidx").on(table.code),
    check("offers_amount_positive", sql`${table.amount} > 0`),
    check("offers_version_positive", sql`${table.version} > 0`),
    check(
      "offers_serves_people_positive",
      sql`${table.servesPeople} IS NULL OR ${table.servesPeople} > 0`,
    ),
  ],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    offerId: uuid("offer_id").notNull().references(() => offers.id),
    merchantId: uuid("merchant_id").references(() => merchants.id),
    amount: integer("amount").notNull(),
    offerVersion: integer("offer_version"),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    offerAvailable: boolean("offer_available"),
    offerVegetarian: boolean("offer_vegetarian"),
    offerServesPeople: integer("offer_serves_people"),
    status: reservationStatusEnum("status").notNull().default("ACTIVE"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("reservations_mission_id_idx").on(table.missionId),
    index("reservations_offer_id_idx").on(table.offerId),
    check("reservations_amount_positive", sql`${table.amount} > 0`),
    check("reservations_version_positive", sql`${table.version} > 0`),
    check(
      "reservations_offer_version_positive",
      sql`${table.offerVersion} IS NULL OR ${table.offerVersion} > 0`,
    ),
    check(
      "reservations_offer_serves_people_positive",
      sql`${table.offerServesPeople} IS NULL OR ${table.offerServesPeople} > 0`,
    ),
  ],
);

export const missionItems = pgTable(
  "mission_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    category: merchantCategoryEnum("category").notNull(),
    required: boolean("required").notNull().default(true),
    reservationId: uuid("reservation_id").references(() => reservations.id),
    status: missionItemStatusEnum("status").notNull().default("REQUIRED"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mission_items_mission_category_uidx").on(table.missionId, table.category),
  ],
);

export const missionEvents = pgTable(
  "mission_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    type: text("type").notNull(),
    missionVersion: integer("mission_version").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mission_events_mission_id_idx").on(table.missionId)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    missionVersion: integer("mission_version").notNull(),
    requestKey: text("request_key"),
    plannerId: text("planner_id").notNull(),
    modelId: text("model_id"),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
    rawOutput: jsonb("raw_output").$type<Record<string, unknown>>(),
    validatedProposal: jsonb("validated_proposal").$type<Record<string, unknown>>(),
    status: agentRunStatusEnum("status").notNull().default("STARTED"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_runs_mission_id_idx").on(table.missionId),
    uniqueIndex("agent_runs_mission_request_key_uidx").on(table.missionId, table.requestKey),
    check("agent_runs_mission_version_positive", sql`${table.missionVersion} > 0`),
  ],
);

export const missionRepairAttempts = pgTable(
  "mission_repair_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    startingVersion: integer("starting_version").notNull(),
    requestKey: text("request_key"),
    plannerId: text("planner_id").notNull(),
    modelId: text("model_id"),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
    rawProposal: jsonb("raw_proposal").$type<Record<string, unknown>>(),
    validatedRepair: jsonb("validated_repair").$type<Record<string, unknown>>(),
    preservedReservationIds: jsonb("preserved_reservation_ids").$type<string[]>().notNull().default([]),
    releasedReservationIds: jsonb("released_reservation_ids").$type<string[]>().notNull().default([]),
    replacementReservationIds: jsonb("replacement_reservation_ids").$type<string[]>().notNull().default([]),
    previousReservedAmount: integer("previous_reserved_amount").notNull(),
    finalReservedAmount: integer("final_reserved_amount"),
    status: repairAttemptStatusEnum("status").notNull().default("STARTED"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("mission_repair_attempts_mission_id_idx").on(table.missionId),
    uniqueIndex("mission_repair_attempts_mission_request_key_uidx").on(
      table.missionId,
      table.requestKey,
    ),
    check("mission_repair_attempts_starting_version_positive", sql`${table.startingVersion} > 0`),
  ],
);

export const missionPaymentOrders = pgTable(
  "mission_payment_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    missionVersion: integer("mission_version").notNull(),
    amount: integer("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    provider: text("provider").notNull().default("razorpay"),
    providerOrderId: text("provider_order_id").unique(),
    idempotencyKey: text("idempotency_key"),
    status: missionPaymentOrderStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mission_payment_orders_mission_id_idx").on(table.missionId),
    uniqueIndex("mission_payment_orders_mission_version_uidx").on(table.missionId, table.missionVersion),
    uniqueIndex("mission_payment_orders_mission_request_key_uidx").on(table.missionId, table.idempotencyKey),
    check("mission_payment_orders_amount_positive", sql`${table.amount} > 0`),
    check("mission_payment_orders_version_positive", sql`${table.missionVersion} > 0`),
  ],
);

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    missionPaymentOrderId: uuid("mission_payment_order_id").notNull().references(() => missionPaymentOrders.id),
    providerPaymentId: text("provider_payment_id"),
    providerOrderId: text("provider_order_id").notNull(),
    callbackVerified: boolean("callback_verified").notNull().default(false),
    providerStatus: text("provider_status"),
    amount: integer("amount").notNull(),
    status: paymentAttemptStatusEnum("status").notNull().default("RECEIVED"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payment_attempts_mission_id_idx").on(table.missionId),
    uniqueIndex("payment_attempts_provider_payment_uidx").on(table.providerPaymentId),
    check("payment_attempts_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const razorpayWebhookEvents = pgTable(
  "razorpay_webhook_events",
  {
    providerEventId: text("provider_event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    processingStatus: webhookProcessingStatusEnum("processing_status").notNull().default("RECEIVED"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const continuityMissions = pgTable("continuity_missions", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id),
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  marketMode: text("market_mode").notNull(),
  outcomeStatus: text("outcome_status").notNull().default("PLANNED"),
  repairAllowancePaise: integer("repair_allowance_paise").notNull().default(0),
  allowAutomaticSubstitution: boolean("allow_automatic_substitution").notNull().default(true),
  ...timestamps,
}, (table) => [
  check("continuity_repair_allowance_nonnegative", sql`${table.repairAllowancePaise} >= 0`),
  check("continuity_market_mode_valid", sql`${table.marketMode} IN ('live', 'sandbox')`),
]);

export const marketSearches = pgTable("market_searches", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  needId: text("need_id").notNull(),
  connectorId: text("connector_id").notNull(),
  query: text("query").notNull(),
  status: text("status").notNull(),
  resultCount: integer("result_count").notNull().default(0),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("market_searches_mission_idx").on(table.missionId)]);

export const marketOfferSnapshots = pgTable("market_offer_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  needId: text("need_id").notNull(),
  sourceProvider: text("source_provider").notNull(),
  externalId: text("external_id"),
  sourceUrl: text("source_url"),
  merchantName: text("merchant_name").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  pricePaise: integer("price_paise").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),
  availability: text("availability").notNull(),
  attributes: jsonb("attributes_json").$type<Record<string, unknown>>().notNull().default({}),
  reversibility: jsonb("reversibility_json").$type<Record<string, unknown>>(),
  evidence: jsonb("evidence_json").$type<Record<string, unknown>>(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  sourceVersion: text("source_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("market_offer_snapshots_mission_need_idx").on(table.missionId, table.needId),
  check("market_offer_snapshots_price_positive", sql`${table.pricePaise} > 0`),
]);

export const continuitySelections = pgTable("continuity_selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  needId: text("need_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull().references(() => marketOfferSnapshots.id),
  status: text("status").notNull().default("SELECTED"),
  reservedPricePaise: integer("reserved_price_paise").notNull(),
  replacedSelectionId: uuid("replaced_selection_id"),
  ...timestamps,
}, (table) => [
  index("continuity_selections_mission_idx").on(table.missionId),
  check("continuity_selection_price_positive", sql`${table.reservedPricePaise} > 0`),
]);

export const missionOutcomeEvents = pgTable("mission_outcome_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  needId: text("need_id"),
  type: text("type").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("mission_outcome_events_mission_idx").on(table.missionId)]);

export const missionRelations = relations(missions, ({ many }) => ({
  items: many(missionItems),
  reservations: many(reservations),
  events: many(missionEvents),
  agentRuns: many(agentRuns),
  repairAttempts: many(missionRepairAttempts),
  paymentOrders: many(missionPaymentOrders),
  paymentAttempts: many(paymentAttempts),
}));
export const agentRunRelations = relations(agentRuns, ({ one }) => ({
  mission: one(missions, { fields: [agentRuns.missionId], references: [missions.id] }),
}));
export const repairAttemptRelations = relations(missionRepairAttempts, ({ one }) => ({
  mission: one(missions, {
    fields: [missionRepairAttempts.missionId],
    references: [missions.id],
  }),
}));
export const missionPaymentOrderRelations = relations(missionPaymentOrders, ({ one, many }) => ({
  mission: one(missions, { fields: [missionPaymentOrders.missionId], references: [missions.id] }),
  attempts: many(paymentAttempts),
}));
export const paymentAttemptRelations = relations(paymentAttempts, ({ one }) => ({
  mission: one(missions, { fields: [paymentAttempts.missionId], references: [missions.id] }),
  paymentOrder: one(missionPaymentOrders, { fields: [paymentAttempts.missionPaymentOrderId], references: [missionPaymentOrders.id] }),
}));

export const merchantRelations = relations(merchants, ({ many }) => ({ offers: many(offers) }));
export const offerRelations = relations(offers, ({ one, many }) => ({
  merchant: one(merchants, { fields: [offers.merchantId], references: [merchants.id] }),
  reservations: many(reservations),
}));
export const reservationRelations = relations(reservations, ({ one }) => ({
  mission: one(missions, { fields: [reservations.missionId], references: [missions.id] }),
  offer: one(offers, { fields: [reservations.offerId], references: [offers.id] }),
}));
export const missionItemRelations = relations(missionItems, ({ one }) => ({
  mission: one(missions, { fields: [missionItems.missionId], references: [missions.id] }),
  reservation: one(reservations, {
    fields: [missionItems.reservationId],
    references: [reservations.id],
  }),
}));
