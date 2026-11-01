# Product variation migration

The migration is additive and idempotent. It adds a single `legacy-default`
variation to products that do not already have a non-empty `variations` array.
Stock is the sum of non-archived batches marked `Available`; when a product has
no batch documents, its existing product-level stock is used. The existing
product price and unit are retained. Products without a valid price are
reported and left unchanged.

The script does not delete or modify `productBatches`, `harvestRecords`,
historical orders, reviews, or cart documents. Existing order and review
snapshots remain available for history.

## Rollout

1. Back up the Firestore database and pause product edits and new checkout
   creation while migrating.
2. Resolve or cancel any in-flight orders created by the batch-based client.
   Buyers with a legacy cart should remove and re-add those items after upgrade
   so they can select a variation.
3. From `FarmGate-Backend`, run `npm run migrate:product-variations` to inspect
   the dry-run output. It does not write data.
4. Review the stock and price summary, then run
   `npm run migrate:product-variations -- --apply`.
5. Deploy the variation-aware backend, Firestore rules, and mobile client.
   Keep the legacy batch collections intact and read-only until historical
   retention and reporting requirements are met.
6. Confirm farmers can edit variation stock and buyers can place orders for
   each variation before reopening checkout.

The backend rechecks the selected variation and aggregate requested quantity
when an order is created, accepted, or paid. Inventory is deducted or restored
inside Firestore transactions, and the walk-in sale endpoint uses the same
variation-level stock protection.
