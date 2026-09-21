import {
  handleRealtimeTokenRequest,
  realtimeTokenOptions,
} from '@/server/openai-realtime/handler';

export function OPTIONS(): Response {
  return realtimeTokenOptions();
}

export function POST(request: Request): Promise<Response> {
  return handleRealtimeTokenRequest(request);
}
