import { apiClient } from "@/services";

interface ProductTitleKeywordsResponse {
  keywords: string[];
}

export async function getProductTitleKeywords(): Promise<string[]> {
  const response = await apiClient.get<ProductTitleKeywordsResponse>(
    "/products/title-keywords",
    {
      cache: "no-store",
      retries: 0,
    },
  );

  return response.data.keywords;
}
