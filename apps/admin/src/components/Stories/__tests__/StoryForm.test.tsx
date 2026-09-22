import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StoryForm from "../StoryForm";

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

jest.mock("@/services/super-admin/files/upload", () => ({
  uploadFile: jest.fn(),
}));

describe("StoryForm", () => {
  it("sends Thumbnail null when cover is absent so Strapi disconnects it", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);

    render(
      <StoryForm
        initialValues={{
          Title: "عنوان",
          IsActive: false,
          SortOrder: 0,
          Items: [{ localId: "one", Key: "one", MediaType: "image", mediaId: 7, mediaUrl: "/uploads/a.webp", DurationMs: 5000, CtaUrl: "/pdp/old-product" }],
        }}
        onSubmit={onSubmit}
        isLoading={false}
        submitLabel="ذخیره تغییرات"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        Title: "عنوان",
        IsActive: false,
        SortOrder: 0,
        Thumbnail: null,
        StartAt: null,
        EndAt: null,
        Items: [{ Key: "one", MediaType: "image", Media: 7, Thumbnail: null, DurationMs: 5000, CtaUrl: "/pdp/old-product", Overlays: [] }],
      });
    });
  });

  it("submits a cleared CTA as null so Strapi removes the destination", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);

    render(
      <StoryForm
        initialValues={{
          Title: "عنوان",
          IsActive: true,
          SortOrder: 2,
          Items: [{ localId: "one", Key: "one", MediaType: "image", mediaId: 7, mediaUrl: "/uploads/a.webp", DurationMs: 5000, CtaUrl: "/pdp/old-product" }],
        }}
        onSubmit={onSubmit}
        isLoading={false}
        submitLabel="ذخیره تغییرات"
      />,
    );

    fireEvent.change(screen.getByLabelText("لینک دکمه «مشاهده لینک»"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        Items: [expect.objectContaining({ CtaUrl: null })],
      }));
    });
  });

  it("duplicates, reorders, and removes item cards without losing stable existing keys", () => {
    render(
      <StoryForm
        initialValues={{
          Title: "عنوان",
          Items: [
            { localId: "one", Key: "one", MediaType: "image", mediaId: 7, mediaUrl: "/uploads/a.webp", DurationMs: 5000 },
            { localId: "two", Key: "two", MediaType: "video", mediaId: 8, mediaUrl: "/uploads/b.mp4", DurationMs: 6000 },
          ],
        }}
        onSubmit={jest.fn()}
        isLoading={false}
        submitLabel="ذخیره تغییرات"
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "کپی آیتم" })[0]);
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button", { name: "انتقال به پایین" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "حذف آیتم" })[1]);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });
});
