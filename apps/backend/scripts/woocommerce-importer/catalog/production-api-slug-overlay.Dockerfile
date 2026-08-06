ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Minimal destination-API compatibility layer for exact WooCommerce slug
# preservation. The base must be the image currently serving production. The
# controller lets a fully trusted migration resolve inactive products by
# external_id while ordinary storefront requests remain active-only.
USER root
COPY --chown=1000:1000 apps/backend/src/api/product/content-types/product/lifecycles.ts /app/src/api/product/content-types/product/lifecycles.ts
COPY --chown=1000:1000 apps/backend/src/api/product/controllers/product.ts /app/src/api/product/controllers/product.ts
COPY --chown=1000:1000 apps/backend/src/api/wordpress-migration/services/wordpress-migration.ts /app/src/api/wordpress-migration/services/wordpress-migration.ts
COPY --chown=1000:1000 apps/backend/src/utils/operationalCommerce.ts /app/src/utils/operationalCommerce.ts
COPY --chown=1000:1000 apps/backend/src/api/product/content-types/product/schema.json /app/src/api/product/content-types/product/schema.json
COPY --chown=1000:1000 apps/backend/src/api/product/content-types/product/schema.json /app/dist/src/api/product/content-types/product/schema.json
COPY --chown=1000:1000 apps/backend/database/migrations/2026.08.05T13.00.00.scope-product-slug-uniqueness.js /app/database/migrations/2026.08.05T13.00.00.scope-product-slug-uniqueness.js
RUN node -e 'const fs=require("node:fs");const path=require("node:path");const ts=require("typescript");for(const relative of ["api/product/content-types/product/lifecycles","api/product/controllers/product","api/wordpress-migration/services/wordpress-migration","utils/operationalCommerce"]){const source=`/app/src/${relative}.ts`;const output=`/app/dist/src/${relative}.js`;const result=ts.transpileModule(fs.readFileSync(source,"utf8"),{compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,result.outputText)}'
