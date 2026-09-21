import { handleTranscribeRequest } from '@/server/openai-audio/handlers';
import { audioApiOptions } from '@/server/openai-audio/responses';

export function OPTIONS(): Response {
  return audioApiOptions();
}

export function POST(request: Request): Promise<Response> {
  return handleTranscribeRequest(request);
}
