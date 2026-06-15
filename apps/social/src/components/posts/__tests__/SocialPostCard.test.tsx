import { fireEvent, render, screen } from "@testing-library/react";
import { SocialPostCard, type PostCardVariant } from "@repo/social-posts/client";

const variants: PostCardVariant[] = ["sm", "xl", "mobile-sm", "mobile-lg"];
const imageSrc =
  "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

function renderCard(variant: PostCardVariant, handlers = {}) {
  return render(
    <SocialPostCard
      variant={variant}
      imageSrc={imageSrc}
      imageAlt={`Test post ${variant}`}
      href={`/post/test-${variant}`}
      linkAriaLabel={`Open test post ${variant}`}
      likesCount={1}
      commentsCount={2}
      onLike={jest.fn()}
      onComment={jest.fn()}
      onSave={jest.fn()}
      {...handlers}
    />,
  );
}

describe("SocialPostCard", () => {
  it.each(variants)(
    "renders the %s media surface as a valid post link",
    (variant) => {
      const { container } = renderCard(variant);
      const link = screen.getByRole("link", {
        name: `Open test post ${variant}`,
      });

      expect(link).toHaveAttribute("href", `/post/test-${variant}`);
      expect(link).toHaveClass("cursor-pointer");
      expect(link.closest("article")).toHaveAttribute("data-variant", variant);
      expect(link.querySelector("img,video")).not.toBeNull();
      expect(container.querySelectorAll(`a[href="/post/test-${variant}"]`)).toHaveLength(1);
    },
  );

  it("keeps post action buttons outside the media link", () => {
    const onLike = jest.fn();
    const onComment = jest.fn();
    const onSave = jest.fn();
    renderCard("sm", { onLike, onComment, onSave });

    const link = screen.getByRole("link", { name: "Open test post sm" });
    const buttons = screen.getAllByRole("button");

    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(link).not.toContainElement(button);
    }

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[2]);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onLike).toHaveBeenCalledTimes(1);
  });
});
