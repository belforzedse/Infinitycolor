import { ProductDetail } from "@/services/product/product";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { safeJsonLd } from "@/utils/seo";

interface ProductSchemaProps {
  product: ProductDetail;
  slug: string;
}

// Strip HTML tags from description for SEO schema (schema.org expects plain text)
function stripHTML(html: string): string {
  if (!html) return "";
  // Remove HTML tags and decode HTML entities
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const getPriceMultiplier = (): number => {
  const parsed = toNumber(
    process.env.SEARCHWISE_PRICE_TO_RIAL_MULTIPLIER ||
      process.env.NEXT_PUBLIC_SEARCHWISE_PRICE_TO_RIAL_MULTIPLIER,
  );
  return parsed > 0 ? parsed : 10;
};

const getAvailableStock = (variation: any): number => {
  const stock = variation?.attributes?.product_stock?.data?.attributes;
  const count = toNumber(stock?.Count);
  const reserved = toNumber(stock?.reservedCount ?? stock?.ReservedCount ?? stock?.reserved_count);
  return Math.max(0, count - reserved);
};

const isPublishedPricedVariation = (variation: any): boolean =>
  variation?.attributes?.IsPublished === true && toNumber(variation?.attributes?.Price) > 0;

const getFinalVariationPrice = (variation: any): number => {
  const price = toNumber(variation?.attributes?.Price);
  const discountPrice = toNumber(variation?.attributes?.DiscountPrice);
  return discountPrice > 0 && discountPrice < price ? discountPrice : price;
};

export function ProductSchema({ product, slug }: ProductSchemaProps) {
  const title = product?.attributes?.Title || "محصول";
  const rawDescription = product?.attributes?.Description || title;
  const description = stripHTML(rawDescription);
  const imageUrl = product?.attributes?.CoverImage?.data?.attributes?.url
    ? resolveAssetUrl(product.attributes.CoverImage.data.attributes.url) || undefined
    : undefined;

  // Get price info from variations if available
  const variations = product?.attributes?.product_variations?.data || [];
  const publishedPricedVariations = variations.filter(isPublishedPricedVariation);
  const priceMultiplier = getPriceMultiplier();
  const prices = publishedPricedVariations
    .map((variation: any) => Math.round(getFinalVariationPrice(variation) * priceMultiplier))
    .filter((p) => p > 0);

  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const currentPrice = minPrice || maxPrice || 0;
  const hasStock = publishedPricedVariations.some((variation: any) => getAvailableStock(variation) > 0);

  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://new.infinitycolor.co";

  const schema: Record<string, any> = {
    "@context": "https://schema.org/",
    "@type": "Product",
    name: title,
    description: description.slice(0, 300),
    image: imageUrl,
    url: `${SITE_URL}/pdp/${slug}`,
    brand: {
      "@type": "Brand",
      name: "اینفینیتی",
    },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "IRR",
      lowPrice: minPrice > 0 ? minPrice.toString() : "0",
      highPrice: maxPrice > 0 ? maxPrice.toString() : "0",
      offerCount: publishedPricedVariations.length,
      availability: hasStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
    itemCondition: "https://schema.org/NewCondition", // Default to new - safe default
  };

  // Add category if main category exists
  if (product?.attributes?.product_main_category?.data?.attributes?.Title) {
    schema.category = product.attributes.product_main_category.data.attributes.Title;
  } else if (product?.attributes?.product_main_category?.data?.attributes?.Name) {
    schema.category = product.attributes.product_main_category.data.attributes.Name;
  }

  // Add additionalProperty for product attributes (size, color) if they exist in variations
  const additionalProperties: Array<{ "@type": string; name: string; value: string }> = [];

  // Collect unique colors from variations
  const uniqueColors = new Set<string>();
  publishedPricedVariations.forEach((v: any) => {
    const color = v?.attributes?.product_variation_color?.data?.attributes?.Title;
    if (color) {
      uniqueColors.add(color);
    }
  });
  uniqueColors.forEach((color) => {
    additionalProperties.push({
      "@type": "PropertyValue",
      name: "رنگ",
      value: color,
    });
  });

  // Collect unique sizes from variations
  const uniqueSizes = new Set<string>();
  publishedPricedVariations.forEach((v: any) => {
    const size = v?.attributes?.product_variation_size?.data?.attributes?.Title;
    if (size) {
      uniqueSizes.add(size);
    }
  });
  uniqueSizes.forEach((size) => {
    additionalProperties.push({
      "@type": "PropertyValue",
      name: "سایز",
      value: size,
    });
  });

  // Only add additionalProperty if we have properties
  if (additionalProperties.length > 0) {
    schema.additionalProperty = additionalProperties;
  }

  // Only add aggregateRating if it exists and has valid data
  if (product?.attributes?.RatingCount && product?.attributes?.RatingCount > 0) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: (product?.attributes?.AverageRating || 0).toString(),
      ratingCount: product?.attributes?.RatingCount?.toString(),
    };
  }

  // Add SKU if available from the first public priced variation, otherwise use product ID.
  const firstSku = publishedPricedVariations
    .map((variation: any) => variation?.attributes?.SKU)
    .find((sku: unknown) => typeof sku === "string" && sku.trim());
  if (firstSku || product?.id) {
    schema.sku = firstSku || product.id.toString();
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJsonLd(schema) }}
    />
  );
}
