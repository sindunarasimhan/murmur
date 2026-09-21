import { z } from 'zod';

export const positionSchema = z.number().finite().min(0).max(86_400);
export const snapshotSchema = z.object({
  revision: z.number().int().min(0),
  positionSeconds: positionSchema,
  audioVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const observationSchema = snapshotSchema.extend({
  reason: z.enum(['progress', 'interrupt', 'pause', 'play', 'seek', 'cancel', 'speech-ended']),
}).strict();
export const turnRequestSchema = snapshotSchema.extend({
  requestId: z.uuid(),
  utterance: z.string().trim().min(1).max(1000),
  resumeAfterAction: z.boolean().optional(),
}).strict();
export const acknowledgementSchema = snapshotSchema.extend({ actionId: z.uuid() }).strict();
export const evidenceSchema = z.object({
  id: z.string(), startSeconds: positionSchema, endSeconds: positionSchema, text: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export const actionSchema = z.object({
  id: z.uuid(), kind: z.enum(['play', 'pause', 'seek', 'return', 'skip-ad']),
  positionSeconds: positionSchema, play: z.boolean(),
});
export type PlaybackAction = z.infer<typeof actionSchema>;
export const sessionSchema = z.object({
  id: z.uuid(), episodeId: z.string(), audioVersion: z.string(), revision: z.number().int(),
  positionSeconds: positionSchema, bookmarkSeconds: positionSchema.nullable(),
  phase: z.enum(['paused', 'playing', 'listening', 'resolving', 'speaking', 'exploring']),
  pendingAction: actionSchema.nullable(),
});
export type ListeningSession = z.infer<typeof sessionSchema>;
export const turnResultSchema = z.object({
  requestId: z.uuid(), session: sessionSchema, answer: z.string(),
  decision: z.enum(['code', 'jev', 'unavailable']),
  evidence: z.array(evidenceSchema), action: actionSchema.nullable(),
  followUp: z.boolean().optional(),
});
export type TurnResult = z.infer<typeof turnResultSchema>;
export const episodeSchema = z.object({
  id: z.string(), title: z.string(), showTitle: z.string(), description: z.string(),
  audioVersion: z.string(), durationSeconds: positionSchema,
  status: z.enum(['queued', 'processing', 'ready', 'failed']),
  audioPath: z.string().nullable(), transcriptReady: z.boolean(),
  guest: z.string().nullable().optional(), publishedAt: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(), artworkUrl: z.string().nullable().optional(),
});
export type PreparedEpisode = z.infer<typeof episodeSchema>;
export const catalogResolutionSchema = z.object({
  kind: z.enum(['play', 'current', 'clarify', 'stop', 'home']),
  episode: episodeSchema.optional(), message: z.string(),
});
export type CatalogResolution = z.infer<typeof catalogResolutionSchema>;
