import Modal from "@/components/Kits/Modal";
import { useRef, useState } from "react";
import EmptyStarIcon from "../Icons/EmptyStarIcon";
import StarIcon from "../Icons/StarIcon";
import SendCommentIcon from "../Icons/SendCommentIcon";
import { productReviewService } from "@/services/product/product-review.service";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  commentCount: number;
  productId?: string;
}

export default function PDPCommentModal({ isOpen, onClose, onSubmitted, commentCount, productId }: Props) {
  const router = useRouter();
  const submitting = useRef(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setRating(0);
    setComment("");
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;

    // Form validation
    if (rating === 0) {
      setFormError("لطفاً یک امتیاز برای محصول انتخاب کنید");
      return;
    }

    if (comment.trim().length < 10) {
      setFormError("لطفاً حداقل 10 کاراکتر برای دیدگاه خود وارد کنید");
      return;
    }

    if (comment.trim().length > 4000) {
      setFormError("دیدگاه باید کوتاه‌تر از ۴۰۰۰ نویسه باشد.");
      return;
    }

    if (!productId) {
      setFormError("خطا در شناسایی محصول");
      return;
    }

    // Clear any previous errors
    setFormError(null);
    submitting.current = true;
    setIsSubmitting(true);

    try {
      await productReviewService.submitReview(productId, rating, comment.trim());

      // Reset form and close modal on success
      resetForm();
      onClose();
      onSubmitted?.();

      // Show success message
      toast.success("دیدگاه شما با موفقیت ثبت شد و پس از تأیید نمایش داده خواهد شد");
    } catch (error: any) {
      console.error("Error submitting review:", error);

      // Only a missing or expired session should send the shopper to login.
      if (error.status === 401 || error.message === "Authentication required") {
        toast.error("لطفاً ابتدا وارد حساب کاربری خود شوید");
        // Redirect to login page after a short delay
        setTimeout(() => {
          router.push("/auth");
        }, 1500);
        return;
      }

      // 403 means the session is valid but the account may not submit reviews;
      // redirecting to login would just loop the shopper back here.
      if (error.status === 403) {
        setFormError("حساب کاربری شما اجازه ثبت دیدگاه ندارد.");
        return;
      }

      setFormError("خطا در ثبت دیدگاه. لطفاً مجددا تلاش کنید.");
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (submitting.current) return;
        resetForm();
        onClose();
      }}
      className="max-w-xl"
      title="افزودن نظر"
    >
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1 text-right">
          <p className="text-lg text-neutral-700">{commentCount} کامنت</p>

          <p className="text-base text-right text-neutral-500">
            شما هم از تجربه خریدتون برامون بنویسین
          </p>
        </div>

        {formError && (
          <div role="alert" className="text-sm rounded-lg bg-red-50 p-3 text-red-700">{formError}</div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <textarea
            placeholder="نظر شما"
            aria-label="نظر شما"
            maxLength={4000}
            disabled={isSubmitting}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="h-32 resize-none rounded-lg border border-gray-200 p-3 text-right"
            required
          />

          <div className="flex items-center justify-between">
            <p className="text-sm text-foreground-muted">به محصولات ما امتیاز بدین!</p>

            <div className="flex flex-row-reverse">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(star)}
                  aria-label={`${star} ستاره`}
                  aria-pressed={rating === star}
                  disabled={isSubmitting}
                  className="rounded p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-infinity-primary"
                >
                  {star <= rating ? <StarIcon /> : <EmptyStarIcon />}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            className={`${
              isSubmitting ? "bg-gray-400" : "bg-actions-primary"
            } mt-5 flex w-full items-center justify-center gap-2 self-end rounded-xl px-6 py-3 text-white md:w-auto`}
            disabled={isSubmitting}
          >
            <span>{isSubmitting ? "در حال ارسال..." : "ثبت نظر"}</span>
            {!isSubmitting && <SendCommentIcon />}
          </button>
        </form>
      </div>
    </Modal>
  );
}
