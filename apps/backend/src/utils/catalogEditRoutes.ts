/** Attach coordination after the normal content-API auth/ability checks. */
export function catalogEditRoutes(uid: string, resource: string, readers: Record<string, any> = {}) {
  const guard = { name: "global::catalog-edit", config: { resource, uid } };
  return {
    ...readers,
    ...(resource === "product" ? {} : { create: { ...(readers.create || {}), middlewares: [guard] } }),
    update: { ...(readers.update || {}), middlewares: [guard] },
    delete: { ...(readers.delete || {}), middlewares: [guard] },
  };
}
