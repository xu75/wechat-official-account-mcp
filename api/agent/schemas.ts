import { z } from 'zod';

export const publishRequestSchema = z.object({
  task_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  review_approved: z.boolean(),
  review_approval_token: z.string().min(1).optional(),
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

export const configInitRequestSchema = z.object({
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  token: z.string().optional(),
  encoding_aes_key: z.string().optional(),
});

export const configCheckRequestSchema = z.object({
  check_token: z.boolean().optional().default(true),
  publish_preview: publishRequestSchema.pick({
    task_id: true,
    idempotency_key: true,
    title: true,
    content: true,
    review_approved: true,
    review_approval_token: true,
    preferred_channel: true,
    thumb_media_id: true,
    author: true,
    digest: true,
    content_source_url: true,
  }).optional(),
});

export type PublishRequestInput = z.infer<typeof publishRequestSchema>;
export type CallbackRequestInput = z.infer<typeof callbackRequestSchema>;
export type ConfigInitRequestInput = z.infer<typeof configInitRequestSchema>;
export type ConfigCheckRequestInput = z.infer<typeof configCheckRequestSchema>;
