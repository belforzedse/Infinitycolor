import { CatalogEditError } from "../../utils/catalogEdit";
import sharp from "sharp";
import { PRODUCT_MEDIA_REFERENCES, rowsFromRaw } from "../../api/admin-media-library/lib/media-library-query";

/** Cover content API, native admin and folder/bulk media operations alike. */
export default (plugin: any) => {
  // Release image-processing cache handles before Strapi removes Windows temp files.
  if (process.platform === "win32" && process.env.NODE_ENV === "development") {
    sharp.cache(false);
  }

  const originalFactory = plugin.services.upload;
  plugin.services.upload = (...args: any[]) => {
    const service = originalFactory(...args);
    const attached = (fileId: number) => strapi.db.query("api::product.product").findOne({
      where: { $or: [{ CoverImage: { id: fileId } }, { Media: { id: fileId } }, { Files: { id: fileId } }] }, select: ["id"],
    } as any);
    const protectFile = async (fileId: number, operation: () => Promise<unknown>) => strapi.db.transaction(async ({ trx }) => {
      // Product attachment takes a shared lock on this same row. An unused
      // file keeps the existing media deletion/replacement behavior.
      await trx(strapi.db.metadata.get("plugin::upload.file").tableName).where({ id: fileId }).forUpdate().first();
      const galleryUsage = await trx.raw(`SELECT 1 FROM (${PRODUCT_MEDIA_REFERENCES}) refs WHERE refs.file_id = ? LIMIT 1`, [fileId]);
      if (rowsFromRaw(galleryUsage).length || await attached(fileId)) throw new CatalogEditError("PRODUCT_MEDIA_IN_USE", 409);
      return operation();
    });
    const upload = service.upload;
    service.upload = async (input: any, ...options: any[]) => {
      const ref = String(input?.data?.ref || "");
      if (ref.startsWith("api::product.") || ref === "product.color-gallery") throw new CatalogEditError("PRODUCT_MEDIA_EDITOR_REQUIRED", 409);
      return upload.call(service, input, ...options);
    };
    const uploadToEntity = service.uploadToEntity;
    service.uploadToEntity = async (input: any, ...options: any[]) => {
      const model = String(input?.model || "");
      if (model.startsWith("api::product.") || model === "product.color-gallery") throw new CatalogEditError("PRODUCT_MEDIA_EDITOR_REQUIRED", 409);
      return uploadToEntity.call(service, input, ...options);
    };
    const replace = service.replace;
    service.replace = async (id: number, ...options: any[]) => protectFile(Number(id), () => replace.call(service, id, ...options));
    const remove = service.remove;
    service.remove = async (file: any, ...options: any[]) => protectFile(Number(file.id), () => remove.call(service, file, ...options));
    return service;
  };
  return plugin;
};
