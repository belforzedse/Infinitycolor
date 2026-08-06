ARG BASE_IMAGE=infinity-importer-opt:aa295435-20260804-v5
FROM ${BASE_IMAGE}

# Rebuild only the reviewed importer surface on top of the already validated
# Node 20 Alpine image. Deliberately exclude legacy import-tracking JSON, logs,
# generated reports and unrelated backend/admin files from the image layer.
USER root
COPY --chown=1000:1000 apps/backend/scripts/woocommerce-importer/catalog /app/scripts/woocommerce-importer/catalog
COPY --chown=1000:1000 apps/backend/scripts/woocommerce-importer/migration-v2 /app/scripts/woocommerce-importer/migration-v2
COPY --chown=1000:1000 apps/backend/scripts/woocommerce-importer/utils/ImageUploader.js /app/scripts/woocommerce-importer/utils/ImageUploader.js
COPY --chown=1000:1000 apps/backend/scripts/woocommerce-importer/catalog-convert.js /app/scripts/woocommerce-importer/catalog-convert.js
COPY --chown=1000:1000 apps/backend/scripts/woocommerce-importer/catalog-exception-audit.js /app/scripts/woocommerce-importer/catalog-exception-audit.js
COPY --chown=1000:1000 apps/backend/scripts/woocommerce-importer/catalog-media-recover.js /app/scripts/woocommerce-importer/catalog-media-recover.js

# Preserve Woo product slugs exactly. Include the committed trusted-migration
# product lookup so inactive rows are found by external_id and updated instead
# of being recreated. Compile only these reviewed TypeScript files against the
# base image's source tree.
COPY --chown=1000:1000 apps/backend/src/api/product/content-types/product/lifecycles.ts /app/src/api/product/content-types/product/lifecycles.ts
COPY --chown=1000:1000 apps/backend/src/api/product/controllers/product.ts /app/src/api/product/controllers/product.ts
COPY --chown=1000:1000 apps/backend/src/api/wordpress-migration/services/wordpress-migration.ts /app/src/api/wordpress-migration/services/wordpress-migration.ts
COPY --chown=1000:1000 apps/backend/src/utils/operationalCommerce.ts /app/src/utils/operationalCommerce.ts
COPY --chown=1000:1000 apps/backend/src/api/product/content-types/product/schema.json /app/src/api/product/content-types/product/schema.json
COPY --chown=1000:1000 apps/backend/src/api/product/content-types/product/schema.json /app/dist/src/api/product/content-types/product/schema.json
COPY --chown=1000:1000 apps/backend/database/migrations/2026.08.05T13.00.00.scope-product-slug-uniqueness.js /app/database/migrations/2026.08.05T13.00.00.scope-product-slug-uniqueness.js
RUN node -e 'const fs=require("node:fs");const path=require("node:path");const ts=require("typescript");for(const relative of ["api/product/content-types/product/lifecycles","api/product/controllers/product","api/wordpress-migration/services/wordpress-migration","utils/operationalCommerce"]){const source=`/app/src/${relative}.ts`;const output=`/app/dist/src/${relative}.js`;const result=ts.transpileModule(fs.readFileSync(source,"utf8"),{compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,result.outputText)}'
