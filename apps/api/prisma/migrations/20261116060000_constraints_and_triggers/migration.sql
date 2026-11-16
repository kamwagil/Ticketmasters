-- Hand-written integrity rules that Prisma's schema language cannot express.

-- ── Inventory: the database itself refuses to oversell ──────────────────────
ALTER TABLE "ticket_inventory"
  ADD CONSTRAINT "ticket_inventory_non_negative" CHECK ("total" >= 0 AND "sold" >= 0 AND "reserved" >= 0),
  ADD CONSTRAINT "ticket_inventory_no_oversell" CHECK ("sold" + "reserved" <= "total");

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_qty_positive" CHECK ("quantity" > 0);

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_qty_positive" CHECK ("quantity" > 0);

ALTER TABLE "ticket_categories"
  ADD CONSTRAINT "ticket_categories_price_non_negative" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "ticket_categories_purchase_limits" CHECK ("minPerOrder" >= 1 AND "maxPerOrder" >= "minPerOrder");

-- ── Orders / money sanity ───────────────────────────────────────────────────
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_non_negative" CHECK (
    "subtotalMinor" >= 0 AND "feesMinor" >= 0 AND "taxMinor" >= 0 AND "discountMinor" >= 0 AND "totalMinor" >= 0
  ),
  ADD CONSTRAINT "orders_total_consistent" CHECK ("totalMinor" = "subtotalMinor" + "feesMinor" + "taxMinor" - "discountMinor"),
  ADD CONSTRAINT "orders_refund_within_total" CHECK ("refundedMinor" >= 0 AND "refundedMinor" <= "totalMinor");

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_qty_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_line_total" CHECK ("lineTotalMinor" = "unitPriceMinor" * "quantity");

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "financial_ledger_entries" ADD CONSTRAINT "ledger_amount_positive" CHECK ("amountMinor" > 0);

-- One successful payment per order: a retried or duplicated capture cannot double-pay an order.
CREATE UNIQUE INDEX "payments_one_success_per_order" ON "payments" ("orderId") WHERE "status" = 'SUCCEEDED';

-- ── Customer identity: a verified email/phone belongs to exactly one central customer ──
CREATE UNIQUE INDEX "customer_identities_verified_unique"
  ON "customer_identities" ("type", "value") WHERE "verifiedAt" IS NOT NULL;

-- ── Brand domains: only one primary per brand ───────────────────────────────
CREATE UNIQUE INDEX "brand_domains_one_primary" ON "brand_domains" ("brandId") WHERE "isPrimary";
CREATE UNIQUE INDEX "brand_legal_entity_one_default" ON "brand_legal_entity_assignments" ("brandId") WHERE "isDefault";

-- ── One live QR token per ticket ────────────────────────────────────────────
CREATE UNIQUE INDEX "ticket_qr_tokens_one_active" ON "ticket_qr_tokens" ("ticketId") WHERE "active";

-- ── Search helpers ──────────────────────────────────────────────────────────
CREATE INDEX "events_name_search" ON "events" USING gin (to_tsvector('simple', "name" || ' ' || "description"));
CREATE INDEX "orders_customer_email_lower" ON "orders" (lower("customerEmail"));

-- ── Financial ledger: append-only ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ctp_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: financial and audit records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON "financial_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ctp_forbid_mutation();

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ctp_forbid_mutation();

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION ctp_forbid_mutation();

CREATE TRIGGER inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION ctp_forbid_mutation();

CREATE TRIGGER marketing_consents_immutable
  BEFORE UPDATE ON "marketing_consents"
  FOR EACH ROW EXECUTE FUNCTION ctp_forbid_mutation();

-- ── Financial ledger: every journal must balance per currency at COMMIT ─────
CREATE OR REPLACE FUNCTION ctp_ledger_balanced() RETURNS trigger AS $$
DECLARE
  bad RECORD;
BEGIN
  SELECT "currency",
         SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END) AS diff
    INTO bad
    FROM "financial_ledger_entries"
   WHERE "transactionId" = NEW."transactionId"
   GROUP BY "currency"
  HAVING SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced in % by % minor units', NEW."transactionId", bad."currency", bad.diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER financial_ledger_entries_balanced
  AFTER INSERT ON "financial_ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ctp_ledger_balanced();
