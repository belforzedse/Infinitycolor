import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CommentsInfo from "../CommentsInfo";

/**
 * The review count is styled as a link, so shoppers click it expecting to reach
 * the review section. It used to be a bare <span> with no handler: inert to the
 * mouse and invisible to the keyboard, while a separate button did the real work.
 */
describe("PDP review-count link", () => {
  it("reaches the review section when there are no reviews yet", async () => {
    const onOpenComments = jest.fn();
    render(<CommentsInfo commentCount={0} rateCount={0} onOpenComments={onOpenComments} />);

    await userEvent.click(screen.getByRole("button", { name: "بدون دیدگاه" }));

    expect(onOpenComments).toHaveBeenCalledTimes(1);
  });

  it("reaches the review section when reviews exist", async () => {
    const onOpenComments = jest.fn();
    render(<CommentsInfo commentCount={12} rateCount={12} onOpenComments={onOpenComments} />);

    await userEvent.click(screen.getByRole("button", { name: "12 دیدگاه" }));

    expect(onOpenComments).toHaveBeenCalledTimes(1);
  });

  it("is reachable and activatable by keyboard", async () => {
    const onOpenComments = jest.fn();
    render(<CommentsInfo commentCount={3} rateCount={3} onOpenComments={onOpenComments} />);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "3 دیدگاه" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(onOpenComments).toHaveBeenCalledTimes(1);
  });
});
