import { productReviewService } from '../product-review.service';
import { apiClient } from '@/services';
jest.mock('@/services', () => ({ apiClient: { post: jest.fn(), get: jest.fn() } }));
const review = { id: 3, Rate: 5, Content: 'This is a review', Status: 'Need for Review', Date: '2026-09-08', LikeCounts: 0, DislikeCounts: 0, isUpdated: true };
it.each([review, { data: review }])('normalizes successful submission without treating it as an error', async response => {
  (apiClient.post as jest.Mock).mockResolvedValue(response);
  const result = await productReviewService.submitReview(1, 5, review.Content);
  expect(result.data).toMatchObject({ id: 3, Content: review.Content, Rate: 5, Status: 'Need for Review' });
  expect(apiClient.post).toHaveBeenCalledWith('/product-reviews/submit', { productId: 1, rate: 5, content: review.Content });
});
it('keeps public review reads restricted to accepted, nonremoved reviews', async () => {
  (apiClient.get as jest.Mock).mockResolvedValue({ data: [], meta: { pagination: { page: 1, pageCount: 1, total: 0 } } });
  await productReviewService.getProductReviews(1);
  expect(apiClient.get).toHaveBeenCalledWith('/product-reviews', { cache: 'no-store', params: expect.objectContaining({ 'filters[Status][$eq]': 'Accepted', 'filters[removedAt][$null]': 'true' }) });
});
