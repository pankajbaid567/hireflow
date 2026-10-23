// Shared normalization has no browser/provider dependencies. Exact normalized
// question matches never infer eligibility or answer a different question.
export const normalizeReviewQuestion = (value: string) => value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export interface ApprovedReview { binding: string; answers: Record<string, string>; reviewId: string; }
