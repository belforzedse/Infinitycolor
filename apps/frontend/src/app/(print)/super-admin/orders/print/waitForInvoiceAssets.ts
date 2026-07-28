const waitForImage = async (image: HTMLImageElement) => {
  if (image.complete) return;

  if (typeof image.decode === "function") {
    await image.decode().catch(() => undefined);
    return;
  }

  await new Promise<void>((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
};

export const waitForInvoiceAssets = async () => {
  await document.fonts?.ready.catch(() => undefined);
  await Promise.all(Array.from(document.images).map(waitForImage));

  // Let the browser commit the final font and image metrics before opening the print dialog.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
};
