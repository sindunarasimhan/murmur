import { isMurmurClientRequest } from './client-request';
import { readBoundedBody } from './read-bounded-body';
import { UpstreamError } from './upstream';

export const API_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, X-Murmur-Client',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, X-Murmur-Voice-Disclosure, X-Murmur-Model, X-Murmur-Decision',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiJson(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...API_HEADERS, ...Object.fromEntries(new Headers(headers)) } });
}

export function apiOptions(): Response {
  return new Response(null, { status: 204, headers: API_HEADERS });
}

export function requireClient(request: Request, code = 'invalid_client') {
  // A client marker, not authentication. Production access control belongs at the gateway.
  if (!isMurmurClientRequest(request)) {
    throw new ApiError(403, code, 'This endpoint accepts Murmur app requests only.');
  }
}

export function requireJson(request: Request, status = 415, code = 'invalid_content_type') {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!/^application\/(?:[\w.-]+\+)?json$/.test(type)) {
    throw new ApiError(status, code, 'Content-Type must be application/json.');
  }
}

export async function readRequestBytes(request: Request, maxBytes: number, sizeCode = 'payload_too_large') {
  try {
    if (request.signal.aborted) throw new UpstreamError('cancelled');
    const body = await readBoundedBody(request, maxBytes, request.signal);
    if (!body.ok) throw new ApiError(413, sizeCode, 'Request body is too large.');
    return body.bytes;
  } catch (error) {
    if (request.signal.aborted) throw new UpstreamError('cancelled');
    if (error instanceof ApiError || error instanceof UpstreamError) throw error;
    throw new ApiError(400, 'invalid_request', 'The request body could not be read.');
  }
}

export async function readRequestJson(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readRequestBytes(request, maxBytes);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.'); }
}

function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof UpstreamError) {
    switch (error.kind) {
      case 'cancelled': return new ApiError(499, 'request_cancelled', 'The request was cancelled.');
      case 'timeout': return new ApiError(504, 'provider_timeout', 'Murmur took too long to respond. Please try again.', true);
      case 'authentication': return new ApiError(503, 'provider_authentication', 'Murmur needs a valid provider API key on this server.');
      case 'quota': return new ApiError(503, 'provider_quota', 'Murmur needs available OpenAI API credits.');
      case 'unavailable': return new ApiError(503, 'provider_unavailable', 'Murmur is temporarily unavailable. Please try again.', true);
      case 'empty': return new ApiError(502, 'empty_provider_response', 'Murmur could not form an answer. Please try again.', true);
      default: return new ApiError(502, 'upstream_error', 'Murmur could not complete this request. Please try again.');
    }
  }
  // Do not expose error.message: a library may put the prompt, URL or credentials in it.
  console.error('Murmur backend failure', { name: error instanceof Error ? error.name : 'UnknownError' });
  return new ApiError(503, 'provider_unavailable', 'Murmur is temporarily unavailable. Please try again.', true);
}

export function apiFailure(error: unknown): Response {
  const failure = publicError(error);
  return apiJson({ error: { code: failure.code, message: failure.message, retryable: failure.retryable } }, failure.status);
}

export async function apiBoundary(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); } catch (error) { return apiFailure(error); }
}
