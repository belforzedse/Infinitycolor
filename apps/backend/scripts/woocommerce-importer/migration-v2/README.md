# WordPress migration v2

This runner imports WordPress and WooCommerce data into the Strapi API. Its
fixtures and test suite run locally. To execute a migration, configure a source
and destination that you operate.

## Safety contract

- The WordPress clients reject every method except `GET`, `HEAD`, and `OPTIONS`
  before network access.
- WooCommerce credentials use the Authorization header and are never appended to
  a URL.
- Destination writes require both a Strapi token and a separate, random
  `MIGRATION_CONTROL_TOKEN` of at least 32 characters. The same control token must
  be present in the backend runtime environment.
- `pilot` requires `--confirm Gate1Pilot`; `full` and `resume` require
  `--confirm Gate2FullImport`.
- The runner holds one process-wide lock and writes resumable state outside Git.
- Source requests are capped by the importer at four concurrent operations and
  destination writes are capped at two.
- Reports contain source identifiers and error codes, but no names, phone
  numbers, email addresses, credentials, addresses, notes, or payment IDs.

The secret file must be owned by the executing user and have mode `0600` or
stricter. It must define:

```text
WP_USERNAME=
WP_APPLICATION_PASSWORD=
WC_CONSUMER_KEY=
WC_CONSUMER_SECRET=
STRAPI_TOKEN=
MIGRATION_CONTROL_TOKEN=
```

The default state directory is
`/var/lib/infinity-migrations/wordpress-v2`. Set `MIGRATION_STATE_DIR` to a
private mode-0700 directory owned by the runner when that location is not
writable. Set `MIGRATION_SECRETS_FILE` to the protected secret-file path.

## Gate 1 workflow

Before any destination write, create and validate fresh database and uploads
backups. Record their paths and checks in the operator log.

Run a complete read-only traversal and destination comparison:

```sh
node scripts/woocommerce-importer/migration-v2/cli.js dry-run
```

For a bounded verification pass, cap each top-level source collection. Product
variations remain complete for the sampled products so the `manage_stock`
product gate is still evaluated correctly. The bounded user cohort selects valid
Woo customers with readable wallet balances, so the same 100 users and wallets
are validated together; rejected phone and wallet candidates remain counted in
the sample metadata. The first order rows are capped literally. References to
users or products outside their bounded samples are counted as exclusions and
skipped, rather than reported as false migration failures. Sampled ledgers are
marked and are rejected as pilot inputs:

```sh
node scripts/woocommerce-importer/migration-v2/cli.js dry-run \
  --limit-per-entity 100
```

Use `runs` or `show --run RUN_ID` to inspect the protected summary without
loading credentials. A dry-run with documented quarantines can finish as
`completed-with-exceptions`; investigate every failure code before selecting a
pilot. A bounded run may feed the explicitly confirmed pilot: the pilot performs
its own read-only catalog preflight and selects real guest and registered orders
with their complete product, variation, and customer dependencies before it
writes anything.

Run only the representative candidates selected by the completed dry-run:

```sh
node scripts/woocommerce-importer/migration-v2/cli.js pilot \
  --from-run DRY_RUN_ID --confirm Gate1Pilot
node scripts/woocommerce-importer/migration-v2/cli.js reconcile \
  --from-run PILOT_RUN_ID
```

Reconciliation verifies the selected products, the existing custom size-guide
matrix, users, wallet balances, orders, and blog posts. Stop after reporting the
pilot evidence and wait for explicit Gate 2 approval.

## Gate 2 workflow

Only after the user explicitly approves Gate 2:

```sh
node scripts/woocommerce-importer/migration-v2/cli.js full \
  --confirm Gate2FullImport
```

If interrupted, resume the same protected run:

```sh
node scripts/woocommerce-importer/migration-v2/cli.js resume \
  --run RUN_ID --confirm Gate2FullImport
```

At cutover, freeze source writes, repeat the idempotent full scan to capture the
final delta, reconcile source and destination counts, and release the freeze only
after the accepted validation or a rollback decision.

## Approved mapping exceptions

- Skip an entire product when any sellable unit has `manage_stock=false`.
- Preserve the custom `product_size_guide` data and its existing destination
  component; do not invent new dimension fields.
- Keep all five global Woo attribute taxonomies distinct. Project only
  `pa_color` to legacy Color and `pa_size` to legacy Size. Product-scoped custom
  attributes remain generic.
- Preserve a Woo variation with no `pa_size` selection as size-less. The
  destination size relation is optional; do not invent a synthetic size.
- Convert wallet balances from toman to rial by an exact multiplication by ten;
  transaction history is not imported.
- Woo order totals, shipping costs, and line-item prices are already toman.
  Preserve them as exact integers without scaling; the migration API accepts
  only the explicit `totalToman`, `shippingToman`, and `unitPriceToman` fields.
- Match users by WordPress source ID, then canonical unique phone. Never match by
  email. Quarantine conflicts and do not import passwords or addresses.
- Link a guest order only when its phone identifies exactly one approved user;
  otherwise leave the user relation empty.
- Historical order addresses, order notes, private PII, and payment identifiers
  are excluded.
