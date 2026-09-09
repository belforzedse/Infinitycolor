export interface CategoryData {
  Title: string;
  Slug: string;
  parent?: number | string | null;
  Image?: number | null;
  MegaMenuImage?: number | null;
}

type CategoryWriteInput = {
  Title: string;
  Slug: string;
  parentId?: string | null;
  Image?: number | null;
  MegaMenuImage?: number | null;
  /** When true, an empty parent control becomes `parent: null` so a child can be unlinked. */
  unlinkEmptyParent?: boolean;
};

/**
 * Maps the category form onto the Strapi schema field `parent`.
 * The form still uses `Parent` as UI state; the API body must not.
 */
export function buildCategoryWritePayload(
  input: CategoryWriteInput,
): CategoryData {
  const payload: CategoryData = {
    Title: input.Title,
    Slug: input.Slug,
  };

  if (input.Image !== undefined) {
    payload.Image = input.Image;
  }
  if (input.MegaMenuImage !== undefined) {
    payload.MegaMenuImage = input.MegaMenuImage;
  }

  const parentId = input.parentId?.trim() ?? "";
  if (parentId) {
    payload.parent = parentId;
  } else if (input.unlinkEmptyParent) {
    payload.parent = null;
  }

  return payload;
}
