-- Reservations created before Milestone 4 already have immutable price/version/readiness
-- snapshots. Backfill the two newly explicit semantic fields from the offer terms that
-- were current when this additive migration was deployed. Future reservations write
-- these values transactionally at reservation time.
UPDATE "reservations" AS reservation
SET
  "offer_vegetarian" = offer."vegetarian",
  "offer_serves_people" = offer."serves_people"
FROM "offers" AS offer
WHERE reservation."offer_id" = offer."id";
