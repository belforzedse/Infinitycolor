ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Destination-API layer for the legacy TeraWallet recovery. Follows the same
# shape as catalog/production-api-slug-overlay.Dockerfile: copy the .ts sources
# and transpile them into dist in-image, so the overlay tracks source rather
# than a locally built artifact.
#
#  customer-identity          — opt-in allowPhoneMerge; adopts the account that
#                               owns the phone without taking its external_id,
#                               and refuses when that account is claimed.
#  wordpress-migration        — wallets resolve via customer_identity_mappings
#                               (a merged holder keeps the owner's external_id),
#                               plus a guard against overwriting a live balance.
#  category-editorial-*       — not in the base image's dist, but required at
#                               module load by wordpress-migration; without them
#                               the service fails to require at startup.
USER root
COPY --chown=1000:1000 apps/backend/src/api/wordpress-migration/services/customer-identity.ts /app/src/api/wordpress-migration/services/customer-identity.ts
COPY --chown=1000:1000 apps/backend/src/api/wordpress-migration/services/wordpress-migration.ts /app/src/api/wordpress-migration/services/wordpress-migration.ts
COPY --chown=1000:1000 apps/backend/src/api/wordpress-migration/services/category-editorial-migration.ts /app/src/api/wordpress-migration/services/category-editorial-migration.ts
COPY --chown=1000:1000 apps/backend/src/api/product-category-content/services/category-editorial-sanitizer.ts /app/src/api/product-category-content/services/category-editorial-sanitizer.ts

# sanitize-html is present in the pnpm store but not linked into /app/node_modules,
# because nothing in the base image's dist required it until now.
RUN ln -sfn .pnpm/sanitize-html@2.13.0/node_modules/sanitize-html /app/node_modules/sanitize-html

RUN node -e 'const fs=require("node:fs");const path=require("node:path");const ts=require("typescript");for(const relative of ["api/wordpress-migration/services/customer-identity","api/wordpress-migration/services/wordpress-migration","api/wordpress-migration/services/category-editorial-migration","api/product-category-content/services/category-editorial-sanitizer"]){const source=`/app/src/${relative}.ts`;const output=`/app/dist/src/${relative}.js`;const result=ts.transpileModule(fs.readFileSync(source,"utf8"),{compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,result.outputText)}'

# Fail the build rather than ship a service that cannot load, and assert the
# merge-aware wallet resolver actually made it in.
RUN node -e 'const m=require("/app/dist/src/api/wordpress-migration/services/wordpress-migration.js");const c=require("/app/dist/src/api/wordpress-migration/services/customer-identity.js");if(typeof c.resolveUserForLegacySource!=="function")throw new Error("resolveUserForLegacySource missing");if(typeof m.upsertWallet!=="function")throw new Error("upsertWallet missing");console.log("wallet-merge-api-overlay ok")'
