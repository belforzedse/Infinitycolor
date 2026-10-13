import { ProductEditorSession, type ProductEditorClient } from "./editor-session";

/**
 * Simple products are modeled as a product with a single, attribute-less
 * (synthetic) published variation that carries SKU/Price/DiscountPrice/Stock.
 * This keeps the storefront, cart, checkout, order and payment flows identical
 * for simple and variable products (a simple product is "a variable product
 * with one invisible variation").
 *
 * This helper creates/updates that single variation and its stock, and ensures
 * no other variation stays published for a simple product.
 */

const MAX_STOCK = 1000;

type SimpleProductInput = {
  ProductType: "Variable" | "Simple";
  IsSimpleProduct?: boolean;
  SimpleVariationId?: number;
  SimpleStockId?: number;
  SimpleStockRevision?: number;
  SimpleSKU?: string;
  SimplePrice?: number;
  SimpleDiscountPrice?: number | null;
  SimpleStock?: number;
  SimpleIsPublished?: boolean;
};

const normalizeStock = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.floor(parsed), 0), MAX_STOCK);
};

const normalizePrice = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

const buildSimpleSku = (productId: number, sku?: string): string => {
  const trimmed = sku?.trim();
  return trimmed || `INFINITY-${productId}`;
};

export const syncSimpleProductVariation = async (
  productId: number,
  product: SimpleProductInput,
  client?: ProductEditorClient,
) => {
  if (product.ProductType !== "Simple" && product.IsSimpleProduct !== true) return;
  const session = client ? null : new ProductEditorSession(productId, () => undefined);
  try {
    if (session) {
      await session.open(true);
      if (session.state.phase !== "editing") throw new Error("Could not start product editing");
    }
    const writer = client ?? session!.client;
    await writer.put(`/products/${productId}/editor`, {
      data: {},
      simpleVariation: {
        ...(product.SimpleVariationId ? { id: product.SimpleVariationId } : {}),
        SKU: buildSimpleSku(productId, product.SimpleSKU),
        Price: normalizePrice(product.SimplePrice),
        DiscountPrice: product.SimpleDiscountPrice == null ? null : normalizePrice(product.SimpleDiscountPrice),
        IsPublished: product.SimpleIsPublished !== false,
        stock: { ...(product.SimpleStockId ? { id: product.SimpleStockId, expectedStockRevision: product.SimpleStockRevision } : {}), Count: normalizeStock(product.SimpleStock) },
      },
    }, { retries: 0 });
  } finally { if (session) { await session.release(); session.dispose(); } }
};
