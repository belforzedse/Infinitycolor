import { CatalogEditError } from "../../utils/catalogEdit";

/** Cover content API, native admin and folder/bulk media operations alike. */
export default (plugin: any) => {
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
      if (await attached(fileId)) throw new CatalogEditError("PRODUCT_MEDIA_IN_USE", 409);
      return operation();
    });
    const upload = service.upload;
    service.upload = async (input: any, ...options: any[]) => {
      if (String(input?.data?.ref || "").startsWith("api::product.")) throw new CatalogEditError("PRODUCT_MEDIA_EDITOR_REQUIRED", 409);
      return upload.call(service, input, ...options);
    };
    const uploadToEntity = service.uploadToEntity;
    service.uploadToEntity = async (input: any, ...options: any[]) => {
      if (String(input?.model || "").startsWith("api::product.")) throw new CatalogEditError("PRODUCT_MEDIA_EDITOR_REQUIRED", 409);
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
