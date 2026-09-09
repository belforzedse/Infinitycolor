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
          MediaType: "image",
          mediaId: 7,
          mediaUrl: "/uploads/a.webp",
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
        MediaType: "image",
        IsActive: false,
        SortOrder: 0,
        Media: 7,
        Thumbnail: null,
      });
    });
  });
});
