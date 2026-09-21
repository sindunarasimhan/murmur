import { handleVoiceCapabilitiesRequest } from '@/server/openai-audio/handlers';
import { audioApiOptions } from '@/server/openai-audio/responses';

export function OPTIONS(): Response {
  return audioApiOptions();
}

export function GET(request: Request): Response {
  return handleVoiceCapabilitiesRequest(request);
}
