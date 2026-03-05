import { z } from 'zod';

export const publishRequestSchema = z.object({
  task_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  review_approved: z.boolean(),
  preferred_channel: z.enum(['official', 'browser']).optional().default('official'),
  thumb_media_id: z.string().min(1).optional(),
  author: z.string().optional(),
  digest: z.string().optional(),
  content_source_url: z.string().url().optional(),
});

export const callbackRequestSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['published', 'publish_failed', 'manual_intervention', 'publishing']),
  message: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type PublishRequestInput = z.infer<typeof publishRequestSchema>;
export type CallbackRequestInput = z.infer<typeof callbackRequestSchema>;
